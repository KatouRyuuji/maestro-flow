import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

import type { TransitionReceiptV20 } from '../protocol-schemas.js';
import { gateRegistrySchema, type RunV30, type SessionStateV30 } from '../schemas.js';
import { SessionStore, type SessionV30StoreTransaction } from '../store.js';
import { assertSafePathSegment } from '../ids.js';
import { createRevisionConflictError, V3StructuredError } from './errors.js';
import {
  canonicalPayloadHash,
  createRequestReceipt,
  createTransitionReceipt,
  replayRequestReceipt,
  transitionReceiptRef,
} from './receipts.js';
import { assertSessionCanComplete, assertSessionOperationAllowed, assertSessionRunTransitionAllowed, transitionSession, type SessionCompletionSnapshot } from './session-machine.js';
import { transitionRun, buildRetryMetadata, type RunStatus, type RunTransitionEvidence } from './run-machine.js';

export interface V3MutationIdentity {
  sessionId: string;
  requestId: string;
  participantId: string;
  actorId: string;
  reason: string;
  evidenceRefs?: readonly string[];
  recordedAt?: string;
}

export interface V3MutationResult {
  status: 'applied' | 'replayed';
  transition: TransitionReceiptV20;
}

export interface MutateRunV3Input extends V3MutationIdentity {
  runId: string;
  expectedRunRevision: number;
  toStatus: RunStatus;
  summary?: string | null;
  verdict?: RunV30['verdict'];
  transitionEvidence?: RunTransitionEvidence;
}

export interface CreateRunV3Input extends V3MutationIdentity {
  expectedOrchestrationRevision: number;
  run: RunV30;
}

export interface CreateRunningRunV3Input extends CreateRunV3Input {
  requestOperation?: 'run-create' | 'run-next';
}

export interface CompleteRunAndAdvanceInput extends V3MutationIdentity {
  runId: string;
  expectedRunRevision: number;
  expectedOrchestrationRevision: number;
  summary: string;
  verdict: Extract<NonNullable<RunV30['verdict']>, 'done' | 'done_with_concerns'>;
}

export interface CompleteSessionV3Input extends V3MutationIdentity {
  expectedOrchestrationRevision: number;
}

function required(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new V3StructuredError('INVALID_ARGUMENT', `${label} is required`);
  return normalized;
}

function normalizedIdentity(input: V3MutationIdentity): Required<Omit<V3MutationIdentity, 'evidenceRefs' | 'recordedAt'>> & {
  evidenceRefs: string[];
  recordedAt: string;
} {
  const sessionId = required(input.sessionId, 'session ID');
  const requestId = required(input.requestId, 'request ID');
  const participantId = required(input.participantId, 'participant ID');
  const actorId = required(input.actorId, 'actor ID');
  assertSafePathSegment(sessionId, 'session ID');
  assertSafePathSegment(requestId, 'request ID');
  return {
    sessionId,
    requestId,
    participantId,
    actorId,
    reason: required(input.reason, 'reason'),
    evidenceRefs: [...new Set((input.evidenceRefs ?? []).map(item => item.trim()).filter(Boolean))].sort(),
    recordedAt: input.recordedAt ?? new Date().toISOString(),
  };
}

function auditPayload(identity: ReturnType<typeof normalizedIdentity>) {
  return {
    actor_id: identity.actorId,
    reason: identity.reason,
    evidence_refs: identity.evidenceRefs,
  };
}

function creationPayload(run: RunV30) {
  return {
    schema_version: run.schema_version,
    run_id: run.run_id,
    session_id: run.session_id,
    step_id: run.step_id,
    parent_run_id: run.parent_run_id,
    retry_of_run_id: run.retry_of_run_id,
    attempt: run.attempt,
    command: run.command,
    args: run.args,
    goal: run.goal,
    gate_refs: run.gate_refs,
    input_refs: run.input_refs,
  };
}

function assertRevision(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new V3StructuredError('INVALID_ARGUMENT', `${label} must be a non-negative safe integer`);
  }
}

function assertRunRevision(run: RunV30, expected: number): void {
  assertRevision(expected, 'expected Run revision');
  if (run.revision !== expected) {
    throw createRevisionConflictError({
      code: 'RUN_REVISION_CONFLICT',
      targetType: 'run',
      targetId: run.run_id,
      expectedRevision: expected,
      currentRevision: run.revision,
      changedBy: run.actor_id,
    });
  }
}

