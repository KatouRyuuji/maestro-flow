import { randomUUID } from 'node:crypto';

import type { TransitionReceiptV20 } from '../protocol-schemas.js';
import type { SessionStateV30 } from '../schemas.js';
import { assertSafePathSegment } from '../ids.js';
import type { SessionStore, SessionV30StoreTransaction } from '../store.js';
import { createRevisionConflictError, V3StructuredError } from './errors.js';
import type { V3MutationIdentity, V3MutationResult } from './mutation-engine.js';
import {
  canonicalPayloadHash,
  createRequestReceipt,
  createTransitionReceipt,
  replayRequestReceipt,
  transitionReceiptRef,
} from './receipts.js';
import {
  assertSessionOperationAllowed,
} from './session-machine.js';

export type DecideV3Verdict = 'proceed' | 'fix' | 'escalate';
export type DecideV3Confidence = 'high' | 'medium' | 'low';

export interface DecideV3Input extends V3MutationIdentity {
  pointId: string;
  verdict: DecideV3Verdict;
  confidence: DecideV3Confidence;
  summary?: string | null;
  expectedOrchestrationRevision: number;
  afterStepId?: string | null;
}

const VERDICTS: readonly DecideV3Verdict[] = ['proceed', 'fix', 'escalate'];
const CONFIDENCES: readonly DecideV3Confidence[] = ['high', 'medium', 'low'];

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
  const actorId = required(input.actorId, 'actor ID');
  assertSafePathSegment(sessionId, 'session ID');
  assertSafePathSegment(requestId, 'request ID');
  return {
    sessionId,
    requestId,
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

function assertRevision(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new V3StructuredError('INVALID_ARGUMENT', `${label} must be a non-negative safe integer`);
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
    // participant_id = actor_id on receipts; the replay key is actor-based.
    participantId: identity.actorId,
    payloadHash,
  });
  return transition ? { status: 'replayed', transition } : null;
}

function stageApplied(input: {
  tx: SessionV30StoreTransaction;
  identity: ReturnType<typeof normalizedIdentity>;
  payloadHash: string;
  session: SessionStateV30;
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
    participantId: input.identity.actorId,
    reason: input.identity.reason,
    evidenceRefs: input.identity.evidenceRefs,
    recordedAt: input.identity.recordedAt,
    result: input.result,
  });
  const reference = transitionReceiptRef(transition.activity_revision, transition.transition_id);
  const request = createRequestReceipt({
    requestId: input.identity.requestId,
    participantId: input.identity.actorId,
    payloadHash: input.payloadHash,
    transitionReceiptRef: reference,
  });
  input.tx.writeSession(input.session);
  input.tx.writeTransitionReceipt(transition);
  input.tx.writeRequestReceipt(request);
  return { status: 'applied', transition };
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

function decisionStatusForVerdict(verdict: DecideV3Verdict): 'resolved' | 'escalated' {
  return verdict === 'escalate' ? 'escalated' : 'resolved';
}

/**
 * Record a decision point verdict against a session/3.0 Session authority.
 *
 * Shared by `decideV3` (standalone mutation) and `completeRunAndAdvance`
 * (chain-proposal decide operations, applied atomically inside the same
 * transaction). It owns the decisions-array upsert, the chain step
 * decision_refs linkage, and the verdict → status / status transition
 * mapping. It deliberately does NOT stage transactions, CAS revisions, or
 * receipts — callers own those (plus the payload hash for replay identity).
 *
 * Verdict semantics:
 *   proceed/fix → decision ref becomes `resolved`, Session stays `open`
 *   escalate    → decision ref becomes `escalated`, Session stays in its
 *                 current status (no pause). Chain advancement past a gate
 *                 stays blocked until the decision is re-decided to
 *                 proceed/fix (enforced by the run next gate check in
 *                 mutation-engine.ts).
 */
