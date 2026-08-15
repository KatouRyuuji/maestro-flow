import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createExecutionState } from './defaults.js';
import { pauseExecution, resumeExecution, sealExecution, startExecution } from './execution.js';
import type { ExecutionLeaseClaim } from './lease.js';
import { requestReceiptV20Schema } from './protocol-schemas.js';
import { sessionStateV20Schema, type RunV30, type SessionStateV30 } from './schemas.js';
import {
  createExecutionSealReceipt,
  createSessionArchiveReceipt,
  SessionStore,
} from './store.js';
import { stableJsonUtf8 } from './transition-receipts.js';

function v2Workspace(root: string): void {
  mkdirSync(join(root, ".workflow"), { recursive: true });
  writeFileSync(join(root, ".workflow", "config.json"), JSON.stringify({
    session_schema: { schema_version: "session-schema-selection/1.0", writer: "session/1.3", features: { session_statusless: false } },
  }));
}

const roots: string[] = [];

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'maestro-store-v20-'));

  v2Workspace(value);
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

function enableSessionV30(projectRoot: string): void {
  const workflowRoot = join(projectRoot, '.workflow');
  mkdirSync(workflowRoot, { recursive: true });
  writeFileSync(join(workflowRoot, 'config.json'), `${JSON.stringify({
    session_schema: {
      schema_version: 'session-schema-selection/1.0',
      writer: 'session/3.0',
      features: { session_statusless: false },
    },
  }, null, 2)}\n`);
}

function sessionV30(sessionId = 's-v3'): SessionStateV30 {
  return {
    schema_version: 'session/3.0', session_id: sessionId,
    objective: 'W1 storage contract', definition_of_done: 'focused tests pass', status: 'open',
    orchestration_revision: 0, activity_revision: 0,
    chain: [], decisions: [], active_run_ids: [],
    artifacts_ref: 'artifacts.json', evidence_ref: 'evidence.json',
    created_at: '2026-08-12T00:00:00.000Z', updated_at: '2026-08-12T00:00:00.000Z',
    completed_at: null, archived_at: null,
  };
}

