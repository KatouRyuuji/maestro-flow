// session/1.3 migration + schema compat.
// Covers: session/1.0 read→write round-trip is lossless (version bumps to 1.3,
// original fields survive); migrateSession folds ralph-meta into orchestration;
// idempotency; running-step rejection; step_details → chain step mapping;
// completion_*/context are never carried; verification_ledger stays in ralph-meta.

import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRun, completeRun, sealSession } from './runtime.js';
import { attachExecution, sealExecution, startExecution } from './execution.js';
import { buildSourceFence } from './recall.js';
import { sessionStateSchema } from './schemas.js';
import {
  SessionStore,
  createExecutionSealReceipt,
  createSessionArchiveReceipt,
} from './store.js';
import { migrateSession } from './migrate.js';

function v2Workspace(root: string): void {
  mkdirSync(join(root, ".workflow"), { recursive: true });
  writeFileSync(join(root, ".workflow", "config.json"), JSON.stringify({
    session_schema: { schema_version: "session-schema-selection/1.0", writer: "session/1.3", features: { session_statusless: false } },
  }));
}

let tmpRoot: string;

function sessionDir(sessionId: string): string {
  return join(tmpRoot, '.workflow', 'sessions', sessionId);
}

interface WriteSessionOpts {
  version?: 'session/1.0' | 'session/1.1';
  engine?: string;
  chain?: unknown[];
  status?: string;
}

function writeSession(sessionId: string, opts: WriteSessionOpts = {}): void {
  const dir = sessionDir(sessionId);
  mkdirSync(join(dir, 'runs'), { recursive: true });
  const session = {
    schema_version: opts.version ?? 'session/1.0',
    session_id: sessionId,
    intent: 'test intent',
    status: opts.status ?? 'running',
    identity_revision: 1,
    activity_revision: 0,
    active_run_id: null,
    latest_completed_run_id: null,
    boundary_contract: { in_scope: [], out_of_scope: [], constraints: [], definition_of_done: '' },
    orchestration: {
      engine: opts.engine ?? 'ralph',
      quality_mode: 'standard',
      auto_mode: false,
      chain: opts.chain ?? [],
      decision_points: [],
    },
    requests: [],
    lifecycle: { sealed_at: null, seal_summary: null, promoted_spec_ids: [], promoted_knowhow_ids: [], forked_from: null },
    refs: { gates: 'gates.json', artifacts: 'artifacts.json', evidence: 'evidence.json' },
  };
  const gates = { schema_version: 'gates/1.0', revision: 0, gates: {}, summary: { total: 0, passed: 0, blocked: 0, failed: 0, active_gate_ids: [], blocking_run_id: null } };
  const artifacts = { schema_version: 'artifacts/1.0', revision: 0, artifacts: {}, aliases: {} };
  const evidence = { schema_version: 'evidence/1.0', revision: 0, records: {} };
  writeFileSync(join(dir, 'session.json'), JSON.stringify(session, null, 2));
  writeFileSync(join(dir, 'gates.json'), JSON.stringify(gates, null, 2));
  writeFileSync(join(dir, 'artifacts.json'), JSON.stringify(artifacts, null, 2));
  writeFileSync(join(dir, 'evidence.json'), JSON.stringify(evidence, null, 2));
  writeFileSync(join(dir, 'events.ndjson'), '');
  writeFileSync(join(dir, 'context.md'), '# test\n');
}

function enableSessionV20(): void {
  const workflowRoot = join(tmpRoot, '.workflow');
  mkdirSync(workflowRoot, { recursive: true });
  writeFileSync(join(workflowRoot, 'config.json'), JSON.stringify({
    session_schema: {
      schema_version: 'session-schema-selection/1.0',
      writer: 'session/2.0',
      features: { session_statusless: true },
    },
  }, null, 2));
}

function sha256(value: string | Buffer): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function commandFile(name = 'migration-empty'): void {
  const directory = join(tmpRoot, '.claude', 'commands');
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, `${name}.md`), [
    '<contract>',
    'consumes: []',
    'produces: []',
    'gates: { entry: [], exit: [] }',
    '</contract>',
  ].join('\n'));
}