function assertOrchestrationRevision(session: SessionStateV30, expected: number): void {
  assertRevision(expected, 'expected orchestration revision');
  if (session.orchestration_revision !== expected) {
    throw createRevisionConflictError({
      code: 'ORCHESTRATION_REVISION_CONFLICT',
      targetType: 'orchestration',
      targetId: session.session_id,
      expectedRevision: expected,
      currentRevision: session.orchestration_revision,
      changedBy: 'unknown',
    });
  }
}

function replay(
  tx: SessionV30StoreTransaction,
  identity: ReturnType<typeof normalizedIdentity>,
  payloadHash: string,
): V3MutationResult | null {
  const transition = replayRequestReceipt({
    tx,
    sessionId: identity.sessionId,
    requestId: identity.requestId,
    participantId: identity.participantId,
    payloadHash,
  });
  return transition ? { status: 'replayed', transition } : null;
}

function stageApplied(input: {
  tx: SessionV30StoreTransaction;
  identity: ReturnType<typeof normalizedIdentity>;
  payloadHash: string;
  session: SessionStateV30;
  run?: RunV30;
  targetType: TransitionReceiptV20['target_type'];
  targetId: string;
  revisionBefore: number;
  revisionAfter: number;
  result: unknown;
}): V3MutationResult {
  const transitionId = `tr_${randomUUID()}`;
  const transition = createTransitionReceipt({
    transitionId,
    requestId: input.identity.requestId,
    sessionId: input.identity.sessionId,
    activityRevision: input.session.activity_revision,
    targetType: input.targetType,
    targetId: input.targetId,
    revisionBefore: input.revisionBefore,
    revisionAfter: input.revisionAfter,
    actorId: input.identity.actorId,
    participantId: input.identity.participantId,
    reason: input.identity.reason,
    evidenceRefs: input.identity.evidenceRefs,
    recordedAt: input.identity.recordedAt,
    result: input.result,
  });
  const reference = transitionReceiptRef(transition.activity_revision, transition.transition_id);
  const request = createRequestReceipt({
    requestId: input.identity.requestId,
    participantId: input.identity.participantId,
    payloadHash: input.payloadHash,
    transitionReceiptRef: reference,
  });
  input.tx.writeSession(input.session);
  if (input.run) input.tx.writeRun(input.run);
  input.tx.writeTransitionReceipt(transition);
  input.tx.writeRequestReceipt(request);
  return { status: 'applied', transition };
}

function assertRunCreationLineage(
  tx: SessionV30StoreTransaction,
  candidate: RunV30,
  stepStatus: SessionStateV30['chain'][number]['status'],
): void {
  if (candidate.retry_of_run_id === null) {
    if (candidate.attempt !== 1) {
      throw new V3StructuredError('INVALID_ARGUMENT', 'an initial Run must have attempt 1');
    }
    if (stepStatus !== 'pending') {
      throw new V3StructuredError('INVALID_STATE_TRANSITION', `chain step ${candidate.step_id} is not pending`);
    }
    return;
  }
  if (!tx.runExists(candidate.retry_of_run_id)) {
    throw new V3StructuredError('INVALID_ARGUMENT', `unknown retry source Run ${candidate.retry_of_run_id}`);
  }
  const source = tx.readRun(candidate.retry_of_run_id);
  if (source.step_id !== candidate.step_id) {
    throw new V3StructuredError('INVALID_ARGUMENT', `retry source Run ${source.run_id} belongs to a different chain step`);
  }
  const expected = source.status === 'sealed'
    ? buildRetryMetadata({
      runId: source.run_id,
      attempt: source.attempt,
      status: source.status,
      verdict: source.verdict,
    })
    : buildRetryMetadata({
      runId: source.run_id,
      attempt: source.attempt,
      status: source.status,
    });
  if (candidate.retry_of_run_id !== expected.retryOfRunId || candidate.attempt !== expected.attempt) {
    throw new V3StructuredError(
      'INVALID_ARGUMENT',
      `retry Run must use source ${expected.retryOfRunId} and attempt ${expected.attempt}`,
    );
  }
  if (stepStatus !== 'failed') {
    throw new V3StructuredError('INVALID_STATE_TRANSITION', `retry chain step ${candidate.step_id} is not failed`);
  }
}

function updatedSessionActivity(
  session: SessionStateV30,
  recordedAt: string,
  orchestrationRevision = session.orchestration_revision,
): SessionStateV30 {
  return {
    ...session,
    orchestration_revision: orchestrationRevision,
    activity_revision: session.activity_revision + 1,
    updated_at: recordedAt,
  };
}