function runV30(sessionId = 's-v3', runId = 'run-v3'): RunV30 {
  return {
    schema_version: 'run/3.0', run_id: runId, session_id: sessionId, step_id: 'step-1',
    parent_run_id: null, retry_of_run_id: null, attempt: 1,
    command: 'implement', args: [], goal: null, status: 'pending', revision: 0,
    actor_id: 'codex', input_refs: [], output_refs: [],
    primary_artifact_id: null, verdict: null, summary: null,
    legacy_execution_generation: null,
    created_at: '2026-08-12T00:00:00.000Z', started_at: null, ended_at: null, sealed_at: null,
  };
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

describe('SessionStore session/3.0 W1 boundaries', () => {
  it('selects v3 writer paths, reads/writes strict v3 entities, and fails legacy mutation closed', () => {
    const projectRoot = root();
    enableSessionV30(projectRoot);
    const store = new SessionStore(projectRoot);
    const session = sessionV30();
    const run = runV30();

    expect(store.sessionSchemaSelection().writer).toBe('session/3.0');
    expect(() => store.createSession('legacy-entry', 'must use v3 engine'))
      .toThrow(/reserved for the v3 Session mutation engine/);

    const legacyRoot = root();
    const legacyStore = new SessionStore(legacyRoot);
    legacyStore.createSession(session.session_id, 'legacy authority');
    enableSessionV30(legacyRoot);
    expect(() => legacyStore.writeSessionV30(session)).toThrow(/requires the migration engine/);
    expect(legacyStore.readSessionRecord(session.session_id).schema_version).toBe('session/1.3');

    store.writeSessionV30(session);
    expect(store.readSessionRecord(session.session_id)).toEqual(session);
    expect(store.readSessionV30(session.session_id)).toEqual(session);
    store.writeRunV30(run);
    expect(store.readRunRecord(session.session_id, run.run_id)).toEqual(run);
    expect(store.readRunV30(session.session_id, run.run_id)).toEqual(run);

    expect(store.receiptsDir(session.session_id)).toBe(join(
      projectRoot, '.workflow', 'sessions', session.session_id, 'receipts',
    ));
    expect(store.requestReceiptV20Path(session.session_id, 'req-1')).toBe(join(
      projectRoot, '.workflow', 'sessions', session.session_id, 'receipts', 'requests', 'req-1.json',
    ));
    expect(store.transitionReceiptV20Path(session.session_id, 7, 'tr-1')).toBe(join(
      projectRoot, '.workflow', 'sessions', session.session_id,
      'receipts', 'transitions', '000000000007-tr-1.json',
    ));
    expect(store.readRequestReceiptV20(session.session_id, 'missing')).toBeNull();
    expect(store.readTransitionReceiptV20(session.session_id, 1, 'missing')).toBeNull();

    const nextSession = { ...session, activity_revision: 1, updated_at: '2026-08-12T00:01:00.000Z' };
    const nextRun = { ...run, status: 'running' as const, revision: 1, started_at: '2026-08-12T00:01:00.000Z' };
    const transition = {
      schema_version: 'transition-receipt/2.0' as const,
      transition_id: 'tr-1', request_id: 'req-1', session_id: session.session_id,
      activity_revision: 1, target_type: 'run' as const, target_id: run.run_id,
      revision_before: 0, revision_after: 1,
      actor_id: 'codex', participant_id: 'pi-window-a', reason: 'start', evidence_refs: [],
      recorded_at: '2026-08-12T00:01:00.000Z', result: { status: 'running' },
    };
    const request = {
      schema_version: 'request-receipt/2.0' as const,
      request_id: 'req-1', participant_id: 'pi-window-a',
      payload_hash: `sha256:${'a'.repeat(64)}`,
      transition_receipt_ref: 'receipts/transitions/000000000001-tr-1.json',
    };
    store.withV30Transaction(session.session_id, tx => {
      tx.writeSession(nextSession);
      tx.writeRun(nextRun);
      tx.writeTransitionReceipt(transition);
      tx.writeRequestReceipt(request);
    });
    expect(store.readSessionV30(session.session_id).activity_revision).toBe(1);
    expect(store.readRunV30(session.session_id, run.run_id)).toMatchObject({ status: 'running', revision: 1 });
    expect(store.readRequestReceiptV20(session.session_id, request.request_id)).toEqual(request);
    expect(store.readTransitionReceiptV20(session.session_id, 1, transition.transition_id)).toEqual(transition);

    let invoked = false;
    let error: unknown;
    try {
      store.update(session.session_id, () => { invoked = true; });
    } catch (caught) {
      error = caught;
    }
    expect(invoked).toBe(false);
    expect(error).toMatchObject({ code: 'SESSION_SCHEMA_UNSUPPORTED' });
    expect(() => store.readBundle(session.session_id))
      .toThrow(/legacy Session\/Execution mutations are unsupported/);
    expect(() => store.readRun(session.session_id, run.run_id))
      .toThrowError(expect.objectContaining({ code: 'SESSION_SCHEMA_UNSUPPORTED' }));
    expect(JSON.parse(readFileSync(join(store.sessionDir(session.session_id), 'session.json'), 'utf8')))
      .toEqual(nextSession);
  });

  it('rejects Session and Run writes through pre-existing symlink or junction parents', () => {
    const projectRoot = root();
    const outside = root();
    enableSessionV30(projectRoot);
    const store = new SessionStore(projectRoot);
    mkdirSync(join(projectRoot, '.workflow', 'sessions'), { recursive: true });
    const sessionLink = store.sessionDir('victim');
    symlinkSync(outside, sessionLink, process.platform === 'win32' ? 'junction' : 'dir');
    expect(() => store.writeSessionV30(sessionV30('victim'))).toThrow(/Unsafe transaction write parent/);
    expect(() => statSync(join(outside, 'session.json'))).toThrow();

    rmSync(sessionLink, { recursive: true, force: true });
    store.writeSessionV30(sessionV30('safe'));
    const runsRoot = join(store.sessionDir('safe'), 'runs');
    mkdirSync(runsRoot, { recursive: true });
    const runLink = join(runsRoot, 'hijack');
    symlinkSync(outside, runLink, process.platform === 'win32' ? 'junction' : 'dir');
    expect(() => store.writeRunV30(runV30('safe', 'hijack'))).toThrow(/Unsafe transaction write parent/);
    expect(() => statSync(join(outside, 'run.json'))).toThrow();
  });

  it('validates receipt canonical identity and refuses immutable receipt replacement', () => {
    const projectRoot = root();
    enableSessionV30(projectRoot);
    const store = new SessionStore(projectRoot);
    store.writeSessionV30(sessionV30());
    const transition = {
      schema_version: 'transition-receipt/2.0' as const,
      transition_id: 'tr-immutable', request_id: 'req-immutable', session_id: 's-v3',
      activity_revision: 1, target_type: 'run' as const, target_id: 'run-v3',
      revision_before: 0, revision_after: 1, actor_id: 'actor', participant_id: 'p-1',
      reason: 'test', evidence_refs: [], recorded_at: '2026-08-12T00:01:00.000Z', result: { ok: true },
    };
    const request = {
      schema_version: 'request-receipt/2.0' as const,
      request_id: 'req-immutable', participant_id: 'p-1', payload_hash: `sha256:${'a'.repeat(64)}`,
      transition_receipt_ref: 'receipts/transitions/000000000001-tr-immutable.json',
    };
    store.withV30Transaction('s-v3', tx => {
      tx.writeTransitionReceipt(transition);
      tx.writeRequestReceipt(request);
    });
    expect(() => store.withV30Transaction('s-v3', tx => tx.writeRequestReceipt({
      ...request, payload_hash: `sha256:${'b'.repeat(64)}`,
    }))).toThrow(/request receipt is immutable/);
    expect(() => store.withV30Transaction('s-v3', tx => tx.writeTransitionReceipt({
      ...transition, result: { ok: false },
    }))).toThrow(/transition receipt is immutable/);

    expect(() => store.withV30Transaction('s-v3', tx => {
      tx.writeRequestReceipt(request);
      tx.writeRequestReceipt({ ...request, payload_hash: `sha256:${'b'.repeat(64)}` });
    })).toThrow(/request receipt is immutable/);
    expect(() => store.withV30Transaction('s-v3', tx => {
      tx.writeTransitionReceipt(transition);
      tx.writeTransitionReceipt({ ...transition, result: { ok: false } });
    })).toThrow(/transition receipt is immutable/);

    expect(() => store.withV30Transaction('s-v3', tx => tx.writeJson(
      store.requestReceiptV20Path('s-v3', 'req-bypass'), request, requestReceiptV20Schema,
    ))).toThrow(/cannot target immutable receipt paths/);

    const aliasPath = store.requestReceiptV20Path('s-v3', 'req-alias');
    mkdirSync(join(store.receiptsDir('s-v3'), 'requests'), { recursive: true });
    writeFileSync(aliasPath, `${JSON.stringify(request, null, 2)}\n`);
    expect(() => store.readRequestReceiptV20('s-v3', 'req-alias')).toThrow(/canonical path/);
  });
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