function writeRalphMeta(sessionId: string, meta: unknown): void {
  writeFileSync(join(sessionDir(sessionId), 'ralph-meta.json'), JSON.stringify(meta, null, 2));
}

function readSessionRaw(sessionId: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(sessionDir(sessionId), 'session.json'), 'utf-8'));
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'session-migrate-'));
  v2Workspace(tmpRoot);
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('session/1.0 read compatibility', () => {
  it('parses a session/1.0 file and materializes null orchestration blocks', () => {
    const sessionId = 'compat-read';
    writeSession(sessionId, { version: 'session/1.0' });
    const store = new SessionStore(tmpRoot);
    const session = store.readBundle(sessionId).session;
    expect(session.schema_version).toBe('session/1.3');
    expect(session.intent_identity).toBeNull();
    expect(session.provenance.source).toBe('legacy-inferred');
    expect(session.orchestration.position).toBeNull();
    expect(session.orchestration.decomposition).toBeNull();
    expect(session.orchestration.lease).toBeNull();
    expect(session.orchestration.executor).toBeNull();
  });

  it('round-trips session/1.0 → 1.3 losslessly (original fields survive, version bumps)', () => {
    const sessionId = 'compat-roundtrip';
    const chain = [
      { step_id: 'step-000-analyze', command: 'maestro-analyze', status: 'completed', run_id: 'run-1', inserted_by: 'build', decision_ref: null },
    ];
    writeSession(sessionId, { version: 'session/1.0', chain });
    const store = new SessionStore(tmpRoot);
    // Any mutation triggers write-back at session/1.3.
    store.update(sessionId, (draft) => { draft.session.activity_revision++; return null; });

    const raw = readSessionRaw(sessionId);
    expect(raw.schema_version).toBe('session/1.3');
    expect((raw.provenance as Record<string, unknown>).source).toBe('legacy-inferred');
    expect(raw.intent).toBe('test intent');
    const orch = raw.orchestration as Record<string, unknown>;
    const writtenChain = orch.chain as Array<Record<string, unknown>>;
    expect(writtenChain[0].step_id).toBe('step-000-analyze');
    expect(writtenChain[0].command).toBe('maestro-analyze');
    expect(writtenChain[0].run_id).toBe('run-1');
    // Re-parse to confirm the written file is schema-valid.
    expect(() => sessionStateSchema.parse(raw)).not.toThrow();
  });
});

