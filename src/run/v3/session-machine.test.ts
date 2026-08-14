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
  decisionGates: [] as Array<{ gateId: string; status: string }>,
};

describe('v3 Session state machine', () => {
  it('exports the session/3.0 transition matrix, including unarchive', () => {
    expect(SESSION_TRANSITIONS).toEqual({
      open: ['completed', 'failed'],
      completed: ['archived'],
      archived: ['open'],
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

  it('allows open Sessions to transition Runs and add evidence', () => {
    expect(() => assertSessionOperationAllowed('open', 'transition_run', { runStatus: 'running' }))
      .not.toThrow();
    expect(() => assertSessionOperationAllowed('open', 'add_evidence')).not.toThrow();
  });

  it.each(['completed', 'archived', 'failed'] as const)('blocks transition_run while the Session is %s', status => {
    expect(() => assertSessionOperationAllowed(status, 'transition_run', { runStatus: 'running' }))
      .toThrowError(expect.objectContaining({
        code: 'INVALID_STATE_TRANSITION',
        details: expect.objectContaining({ reason: 'SESSION_OPERATION_BLOCKED' }),
      }));
  });

  it('allows pending to running while open', () => {
    expect(() => assertSessionOperationAllowed('open', 'transition_run', {
      runStatus: 'pending', nextRunStatus: 'running',
    })).not.toThrow();
  });

  it('combines open Session permissions with Run transition and evidence guards', () => {
    expect(() => assertSessionRunTransitionAllowed('open', 'running', 'completed')).not.toThrow();
    expect(() => assertSessionRunTransitionAllowed('open', 'completed', 'sealed')).not.toThrow();
    expect(() => assertSessionRunTransitionAllowed('open', 'pending', 'running')).not.toThrow();
    expect(() => assertSessionRunTransitionAllowed('open', 'blocked', 'failed'))
      .toThrowError(expect.objectContaining({
        code: 'INVALID_STATE_TRANSITION',
        details: expect.objectContaining({ reason: 'RUN_TRANSITION_EVIDENCE_REQUIRED' }),
      }));
    expect(() => assertSessionRunTransitionAllowed('open', 'blocked', 'failed', {
      reason: 'unrecoverable dependency', evidence: ['evidence/decision.json'],
    })).not.toThrow();
  });

  it('exports a stable permission table for mutation-engine dispatch', () => {
    expect(SESSION_OPERATION_PERMISSIONS).toEqual({
      open: ['create_run', 'advance_chain', 'transition_run', 'add_evidence', 'decide'],
      completed: [],
      archived: [],
      failed: [],
    });
  });

  it.each(['completed', 'failed'] as const)('allows %s Sessions to archive', status => {
    expect(transitionSession({ sessionId: 's-1', status }, 'archived'))
      .toEqual({ sessionId: 's-1', status: 'archived' });
  });

  it('allows unarchive only back to open and keeps other transitions terminal', () => {
    expect(transitionSession({ sessionId: 's-1', status: 'archived' }, 'open'))
      .toEqual({ sessionId: 's-1', status: 'open' });
    for (const status of SESSION_STATUSES) {
      if (status === 'open') continue;
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
      decisionGates: [],
    })).toEqual([
      expect.objectContaining({ kind: 'running_run', id: 'run-1' }),
      expect.objectContaining({ kind: 'blocking_gate', id: 'gate-1' }),
      expect.objectContaining({ kind: 'required_step', id: 'step-1' }),
      expect.objectContaining({ kind: 'required_step', id: 'step-2' }),
    ]);
  });

  it('blocks completion only on open decision gates and ignores resolved/escalated ones', () => {
    expect(listSessionCompletionBlockers({
      runs: [], blockingGates: [], requiredSteps: [],
      decisionGates: [
        { gateId: 'gate-open', status: 'open' },
        { gateId: 'gate-resolved', status: 'resolved' },
        { gateId: 'gate-escalated', status: 'escalated' },
      ],
    })).toEqual([
      expect.objectContaining({ kind: 'open_decision_gate', id: 'gate-open' }),
    ]);
    expect(() => assertSessionCanComplete({
      runs: [], blockingGates: [], requiredSteps: [],
      decisionGates: [{ gateId: 'gate-open', status: 'open' }],
    })).toThrowError(expect.objectContaining({
      code: 'INVALID_STATE_TRANSITION',
      details: expect.objectContaining({
        reason: 'SESSION_COMPLETION_BLOCKED',
        blockers: [expect.objectContaining({ kind: 'open_decision_gate', id: 'gate-open' })],
      }),
      next_actions: ['resolve-open_decision_gate:gate-open'],
    }));
    expect(() => assertSessionCanComplete({
      runs: [], blockingGates: [], requiredSteps: [],
      decisionGates: [
        { gateId: 'gate-resolved', status: 'resolved' },
        { gateId: 'gate-escalated', status: 'escalated' },
      ],
    })).not.toThrow();
  });

  it.each(['open'] as const)(
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

  it('completes an open Session only after every guard passes and preserves the input', () => {
    const session = { sessionId: 's-1', status: 'open' as const, orchestrationRevision: 7 };
    const completed = transitionSession(session, 'completed', cleanCompletion);
    expect(completed).toEqual({ sessionId: 's-1', status: 'completed', orchestrationRevision: 7 });
    expect(session.status).toBe('open');
    expect(() => assertSessionCanComplete(cleanCompletion)).not.toThrow();
  });
});