export function mutateRunV3(store: SessionStore, input: MutateRunV3Input): V3MutationResult {
  const identity = normalizedIdentity(input);
  const runId = required(input.runId, 'run ID');
  const payload = {
    operation: 'run-transition', run_id: runId, expected_run_revision: input.expectedRunRevision,
    to_status: input.toStatus, summary: input.summary, verdict: input.verdict,
    transition_evidence: input.transitionEvidence ?? {},
    ...auditPayload(identity),
  };
  const payloadHash = canonicalPayloadHash(payload);
  return store.withV30Transaction(identity.sessionId, tx => {
    const replayed = replay(tx, identity, payloadHash);
    if (replayed) return replayed;
    const session = tx.readSession();
    const run = tx.readRun(runId);
    assertRunRevision(run, input.expectedRunRevision);
    assertSessionRunTransitionAllowed(session.status, run.status, input.toStatus, input.transitionEvidence);
    const transitioned = transitionRun(run, input.toStatus, input.transitionEvidence);
    const nextRun: RunV30 = {
      ...transitioned,
      revision: run.revision + 1,
      actor_id: identity.actorId,
      participant_id: identity.participantId,
      summary: input.summary === undefined ? run.summary : input.summary,
      verdict: input.verdict === undefined ? run.verdict : input.verdict,
      started_at: input.toStatus === 'running' ? (run.started_at ?? identity.recordedAt) : run.started_at,
      ended_at: ['completed', 'failed', 'cancelled'].includes(input.toStatus) ? identity.recordedAt : run.ended_at,
      sealed_at: input.toStatus === 'sealed' ? identity.recordedAt : run.sealed_at,
    };
    const terminal = ['completed', 'failed', 'cancelled', 'sealed'].includes(input.toStatus);
    const stepIndex = session.chain.findIndex(step => step.step_id === run.step_id);
    const terminalStepStatus = input.toStatus === 'failed'
      ? 'failed' as const
      : input.toStatus === 'cancelled'
        ? 'pending' as const
        : null;
    const changesRunningStep = terminalStepStatus !== null
      && stepIndex >= 0
      && session.chain[stepIndex].status === 'running'
      && session.chain[stepIndex].run_ids.includes(runId);
    const chain = changesRunningStep
      ? session.chain.map((step, index) => index === stepIndex ? { ...step, status: terminalStepStatus } : step)
      : session.chain;
    const nextSession = updatedSessionActivity(terminal
      ? { ...session, chain, active_run_ids: session.active_run_ids.filter(id => id !== runId) }
      : session, identity.recordedAt, changesRunningStep
        ? session.orchestration_revision + 1
        : session.orchestration_revision);
    return stageApplied({
      tx, identity, payloadHash, session: nextSession, run: nextRun,
      targetType: 'run', targetId: runId,
      revisionBefore: run.revision, revisionAfter: nextRun.revision,
      result: {
        run_id: runId, status: nextRun.status, revision: nextRun.revision,
        orchestration_revision: nextSession.orchestration_revision,
      },
    });
  });
}

