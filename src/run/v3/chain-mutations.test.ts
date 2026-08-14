import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { SessionStateV30 } from '../schemas.js';
import { SessionStore } from '../store.js';
import { V3StructuredError } from './errors.js';
import { mutateChainV3, type ChainMutation } from './chain-mutations.js';

const roots: string[] = [];

function setup(status: SessionStateV30['status'] = 'open'): SessionStore {
  const root = mkdtempSync(join(tmpdir(), 'maestro-chain-v3-'));
  roots.push(root);
  mkdirSync(join(root, '.workflow'), { recursive: true });
  writeFileSync(join(root, '.workflow', 'config.json'), JSON.stringify({
    session_schema: { schema_version: 'session-schema-selection/1.0', writer: 'session/3.0', features: { session_statusless: false } },
  }));
  const store = new SessionStore(root);
  store.writeSessionV30({
    schema_version: 'session/3.0', session_id: 's-1', objective: 'chain', definition_of_done: 'done', status,
    orchestration_revision: 0, activity_revision: 0,
    chain: [
      { step_id: 'step-1', command: 'implement', args: [], status: 'completed', run_ids: [], goal_ref: null, decision_refs: [] },
      { step_id: 'step-2', command: 'verify', args: [], status: 'pending', run_ids: [], goal_ref: null, decision_refs: [] },
    ],
    decisions: [], active_run_ids: [], artifacts_ref: 'artifacts.json', evidence_ref: 'evidence.json',
    created_at: '2026-08-12T00:00:00.000Z', updated_at: '2026-08-12T00:00:00.000Z', completed_at: null, archived_at: null,
  });
  return store;
}

function mutate(store: SessionStore, requestId: string, mutation: ChainMutation, revision = 0, evidenceRefs: string[] = []) {
  return mutateChainV3(store, {
    sessionId: 's-1', actorId: 'actor', requestId,
    expectedOrchestrationRevision: revision, reason: 'chain change', evidenceRefs,
    recordedAt: '2026-08-12T01:00:00.000Z', mutation,
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('v3 chain mutations', () => {
  it('inserts, replaces, and skips with orchestration/activity revisions', () => {
    const store = setup();
    mutate(store, 'req-insert', { kind: 'insert', stepId: 'step-1b', command: 'review', afterStepId: 'step-1' });
    mutate(store, 'req-replace', { kind: 'replace', stepId: 'step-1b', command: 'audit', args: ['--strict'] }, 1);
    mutate(store, 'req-skip', { kind: 'skip', stepId: 'step-2' }, 2, ['evidence-1']);
    const session = store.readSessionV30('s-1');
    expect(session).toMatchObject({ orchestration_revision: 3, activity_revision: 3 });
    expect(session.chain.map(step => [step.step_id, step.command, step.status])).toEqual([
      ['step-1', 'implement', 'completed'], ['step-1b', 'audit', 'pending'], ['step-2', 'verify', 'skipped'],
    ]);
    expect(session.chain[2].decision_refs).toEqual(['evidence-1']);
  });

  it('replays without another revision increment', () => {
    const store = setup();
    const input: ChainMutation = { kind: 'replace', stepId: 'step-2', command: 'audit' };
    const applied = mutate(store, 'req-replay', input);
    const replayed = mutate(store, 'req-replay', input);
    expect(replayed).toEqual({ status: 'replayed', transition: applied.transition });
    expect(store.readSessionV30('s-1')).toMatchObject({ orchestration_revision: 1, activity_revision: 1 });
  });

  it('rejects stale CAS and non-open mutations without writes', () => {
    const store = setup();
    expect(() => mutate(store, 'req-stale', { kind: 'replace', stepId: 'step-2', command: 'audit' }, 4))
      .toThrow(expect.objectContaining({ code: 'ORCHESTRATION_REVISION_CONFLICT' }));
    expect(store.readSessionV30('s-1')).toMatchObject({ orchestration_revision: 0, activity_revision: 0 });

    const completed = setup('completed');
    expect(() => mutate(completed, 'req-completed', { kind: 'replace', stepId: 'step-2', command: 'audit' }))
      .toThrow(expect.objectContaining({ code: 'INVALID_STATE_TRANSITION' }));
    expect(completed.readRequestReceiptV20('s-1', 'req-completed')).toBeNull();
  });

  it.each(['completed', 'failed', 'skipped'] as const)(
    'rejects skip and replace when the target is %s',
    status => {
      for (const mutation of [
        { kind: 'replace', stepId: 'step-1', command: 'audit' } as const,
        { kind: 'skip', stepId: 'step-1' } as const,
      ]) {
        const store = setup();
        const current = store.readSessionV30('s-1');
        store.writeSessionV30({
          ...current,
          chain: current.chain.map((step, index) => index === 0 ? { ...step, status } : step),
        });
        expect(() => mutate(store, `req-${status}-${mutation.kind}`, mutation, 0, ['evidence-1']))
          .toThrow(expect.objectContaining({ code: 'INVALID_STATE_TRANSITION' }));
        const unchanged = store.readSessionV30('s-1');
        expect(unchanged).toMatchObject({ orchestration_revision: 0, activity_revision: 0 });
        expect(unchanged.chain[0]).toMatchObject({ status, command: 'implement' });
      }
    },
  );

  it('requires evidence to skip and reports protocol-valid errors', () => {
    const store = setup();
    try {
      mutate(store, 'req-no-evidence', { kind: 'skip', stepId: 'step-2' });
      throw new Error('expected failure');
    } catch (error) {
      expect(error).toBeInstanceOf(V3StructuredError);
      expect((error as V3StructuredError).toRunResponseV12ErrorDetail()).toMatchObject({ code: 'INVALID_ARGUMENT' });
    }
  });
});