describe('migrateSession', () => {
  const fullChain = [
    { step_id: 'step-000-analyze', command: 'maestro-analyze', status: 'completed', run_id: 'run-1', inserted_by: 'build', decision_ref: null },
    { step_id: 'step-001-plan', command: 'maestro-plan', status: 'pending', run_id: null, inserted_by: 'build', decision_ref: null },
  ];

  const fullMeta = {
    lifecycle_position: 'plan',
    phase: 2,
    phase_is_new: true,
    milestone: 'M-alpha',
    planning_mode: 'unified',
    passed_gates: ['entry', 'scope'],
    scope_verdict: 'medium',
    execution_criteria: ['builds green', 'tests pass'],
    task_decomposition: [
      { id: 'G1', goal: 'ship migrate', status: 'pending' },
    ],
    goal_changelog: [
      {
        id: 'CHG-001', timestamp: '2026-07-16T00:00:00Z', change_type: 'add', reason: 'init',
        before: { goals: [] }, after: { goals: [{ id: 'G1', goal: 'ship migrate' }] },
      },
    ],
    execution_owner: 'ralph-execute',
    owner_epoch: 3,
    lease_id: 'lease-xyz',
    platform: 'claude',
    cli_tool: 'claude',
    context: { plan_dir: '/tmp/plan', analyze_macro_id: 'AM-1' },
    protocol_version: '2',
    verification_ledger: [
      { authority: 'verify', dimension: 'unit', subject_ids: ['G1'], evidence_hashes: {}, scope_hash: 'h', verdict: 'pass', confidence: 'high', risk_ceiling: 'low', created_at: '2026-07-16T00:00:00Z' },
    ],
    step_details: {
      'step-000-analyze': {
        args: '--depth deep', stage: 'analysis', goal_ref: 'G1', retry_count: 1, max_retries: 3,
        completion_status: 'DONE', completion_summary: 'analysis done', completion_evidence: 'evi.md',
      },
      'step-001-plan': {
        args: '', stage: 'plan', goal_ref: null,
      },
    },
  };

  it('folds ralph-meta into orchestration blocks and maps step_details onto chain steps', () => {
    const sessionId = 'migrate-full';
    writeSession(sessionId, { version: 'session/1.0', chain: fullChain });
    writeRalphMeta(sessionId, fullMeta);

    const result = migrateSession(tmpRoot, sessionId);
    expect(result.status).toBe('migrated');
    expect(result.had_ralph_meta).toBe(true);
    expect(result.mapped_steps).toBe(2);

    const session = new SessionStore(tmpRoot).readBundle(sessionId).session;
    expect(session.schema_version).toBe('session/1.3');

    expect(session.orchestration.position).toEqual({
      lifecycle: 'plan', phase: 2, phase_is_new: true, milestone: 'M-alpha',
      planning_mode: 'unified', passed_gates: ['entry', 'scope'], scope_verdict: 'medium',
    });
    expect(session.orchestration.decomposition?.execution_criteria).toEqual(['builds green', 'tests pass']);
    expect(session.orchestration.decomposition?.goals[0].id).toBe('G1');
    expect(session.orchestration.decomposition?.changelog[0].id).toBe('CHG-001');
    expect(session.orchestration.lease).toEqual({ owner: 'ralph-execute', epoch: 3, id: 'lease-xyz' });
    expect(session.orchestration.executor).toEqual({ platform: 'claude', cli_tool: 'claude' });

    const step0 = session.orchestration.chain[0];
    expect(step0.args).toBe('--depth deep');
    expect(step0.stage).toBe('analysis');
    expect(step0.goal_ref).toBe('G1');
    expect(step0.retry).toEqual({ count: 1, max: 3 });
    const step1 = session.orchestration.chain[1];
    expect(step1.stage).toBe('plan');
    expect(step1.goal_ref).toBeNull();
    // No retry_count/max_retries in detail → defaults (count 0, max 2).
    expect(step1.retry).toEqual({ count: 0, max: 2 });
  });

  it('does not carry completion_* or context onto the session', () => {
    const sessionId = 'migrate-excludes';
    writeSession(sessionId, { version: 'session/1.0', chain: fullChain });
    writeRalphMeta(sessionId, fullMeta);
    migrateSession(tmpRoot, sessionId);

    const raw = JSON.stringify(readSessionRaw(sessionId));
    expect(raw).not.toContain('completion_status');
    expect(raw).not.toContain('completion_summary');
    expect(raw).not.toContain('completion_evidence');
    expect(raw).not.toContain('analyze_macro_id');
    expect(raw).not.toContain('plan_dir');
    expect(raw).not.toContain('protocol_version');
  });

  it('leaves verification_ledger in ralph-meta.json untouched', () => {
    const sessionId = 'migrate-ledger';
    writeSession(sessionId, { version: 'session/1.0', chain: fullChain });
    writeRalphMeta(sessionId, fullMeta);
    migrateSession(tmpRoot, sessionId);

    const meta = JSON.parse(readFileSync(join(sessionDir(sessionId), 'ralph-meta.json'), 'utf-8'));
    expect(Array.isArray(meta.verification_ledger)).toBe(true);
    expect(meta.verification_ledger[0].authority).toBe('verify');
    // Session file never gains a verification_ledger key.
    expect(readSessionRaw(sessionId).verification_ledger).toBeUndefined();
  });

  it('is idempotent — second migrate is a no-op', () => {
    const sessionId = 'migrate-idempotent';
    writeSession(sessionId, { version: 'session/1.0', chain: fullChain });
    writeRalphMeta(sessionId, fullMeta);

    const first = migrateSession(tmpRoot, sessionId);
    expect(first.status).toBe('migrated');
    const second = migrateSession(tmpRoot, sessionId);
    expect(second.status).toBe('already-migrated');
    expect(second.mapped_steps).toBe(0);
  });

  it('fills missing promoted blocks after a partial Session 1.1 update', () => {
    const sessionId = 'migrate-partial';
    writeSession(sessionId, { version: 'session/1.0', chain: fullChain });
    writeRalphMeta(sessionId, fullMeta);
    const store = new SessionStore(tmpRoot);
    store.update(sessionId, draft => {
      draft.session.orchestration.position = {
        lifecycle: 'manual-override', phase: 9, phase_is_new: false, milestone: 'manual',
        planning_mode: null, passed_gates: [], scope_verdict: null,
      };
      return null;
    });

    const result = migrateSession(tmpRoot, sessionId);
    expect(result.status).toBe('migrated');
    const session = store.readBundle(sessionId).session;
    expect(session.orchestration.position?.lifecycle).toBe('manual-override');
    expect(session.orchestration.decomposition?.goals[0].id).toBe('G1');
    expect(session.orchestration.lease?.owner).toBe('ralph-execute');
    expect(session.orchestration.chain[0].args).toBe('--depth deep');
  });

  it('rejects corrupt ralph-meta instead of treating it as absent', () => {
    const sessionId = 'migrate-corrupt';
    writeSession(sessionId, { version: 'session/1.0', chain: fullChain });
    writeFileSync(join(sessionDir(sessionId), 'ralph-meta.json'), '{broken', 'utf8');
    expect(() => migrateSession(tmpRoot, sessionId)).toThrow(/invalid legacy ralph-meta/);
    expect(readSessionRaw(sessionId).schema_version).toBe('session/1.0');
  });

  it('rejects a session with a running chain step', () => {
    const sessionId = 'migrate-running';
    const chain = [
      { step_id: 'step-000-execute', command: 'maestro-execute', status: 'running', run_id: 'run-9', inserted_by: 'build', decision_ref: null },
    ];
    writeSession(sessionId, { version: 'session/1.0', chain });
    writeRalphMeta(sessionId, fullMeta);
    expect(() => migrateSession(tmpRoot, sessionId)).toThrow(/running chain step/);
  });

  it('bumps version only when no ralph-meta is present', () => {
    const sessionId = 'migrate-versiononly';
    writeSession(sessionId, { version: 'session/1.0', engine: 'manual', chain: [] });
    const result = migrateSession(tmpRoot, sessionId);
    expect(result.status).toBe('version-only');
    expect(result.had_ralph_meta).toBe(false);
    expect(readSessionRaw(sessionId).schema_version).toBe('session/1.3');
    // Second run recognizes it as already migrated.
    expect(migrateSession(tmpRoot, sessionId).status).toBe('already-migrated');
  });
});

