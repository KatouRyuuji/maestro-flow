import { describe, expect, it } from 'vitest';

import {
  SESSION_OPERATION_PERMISSIONS,
  SESSION_STATUSES,
  SESSION_TRANSITIONS,
  assertSessionCanComplete,
  assertSessionOperationAllowed,
  assertSessionRunTransitionAllowed,
  listSessionCompletionBlockers,
  transitionSession,
} from './session-machine.js';

const cleanCompletion = {
  runs: [{ runId: 'run-done', status: 'completed' as const }],
  blockingGates: [{ gateId: 'gate-1', status: 'passed' }],
  requiredSteps: [
    { stepId: 'step-1', status: 'completed' as const },
    { stepId: 'step-2', status: 'skipped' as const, skipEvidence: ['evidence/skip.json'] },
  ],
};

describe('v3 Session state machine', () => {
  it('exports the session/3.0 transition matrix, including failure archival', () => {
    expect(SESSION_TRANSITIONS).toEqual({
      open: ['paused', 'completed', 'failed'],
      paused: ['open', 'completed', 'failed'],
      completed: ['archived'],
      archived: [],
      failed: ['archived'],
    });
  });

  it.each(SESSION_STATUSES.flatMap(from => SESSION_STATUSES.map(to => [from, to] as const)))(
    'enforces the transition table for %s -> %s',
    (from, to) => {
      const allowed = SESSION_TRANSITIONS[from].includes(to);
      const operation = () => transitionSession({ status: from }, to, cleanCompletion);
      if (allowed) expect(operation).not.toThrow();
      else expect(operation).toThrowError(expect.objectContaining({
        code: 'INVALID_STATE_TRANSITION',
        details: expect.objectContaining({ reason: 'SESSION_TRANSITION_INVALID' }),
      }));
    },
  );

  it('allows paused running/blocked Run transitions, terminal sealing, and evidence updates', () => {
    expect(() => assertSessionOperationAllowed('paused', 'transition_run', { runStatus: 'running' }))
      .not.toThrow();
    expect(() => assertSessionOperationAllowed('paused', 'transition_run', { runStatus: 'blocked' }))
      .not.toThrow();
    for (const runStatus of ['completed', 'failed', 'cancelled'] as const) {
      expect(() => assertSessionOperationAllowed('paused', 'transition_run', {
        runStatus, nextRunStatus: 'sealed',
      })).not.toThrow();
    }
    expect(() => assertSessionOperationAllowed('paused', 'add_evidence')).not.toThrow();
  });

  it.each(['create_run', 'advance_chain'] as const)('blocks %s while paused', operation => {
    expect(() => assertSessionOperationAllowed('paused', operation))
      .toThrowError(expect.objectContaining({
        code: 'INVALID_STATE_TRANSITION',
        details: expect.objectContaining({ reason: 'SESSION_OPERATION_BLOCKED' }),
      }));
  });

  it.each(['pending', 'completed', 'failed', 'cancelled', 'sealed'] as const)(
    'does not treat a %s Run as an unfinished paused-session work item by default',
    runStatus => expect(() => assertSessionOperationAllowed('paused', 'transition_run', { runStatus }))
      .toThrowError(expect.objectContaining({
        code: 'INVALID_STATE_TRANSITION',
        details: expect.objectContaining({ reason: 'SESSION_OPERATION_BLOCKED' }),
      })),
  );

  it('does not allow pending to running while paused', () => {
    expect(() => assertSessionOperationAllowed('paused', 'transition_run', {
      runStatus: 'pending', nextRunStatus: 'running',
    })).toThrowError(expect.objectContaining({
      code: 'INVALID_STATE_TRANSITION',
      details: expect.objectContaining({ reason: 'SESSION_OPERATION_BLOCKED' }),
    }));
  });

  it('combines paused Session permissions with Run transition and evidence guards', () => {
    expect(() => assertSessionRunTransitionAllowed('paused', 'running', 'completed')).not.toThrow();
    expect(() => assertSessionRunTransitionAllowed('paused', 'completed', 'sealed')).not.toThrow();
    expect(() => assertSessionRunTransitionAllowed('paused', 'pending', 'running'))
      .toThrowError(expect.objectContaining({
        code: 'INVALID_STATE_TRANSITION',
        details: expect.objectContaining({ reason: 'SESSION_OPERATION_BLOCKED' }),
      }));
    expect(() => assertSessionRunTransitionAllowed('paused', 'blocked', 'failed'))
      .toThrowError(expect.objectContaining({
        code: 'INVALID_STATE_TRANSITION',
        details: expect.objectContaining({ reason: 'RUN_TRANSITION_EVIDENCE_REQUIRED' }),
      }));
    expect(() => assertSessionRunTransitionAllowed('paused', 'blocked', 'failed', {
      reason: 'unrecoverable dependency', evidence: ['evidence/decision.json'],
    })).not.toThrow();
  });

  it('exports a stable permission table for mutation-engine dispatch', () => {
    expect(SESSION_OPERATION_PERMISSIONS).toEqual({
      open: ['create_run', 'advance_chain', 'transition_run', 'add_evidence'],
      paused: ['transition_run', 'add_evidence'],
      completed: [],
      archived: [],
      failed: [],
    });
  });

  it.each(['completed', 'failed'] as const)('allows %s Sessions to archive', status => {
    expect(transitionSession({ sessionId: 's-1', status }, 'archived'))
      .toEqual({ sessionId: 's-1', status: 'archived' });
  });

  it('keeps archived Sessions terminal', () => {
    for (const status of SESSION_STATUSES) {
      expect(() => transitionSession({ status: 'archived' }, status, cleanCompletion))
        .toThrowError(expect.objectContaining({
          code: 'INVALID_STATE_TRANSITION',
          details: expect.objectContaining({ reason: 'SESSION_TRANSITION_INVALID' }),
        }));
    }
  });

  it('reports running Run, blocking gate, and required-step blockers together', () => {
    expect(listSessionCompletionBlockers({
      runs: [{ runId: 'run-1', status: 'running' }],
      blockingGates: [{ gateId: 'gate-1', status: 'blocked' }],
      requiredSteps: [
        { stepId: 'step-1', status: 'pending' },
        { stepId: 'step-2', status: 'skipped', skipEvidence: [] },
      ],
    })).toEqual([
      expect.objectContaining({ kind: 'running_run', id: 'run-1' }),
      expect.objectContaining({ kind: 'blocking_gate', id: 'gate-1' }),
      expect.objectContaining({ kind: 'required_step', id: 'step-1' }),
      expect.objectContaining({ kind: 'required_step', id: 'step-2' }),
    ]);
  });

  it.each(['open', 'paused'] as const)(
    'applies identical completion guards while %s',
    status => {
      const blocked = { ...cleanCompletion, runs: [{ runId: 'run-live', status: 'running' as const }] };
      expect(() => transitionSession({ status }, 'completed', blocked))
        .toThrowError(expect.objectContaining({
          code: 'INVALID_STATE_TRANSITION',
          details: expect.objectContaining({ reason: 'SESSION_COMPLETION_BLOCKED' }),
        }));
    },
  );

  it('completes a paused Session only after every guard passes and preserves the input', () => {
    const session = { sessionId: 's-1', status: 'paused' as const, orchestrationRevision: 7 };
    const completed = transitionSession(session, 'completed', cleanCompletion);
    expect(completed).toEqual({ sessionId: 's-1', status: 'completed', orchestrationRevision: 7 });
    expect(session.status).toBe('paused');
    expect(() => assertSessionCanComplete(cleanCompletion)).not.toThrow();
  });
});
