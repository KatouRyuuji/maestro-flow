import { describe, expect, it } from 'vitest';

import {
  RUN_STATUSES,
  RUN_TRANSITIONS,
  buildRetryMetadata,
  canRunTransition,
  transitionRun,
  type RunStatus,
} from './run-machine.js';

const allowed = new Set<string>(Object.entries(RUN_TRANSITIONS)
  .flatMap(([from, targets]) => targets.map(to => `${from}->${to}`)));

describe('v3 Run state machine', () => {
  it.each(RUN_STATUSES.flatMap(from => RUN_STATUSES.map(to => [from, to] as const)))(
    'enforces the transition table for %s -> %s',
    (from, to) => {
      const context = from === 'blocked' && to === 'failed'
        ? { reason: 'dependency cannot recover', evidence: ['evidence/decision.json'] }
        : {};
      expect(canRunTransition(from, to, context)).toBe(allowed.has(`${from}->${to}`));
    },
  );

  it('allows pending to cancel without first running', () => {
    expect(transitionRun({ runId: 'r-1', status: 'pending' as RunStatus }, 'cancelled'))
      .toEqual({ runId: 'r-1', status: 'cancelled' });
  });

  it.each([
    {},
    { reason: 'unrecoverable' },
    { evidence: ['evidence/decision.json'] },
    { reason: ' ', evidence: [' '] },
  ])('rejects blocked to failed without both reason and evidence: %j', context => {
    expect(() => transitionRun({ status: 'blocked' as const }, 'failed', context))
      .toThrowError(expect.objectContaining({
        code: 'INVALID_STATE_TRANSITION',
        details: expect.objectContaining({ reason: 'RUN_TRANSITION_EVIDENCE_REQUIRED' }),
      }));
  });

  it('does not mutate the old Run snapshot', () => {
    const oldRun = { runId: 'r-1', status: 'running' as const, revision: 2 };
    const nextRun = transitionRun(oldRun, 'completed');
    expect(nextRun).toEqual({ runId: 'r-1', status: 'completed', revision: 2 });
    expect(oldRun.status).toBe('running');
    expect(nextRun).not.toBe(oldRun);
  });

  it('never revives a failed Run and builds attempt+1 metadata', () => {
    const source = { runId: 'run-old', attempt: 2, status: 'failed' as const };
    expect(() => transitionRun(source, 'running')).toThrowError(expect.objectContaining({
      code: 'INVALID_STATE_TRANSITION',
      details: expect.objectContaining({ reason: 'RUN_TRANSITION_INVALID' }),
    }));
    expect(buildRetryMetadata(source)).toEqual({ retryOfRunId: 'run-old', attempt: 3 });
    expect(source).toEqual({ runId: 'run-old', attempt: 2, status: 'failed' });
  });

  it.each(['needs_retry', 'blocked'] as const)(
    'accepts an explicitly unsuccessful sealed Run with %s verdict',
    verdict => expect(buildRetryMetadata({
      runId: ' run-old ', attempt: 2, status: 'sealed', verdict,
    })).toEqual({ retryOfRunId: 'run-old', attempt: 3 }),
  );

  it.each(['done', 'done_with_concerns'] as const)(
    'rejects a successful sealed Run with %s verdict',
    verdict => expect(() => buildRetryMetadata({
      runId: 'r-1', attempt: 1, status: 'sealed', verdict,
    })).toThrowError(expect.objectContaining({
      code: 'INVALID_STATE_TRANSITION',
      details: expect.objectContaining({ reason: 'RUN_RETRY_INVALID' }),
    })),
  );

  it('rejects sealed retry eligibility without an explicit verdict', () => {
    expect(() => buildRetryMetadata({
      runId: 'r-1', attempt: 1, status: 'sealed',
    } as Parameters<typeof buildRetryMetadata>[0])).toThrowError(expect.objectContaining({
      code: 'INVALID_STATE_TRANSITION',
      details: expect.objectContaining({ reason: 'RUN_RETRY_INVALID' }),
    }));
  });

  it.each(['pending', 'running', 'blocked', 'completed', 'cancelled'] as const)(
    'rejects retry metadata for a %s source Run',
    status => expect(() => buildRetryMetadata({ runId: 'r-1', attempt: 1, status }))
      .toThrowError(expect.objectContaining({
        code: 'INVALID_STATE_TRANSITION',
        details: expect.objectContaining({ reason: 'RUN_RETRY_INVALID' }),
      })),
  );

  it.each([
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
  ])('rejects unsafe or non-positive retry attempt %s', attempt => {
    expect(() => buildRetryMetadata({ runId: 'r-1', attempt, status: 'failed' }))
      .toThrowError(expect.objectContaining({
        code: 'INVALID_STATE_TRANSITION',
        details: expect.objectContaining({ reason: 'RUN_RETRY_INVALID' }),
      }));
  });

  it('rejects a safe source attempt when attempt+1 would be unsafe', () => {
    expect(() => buildRetryMetadata({
      runId: 'r-1', attempt: Number.MAX_SAFE_INTEGER, status: 'failed',
    })).toThrowError(expect.objectContaining({
      code: 'INVALID_STATE_TRANSITION',
      details: expect.objectContaining({ reason: 'RUN_RETRY_INVALID' }),
    }));
  });
});
