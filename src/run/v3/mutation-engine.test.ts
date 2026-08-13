import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { RunV30, SessionStateV30 } from '../schemas.js';
import { SessionStore } from '../store.js';
import { V3StructuredError } from './errors.js';
import {
  completeRunAndAdvance,
  completeSessionV3,
  createRunV3,
  createRunningRunV3,
  mutateRunV3,
} from './mutation-engine.js';

const roots: string[] = [];

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'maestro-v3-mutation-'));
  roots.push(value);
  mkdirSync(join(value, '.workflow'), { recursive: true });
  writeFileSync(join(value, '.workflow', 'config.json'), `${JSON.stringify({
    session_schema: {
      schema_version: 'session-schema-selection/1.0',
      writer: 'session/3.0',
      features: { session_statusless: false },
    },
  }, null, 2)}\n`);
  return value;
}

function session(status: SessionStateV30['status'] = 'open'): SessionStateV30 {
  return {
    schema_version: 'session/3.0', session_id: 's-1', objective: 'v3 mutation', definition_of_done: 'tests pass',
    status, identity_revision: 1, orchestration_revision: 0, activity_revision: 0,
    chain: [
      { step_id: 'step-1', command: 'implement', args: [], status: 'running', run_ids: ['r-1'], goal_ref: null, decision_refs: [] },
      { step_id: 'step-2', command: 'verify', args: [], status: 'pending', run_ids: ['r-2'], goal_ref: null, decision_refs: [] },
    ],
    decisions: [], active_run_ids: ['r-1', 'r-2'], gates_ref: 'gates.json', artifacts_ref: 'artifacts.json', evidence_ref: 'evidence.json',
    created_at: '2026-08-12T00:00:00.000Z', updated_at: '2026-08-12T00:00:00.000Z', completed_at: null, archived_at: null,
  };
}

function run(runId: string, stepId: string, status: RunV30['status'] = 'running'): RunV30 {
  return {
    schema_version: 'run/3.0', run_id: runId, session_id: 's-1', step_id: stepId,
    parent_run_id: null, retry_of_run_id: null, attempt: 1, command: 'work', args: [], goal: null,
    status, revision: 0, actor_id: 'actor-a', participant_id: 'p-a', gate_refs: [], input_refs: [], output_refs: [],
    primary_artifact_id: null, verdict: null, summary: null, legacy_execution_generation: null,
    created_at: '2026-08-12T00:00:00.000Z', started_at: status === 'running' ? '2026-08-12T00:00:00.000Z' : null,
    ended_at: null, sealed_at: null,
  };
}

function setup(status: SessionStateV30['status'] = 'open'): SessionStore {
  const store = new SessionStore(root());
  store.writeSessionV30(session(status));
  writeFileSync(join(store.sessionDir('s-1'), 'gates.json'), `${JSON.stringify({
    schema_version: 'gates/1.0', revision: 0, gates: {},
    summary: { total: 0, passed: 0, blocked: 0, failed: 0, active_gate_ids: [], blocking_run_id: null },
  }, null, 2)}\n`);
  store.writeRunV30(run('r-1', 'step-1'));
  store.writeRunV30(run('r-2', 'step-2'));
  return store;
}

function identity(requestId: string, participantId = 'p-a') {
  return {
    sessionId: 's-1', requestId, participantId, actorId: 'actor-a', reason: 'test mutation',
    recordedAt: '2026-08-12T01:00:00.000Z',
  };
}

afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('v3 mutation engine', () => {
  it('mutates different Runs without CAS interference and blindly increments activity', async () => {
    const store = setup();
    const [first, second] = await Promise.all([
      Promise.resolve().then(() => mutateRunV3(store, {
        ...identity('req-r1'), runId: 'r-1', expectedRunRevision: 0, toStatus: 'blocked',
      })),
      Promise.resolve().then(() => mutateRunV3(store, {
        ...identity('req-r2', 'p-b'), actorId: 'actor-b', runId: 'r-2', expectedRunRevision: 0, toStatus: 'blocked',
      })),
    ]);
    expect(first.status).toBe('applied');
    expect(second.status).toBe('applied');
    expect(store.readRunV30('s-1', 'r-1').revision).toBe(1);
    expect(store.readRunV30('s-1', 'r-2').revision).toBe(1);
    expect(store.readSessionV30('s-1').activity_revision).toBe(2);
  });

  it('allows only one same-Run mutation for the same expected revision', async () => {
    const store = setup();
    const results = await Promise.allSettled([
      Promise.resolve().then(() => mutateRunV3(store, {
        ...identity('req-a'), runId: 'r-1', expectedRunRevision: 0, toStatus: 'blocked',
      })),
      Promise.resolve().then(() => mutateRunV3(store, {
        ...identity('req-b', 'p-b'), actorId: 'actor-b', runId: 'r-1', expectedRunRevision: 0, toStatus: 'cancelled',
      })),
    ]);
    expect(results.filter(item => item.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find(item => item.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(V3StructuredError);
    expect((rejected.reason as V3StructuredError).toJSON()).toMatchObject({
      code: 'RUN_REVISION_CONFLICT', expected_revision: 0, current_revision: 1,
    });
    expect(store.readSessionV30('s-1').activity_revision).toBe(1);
  });

  it('replays the original receipt without another activity increment', () => {
    const store = setup();
    const input = { ...identity('req-replay'), runId: 'r-1', expectedRunRevision: 0, toStatus: 'blocked' as const };
    const applied = mutateRunV3(store, input);
    const replayed = mutateRunV3(store, input);
    expect(replayed).toEqual({ status: 'replayed', transition: applied.transition });
    expect(store.readSessionV30('s-1').activity_revision).toBe(1);
  });

  it('treats changed audit inputs as request conflicts', () => {
    const store = setup();
    const input = { ...identity('req-audit'), runId: 'r-1', expectedRunRevision: 0, toStatus: 'blocked' as const };
    mutateRunV3(store, input);
    for (const changed of [
      { ...input, actorId: 'actor-b' },
      { ...input, reason: 'different reason' },
      { ...input, evidenceRefs: ['evidence-2'] },
    ]) {
      expect(() => mutateRunV3(store, changed))
        .toThrow(expect.objectContaining({ code: 'REQUEST_CONFLICT' }));
    }
    expect(store.readSessionV30('s-1').activity_revision).toBe(1);
  });

  it('rejects the same request across participants and leaves state unchanged', () => {
    const store = setup();
    const base = { ...identity('req-conflict'), runId: 'r-1', expectedRunRevision: 0, toStatus: 'blocked' as const };
    mutateRunV3(store, base);
    expect(() => mutateRunV3(store, { ...base, participantId: 'p-b' }))
      .toThrow(expect.objectContaining({ code: 'REQUEST_CONFLICT' }));
    expect(store.readSessionV30('s-1').activity_revision).toBe(1);
  });

  it.each([
    ['failed', 'failed'],
    ['cancelled', 'pending'],
  ] as const)('projects a running Run transitioned to %s into recoverable chain state %s', (runStatus, stepStatus) => {
    const store = setup();
    const result = mutateRunV3(store, {
      ...identity(`req-${runStatus}`), runId: 'r-1', expectedRunRevision: 0, toStatus: runStatus,
      verdict: runStatus === 'failed' ? 'needs_retry' : undefined,
    });
    expect(result.transition).toMatchObject({ revision_before: 0, revision_after: 1 });
    expect(store.readRunV30('s-1', 'r-1')).toMatchObject({ status: runStatus, revision: 1 });
    expect(store.readSessionV30('s-1')).toMatchObject({
      orchestration_revision: 1, activity_revision: 1, active_run_ids: ['r-2'],
      chain: [{ status: stepStatus }, { status: 'pending' }],
    });
  });

  it('validates and derives retry lineage from locked source state', () => {
    const store = setup();
    mutateRunV3(store, {
      ...identity('req-source-failed'), runId: 'r-1', expectedRunRevision: 0,
      toStatus: 'failed', verdict: 'needs_retry',
    });
    const result = createRunningRunV3(store, {
      ...identity('req-retry'), expectedOrchestrationRevision: 1,
      run: { ...run('r-3', 'step-1', 'pending'), retry_of_run_id: 'r-1', attempt: 2 },
    });
    expect(result.status).toBe('applied');
    expect(store.readRunV30('s-1', 'r-3')).toMatchObject({
      status: 'running', revision: 1, retry_of_run_id: 'r-1', attempt: 2,
    });
    expect(store.readSessionV30('s-1')).toMatchObject({
      orchestration_revision: 2, chain: [{ status: 'running', run_ids: ['r-1', 'r-3'] }, { status: 'pending' }],
    });
  });

  it('rejects forged retry attempts atomically', () => {
    const store = setup();
    mutateRunV3(store, {
      ...identity('req-source-forged'), runId: 'r-1', expectedRunRevision: 0,
      toStatus: 'failed', verdict: 'needs_retry',
    });
    const before = store.readSessionV30('s-1');
    expect(() => createRunningRunV3(store, {
      ...identity('req-forged-retry'), expectedOrchestrationRevision: 1,
      run: { ...run('r-3', 'step-1', 'pending'), retry_of_run_id: 'r-1', attempt: 9 },
    })).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
    expect(store.readSessionV30('s-1')).toEqual(before);
    expect(store.readRequestReceiptV20('s-1', 'req-forged-retry')).toBeNull();
    expect(() => store.readRunV30('s-1', 'r-3')).toThrow();
  });

  it('rejects invalid and cross-step retry sources inside the transaction', () => {
    const invalidStore = setup();
    const invalidBefore = invalidStore.readSessionV30('s-1');
    expect(() => createRunningRunV3(invalidStore, {
      ...identity('req-invalid-source'), expectedOrchestrationRevision: 0,
      run: { ...run('r-3', 'step-1', 'pending'), retry_of_run_id: 'r-1', attempt: 2 },
    })).toThrow(expect.objectContaining({ code: 'INVALID_STATE_TRANSITION' }));
    expect(invalidStore.readSessionV30('s-1')).toEqual(invalidBefore);

    const crossStepStore = setup();
    mutateRunV3(crossStepStore, {
      ...identity('req-cross-source-failed'), runId: 'r-1', expectedRunRevision: 0,
      toStatus: 'failed', verdict: 'needs_retry',
    });
    const crossStepBefore = crossStepStore.readSessionV30('s-1');
    expect(() => createRunningRunV3(crossStepStore, {
      ...identity('req-cross-step'), expectedOrchestrationRevision: 1,
      run: { ...run('r-3', 'step-2', 'pending'), retry_of_run_id: 'r-1', attempt: 2 },
    })).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
    expect(crossStepStore.readSessionV30('s-1')).toEqual(crossStepBefore);
    expect(crossStepStore.readRequestReceiptV20('s-1', 'req-cross-step')).toBeNull();
  });

  it('replays Run creation when only server-generated timestamps differ', () => {
    const store = setup();
    const first = createRunningRunV3(store, {
      ...identity('req-create-replay'), expectedOrchestrationRevision: 0,
      run: { ...run('r-3', 'step-2', 'pending'), created_at: '2026-08-12T01:00:00.000Z' },
    });
    const replayed = createRunningRunV3(store, {
      ...identity('req-create-replay'), expectedOrchestrationRevision: 0,
      run: { ...run('r-3', 'step-2', 'pending'), created_at: '2026-08-12T02:00:00.000Z' },
    });
    expect(replayed).toEqual({ status: 'replayed', transition: first.transition });
    expect(store.readRunV30('s-1', 'r-3').created_at).toBe('2026-08-12T01:00:00.000Z');
    expect(store.readSessionV30('s-1')).toMatchObject({ orchestration_revision: 1, activity_revision: 1 });
  });

  it('rejects reuse of an existing terminal Run ID without changing its bytes', () => {
    const store = setup();
    const existing = { ...run('r-1', 'step-1', 'sealed'), revision: 4, verdict: 'done' as const,
      summary: 'immutable', ended_at: '2026-08-12T00:10:00.000Z', sealed_at: '2026-08-12T00:11:00.000Z' };
    store.writeRunV30(existing);
    const before = store.readRunV30('s-1', 'r-1');
    expect(() => createRunV3(store, {
      ...identity('req-reuse-id'), expectedOrchestrationRevision: 0, run: run('r-1', 'step-1', 'pending'),
    })).toThrow(expect.objectContaining({ code: 'INVALID_STATE_TRANSITION' }));
    expect(store.readRunV30('s-1', 'r-1')).toEqual(before);
    expect(store.readSessionV30('s-1').activity_revision).toBe(0);
  });

  it('rejects Run creation while paused but permits an existing Run to complete its current step', () => {
    const store = setup('paused');
    const candidate = run('r-3', 'step-2', 'pending');
    expect(() => createRunV3(store, {
      ...identity('req-create'), expectedOrchestrationRevision: 0, run: candidate,
    })).toThrow(expect.objectContaining({ code: 'INVALID_STATE_TRANSITION' }));
    const completed = completeRunAndAdvance(store, {
      ...identity('req-complete'), runId: 'r-1', expectedRunRevision: 0,
      expectedOrchestrationRevision: 0, summary: 'done', verdict: 'done',
    });
    expect(completed.status).toBe('applied');
    expect(store.readRunV30('s-1', 'r-1').status).toBe('completed');
    expect(store.readSessionV30('s-1')).toMatchObject({
      status: 'paused', orchestration_revision: 1,
      chain: [{ status: 'completed' }, { status: 'pending' }],
    });
  });

  it('completes a Run and advances the chain in one transaction', () => {
    const store = setup();
    const result = completeRunAndAdvance(store, {
      ...identity('req-complete-advance'), runId: 'r-1', expectedRunRevision: 0,
      expectedOrchestrationRevision: 0, summary: 'implemented', verdict: 'done',
    });
    expect(result.status).toBe('applied');
    expect(store.readRunV30('s-1', 'r-1')).toMatchObject({ status: 'completed', revision: 1 });
    expect(store.readSessionV30('s-1')).toMatchObject({
      orchestration_revision: 1, activity_revision: 1, active_run_ids: ['r-2'],
      chain: [{ status: 'completed' }, { status: 'pending' }],
    });
  });

  it('does not half-commit when complete-and-advance validation fails', () => {
    const store = setup();
    expect(() => completeRunAndAdvance(store, {
      ...identity('req-fail'), runId: 'r-1', expectedRunRevision: 0,
      expectedOrchestrationRevision: 99, summary: 'implemented', verdict: 'done',
    })).toThrow(expect.objectContaining({ code: 'ORCHESTRATION_REVISION_CONFLICT' }));
    expect(store.readRunV30('s-1', 'r-1')).toMatchObject({ status: 'running', revision: 0 });
    expect(store.readSessionV30('s-1')).toMatchObject({ orchestration_revision: 0, activity_revision: 0 });
    expect(store.readRequestReceiptV20('s-1', 'req-fail')).toBeNull();
  });

  it('derives Session completion blockers from locked authority instead of caller input', () => {
    const store = setup();
    expect(() => completeSessionV3(store, {
      ...identity('req-session-blocked'), expectedOrchestrationRevision: 0,
    })).toThrow(expect.objectContaining({ code: 'INVALID_STATE_TRANSITION' }));
    expect(store.readSessionV30('s-1')).toMatchObject({ status: 'open', orchestration_revision: 0, activity_revision: 0 });
    expect(store.readRequestReceiptV20('s-1', 'req-session-blocked')).toBeNull();
  });

  it('completes a Session atomically when locked authority has no blockers', () => {
    const store = setup();
    const current = store.readSessionV30('s-1');
    store.writeSessionV30({
      ...current,
      chain: current.chain.map(step => ({ ...step, status: 'completed' })),
      active_run_ids: [],
    });
    for (const [runId, stepId] of [['r-1', 'step-1'], ['r-2', 'step-2']] as const) {
      store.writeRunV30({
        ...run(runId, stepId, 'sealed'), revision: 2, verdict: 'done', summary: 'done',
        ended_at: '2026-08-12T00:02:00.000Z', sealed_at: '2026-08-12T00:03:00.000Z',
      });
    }
    const result = completeSessionV3(store, {
      ...identity('req-session-complete'), expectedOrchestrationRevision: 0,
    });
    expect(result.status).toBe('applied');
    expect(store.readSessionV30('s-1')).toMatchObject({
      status: 'completed', orchestration_revision: 1, activity_revision: 1,
      completed_at: '2026-08-12T01:00:00.000Z',
    });
  });
});