export function createRunV3(store: SessionStore, input: CreateRunV3Input): V3MutationResult {
  const identity = normalizedIdentity(input);
  const candidate = structuredClone(input.run);
  const payload = {
    operation: 'run-create', expected_orchestration_revision: input.expectedOrchestrationRevision,
    run: creationPayload(candidate),
    ...auditPayload(identity),
  };
  const payloadHash = canonicalPayloadHash(payload);
  return store.withV30Transaction(identity.sessionId, tx => {
    const replayed = replay(tx, identity, payloadHash);
    if (replayed) return replayed;
    const session = tx.readSession();
    assertOrchestrationRevision(session, input.expectedOrchestrationRevision);
    assertSessionOperationAllowed(session.status, 'create_run');
    if (candidate.session_id !== identity.sessionId || candidate.revision !== 0 || candidate.status !== 'pending') {
      throw new V3StructuredError('INVALID_ARGUMENT', 'new Run must target the Session with pending status and revision 0');
    }
    if (tx.runExists(candidate.run_id)) {
      throw new V3StructuredError('INVALID_STATE_TRANSITION', `Run ${candidate.run_id} already exists`, {
        target_type: 'run', target_id: candidate.run_id, next_actions: ['choose-a-new-run-id', 'inspect-existing-run'],
      });
    }
    const stepIndex = session.chain.findIndex(step => step.step_id === candidate.step_id);
    if (stepIndex < 0) throw new V3StructuredError('INVALID_ARGUMENT', `unknown chain step ${candidate.step_id}`);
    assertRunCreationLineage(tx, candidate, session.chain[stepIndex].status);
    if (session.active_run_ids.includes(candidate.run_id)) {
      throw new V3StructuredError('INVALID_STATE_TRANSITION', `Run ${candidate.run_id} is already active`);
    }
    const chain = session.chain.map((step, index) => index === stepIndex
      ? { ...step, run_ids: [...new Set([...step.run_ids, candidate.run_id])].sort() }
      : step);
    const nextSession = updatedSessionActivity({
      ...session,
      chain,
      active_run_ids: [...session.active_run_ids, candidate.run_id].sort(),
    }, identity.recordedAt, session.orchestration_revision + 1);
    const nextRun: RunV30 = {
      ...candidate,
      actor_id: identity.actorId,
      participant_id: identity.participantId,
    };
    return stageApplied({
      tx, identity, payloadHash, session: nextSession, run: nextRun,
      targetType: 'orchestration', targetId: identity.sessionId,
      revisionBefore: session.orchestration_revision,
      revisionAfter: nextSession.orchestration_revision,
      result: { run_id: nextRun.run_id, revision: nextRun.revision },
    });
  });
}

export function createRunningRunV3(store: SessionStore, input: CreateRunningRunV3Input): V3MutationResult {
  const identity = normalizedIdentity(input);
  const candidate = structuredClone(input.run);
  const payload = {
    operation: input.requestOperation ?? 'run-next', expected_orchestration_revision: input.expectedOrchestrationRevision,
    run: creationPayload(candidate),
    ...auditPayload(identity),
  };
  const payloadHash = canonicalPayloadHash(payload);
  return store.withV30Transaction(identity.sessionId, tx => {
    const replayed = replay(tx, identity, payloadHash);
    if (replayed) return replayed;
    const session = tx.readSession();
    assertOrchestrationRevision(session, input.expectedOrchestrationRevision);
    assertSessionOperationAllowed(session.status, 'create_run');
    assertSessionOperationAllowed(session.status, 'advance_chain');
    if (candidate.session_id !== identity.sessionId || candidate.revision !== 0 || candidate.status !== 'pending') {
      throw new V3StructuredError('INVALID_ARGUMENT', 'next Run must target the Session with pending status and revision 0');
    }
    if (tx.runExists(candidate.run_id)) {
      throw new V3StructuredError('INVALID_STATE_TRANSITION', `Run ${candidate.run_id} already exists`, {
        target_type: 'run', target_id: candidate.run_id, next_actions: ['choose-a-new-run-id', 'inspect-existing-run'],
      });
    }
    const stepIndex = session.chain.findIndex(step => step.step_id === candidate.step_id);
    if (stepIndex < 0) {
      throw new V3StructuredError('INVALID_ARGUMENT', `unknown chain step ${candidate.step_id}`);
    }
    assertRunCreationLineage(tx, candidate, session.chain[stepIndex].status);
    const nextRun: RunV30 = {
      ...candidate,
      status: 'running',
      revision: 1,
      actor_id: identity.actorId,
      participant_id: identity.participantId,
      started_at: identity.recordedAt,
    };
    const chain = session.chain.map((step, index) => index === stepIndex
      ? { ...step, status: 'running' as const, run_ids: [...new Set([...step.run_ids, candidate.run_id])].sort() }
      : step);
    const nextSession = updatedSessionActivity({
      ...session,
      chain,
      active_run_ids: [...session.active_run_ids, candidate.run_id].sort(),
    }, identity.recordedAt, session.orchestration_revision + 1);
    return stageApplied({
      tx, identity, payloadHash, session: nextSession, run: nextRun,
      targetType: 'orchestration', targetId: identity.sessionId,
      revisionBefore: session.orchestration_revision,
      revisionAfter: nextSession.orchestration_revision,
      result: { run_id: nextRun.run_id, status: nextRun.status, revision: nextRun.revision },
    });
  });
}

