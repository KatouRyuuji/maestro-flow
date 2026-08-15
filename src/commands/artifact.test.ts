import { Command } from 'commander';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { runResponseV12Schema } from '../run/protocol-schemas.js';
import { assessSessionReuse, completeRun, createRun } from '../run/runtime.js';
import type { RunV30 } from '../run/schemas.js';
import { SessionStore } from '../run/store.js';
import { applyV3Migration } from '../run/v3/migrate-v3.js';
import { loadLegacyV3MigrationInput } from '../run/v3/migrate-v3-loader.js';
import { createRunningRunV3 } from '../run/v3/mutation-engine.js';
import { registerArtifactCommand } from './artifact.js';

function v2Workspace(root: string): void {
  mkdirSync(join(root, ".workflow"), { recursive: true });
  writeFileSync(join(root, ".workflow", "config.json"), JSON.stringify({
    session_schema: { schema_version: "session-schema-selection/1.0", writer: "session/1.3", features: { session_statusless: false } },
  }));
}

const roots: string[] = [];

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'maestro-artifact-command-'));

  v2Workspace(value);
  roots.push(value);
  return value;
}

function commandFile(projectRoot: string, name: string, contract: string): void {
  const dir = join(projectRoot, '.claude', 'commands');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.md`), `<contract>\n${contract}\n</contract>\n`);
}

function fixture(): { projectRoot: string; sessionId: string; artifactId: string; sourcePath: string } {
  const projectRoot = root();
  commandFile(projectRoot, 'legacy-producer', `contract_version: 2.1
arguments: []
consumes: []
produces:
  - kind: execution
    path: outputs/execution.json
    alias: latest-execution
    role: attachment
    required: true
    schema: execution/1.0
gates:
  entry: []
  exit: []`);
  commandFile(projectRoot, 'legacy-review', `contract_version: 2.1
arguments: []
consumes:
  - kind: execution
    alias: latest-execution
    required: true
    require_status: sealed
    schema: execution/1.0
    role: primary
produces: []
gates:
  entry: []
  exit: []`);
  const created = createRun({ projectRoot, command: 'legacy-producer', intent: 'artifact compatibility' });
  const createdStore = new SessionStore(projectRoot);
  const runDir = createdStore.runDir(created.session_id, created.run_id);
  const sourcePath = join(runDir, 'outputs', 'execution.json');
  mkdirSync(join(runDir, 'outputs'), { recursive: true });
  writeFileSync(sourcePath, `${JSON.stringify({
    _meta: { kind: 'execution', schema: 'execution/1.0', role: 'attachment', alias: 'latest-execution' },
    changes: [],
  }, null, 2)}\n`);
  writeFileSync(join(runDir, 'report.md'), `---
verdict: ready
summary: legacy execution ready
constraints: []
decisions: []
concerns: []
next: []
---
legacy execution ready
`);
  const completed = completeRun(projectRoot, created.run_id, created.session_id);
  const artifactId = completed.artifact_ids[0];
  if (!artifactId) throw new Error(`producer Run did not publish an Artifact: ${JSON.stringify(completed)}`);
  const store = new SessionStore(projectRoot);
  store.update(created.session_id, draft => {
    draft.session.orchestration.chain.push({
      step_id: 'review-step', command: 'legacy-review', status: 'pending', run_id: null,
      inserted_by: 'test', decision_ref: null,
    });
    draft.session.activity_revision++;
  });
  return { projectRoot, sessionId: created.session_id, artifactId, sourcePath };
}

async function invoke(args: string[]) {
  const writes: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
    writes.push(String(chunk));
    return true;
  }) as typeof process.stdout.write);
  const program = new Command().name('maestro').exitOverride();
  registerArtifactCommand(program);
  await program.parseAsync(['node', 'maestro', ...args]);
  expect(writes).toHaveLength(1);
  return runResponseV12Schema.parse(JSON.parse(writes[0]));
}

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
});

describe('artifact inspect and republish commands', () => {
  it('inspects without mutation and republishes only role/alias metadata with immutable receipts', async () => {
    const { projectRoot, sessionId, artifactId, sourcePath } = fixture();
    const store = new SessionStore(projectRoot);
    const sourceBytes = readFileSync(sourcePath, 'utf8');
    const sourceRecord = structuredClone(store.readBundle(sessionId).artifacts.artifacts[artifactId]);
    const beforeSession = readFileSync(join(store.sessionDir(sessionId), 'session.json'), 'utf8');
    const beforeRegistry = readFileSync(join(store.sessionDir(sessionId), 'artifacts.json'), 'utf8');

    const inspected = await invoke([
      'artifact', 'inspect', artifactId,
      '--session', sessionId, '--consumer', 'legacy-review', '--alias', 'latest-execution',
      '--json', '--workflow-root', projectRoot,
    ]);
    expect(inspected).toMatchObject({
      schema_version: 'run-response/1.2', operation: 'artifact-inspect', ok: true,
      result: { classification: 'semantic_republish_required' },
    });
    expect(readFileSync(join(store.sessionDir(sessionId), 'session.json'), 'utf8')).toBe(beforeSession);
    expect(readFileSync(join(store.sessionDir(sessionId), 'artifacts.json'), 'utf8')).toBe(beforeRegistry);

    vi.restoreAllMocks();
    const assessment = inspected.result as { assessment_hash: string; source: { artifact_registry_revision: number; session_revision: number } };
    const common = [
      'artifact', 'republish', artifactId,
      '--session', sessionId, '--consumer', 'legacy-review', '--alias', 'latest-execution',
      '--assessment-hash', assessment.assessment_hash,
      '--request-id', 'req-republish-1',
      '--expected-artifact-revision', String(assessment.source.artifact_registry_revision),
      '--expected-session-revision', String(assessment.source.session_revision),
      '--participant', 'window-a', '--actor', 'actor-a', '--reason', 'approved compatibility repair',
      '--evidence', 'EVD-compat-1', '--json', '--workflow-root', projectRoot,
    ];
    const republished = await invoke(common);
    expect(republished).toMatchObject({
      operation: 'artifact-republish', ok: true, replay: { status: 'applied' },
      result: {
        source_artifact_id: artifactId,
        assessment_hash: assessment.assessment_hash,
        receipt: { schema_version: 'artifact-republish/1.0', evidence_refs: ['EVD-compat-1'] },
      },
    });
    const result = republished.result as { artifact_id: string; compatibility_run_id: string; receipt: { artifact_path: string } };
    const bundle = store.readBundle(sessionId);
    expect(readFileSync(sourcePath, 'utf8')).toBe(sourceBytes);
    expect(bundle.artifacts.artifacts[artifactId]).toEqual(sourceRecord);
    expect(bundle.artifacts.aliases['latest-execution']).toBe(result.artifact_id);
    expect(bundle.artifacts.artifacts[result.artifact_id]).toMatchObject({
      role: 'primary', status: 'sealed', derived_from: [artifactId], replaces: null,
      producer_run_id: result.compatibility_run_id,
    });
    expect(JSON.parse(readFileSync(join(store.sessionDir(sessionId), result.receipt.artifact_path), 'utf8')))
      .toMatchObject({ _meta: { kind: 'execution', schema: 'execution/1.0', role: 'primary', alias: 'latest-execution' } });
    expect(store.readRun(sessionId, result.compatibility_run_id)).toMatchObject({ status: 'sealed' });
    expect(bundle.session.orchestration.chain).toEqual(expect.arrayContaining([
      expect.objectContaining({ command: 'artifact-compatibility-republish', status: 'sealed' }),
      expect.objectContaining({ step_id: 'review-step', status: 'pending', run_id: null }),
    ]));
    expect(bundle.session.active_run_id).toBeNull();

    vi.restoreAllMocks();
    const replayed = await invoke(common);
    expect(replayed).toMatchObject({ ok: true, replay: { status: 'replayed' }, result: { artifact_id: result.artifact_id } });
    expect(store.readBundle(sessionId).artifacts.revision).toBe(bundle.artifacts.revision);

    const reuse = assessSessionReuse(projectRoot, sessionId, 'legacy-review');
    expect(reuse.upstream['latest-execution']?.artifact_id).toBe(result.artifact_id);
    expect(reuse.assessments.find(item => item.source_fence.artifact_id === result.artifact_id))
      .toMatchObject({ decision: 'REUSE', reason_codes: expect.arrayContaining(['CONTRACT_COMPATIBLE_OUTPUT']) });
  });

  it('preserves sealed legacy attachment semantics through v3 migration and exact republish reuse', async () => {
    const { projectRoot, sessionId, artifactId, sourcePath } = fixture();
    const legacyStore = new SessionStore(projectRoot);
    legacyStore.update(sessionId, draft => {
      for (const [gateId, gate] of Object.entries(draft.gates.gates)) gate.key = gateId;
    });
    const registryPath = join(legacyStore.sessionDir(sessionId), 'artifacts.json');
    const sourceBytes = readFileSync(sourcePath);
    const registryBytes = readFileSync(registryPath);
    commandFile(projectRoot, 'legacy-producer', `contract_version: 2.1
arguments: []
consumes: []
produces:
  - kind: execution
    path: outputs/execution.json
    alias: latest-execution
    role: primary
    required: true
    schema: execution/1.0
gates:
  entry: []
  exit: []`);
    const migrationInput = loadLegacyV3MigrationInput(legacyStore, sessionId);
    writeFileSync(join(projectRoot, '.workflow', 'config.json'), `${JSON.stringify({
      session_schema: {
        schema_version: 'session-schema-selection/1.0', writer: 'session/3.0',
        features: { session_statusless: false },
      },
    }, null, 2)}\n`);
    const store = new SessionStore(projectRoot);
    const migrated = applyV3Migration(store, migrationInput, {
      actor_id: 'migration-actor',
      recorded_at: '2026-08-14T10:00:00.000Z',
    });
    expect(migrated.status).toBe('applied');
    expect(readFileSync(sourcePath)).toEqual(sourceBytes);
    expect(readFileSync(registryPath)).toEqual(registryBytes);

    const inspected = await invoke([
      'artifact', 'inspect', artifactId, '--session', sessionId,
      '--consumer', 'legacy-review', '--alias', 'latest-execution', '--json', '--workflow-root', projectRoot,
    ]);
    expect(inspected).toMatchObject({
      ok: true,
      result: {
        classification: 'semantic_republish_required',
        source: {
          producer_contract_source: 'sealed_raw_registry',
          raw_slot: { role: 'attachment' },
          registry_slot: { role: 'attachment' },
          producer_slot: { role: 'attachment' },
        },
      },
    });
    vi.restoreAllMocks();
    const assessment = inspected.result as {
      assessment_hash: string;
      source: { artifact_registry_revision: number; session_revision: number };
    };
    const republished = await invoke([
      'artifact', 'republish', artifactId, '--session', sessionId,
      '--consumer', 'legacy-review', '--alias', 'latest-execution',
      '--assessment-hash', assessment.assessment_hash, '--request-id', 'req-migrated-republish',
      '--expected-artifact-revision', String(assessment.source.artifact_registry_revision),
      '--expected-session-revision', String(assessment.source.session_revision),
      '--participant', 'window-a', '--actor', 'actor-a', '--reason', 'repair migrated semantics',
      '--evidence', 'EVD-migrated', '--json', '--workflow-root', projectRoot,
    ]);
    expect(republished).toMatchObject({
      ok: true, result: { receipt: { schema_version: 'artifact-republish/1.0' } },
    });
    expect(readFileSync(sourcePath)).toEqual(sourceBytes);
    const afterRegistry = JSON.parse(readFileSync(registryPath, 'utf8'));
    expect(afterRegistry.artifacts[artifactId]).toEqual(JSON.parse(registryBytes.toString()).artifacts[artifactId]);
    const result = republished.result as { artifact_id: string };
    const state = store.readSessionV30(sessionId);
    const pending = state.chain.find(step => step.command === 'legacy-review');
    expect(pending).toMatchObject({ status: 'pending', run_ids: [] });
    const now = '2026-08-14T10:05:00.000Z';
    const consumerRun: RunV30 = {
      schema_version: 'run/3.0', run_id: 'review-after-migration', session_id: sessionId,
      step_id: pending!.step_id, parent_run_id: null, retry_of_run_id: null, attempt: 1,
      command: 'legacy-review', args: [], goal: null, status: 'pending', revision: 0,
      actor_id: 'actor-a', input_refs: [], output_refs: [],
      primary_artifact_id: null, verdict: null, summary: null, legacy_execution_generation: null,
      created_at: now, started_at: null, ended_at: null, sealed_at: null,
    };
    createRunningRunV3(store, {
      sessionId, requestId: 'req-migrated-next', actorId: 'actor-a',
      reason: 'explicit consumer next', evidenceRefs: ['EVD-migrated'], recordedAt: now,
      expectedOrchestrationRevision: state.orchestration_revision, run: consumerRun,
    });
    expect(store.readRunV30(sessionId, consumerRun.run_id).input_refs).toEqual([result.artifact_id]);
    expect(readFileSync(sourcePath)).toEqual(sourceBytes);
    expect(JSON.parse(readFileSync(registryPath, 'utf8')).artifacts[artifactId])
      .toEqual(JSON.parse(registryBytes.toString()).artifacts[artifactId]);
  });

  it('rejects a stale assessment after source bytes change and commits no derived authority', async () => {
    const { projectRoot, sessionId, artifactId, sourcePath } = fixture();
    const store = new SessionStore(projectRoot);
    const inspected = await invoke([
      'artifact', 'inspect', artifactId, '--session', sessionId,
      '--consumer', 'legacy-review', '--alias', 'latest-execution', '--json', '--workflow-root', projectRoot,
    ]);
    vi.restoreAllMocks();
    const assessment = inspected.result as {
      assessment_hash: string;
      source: { artifact_registry_revision: number; session_revision: number };
    };
    const registryBefore = readFileSync(join(store.sessionDir(sessionId), 'artifacts.json'), 'utf8');
    writeFileSync(sourcePath, readFileSync(sourcePath, 'utf8').replace('"changes": []', '"changes": ["tampered"]'));
    const rejected = await invoke([
      'artifact', 'republish', artifactId, '--session', sessionId,
      '--consumer', 'legacy-review', '--alias', 'latest-execution',
      '--assessment-hash', assessment.assessment_hash, '--request-id', 'req-stale-source',
      '--expected-artifact-revision', String(assessment.source.artifact_registry_revision),
      '--expected-session-revision', String(assessment.source.session_revision),
      '--participant', 'p', '--actor', 'a', '--reason', 'test stale fence', '--evidence', 'EVD-1',
      '--json', '--workflow-root', projectRoot,
    ]);
    expect(rejected).toMatchObject({
      operation: 'artifact-republish', ok: false,
      error: { message: expect.stringMatching(/assessment changed|not allowed/) },
    });
    expect(readFileSync(join(store.sessionDir(sessionId), 'artifacts.json'), 'utf8')).toBe(registryBefore);
  });

  it('republishes through the session/2.0 statusless atomic adapter without changing Session schema authority', async () => {
    const { projectRoot, sessionId, artifactId } = fixture();
    const store = new SessionStore(projectRoot);
    const dir = store.sessionDir(sessionId);
    const legacy = store.readBundle(sessionId).session;
    mkdirSync(join(dir, '.compat'), { recursive: true });
    writeFileSync(store.sessionCompatibilityPath(sessionId), `${JSON.stringify(legacy, null, 2)}\n`);
    writeFileSync(join(dir, 'session.json'), `${JSON.stringify({
      schema_version: 'session/2.0', session_id: sessionId, intent: legacy.intent,
      topic_identity: legacy.topic_identity, identity_revision: legacy.identity_revision,
      activity_revision: legacy.activity_revision, current_execution_id: null,
      latest_execution_id: null, latest_completed_run_id: legacy.latest_completed_run_id,
      archived_at: null, archived_by: null,
    }, null, 2)}\n`);
    const inspected = await invoke([
      'artifact', 'inspect', artifactId, '--session', sessionId,
      '--consumer', 'legacy-review', '--alias', 'latest-execution', '--json', '--workflow-root', projectRoot,
    ]);
    vi.restoreAllMocks();
    const assessment = inspected.result as { assessment_hash: string; source: { artifact_registry_revision: number; session_revision: number } };
    const response = await invoke([
      'artifact', 'republish', artifactId, '--session', sessionId,
      '--consumer', 'legacy-review', '--alias', 'latest-execution',
      '--assessment-hash', assessment.assessment_hash, '--request-id', 'req-v2-limit',
      '--expected-artifact-revision', String(assessment.source.artifact_registry_revision),
      '--expected-session-revision', String(assessment.source.session_revision),
      '--participant', 'p', '--actor', 'a', '--reason', 'test', '--evidence', 'EVD-1',
      '--json', '--workflow-root', projectRoot,
    ]);
    expect(response).toMatchObject({
      operation: 'artifact-republish', ok: true, replay: { status: 'applied' },
      result: { source_artifact_id: artifactId, receipt: { schema_version: 'artifact-republish/1.0' } },
    });
    const canonical = JSON.parse(readFileSync(join(dir, 'session.json'), 'utf8'));
    const compatibility = JSON.parse(readFileSync(store.sessionCompatibilityPath(sessionId), 'utf8'));
    expect(canonical).toMatchObject({
      schema_version: 'session/2.0', activity_revision: assessment.source.session_revision + 1,
      current_execution_id: null,
    });
    expect(compatibility).toMatchObject({ schema_version: 'session/1.3' });
    expect(compatibility.orchestration.chain).toEqual(expect.arrayContaining([
      expect.objectContaining({ command: 'artifact-compatibility-republish', status: 'sealed' }),
      expect.objectContaining({ command: 'legacy-review', status: 'pending', run_id: null }),
    ]));
    const reuse = assessSessionReuse(projectRoot, sessionId, 'legacy-review');
    const republishedId = (response.result as { artifact_id: string }).artifact_id;
    expect(reuse.upstream['latest-execution']?.artifact_id).toBe(republishedId);
    expect(reuse.assessments.find(item => item.source_fence.artifact_id === republishedId))
      .toMatchObject({ decision: 'REUSE' });
  });
});
