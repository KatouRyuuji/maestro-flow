import { V3StructuredError } from './errors.js';

export const RUN_STATUSES = [
  'pending', 'running', 'blocked', 'completed', 'failed', 'cancelled', 'sealed',
] as const;

export type RunStatus = typeof RUN_STATUSES[number];

export const RUN_TRANSITIONS: Readonly<Record<RunStatus, readonly RunStatus[]>> = {
  pending: ['running', 'cancelled'],
  running: ['completed', 'failed', 'blocked', 'cancelled'],
  blocked: ['running', 'failed', 'cancelled'],
  completed: ['sealed'],
  failed: ['sealed'],
  cancelled: ['sealed'],
  sealed: [],
};

export interface RunTransitionEvidence {
  reason?: string;
  evidence?: readonly string[];
}

export interface RunStateSnapshot {
  status: RunStatus;
}

export type RunVerdict = 'done' | 'done_with_concerns' | 'needs_retry' | 'blocked';

interface RetrySourceRunBase {
  runId: string;
  attempt: number;
}

export type RetrySourceRun = RetrySourceRunBase & (
  | { status: Exclude<RunStatus, 'sealed'>; verdict?: never }
  | { status: 'sealed'; verdict: RunVerdict | null }
);

export interface RetryMetadata {
  retryOfRunId: string;
  attempt: number;
}

function hasText(value: string | undefined): boolean {
  return value !== undefined && value.trim().length > 0;
}

function hasEvidence(value: readonly string[] | undefined): boolean {
  return value !== undefined && value.some(item => item.trim().length > 0);
}

export function assertRunTransition(
  from: RunStatus,
  to: RunStatus,
  context: RunTransitionEvidence = {},
): void {
  if (!RUN_TRANSITIONS[from].includes(to)) {
    throw new V3StructuredError('INVALID_STATE_TRANSITION', `Run cannot transition from ${from} to ${to}`, {
      details: { reason: 'RUN_TRANSITION_INVALID', from_status: from, to_status: to },
      target_type: 'run',
      next_actions: RUN_TRANSITIONS[from].map(status => `transition-to:${status}`),
    });
  }
  if (from === 'blocked' && to === 'failed'
    && (!hasText(context.reason) || !hasEvidence(context.evidence))) {
    throw new V3StructuredError(
      'INVALID_STATE_TRANSITION',
      'blocked to failed requires a non-empty reason and at least one evidence reference',
      {
        details: { reason: 'RUN_TRANSITION_EVIDENCE_REQUIRED', from_status: from, to_status: to },
        target_type: 'run',
        next_actions: ['attach-reason', 'attach-evidence', 'resume-run'],
      },
    );
  }
}

export function canRunTransition(
  from: RunStatus,
  to: RunStatus,
  context: RunTransitionEvidence = {},
): boolean {
  try {
    assertRunTransition(from, to, context);
    return true;
  } catch (error) {
    if (error instanceof V3StructuredError) return false;
    throw error;
  }
}

export function transitionRun<T extends RunStateSnapshot, S extends RunStatus>(
  run: T,
  to: S,
  context: RunTransitionEvidence = {},
): Omit<T, 'status'> & { status: S } {
  assertRunTransition(run.status, to, context);
  return { ...run, status: to };
}

export function assertRetrySource(run: RetrySourceRun): void {
  if (!hasText(run.runId)) {
    throw new V3StructuredError('INVALID_STATE_TRANSITION', 'retry source Run ID is required', {
      details: { reason: 'RUN_RETRY_INVALID' },
      target_type: 'run', next_actions: ['select-failed-run'],
    });
  }
  if (!Number.isSafeInteger(run.attempt) || run.attempt < 1) {
    throw new V3StructuredError('INVALID_STATE_TRANSITION', 'retry source attempt must be a positive safe integer', {
      details: { reason: 'RUN_RETRY_INVALID', attempt: run.attempt },
      target_type: 'run', target_id: run.runId, next_actions: ['reload-run'],
    });
  }
  if (!Number.isSafeInteger(run.attempt + 1)) {
    throw new V3StructuredError('INVALID_STATE_TRANSITION', 'retry source attempt cannot be incremented safely', {
      details: { reason: 'RUN_RETRY_INVALID', attempt: run.attempt },
      target_type: 'run', target_id: run.runId, next_actions: ['repair-run-attempt'],
    });
  }
  const failedSealedSource = run.status === 'sealed'
    && (run.verdict === 'needs_retry' || run.verdict === 'blocked');
  if (run.status !== 'failed' && !failedSealedSource) {
    throw new V3StructuredError('INVALID_STATE_TRANSITION', `cannot retry a Run in ${run.status} state`, {
      details: { reason: 'RUN_RETRY_INVALID', run_status: run.status },
      target_type: 'run', target_id: run.runId, next_actions: ['finish-current-run'],
    });
  }
}

export function buildRetryMetadata(run: RetrySourceRun): RetryMetadata {
  assertRetrySource(run);
  return { retryOfRunId: run.runId.trim(), attempt: run.attempt + 1 };
}