export function completeRunAndAdvance(
  store: SessionStore,
  input: CompleteRunAndAdvanceInput,
): V3MutationResult {
  const identity = normalizedIdentity(input);
  const runId = required(input.runId, 'run ID');
  const payload = {
    operation: 'run-complete-and-advance', run_id: runId,
    expected_run_revision: input.expectedRunRevision,
    expected_orchestration_revision: input.expectedOrchestrationRevision,
    summary: input.summary, verdict: input.verdict,
    ...auditPayload(identity),
  };
  const payloadHash = canonicalPayloadHash(payload);
  return store.withV30Transaction(identity.sessionId, tx => {
    const replayed = replay(tx, identity, payloadHash);
    if (replayed) return replayed;
    const session = tx.readSession();
    const run = tx.readRun(runId);
    assertRunRevision(run, input.expectedRunRevision);
    assertOrchestrationRevision(session, input.expectedOrchestrationRevision);
    assertSessionRunTransitionAllowed(session.status, run.status, 'completed');
    const stepIndex = session.chain.findIndex(step => step.step_id === run.step_id);
    if (stepIndex < 0) throw new V3StructuredError('INVALID_ARGUMENT', `Run ${runId} references unknown step ${run.step_id}`);
    const nextPendingIndex = session.chain.findIndex((step, index) => index > stepIndex && step.status === 'pending');
    const chain = session.chain.map((step, index) => (
      index === stepIndex ? { ...step, status: 'completed' as const } : step
    ));
    const nextRun: RunV30 = {
      ...transitionRun(run, 'completed'),
      revision: run.revision + 1,
      actor_id: identity.actorId,
      participant_id: identity.participantId,
      verdict: input.verdict,
      summary: required(input.summary, 'summary'),
      ended_at: identity.recordedAt,
    };
    const nextSession = updatedSessionActivity({
      ...session,
      chain,
      active_run_ids: session.active_run_ids.filter(id => id !== runId),
    }, identity.recordedAt, session.orchestration_revision + 1);
    return stageApplied({
      tx, identity, payloadHash, session: nextSession, run: nextRun,
      targetType: 'orchestration', targetId: identity.sessionId,
      revisionBefore: session.orchestration_revision,
      revisionAfter: nextSession.orchestration_revision,
      result: {
        run_id: runId, run_revision: nextRun.revision,
        orchestration_revision: nextSession.orchestration_revision,
        advanced_step_id: nextPendingIndex >= 0 ? chain[nextPendingIndex].step_id : null,
      },
    });
  });
}

export function completeSessionV3(store: SessionStore, input: CompleteSessionV3Input): V3MutationResult {
  const identity = normalizedIdentity(input);
  const payload = {
    operation: 'session-complete', expected_orchestration_revision: input.expectedOrchestrationRevision,
    ...auditPayload(identity),
  };
  const payloadHash = canonicalPayloadHash(payload);
  return store.withV30Transaction(identity.sessionId, tx => {
    const replayed = replay(tx, identity, payloadHash);
    if (replayed) return replayed;
    const session = tx.readSession();
    assertOrchestrationRevision(session, input.expectedOrchestrationRevision);
    const referencedRunIds = [...new Set([
      ...session.active_run_ids,
      ...session.chain.flatMap(step => step.run_ids),
    ])].sort();
    const runs = referencedRunIds.map(runId => tx.readRun(runId));
    const gates = tx.readJson(resolve(store.sessionDir(identity.sessionId), session.gates_ref), gateRegistrySchema);
    const completion: SessionCompletionSnapshot = {
      runs: runs.map(run => ({ runId: run.run_id, status: run.status })),
      blockingGates: Object.entries(gates.gates)
        .filter(([, gate]) => gate.blocking)
        .map(([gateId, gate]) => ({ gateId, status: gate.status })),
      requiredSteps: session.chain.map(step => ({
        stepId: step.step_id,
        status: step.status,
        skipEvidence: step.status === 'skipped' ? step.decision_refs : undefined,
      })),
    };
    assertSessionCanComplete(completion);
    const transitioned = transitionSession(session, 'completed', completion);
    const nextSession = updatedSessionActivity({
      ...transitioned,
      completed_at: identity.recordedAt,
      active_run_ids: [],
    }, identity.recordedAt, session.orchestration_revision + 1);
    return stageApplied({
      tx, identity, payloadHash, session: nextSession,
      targetType: 'orchestration', targetId: identity.sessionId,
      revisionBefore: session.orchestration_revision,
      revisionAfter: nextSession.orchestration_revision,
      result: { status: nextSession.status, orchestration_revision: nextSession.orchestration_revision },
    });
  });
}
