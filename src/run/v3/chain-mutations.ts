import type { TransitionReceiptV20 } from '../protocol-schemas.js';
import type { SessionStateV30 } from '../schemas.js';
import { SessionStore } from '../store.js';
import { createRevisionConflictError, V3StructuredError } from './errors.js';
import {
  canonicalPayloadHash,
  createRequestReceipt,
  createTransitionReceipt,
  replayRequestReceipt,
  transitionReceiptRef,
} from './receipts.js';
import { assertSessionOperationAllowed } from './session-machine.js';

type SessionChainStepV30 = SessionStateV30['chain'][number];

export type ChainMutation =
  | { kind: 'insert'; stepId: string; command: string; args?: readonly string[]; afterStepId?: string | null; goalRef?: string | null; stage?: string | null }
  | { kind: 'skip'; stepId: string }
  | { kind: 'replace'; stepId: string; command: string; args?: readonly string[] };

export interface MutateChainV3Input {
  sessionId: string;
  participantId: string;
  actorId: string;
  requestId: string;
  expectedOrchestrationRevision: number;
  reason: string;
  evidenceRefs?: readonly string[];
  recordedAt?: string;
  mutation: ChainMutation;
}

export interface ChainMutationResult {
  status: 'applied' | 'replayed';
  transition: TransitionReceiptV20;
}

function text(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new V3StructuredError('INVALID_ARGUMENT', `${label} is required`);
  return normalized;
}

function mutateSteps(session: SessionStateV30, mutation: ChainMutation, evidence: readonly string[]): SessionChainStepV30[] {
  const stepId = text(mutation.stepId, 'step ID');
  const index = session.chain.findIndex(step => step.step_id === stepId);
  if (mutation.kind === 'insert') {
    if (index >= 0) throw new V3StructuredError('INVALID_STATE_TRANSITION', `chain step ${stepId} already exists`);
    const after = mutation.afterStepId?.trim() || null;
    const insertionIndex = after === null ? session.chain.length : session.chain.findIndex(step => step.step_id === after) + 1;
    if (after !== null && insertionIndex === 0) throw new V3StructuredError('INVALID_ARGUMENT', `unknown after-step ${after}`);
    const step: SessionChainStepV30 = {
      step_id: stepId, command: text(mutation.command, 'command'), args: [...(mutation.args ?? [])],
      status: 'pending', run_ids: [], goal_ref: mutation.goalRef?.trim() || null,
      decision_refs: [], stage: mutation.stage?.trim() || null,
    };
    return [...session.chain.slice(0, insertionIndex), step, ...session.chain.slice(insertionIndex)];
  }
  if (index < 0) throw new V3StructuredError('INVALID_ARGUMENT', `unknown chain step ${stepId}`);
  if (session.chain[index].status !== 'pending') {
    throw new V3StructuredError('INVALID_STATE_TRANSITION', `${mutation.kind} requires pending chain step ${stepId}`);
  }
  if (mutation.kind === 'skip') {
    if (evidence.length === 0) throw new V3StructuredError('INVALID_ARGUMENT', 'skipping a chain step requires evidence');
    return session.chain.map((step, itemIndex) => itemIndex === index
      ? { ...step, status: 'skipped' as const, decision_refs: [...new Set([...step.decision_refs, ...evidence])].sort() }
      : step);
  }
  return session.chain.map((step, itemIndex) => itemIndex === index
    ? { ...step, command: text(mutation.command, 'command'), args: [...(mutation.args ?? [])] }
    : step);
}

export function mutateChainV3(store: SessionStore, input: MutateChainV3Input): ChainMutationResult {
  const sessionId = text(input.sessionId, 'session ID');
  const requestId = text(input.requestId, 'request ID');
  const participantId = text(input.participantId, 'participant ID');
  const actorId = text(input.actorId, 'actor ID');
  const reason = text(input.reason, 'reason');
  const evidenceRefs = [...new Set((input.evidenceRefs ?? []).map(item => item.trim()).filter(Boolean))].sort();
  const recordedAt = input.recordedAt ?? new Date().toISOString();
  const payload = {
    operation: `session-chain-${input.mutation.kind}`,
    expected_orchestration_revision: input.expectedOrchestrationRevision,
    mutation: input.mutation,
    actor_id: actorId,
    reason,
    evidence_refs: evidenceRefs,
  };
  const payloadHash = canonicalPayloadHash(payload);
  return store.withV30Transaction(sessionId, tx => {
    const replayed = replayRequestReceipt({ tx, sessionId, requestId, participantId, payloadHash });
    if (replayed) return { status: 'replayed', transition: replayed };
    const session = tx.readSession();
    if (session.orchestration_revision !== input.expectedOrchestrationRevision) {
      throw createRevisionConflictError({
        code: 'ORCHESTRATION_REVISION_CONFLICT', targetType: 'orchestration', targetId: sessionId,
        expectedRevision: input.expectedOrchestrationRevision, currentRevision: session.orchestration_revision,
        changedBy: 'unknown',
      });
    }
    assertSessionOperationAllowed(session.status, 'advance_chain');
    const chain = mutateSteps(session, input.mutation, evidenceRefs);
    const nextSession: SessionStateV30 = {
      ...session,
      chain,
      orchestration_revision: session.orchestration_revision + 1,
      activity_revision: session.activity_revision + 1,
      updated_at: recordedAt,
    };
    const transition = createTransitionReceipt({
      transitionId: `chain-${requestId}`,
      requestId, sessionId, activityRevision: nextSession.activity_revision,
      targetType: 'orchestration', targetId: sessionId,
      revisionBefore: session.orchestration_revision, revisionAfter: nextSession.orchestration_revision,
      actorId, participantId, reason, evidenceRefs, recordedAt,
      result: { kind: input.mutation.kind, chain },
    });
    const request = createRequestReceipt({
      requestId, participantId, payloadHash,
      transitionReceiptRef: transitionReceiptRef(transition.activity_revision, transition.transition_id),
    });
    tx.writeSession(nextSession);
    tx.writeTransitionReceipt(transition);
    tx.writeRequestReceipt(request);
    return { status: 'applied', transition };
  });
}
