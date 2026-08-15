import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from './store.js';
import { pauseExecution, startExecution } from './execution.js';
import { archiveSession } from './session-transition.js';
import { createExecutionRun } from './runtime.js';
import { recallRuns } from './recall.js';
import { runRecallSchema } from './protocol-schemas.js';

function v2Workspace(root: string): void {
  mkdirSync(join(root, ".workflow"), { recursive: true });
  writeFileSync(join(root, ".workflow", "config.json"), JSON.stringify({
    session_schema: { schema_version: "session-schema-selection/1.0", writer: "session/1.3", features: { session_statusless: false } },
  }));
}

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function enableV20(projectRoot: string): void {
  mkdirSync(join(projectRoot, '.workflow'), { recursive: true });
  writeFileSync(join(projectRoot, '.workflow', 'config.json'), JSON.stringify({
    session_schema: {
      schema_version: 'session-schema-selection/1.0',
      writer: 'session/2.0',
      features: { session_statusless: true },
    },
  }));
  mkdirSync(join(projectRoot, '.claude', 'commands'), { recursive: true });
  writeFileSync(join(projectRoot, '.claude', 'commands', 'demo.md'), '# Demo\n');
}

function executionClaim(started: ReturnType<typeof startExecution>) {
  return {
    ownerId: started.lease_claim.owner_id,
    ownerKind: started.lease_claim.owner_kind,
    epoch: started.lease_claim.epoch,
    leaseId: started.lease_claim.lease_id,
  };
}