describe('session/2.0 historical migration', () => {
  it.each([
    ['running', 'active'],
    ['paused', 'paused'],
    ['failed', 'paused'],
    ['sealed', 'sealed'],
    ['archived', 'sealed'],
  ] as const)('maps legacy %s deterministically to a %s generation-1 Execution', (legacyStatus, executionStatus) => {
    const sessionId = `migrate-v2-${legacyStatus}`;
    writeSession(sessionId, { version: 'session/1.0', status: legacyStatus });
    const artifactPath = join(sessionDir(sessionId), 'artifacts.json');
    const artifactBytes = readFileSync(artifactPath);
    const runPath = join(sessionDir(sessionId), 'runs', 'legacy-run.json');
    writeFileSync(runPath, '{"immutable":"run-hash"}\n');
    const runBytes = readFileSync(runPath);
    enableSessionV20();

    const result = migrateSession(tmpRoot, sessionId);
    expect(result).toMatchObject({
      status: 'migrated-to-2.0',
      target_version: 'session/2.0',
      legacy_execution_id: 'execution-legacy-g1',
    });
    const store = new SessionStore(tmpRoot);
    const identity = store.readSessionRecord(sessionId);
    expect(identity).toMatchObject({
      schema_version: 'session/2.0',
      current_execution_id: executionStatus === 'sealed' ? null : 'execution-legacy-g1',
      latest_execution_id: 'execution-legacy-g1',
    });
    expect(identity).not.toHaveProperty('status');
    expect(identity).not.toHaveProperty('orchestration');
    expect(store.readExecution(sessionId, 'execution-legacy-g1')).toMatchObject({
      generation: 1,
      status: executionStatus,
    });
    expect(store.readBundle(sessionId).session.status).toBe(legacyStatus);
    expect(readFileSync(artifactPath)).toEqual(artifactBytes);
    expect(readFileSync(runPath)).toEqual(runBytes);

    if (legacyStatus === 'archived') {
      expect(identity).toMatchObject({
        archived_at: '1970-01-01T00:00:00.000Z',
        archived_by: 'legacy-migration',
      });
      const receipts = store.listSessionArchiveReceipts(sessionId);
      expect(receipts).toHaveLength(1);
      expect(receipts[0]).toMatchObject({
        actor: 'legacy-migration',
        reason: 'Historical session/1.x archived status migration',
        evidence_refs: [expect.stringMatching(/^legacy-session:sha256:/)],
      });
    } else {
      expect(identity).toMatchObject({ archived_at: null, archived_by: null });
      expect(store.listSessionArchiveReceipts(sessionId)).toEqual([]);
    }
    expect(migrateSession(tmpRoot, sessionId).status).toBe('already-migrated');
  });

  it('migrates a session/1.3 after a Wave1 Execution starts and seals without rewriting projections', () => {
    const sessionId = 'migrate-v2-wave1-sealed';
    const store = new SessionStore(tmpRoot);
    store.createSession(sessionId, 'Wave1 migration');
    const started = startExecution(tmpRoot, sessionId, {
      requestId: 'req-wave1-start',
      ownerId: 'wave1-worker',
      ownerKind: 'codex',
    });
    sealExecution(tmpRoot, {
      sessionId,
      executionId: started.execution.execution_id,
      requestId: 'req-wave1-seal',
      expectedExecutionRevision: 1,
      lease: {
        ownerId: started.lease_claim.owner_id,
        ownerKind: started.lease_claim.owner_kind,
        epoch: started.lease_claim.epoch,
        leaseId: started.lease_claim.lease_id,
      },
      summary: 'Wave1 complete',
      outcome: 'done',
    });
    const executionPath = store.executionPath(sessionId, started.execution.execution_id);
    const transitionPath = store.executionTransitionPath(sessionId, started.execution.execution_id, 'req-wave1-start');
    const receiptPath = store.executionSealReceiptPath(sessionId, started.execution.execution_id);
    const preserved = [executionPath, transitionPath, receiptPath].map(path => readFileSync(path));

    enableSessionV20();
    expect(migrateSession(tmpRoot, sessionId)).toMatchObject({
      status: 'migrated-to-2.0',
      legacy_execution_id: started.execution.execution_id,
    });
    expect([executionPath, transitionPath, receiptPath].map(path => readFileSync(path))).toEqual(preserved);
    expect(store.readSessionRecord(sessionId)).toMatchObject({
      current_execution_id: null,
      latest_execution_id: started.execution.execution_id,
    });
    expect(store.listExecutions(sessionId)).toHaveLength(1);
    expect(migrateSession(tmpRoot, sessionId).status).toBe('already-migrated');
  });

  it('does not synthesize a missing receipt for an existing sealed Wave1 Execution during migration', () => {
    const sessionId = 'migrate-v2-wave1-missing-receipt';
    const store = new SessionStore(tmpRoot);
    store.createSession(sessionId, 'Wave1 missing receipt');
    const started = startExecution(tmpRoot, sessionId, {
      requestId: 'req-wave1-start-missing', ownerId: 'wave1-worker', ownerKind: 'codex',
    });
    sealExecution(tmpRoot, {
      sessionId,
      executionId: started.execution.execution_id,
      requestId: 'req-wave1-seal-missing',
      expectedExecutionRevision: 1,
      lease: {
        ownerId: started.lease_claim.owner_id,
        ownerKind: started.lease_claim.owner_kind,
        epoch: started.lease_claim.epoch,
        leaseId: started.lease_claim.lease_id,
      },
      summary: 'Wave1 complete',
      outcome: 'done',
    });
    const executionPath = store.executionPath(sessionId, started.execution.execution_id);
    const executionBytes = readFileSync(executionPath);
    rmSync(store.executionSealReceiptPath(sessionId, started.execution.execution_id));

    enableSessionV20();
    migrateSession(tmpRoot, sessionId);
    expect(readFileSync(executionPath)).toEqual(executionBytes);
    expect(store.readExecutionSealReceipt(sessionId, started.execution.execution_id)).toBeNull();
  });

  it('migrates a sealed legacy Run into an immediately recallable receipt-backed source', () => {
    const sessionId = 'migrate-v2-legacy-sealed-run';
    commandFile();
    const store = new SessionStore(tmpRoot);
    store.createSession(sessionId, 'sealed legacy source');
    const created = createRun({
      projectRoot: tmpRoot,
      sessionId,
      command: 'migration-empty',
      intent: 'sealed legacy source',
    });
    expect(completeRun(tmpRoot, created.run_id, sessionId).sealed).toBe(true);
    sealSession(tmpRoot, sessionId, 'legacy source complete');
    const runPath = join(store.runDir(sessionId, created.run_id), 'run.json');
    const runBytes = readFileSync(runPath);

    enableSessionV20();
    migrateSession(tmpRoot, sessionId);
    const receipt = store.readExecutionSealReceipt(sessionId, 'execution-legacy-g1');
    expect(receipt).toMatchObject({
      schema_version: 'execution-seal-receipt/1.0',
      execution_id: 'execution-legacy-g1',
      runs: [{
        run_id: created.run_id,
        schema_version: 'command-run/1.3',
        content_hash: sha256(runBytes),
      }],
    });
    expect(readFileSync(runPath)).toEqual(runBytes);
    expect(buildSourceFence(tmpRoot, sessionId, created.run_id)).toMatchObject({
      schema_version: 'source-fence/1.1',
      execution_seal_receipt: {
        execution_id: 'execution-legacy-g1',
        overall_hash: receipt?.overall_hash,
      },
    });
  });

  it('fails closed when a sealed legacy source contains an unsealed Run', () => {
    const sessionId = 'migrate-v2-legacy-unsealed-run';
    commandFile('migration-unsealed');
    const store = new SessionStore(tmpRoot);
    store.createSession(sessionId, 'invalid sealed legacy source');
    const created = createRun({
      projectRoot: tmpRoot,
      sessionId,
      command: 'migration-unsealed',
      intent: 'invalid sealed legacy source',
    });
    store.update(sessionId, draft => {
      draft.session.status = 'sealed';
      draft.session.active_run_id = null;
      draft.session.lifecycle.sealed_at = '2026-07-20T00:00:00.000Z';
      draft.session.lifecycle.seal_summary = 'invalid historical seal';
    });
    enableSessionV20();
    expect(() => migrateSession(tmpRoot, sessionId))
      .toThrow(new RegExp(`sealed Session ${sessionId}; unsealed Runs: ${created.run_id}`));
    expect(store.readSessionRecord(sessionId).schema_version).toBe('session/1.3');
    expect(store.readExecutionSealReceipt(sessionId, 'execution-legacy-g1')).toBeNull();
  });

  it('allows a running legacy chain only on the explicit 2.0 migration path', () => {
    const sessionId = 'migrate-v2-running-chain';
    writeSession(sessionId, {
      version: 'session/1.0',
      status: 'running',
      chain: [{
        step_id: 'step-running', command: 'demo', status: 'running', run_id: 'run-1',
        inserted_by: 'legacy', decision_ref: null,
      }],
    });
    enableSessionV20();
    expect(migrateSession(tmpRoot, sessionId).status).toBe('migrated-to-2.0');
    expect(new SessionStore(tmpRoot).readExecution(sessionId, 'execution-legacy-g1').status).toBe('active');
  });

  it('records deterministic archive CAS history and refuses stale successors', () => {
    const sessionId = 'migrate-v2-cas';
    writeSession(sessionId, { version: 'session/1.0', status: 'running' });
    enableSessionV20();
    migrateSession(tmpRoot, sessionId);
    const store = new SessionStore(tmpRoot);
    const attached = attachExecution(tmpRoot, {
      sessionId,
      executionId: 'execution-legacy-g1',
      requestId: 'req-attach-before-archive',
      expectedExecutionRevision: 0,
      ownerId: 'migration-test',
      ownerKind: 'codex',
    });
    sealExecution(tmpRoot, {
      sessionId,
      executionId: 'execution-legacy-g1',
      requestId: 'req-seal-before-archive',
      expectedExecutionRevision: 1,
      lease: {
        ownerId: attached.lease_claim.owner_id,
        ownerKind: attached.lease_claim.owner_kind,
        epoch: attached.lease_claim.epoch,
        leaseId: attached.lease_claim.lease_id,
      },
      summary: 'ready to archive',
      outcome: 'done',
    });
    const current = store.readSessionRecord(sessionId);
    if (current.schema_version !== 'session/2.0') throw new Error('expected session/2.0');
    const receipt = createSessionArchiveReceipt({
      receipt_id: 'archive-000000000001',
      operation: 'archive',
      session_id: sessionId,
      actor: 'operator',
      reason: 'completed',
      evidence_refs: ['execution-seal:execution-legacy-g1'],
      recorded_at: '2026-07-21T00:00:00.000Z',
      before: {
        identity_revision: current.identity_revision,
        activity_revision: current.activity_revision,
        archived_at: null,
        archived_by: null,
      },
      after: {
        identity_revision: current.identity_revision,
        activity_revision: current.activity_revision + 1,
        archived_at: '2026-07-21T00:00:00.000Z',
        archived_by: 'operator',
      },
      previous_receipt_hash: null,
    });
    expect(store.applySessionArchiveReceipt(receipt)).toMatchObject({ archived_by: 'operator' });
    expect(store.listSessionArchiveReceipts(sessionId)).toEqual([receipt]);
    expect(store.applySessionArchiveReceipt(receipt)).toMatchObject({ archived_by: 'operator' });
    const stale = createSessionArchiveReceipt({
      ...receipt,
      receipt_id: 'archive-000000000002',
      before: receipt.before,
      after: { ...receipt.after, activity_revision: receipt.after.activity_revision + 1 },
      previous_receipt_hash: receipt.receipt_hash,
    });
    expect(() => store.applySessionArchiveReceipt(stale)).toThrow(/CAS conflict/);
  });

  it('writes and replay-reads one immutable, hash-verified Execution seal receipt', () => {
    const sessionId = 'migrate-v2-seal-receipt';
    writeSession(sessionId, { version: 'session/1.0', status: 'sealed' });
    enableSessionV20();
    migrateSession(tmpRoot, sessionId);
    const store = new SessionStore(tmpRoot);
    const identity = store.readSessionRecord(sessionId);
    if (identity.schema_version !== 'session/2.0') throw new Error('expected session/2.0');
    const execution = store.readExecution(sessionId, 'execution-legacy-g1');
    const dir = sessionDir(sessionId);
    const receipt = createExecutionSealReceipt({
      session_id: sessionId,
      execution_id: execution.execution_id,
      generation: execution.generation,
      sealed_at: execution.sealed_at!,
      execution_revision: execution.revision,
      session_identity_revision: identity.identity_revision,
      session_activity_revision: identity.activity_revision,
      runs: [],
      chain_snapshot: execution.chain,
      chain_hash: sha256(JSON.stringify(execution.chain)),
      gates: {
        clean: true,
        blocking_gate_ids: [],
        registry_revision: 0,
        registry_hash: sha256(readFileSync(join(dir, 'gates.json'))),
      },
      artifacts: {
        registry_revision: 0,
        registry_hash: sha256(readFileSync(join(dir, 'artifacts.json'))),
        content_hashes: {},
      },
      evidence: {
        store_revision: 0,
        store_hash: sha256(readFileSync(join(dir, 'evidence.json'))),
        record_refs: [],
      },
      corpus_refs: [],
    });
    expect(store.writeExecutionSealReceipt(receipt)).toEqual(receipt);
    expect(store.writeExecutionSealReceipt(receipt)).toEqual(receipt);
    expect(store.readExecutionSealReceipt(sessionId, execution.execution_id)).toEqual(receipt);
    expect(() => store.writeExecutionSealReceipt({
      ...receipt,
      overall_hash: `sha256:${'f'.repeat(64)}`,
    })).toThrow(/immutable|hash mismatch/);
  });
});
