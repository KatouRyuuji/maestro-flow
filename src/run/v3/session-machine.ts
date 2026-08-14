import { V3StructuredError } from './errors.js';
import {
  assertRunTransition,
  type RunStatus,
  type RunTransitionEvidence,
} from './run-machine.js';

export const SESSION_STATUSES = ['open', 'completed', 'archived', 'failed'] as const;
export type SessionStatus = typeof SESSION_STATUSES[number];

export const SESSION_TRANSITIONS: Readonly<Record<SessionStatus, readonly SessionStatus[]>> = {
  open: ['completed', 'failed'],
  completed: ['archived'],
  // archived is not terminal: unarchive returns the Session to open.
  // The archived -> open edge is consumed by `session unarchive` only;
  // there is no separate unarchive operation permission because it is a
  // state transition, not an operation (SESSION_OPERATION_PERMISSIONS stays []).
  archived: ['open'],
  failed: ['archived'],
};

export type SessionOperation = 'create_run' | 'advance_chain' | 'transition_run' | 'add_evidence' | 'decide';

export const SESSION_OPERATION_PERMISSIONS: Readonly<Record<SessionStatus, readonly SessionOperation[]>> = {
  open: ['create_run', 'advance_chain', 'transition_run', 'add_evidence', 'decide'],
  completed: [],
  archived: [],
  failed: [],
};

export interface SessionStateSnapshot {
  status: SessionStatus;
}

export interface SessionRunOperationContext {
  runStatus?: RunStatus;
  nextRunStatus?: RunStatus;
}

export interface SessionCompletionRun {
  runId: string;
  status: RunStatus;
}

export interface SessionCompletionGate {
  gateId: string;
  status: string;
}

export interface SessionCompletionStep {
  stepId: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
  skipEvidence?: readonly string[];
}

export interface SessionCompletionSnapshot {
  runs: readonly SessionCompletionRun[];
  blockingGates: readonly SessionCompletionGate[];
  requiredSteps: readonly SessionCompletionStep[];
  /** Decision gates declared on chain steps (step.decision_ref → decisions[] status). */
  decisionGates: readonly SessionCompletionGate[];
}

export type SessionCompletionBlocker =
  | { kind: 'running_run'; id: string; message: string }
  | { kind: 'blocking_gate'; id: string; message: string }
  | { kind: 'required_step'; id: string; message: string }
  | { kind: 'open_decision_gate'; id: string; message: string };

export function assertSessionOperationAllowed(
  status: SessionStatus,
  operation: SessionOperation,
  context: SessionRunOperationContext = {},
): void {
  if (!SESSION_OPERATION_PERMISSIONS[status].includes(operation)) {
    throw new V3StructuredError('INVALID_STATE_TRANSITION', `${operation} is not allowed while Session is ${status}`, {
      details: { reason: 'SESSION_OPERATION_BLOCKED', session_status: status, operation },
      target_type: 'orchestration',
      next_actions: [],
    });
  }
}

export function assertSessionRunTransitionAllowed(
  sessionStatus: SessionStatus,
  from: RunStatus,
  to: RunStatus,
  evidence: RunTransitionEvidence = {},
): void {
  assertSessionOperationAllowed(sessionStatus, 'transition_run', {
    runStatus: from,
    nextRunStatus: to,
  });
  assertRunTransition(from, to, evidence);
}

function hasSkipEvidence(step: SessionCompletionStep): boolean {
  return step.skipEvidence?.some(reference => reference.trim().length > 0) ?? false;
}

export function listSessionCompletionBlockers(
  snapshot: SessionCompletionSnapshot,
): SessionCompletionBlocker[] {
  const runningRuns: SessionCompletionBlocker[] = snapshot.runs
    .filter(run => run.status === 'running')
    .map(run => ({
      kind: 'running_run', id: run.runId, message: `Run ${run.runId} is still running`,
    }));
  const gates: SessionCompletionBlocker[] = snapshot.blockingGates
    .filter(gate => gate.status !== 'passed')
    .map(gate => ({
      kind: 'blocking_gate', id: gate.gateId,
      message: `blocking gate ${gate.gateId} is ${gate.status}, expected passed`,
    }));
  // v3 has no gate evaluation channel today; this blocker stays defensive
  // (gates.json is only initialized empty and migrated, never evaluated/written
  // by v3 mutations; bridge/UI still consume gates.json).
  const steps: SessionCompletionBlocker[] = snapshot.requiredSteps
    .filter(step => step.status !== 'completed' && !(step.status === 'skipped' && hasSkipEvidence(step)))
    .map(step => ({
      kind: 'required_step', id: step.stepId,
      message: step.status === 'skipped'
        ? `required step ${step.stepId} was skipped without evidence`
        : `required step ${step.stepId} is ${step.status}`,
    }));
  // Open decision gates block completion: a declared gate whose decision is
  // still open is an unresolved correction point. Escalated gates deliberately
  // do NOT block here — completion records them as concerns instead.
  const decisionGates: SessionCompletionBlocker[] = snapshot.decisionGates
    .filter(gate => gate.status === 'open')
    .map(gate => ({
      kind: 'open_decision_gate', id: gate.gateId,
      message: `open decision gate ${gate.gateId} must be resolved before completing`,
    }));
  return [...runningRuns, ...gates, ...steps, ...decisionGates];
}

export function assertSessionCanComplete(snapshot: SessionCompletionSnapshot): void {
  const blockers = listSessionCompletionBlockers(snapshot);
  if (blockers.length === 0) return;
  throw new V3StructuredError('INVALID_STATE_TRANSITION', blockers.map(blocker => blocker.message).join('; '), {
    details: { reason: 'SESSION_COMPLETION_BLOCKED', blockers },
    target_type: 'orchestration',
    next_actions: blockers.map(blocker => `resolve-${blocker.kind}:${blocker.id}`),
  });
}

export function assertSessionTransition(
  from: SessionStatus,
  to: SessionStatus,
  completion?: SessionCompletionSnapshot,
): void {
  if (!SESSION_TRANSITIONS[from].includes(to)) {
    throw new V3StructuredError('INVALID_STATE_TRANSITION', `Session cannot transition from ${from} to ${to}`, {
      details: { reason: 'SESSION_TRANSITION_INVALID', from_status: from, to_status: to },
      target_type: 'orchestration',
      next_actions: SESSION_TRANSITIONS[from].map(status => `transition-to:${status}`),
    });
  }
  if (to === 'completed') {
    if (completion === undefined) {
      throw new V3StructuredError('INVALID_STATE_TRANSITION', 'Session completion snapshot is required', {
        details: { reason: 'SESSION_COMPLETION_BLOCKED' },
        target_type: 'orchestration', next_actions: ['load-completion-snapshot'],
      });
    }
    assertSessionCanComplete(completion);
  }
}

export function transitionSession<T extends SessionStateSnapshot, S extends SessionStatus>(
  session: T,
  to: S,
  completion?: SessionCompletionSnapshot,
): Omit<T, 'status'> & { status: S } {
  assertSessionTransition(session.status, to, completion);
  return { ...session, status: to };
}