export function applyV3DecisionRecord(
  session: SessionStateV30,
  input: {
    pointId: string;
    verdict: DecideV3Verdict;
    confidence: DecideV3Confidence;
    summary?: string | null;
    evidenceRefs?: string[];
    afterStepId?: string | null;
  },
): { session: SessionStateV30; decisionStatus: 'resolved' | 'escalated' } {
  const pointId = required(input.pointId, 'decision point ID');
  if (!VERDICTS.includes(input.verdict)) {
    throw new V3StructuredError('INVALID_ARGUMENT', 'verdict must be proceed, fix, or escalate');
  }
  if (!CONFIDENCES.includes(input.confidence)) {
    throw new V3StructuredError('INVALID_ARGUMENT', 'confidence must be high, medium, or low');
  }
  const verdict = input.verdict;
  const afterStepId = input.afterStepId?.trim() || null;

  const stepIndex = afterStepId
    ? session.chain.findIndex(step => step.step_id === afterStepId)
    : session.chain.findIndex(step => step.status === 'pending');
  if (afterStepId && stepIndex < 0) {
    throw new V3StructuredError('INVALID_ARGUMENT', `unknown chain step ${afterStepId}`);
  }
  const afterStepIdResolved = stepIndex >= 0 ? session.chain[stepIndex].step_id : null;

  const decisionStatus = decisionStatusForVerdict(verdict);
  const evidenceRefs = [...new Set((input.evidenceRefs ?? []).map(item => item.trim()).filter(Boolean))].sort();
  const existing = session.decisions.find(decision => decision.decision_id === pointId);
  const decisions = existing
    ? session.decisions.map(decision => decision.decision_id === pointId
      ? {
          ...decision,
          status: decisionStatus,
          evidence_refs: [...new Set([...decision.evidence_refs, ...evidenceRefs])].sort(),
        }
      : decision)
    : [...session.decisions, {
        decision_id: pointId,
        after_step_id: afterStepIdResolved,
        status: decisionStatus,
        evidence_refs: evidenceRefs,
      }];
  const chain = stepIndex >= 0
    ? session.chain.map((step, index) => index === stepIndex
      ? { ...step, decision_refs: [...new Set([...step.decision_refs, pointId])].sort() }
      : step)
    : session.chain;

  const nextSession = { ...session, decisions, chain };
  return { session: nextSession, decisionStatus };
}

/**
 * Record a decision point verdict against a session/3.0 Session.
 *
 * Mirrors `completeRunAndAdvance` from mutation-engine.ts: normalized identity,
 * canonical payload hash, one locked withV30Transaction, request-receipt replay
 * idempotency, orchestration-revision CAS, then one staged transition receipt.
 * The decisions array upsert and the chain step decision_refs linkage commit
 * together with the receipt, so replays never re-apply.
 *
 * Verdict semantics:
 *   proceed/fix → decision ref becomes `resolved`, Session stays `open`
 *   escalate    → decision ref becomes `escalated`, Session stays in its
 *                 current status (no pause). Chain advancement past a gate
 *                 stays blocked until the decision is re-decided.
 */
export function decideV3(store: SessionStore, input: DecideV3Input): V3MutationResult {
  const identity = normalizedIdentity(input);
  const pointId = required(input.pointId, 'decision point ID');
  const verdict = input.verdict;
  const afterStepId = input.afterStepId?.trim() || null;
  const payload = {
    operation: 'run-decide', point_id: pointId, verdict,
    confidence: input.confidence,
    summary: input.summary?.trim() || null,
    expected_orchestration_revision: input.expectedOrchestrationRevision,
    after_step_id: afterStepId,
    ...auditPayload(identity),
  };
  const payloadHash = canonicalPayloadHash(payload);
  return store.withV30Transaction(identity.sessionId, tx => {
    const replayed = replay(tx, identity, payloadHash);
    if (replayed) return replayed;
    const session = tx.readSession();
    assertOrchestrationRevision(session, input.expectedOrchestrationRevision);
    assertSessionOperationAllowed(session.status, 'decide');

    const applied = applyV3DecisionRecord(session, {
      pointId,
      verdict,
      confidence: input.confidence,
      summary: input.summary,
      evidenceRefs: identity.evidenceRefs,
      afterStepId,
    });
    const decisionStatus = applied.decisionStatus;
    const nextSession = updatedSessionActivity(
      applied.session,
      identity.recordedAt,
      session.orchestration_revision + 1,
    );

    return stageApplied({
      tx, identity, payloadHash, session: nextSession,
      targetType: 'orchestration', targetId: identity.sessionId,
      revisionBefore: session.orchestration_revision,
      revisionAfter: nextSession.orchestration_revision,
      result: {
        point_id: pointId,
        status: decisionStatus,
        orchestration_revision: nextSession.orchestration_revision,
        next: {
          suggest_only: true,
          command: verdict === 'escalate'
            ? `maestro run decide ${pointId} --verdict proceed`
            : `maestro run next --session ${identity.sessionId}`,
          reason: verdict === 'escalate'
            ? 'Decision escalated — Session stays open; re-decide once the blocker is resolved (run next stays blocked until the decision is resolved)'
            : 'Decision recorded — run next may advance the chain',
        },
      },
    });
  });
}