describe('read-only run recall', () => {
  it('uses command-independent Unicode topic identity and preserves authority mtimes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'maestro-recall-')); roots.push(root);

    v2Workspace(root);
    const store = new SessionStore(root);
    store.createSession('live', '修复 Unicode intent', { command: 'demo' });
    const sessionPath = join(store.sessionDir('live'), 'session.json');
    const before = statSync(sessionPath).mtimeMs;
    const result = await recallRuns(root, { command: 'other-command', intent: '修复 Unicode intent', topic: '  修复 Unicode intent  ', asOf: '2026-07-19T00:00:00.000Z' });
    expect(runRecallSchema.parse(result).recommendation).toMatchObject({ action: null, automatic: false, reason_codes: ['READ_ONLY_TOPIC_MATCH'] });
    expect(result.exact_candidates.map(item => item.session_id)).toEqual(['live']);
    expect(result.topic_identity?.normalized).toBe('修复 unicode intent');
    expect(result.confirmation).toEqual({ required: false, issuance_command: '', allowed_actions: [] });
    expect(result.next.command).toBeNull();
    expect(result.historical_candidates).toEqual([]);
    expect(JSON.stringify(result)).not.toMatch(/recall-confirm|maestro session resume|maestro run (?:fork|import|new)/);
    expect(statSync(sessionPath).mtimeMs).toBe(before);
  });

  it('derives live session/2.0 lifecycle from canonical identity and current Execution authority', async () => {
    const root = mkdtempSync(join(tmpdir(), 'maestro-recall-')); roots.push(root);

    v2Workspace(root);
    enableV20(root);
    const store = new SessionStore(root);
    for (const id of ['idle', 'runnable', 'executing', 'blocked', 'archived']) {
      store.createSession(id, 'shared v2 topic', { command: 'demo' });
    }

    const runnable = startExecution(root, 'runnable', {
      requestId: 'start-runnable', ownerId: 'manual-runnable', ownerKind: 'manual',
    });
    const executing = startExecution(root, 'executing', {
      requestId: 'start-executing', ownerId: 'manual-executing', ownerKind: 'manual',
    });
    const executingRun = createExecutionRun({
      projectRoot: root,
      command: 'demo',
      sessionId: 'executing',
      intent: 'shared v2 topic',
      executionId: executing.execution.execution_id,
      generation: executing.execution.generation,
      expectedExecutionRevision: executing.execution.revision,
      executionLease: executionClaim(executing),
      requestId: 'create-executing',
    });
    const blocked = startExecution(root, 'blocked', {
      requestId: 'start-blocked', ownerId: 'manual-blocked', ownerKind: 'manual',
    });
    pauseExecution(root, {
      sessionId: 'blocked',
      executionId: blocked.execution.execution_id,
      requestId: 'pause-blocked',
      expectedExecutionRevision: blocked.execution.revision,
      lease: executionClaim(blocked),
    });
    archiveSession(root, 'archived', {
      requestId: 'archive-session',
      actor: 'test',
      reason: 'historical identity',
      evidence: ['evidence/archive.json'],
      expectedIdentityRevision: 1,
      expectedActivityRevision: 0,
    });

    const result = await recallRuns(root, {
      command: 'demo', intent: 'shared v2 topic', asOf: '2026-07-19T00:00:00.000Z',
    });
    expect(result.exact_candidates.map(candidate => candidate.session_id).sort()).toEqual([
      'blocked', 'executing', 'idle', 'runnable',
    ]);
    expect(result.exact_candidates.find(candidate => candidate.session_id === 'idle')?.exclusions)
      .toContain('DERIVED_IDLE');
    expect(result.exact_candidates.find(candidate => candidate.session_id === 'runnable')?.exclusions)
      .toContain('DERIVED_RUNNABLE');
    expect(result.exact_candidates.find(candidate => candidate.session_id === 'executing')).toMatchObject({
      active_run_id: executingRun.run_id,
      exclusions: expect.arrayContaining(['DERIVED_EXECUTING', 'ACTIVE_RUN_PRESENT']),
    });
    expect(result.exact_candidates.find(candidate => candidate.session_id === 'blocked')).toMatchObject({
      status: 'paused',
      exclusions: expect.arrayContaining(['DERIVED_BLOCKED']),
    });
    expect(result.recommendation).toMatchObject({ candidate_id: null, automatic: false });
    expect(store.readSessionRecord('archived')).toMatchObject({
      schema_version: 'session/2.0', archived_at: expect.any(String),
    });
    expect(store.readBundle('archived').session.status).toBe('running');
  });

  it('rejects mutation-capable recommendation shapes', () => {
    expect(runRecallSchema.safeParse({ schema_version: 'run-recall/1.0', recommendation: { automatic: true } }).success).toBe(false);
  });

  it('keeps multiple exact live Sessions ambiguous and emits no confirmation mutation surface', async () => {
    const root = mkdtempSync(join(tmpdir(), 'maestro-recall-')); roots.push(root);

    v2Workspace(root);
    const store = new SessionStore(root);
    store.createSession('a', 'same intent', { command: 'demo' });
    store.createSession('b', 'same intent', { command: 'demo' });
    const result = await recallRuns(root, { command: 'demo', intent: 'same intent', asOf: '2026-07-19T00:00:00.000Z' });
    expect(result.exact_candidates).toHaveLength(2);
    expect(result.recommendation).toMatchObject({ action: null, candidate_id: null, automatic: false, reason_codes: ['AMBIGUOUS_TOPIC_MATCH'] });
    expect(result.confirmation).toEqual({ required: false, issuance_command: '', allowed_actions: [] });
    expect(result.next.command).toBeNull();
  });

  it('does not select or emit a mutation pointer for a paused Session', async () => {
    const root = mkdtempSync(join(tmpdir(), 'maestro-recall-')); roots.push(root);

    v2Workspace(root);
    const store = new SessionStore(root);
    store.createSession('paused', 'paused intent', { command: 'demo' });
    store.update('paused', draft => { draft.session.status = 'paused'; });
    const result = await recallRuns(root, { command: 'demo', intent: 'paused intent', asOf: '2026-07-19T00:00:00.000Z' });
    expect(result.exact_candidates).toEqual([]);
    expect(result.recommendation.reason_codes).toEqual(['NO_RUNNING_TOPIC_MATCH']);
    expect(result.next.command).toBeNull();
    expect(JSON.stringify(result)).not.toContain('maestro session resume');
  });
});
