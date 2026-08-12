import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createExecutionState } from './defaults.js';
import { pauseExecution, resumeExecution, sealExecution, startExecution } from './execution.js';
import type { ExecutionLeaseClaim } from './lease.js';
import { sessionStateV20Schema } from './schemas.js';
import {
  createExecutionSealReceipt,
  createSessionArchiveReceipt,
  SessionStore,
} from './store.js';
import { stableJsonUtf8 } from './transition-receipts.js';

const roots: string[] = [];

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'maestro-store-v20-'));
  roots.push(value);
  return value;
}

function enableSessionV20(projectRoot: string): void {
  const workflowRoot = join(projectRoot, '.workflow');
  mkdirSync(workflowRoot, { recursive: true });
  writeFileSync(join(workflowRoot, 'config.json'), `${JSON.stringify({
    session_schema: {
      schema_version: 'session-schema-selection/1.0',
      writer: 'session/2.0',
      features: { session_statusless: true },
    },
  }, null, 2)}\n`);
}

function sha256(value: string | Buffer): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function storedJsonHash(value: unknown): string {
  return sha256(`${JSON.stringify(value, null, 2)}\n`);
}

function claim(value: { lease_claim: {
  owner_id: string;
  owner_kind: ExecutionLeaseClaim['ownerKind'];
  epoch: number;
  lease_id: string;
} }): ExecutionLeaseClaim {
  return {
    ownerId: value.lease_claim.owner_id,
    ownerKind: value.lease_claim.owner_kind,
    epoch: value.lease_claim.epoch,
    leaseId: value.lease_claim.lease_id,
  };
}

afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('SessionStore session/2.0 execution atomics', () => {
  it('selects fresh canonical session/2.0 identity explicitly and keeps absence on session/1.3', () => {
    const legacyRoot = root();
    const legacy = new SessionStore(legacyRoot);
    expect(legacy.createSession('legacy', 'default writer').session.schema_version).toBe('session/1.3');
    expect(legacy.readSessionRecord('legacy').schema_version).toBe('session/1.3');

    const projectRoot = root();
    enableSessionV20(projectRoot);
    const store = new SessionStore(projectRoot);
    const compatibility = store.createSession('fresh-v2', 'statusless identity');
    expect(compatibility.session.schema_version).toBe('session/1.3');
    expect(store.readSessionRecord('fresh-v2')).toEqual({
      schema_version: 'session/2.0',
      session_id: 'fresh-v2',
      intent: 'statusless identity',
      topic_identity: null,
      identity_revision: 1,
      activity_revision: 0,
      current_execution_id: null,
      latest_execution_id: null,
      latest_completed_run_id: null,
      archived_at: null,
      archived_by: null,
    });
    expect(JSON.parse(readFileSync(store.sessionCompatibilityPath('fresh-v2'), 'utf8')))
      .toMatchObject({ schema_version: 'session/1.3', session_id: 'fresh-v2', status: 'running' });
  });

  it('updates pointers, preserves archive identity, enforces activity CAS, and seals with one receipt batch', () => {
    const projectRoot = root();
    enableSessionV20(projectRoot);
    const store = new SessionStore(projectRoot);
    store.createSession('s', 'atomic pointers');

    const executionId = 'execution-001';
    store.createExecutionAtomic('s', (draft) => {
      const execution = createExecutionState(draft.session, {
        executionId,
        generation: 1,
        startedAt: '2026-08-01T00:00:00.000Z',
      });
      draft.session.activity_revision++;
      return { execution, result: null };
    }, { expectedActivityRevision: 0 });
    expect(store.readSessionRecord('s')).toMatchObject({
      schema_version: 'session/2.0',
      activity_revision: 1,
      current_execution_id: executionId,
      latest_execution_id: executionId,
    });

    store.updateExecutionAtomic('s', executionId, 0, (draft, execution) => {
      draft.session.active_run_id = 'run-1';
      draft.session.latest_completed_run_id = 'run-0';
      draft.session.activity_revision++;
      execution.active_run_id = 'run-1';
      execution.revision++;
    }, { expectedActivityRevision: 1 });
    expect(store.readSessionRecord('s')).toMatchObject({
      activity_revision: 2,
      current_execution_id: executionId,
      latest_execution_id: executionId,
      latest_completed_run_id: 'run-0',
    });
    expect(() => store.updateExecutionAtomic('s', executionId, 1, () => undefined, {
      expectedActivityRevision: 1,
    })).toThrow(/session activity revision conflict: expected 1, current 2/);

    const activeArchiveState = sessionStateV20Schema.parse(store.readSessionRecord('s'));
    const activeArchiveReceipt = createSessionArchiveReceipt({
      receipt_id: 'archive-active-rejected',
      operation: 'archive',
      session_id: 's',
      actor: 'operator',
      reason: 'must not archive active authority',
      evidence_refs: ['execution:execution-001'],
      recorded_at: '2026-08-01T01:00:00.000Z',
      before: {
        identity_revision: activeArchiveState.identity_revision,
        activity_revision: activeArchiveState.activity_revision,
        archived_at: activeArchiveState.archived_at,
        archived_by: activeArchiveState.archived_by,
      },
      after: {
        identity_revision: activeArchiveState.identity_revision,
        activity_revision: activeArchiveState.activity_revision + 1,
        archived_at: '2026-08-01T01:00:00.000Z',
        archived_by: 'operator',
      },
      previous_receipt_hash: null,
    });
    expect(() => store.applySessionArchiveReceipt(activeArchiveReceipt))
      .toThrow(/cannot be archived while an Execution is current or open.*execution-001/);
    expect(store.readSessionRecord('s')).toEqual(activeArchiveState);
    expect(store.listSessionArchiveReceipts('s')).toEqual([]);

    store.updateExecutionAtomic('s', executionId, 1, (draft, execution, tx) => {
      draft.session.active_run_id = null;
      draft.session.activity_revision++;
      execution.active_run_id = null;
      execution.status = 'sealed';
      execution.revision++;
      execution.lease = null;
      execution.sealed_at = '2026-08-01T02:00:00.000Z';
      execution.seal_summary = 'complete';
      execution.final_outcome = 'done';
      tx.writeExecutionSealReceipt(executionId, createExecutionSealReceipt({
        session_id: 's',
        execution_id: executionId,
        generation: execution.generation,
        sealed_at: execution.sealed_at,
        execution_revision: execution.revision,
        session_identity_revision: draft.session.identity_revision,
        session_activity_revision: draft.session.activity_revision,
        runs: [],
        chain_snapshot: execution.chain,
        chain_hash: sha256(stableJsonUtf8(execution.chain)),
        gates: {
          clean: true,
          blocking_gate_ids: [],
          registry_revision: draft.gates.revision,
          registry_hash: storedJsonHash(draft.gates),
        },
        artifacts: {
          registry_revision: draft.artifacts.revision,
          registry_hash: storedJsonHash(draft.artifacts),
          content_hashes: {},
        },
        evidence: {
          store_revision: draft.evidence.revision,
          store_hash: storedJsonHash(draft.evidence),
          record_refs: [],
        },
        corpus_refs: [],
      }));
    }, { expectedActivityRevision: 2 });

    const beforeArchive = sessionStateV20Schema.parse(store.readSessionRecord('s'));
    store.applySessionArchiveReceipt(createSessionArchiveReceipt({
      receipt_id: 'archive-000000000004',
      operation: 'archive',
      session_id: 's',
      actor: 'operator',
      reason: 'preservation fence',
      evidence_refs: ['execution:execution-001'],
      recorded_at: '2026-08-01T03:00:00.000Z',
      before: {
        identity_revision: beforeArchive.identity_revision,
        activity_revision: beforeArchive.activity_revision,
        archived_at: beforeArchive.archived_at,
        archived_by: beforeArchive.archived_by,
      },
      after: {
        identity_revision: beforeArchive.identity_revision,
        activity_revision: beforeArchive.activity_revision + 1,
        archived_at: '2026-08-01T03:00:00.000Z',
        archived_by: 'operator',
      },
      previous_receipt_hash: null,
    }));

    expect(store.readSessionRecord('s')).toMatchObject({
      schema_version: 'session/2.0',
      identity_revision: 1,
      activity_revision: 4,
      current_execution_id: null,
      latest_execution_id: executionId,
      latest_completed_run_id: 'run-0',
      archived_at: '2026-08-01T03:00:00.000Z',
      archived_by: 'operator',
    });
    expect(store.readExecution('s', executionId)).toMatchObject({ status: 'sealed', revision: 2 });
    expect(store.readExecutionSealReceipt('s', executionId)).toMatchObject({
      execution_id: executionId,
      execution_revision: 2,
      session_activity_revision: 3,
    });
    const directExecution = createExecutionState(store.readBundle('s').session, {
      executionId: 'execution-002',
      generation: 2,
      startedAt: '2026-08-01T04:00:00.000Z',
    });
    expect(() => store.createExecution(directExecution))
      .toThrow(/Session s is archived; unarchive it before creating an Execution/);
    expect(store.listExecutions('s')).toHaveLength(1);
  });

  it('supports the unchanged downstream Execution lifecycle against fresh session/2.0 identity', () => {
    const projectRoot = root();
    enableSessionV20(projectRoot);
    const store = new SessionStore(projectRoot);
    store.createSession('s', 'downstream lifecycle');

    const started = startExecution(projectRoot, 's', {
      requestId: 'req-start',
      ownerId: 'worker',
      ownerKind: 'codex',
      now: new Date('2026-08-02T00:00:00.000Z'),
    });
    expect(store.readSessionRecord('s')).toMatchObject({
      activity_revision: 1,
      current_execution_id: started.execution.execution_id,
      latest_execution_id: started.execution.execution_id,
    });

    const paused = pauseExecution(projectRoot, {
      sessionId: 's',
      executionId: started.execution.execution_id,
      requestId: 'req-pause',
      expectedExecutionRevision: 1,
      lease: claim(started),
      now: new Date('2026-08-02T01:00:00.000Z'),
    });
    expect(paused.execution.status).toBe('paused');
    expect(store.readSessionRecord('s')).toMatchObject({
      activity_revision: 2,
      current_execution_id: started.execution.execution_id,
    });

    const resumed = resumeExecution(projectRoot, {
      sessionId: 's',
      executionId: started.execution.execution_id,
      requestId: 'req-resume',
      expectedExecutionRevision: 2,
      ownerId: 'worker',
      ownerKind: 'codex',
      now: new Date('2026-08-02T02:00:00.000Z'),
    });
    sealExecution(projectRoot, {
      sessionId: 's',
      executionId: started.execution.execution_id,
      requestId: 'req-seal',
      expectedExecutionRevision: 3,
      lease: claim(resumed),
      summary: 'complete',
      outcome: 'done',
      now: new Date('2026-08-02T02:00:01.000Z'),
    });
    expect(store.readSessionRecord('s')).toMatchObject({
      activity_revision: 4,
      current_execution_id: null,
      latest_execution_id: started.execution.execution_id,
    });
  });

  it('rejects legacy authority writes against canonical session/2.0', () => {
    const projectRoot = root();
    enableSessionV20(projectRoot);
    const store = new SessionStore(projectRoot);
    store.createSession('s', 'strict statusless authority');

    expect(() => store.update('s', draft => {
      draft.session.status = 'paused';
      draft.session.active_run_id = 'legacy-run';
    })).toThrow(/statusless Session\/Execution store primitives/);
    const canonical = store.readSessionRecord('s');
    expect(canonical).not.toHaveProperty('status');
    expect(canonical).not.toHaveProperty('active_run_id');
    expect(() => sessionStateV20Schema.parse({ ...canonical, status: 'paused' })).toThrow();
  });
});
