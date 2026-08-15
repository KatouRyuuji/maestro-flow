import { afterEach, describe, expect, it } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  commandRunV13Schema,
  commandRunV14Schema,
  executionStateSchema,
  sessionStateV20Schema,
  type ArtifactRegistry,
  type CommandRunInput,
  type EvidenceStore,
  type ExecutionState,
  type GateRegistry,
  type SessionIdentityV20,
  type SessionState,
} from '../schemas.js';
import {
  createArtifactRegistry,
  createEvidenceStore,
  createGateRegistry,
  createSessionState,
} from '../defaults.js';
import { SessionStore } from '../store.js';
import {
  createTransitionOutcomeV11,
  createTransitionRequestV11,
  sha256Digest,
  type TransitionFenceV11,
} from '../transition-receipts.js';
import type { PersistedTransitionRecordV11 } from '../protocol-schemas.js';
import { loadLegacyV3MigrationInput } from './migrate-v3-loader.js';
import {
  applyV3Migration,
  migrationReportV1Schema,
  projectLegacySessionToV30,
  readAppliedV3Migration,
  V3MigrationError,
  type LegacyV3MigrationInput,
} from './migrate-v3.js';

const roots: string[] = [];
const HASH = 'a'.repeat(64);
const LEASE_SECRET = 'lease-secret-value';
const RETRY_SECRET = 'retry-secret-value';
const HANDOFF_SECRET = 'handoff-secret-value';
const TRANSITION_PRIVATE_SECRET = 'transition-private-secret';
const OPERATION_SECRET = 'operation-secret-value';
const SESSION_RETRY_SECRET = 'session-retry-secret';
const ORCHESTRATION_LEASE_SECRET = 'orchestration-lease-secret';
const RECORDED_AT = '2026-08-12T04:00:00.000Z';

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'maestro-migrate-v3-'));
  roots.push(value);
  return value;
}

function jsonBytes(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function handoff() {
  return {
    schema_version: 'command-handoff/1.0' as const,
    producer_run_id: 'run-1',
    command: 'implement',
    verdict: 'ready_with_concerns' as const,
    summary: 'implemented with auditable concerns',
    constraints: [],
    decisions: [],
    concerns: ['review follow-up'],
    artifact_refs: ['artifact-1'],
    next: [],
    details: { operation_token: OPERATION_SECRET, harmless: 'retained only in old snapshot' },
  };
}

function runV14(
  status: 'created' | 'running' | 'blocked' | 'failed' | 'completed' | 'sealed' = 'completed',
) {
  return commandRunV14Schema.parse({
    schema_version: 'command-run/1.4',
    session_id: 's',
    run_id: 'run-1',
    sequence: 1,
    parent_run_id: null,
    command: {
      name: 'implement',
      version: '1.0',
      source_path: 'workflows/implement.md',
      content_hash: HASH,
      resolved_prompt_hash: HASH,
    },
    status,
    input: {
      args: ['--focused'],
      consumes: [],
      context_identity_revision: 2,
      reuse_assessments: [],
    },
    gate_ids: ['gate-1'],
    output: {
      produces: ['artifact-1'],
      primary_artifact_id: 'artifact-1',
      verdict: status === 'failed' ? 'failed' : 'ready_with_concerns',
    },
    handoff: handoff(),
    started_at: '2026-08-12T01:00:00.000Z',
    completed_at: status === 'created' || status === 'running' || status === 'blocked'
      ? null
      : '2026-08-12T02:00:00.000Z',
    sealed_at: status === 'sealed' ? '2026-08-12T03:00:00.000Z' : null,
    chain_step_id: 'step-1',
    resolved_platform: 'codex',
    goal_binding: {
      provider: 'todo',
      external_id: 'T-1',
      step_goal_ref: 'goal-1',
      observed_status: 'complete',
      observed_at: '2026-08-12T02:00:00.000Z',
    },
    checkpoint_expectation: null,
    checkpoint: null,
    retry_fence: null,
    contract_snapshot: null,
    guidance_snapshot: null,
    creation_decision: null,
    creation_provenance: {
      schema_version: 'creation-provenance/1.0',
      provenance: 'native-v2',
      source_workspace_id: null,
      source_session_id: null,
      source_run_id: null,
      imported_artifact_hashes: [],
    },
    transition: null,
    execution_id: 'execution-7',
    generation: 7,
  });
}

function runV13(status: 'running' | 'sealed' = 'sealed') {
  const current = runV14(status);
  const { execution_id: _executionId, generation: _generation, ...legacy } = current;
  return commandRunV13Schema.parse({
    ...legacy,
    schema_version: 'command-run/1.3',
  });
}

function registries(): {
  gates: GateRegistry;
  artifacts: ArtifactRegistry;
  evidence: EvidenceStore;
} {
  const gates = createGateRegistry();
  gates.revision = 2;
  gates.gates['gate-1'] = {
    key: 'gate-1',
    title: 'Migration acceptance',
    scope: 'session',
    run_id: 'run-1',
    required: true,
    blocking: true,
    applicable_modes: ['standard'],
    status: 'passed',
    check: { type: 'manual', prompt: 'approved' },
    evidence_refs: ['evidence-1'],
    waiver: null,
  };
  gates.summary = {
    total: 1,
    passed: 1,
    blocked: 0,
    failed: 0,
    active_gate_ids: [],
    blocking_run_id: null,
  };

  const artifacts = createArtifactRegistry();
  artifacts.revision = 3;
  artifacts.artifacts['artifact-1'] = {
    kind: 'report',
    role: 'primary',
    producer_run_id: 'run-1',
    relative_path: 'outputs/report.md',
    media_type: 'text/markdown',
    schema_version: 'report/1.0',
    content_hash: 'b'.repeat(64),
    size: 123,
    status: 'sealed',
    derived_from: [],
    replaces: null,
  };
  artifacts.aliases.current = 'artifact-1';

  const evidence = createEvidenceStore();
  evidence.revision = 4;
  evidence.records['evidence-1'] = {
    run_id: 'run-1',
    command: 'implement',
    kind: 'test',
    point: 'migration',
    claim: 'references survive',
    outcome: 'pass',
    rationale: 'focused fixture',
    status: 'accepted',
    artifact_refs: ['artifact-1'],
    gate_refs: ['gate-1'],
    source_refs: ['src/run/v3/migrate-v3.ts'],
  };
  return { gates, artifacts, evidence };
}

function chain(status: 'completed' | 'sealed' = 'completed') {
  return [{
    step_id: 'step-1',
    command: 'implement',
    status,
    run_id: 'run-1',
    inserted_by: 'legacy',
    decision_ref: 'decision-1',
    args: '--focused',
    stage: null,
    goal_ref: 'goal-1',
    retry: { count: 0, max: 2 },
  }];
}

function decisions() {
  return [{
    point_id: 'decision-1',
    after_step_id: 'step-1',
    status: 'passed' as const,
    retry_count: 0,
    max_retries: 1,
    evidence_ref: 'evidence-1',
  }];
}

function sealedV13Input(): LegacyV3MigrationInput {
  const session = createSessionState('s', 'migrate sealed session');
  session.status = 'sealed';
  session.identity_revision = 2;
  session.activity_revision = 5;
  session.latest_completed_run_id = 'run-1';
  session.boundary_contract.definition_of_done = 'migration tests pass';
  session.orchestration.chain = chain('sealed');
  session.orchestration.decision_points = decisions();
  session.orchestration.lease = {
    owner: 'legacy-worker', epoch: 2, id: ORCHESTRATION_LEASE_SECRET,
  };
  session.requests = [{
    request_id: 'legacy-request',
    type: 'mutation',
    status: 'pending',
    payload: { operation_token: OPERATION_SECRET },
    claimed_by_run_id: null,
  }];
  session.lifecycle.sealed_at = '2026-08-12T03:00:00.000Z';
  session.lifecycle.seal_summary = 'legacy complete';
  const run = runV13();
  run.retry_fence = {
    token: RETRY_SECRET,
    chain_step_id: 'step-1',
    issued_at: '2026-08-12T00:00:00.000Z',
    expires_at: '2026-08-13T00:00:00.000Z',
    consumed_at: null,
  };
  const registry = registries();
  return { session, runs: [run], ...registry };
}

function execution(
  status: 'active' | 'paused' | 'sealed' = 'active',
  outcome: 'done' | 'done_with_concerns' | 'failed' | null = null,
): ExecutionState {
  return executionStateSchema.parse({
    schema_version: 'execution/1.0',
    execution_id: 'execution-7',
    session_id: 's',
    generation: 7,
    status,
    revision: 9,
    active_run_id: null,
    chain: chain(status === 'sealed' ? 'sealed' : 'completed'),
    decision_points: decisions(),
    gates_ref: 'gates.json',
    artifacts_ref: 'artifacts.json',
    evidence_ref: 'evidence.json',
    lease: status === 'active' ? {
      schema_version: 'execution-lease/1.0',
      session_id: 's',
      execution_id: 'execution-7',
      owner_id: 'pi-window-a',
      owner_kind: 'pi',
      epoch: 3,
      lease_id: LEASE_SECRET,
      acquired_at: '2026-08-12T00:00:00.000Z',
      heartbeat_at: '2026-08-12T00:05:00.000Z',
      handoff_to: null,
    } : null,
    started_at: '2026-08-12T00:00:00.000Z',
    sealed_at: status === 'sealed' ? '2026-08-12T03:00:00.000Z' : null,
    seal_summary: status === 'sealed' ? 'execution final summary' : null,
    final_outcome: status === 'sealed' ? outcome : null,
  });
}

function executionTransition(
  requestId = 'req-pause',
  transitionId = 'tr-pause',
): PersistedTransitionRecordV11 {
  const before: TransitionFenceV11 = {
    session_identity_revision: 4,
    session_activity_revision: 10,
    execution_id: 'execution-7',
    execution_generation: 7,
    execution_revision: 8,
    execution_status: 'active',
    lease_epoch: 3,
    active_run_id: null,
    run_hash: null,
    artifact_registry_revision: 3,
  };
  const after: TransitionFenceV11 = {
    ...before,
    session_activity_revision: 11,
    execution_revision: 9,
    execution_status: 'paused',
    lease_epoch: null,
  };
  const payload = createTransitionRequestV11({
    request_id: requestId,
    operation: 'execution-pause',
    subject: {
      session_id: 's', execution_id: 'execution-7', generation: 7,
      run_id: null, chain_step_id: null,
    },
    requested_at: '2026-08-12T00:10:00.000Z',
    preconditions: before,
    payload: {
      actor: 'migration-reviewer',
      lease: { lease_id_hash: `sha256:${HASH}`, handoff_token: HANDOFF_SECRET },
      private_token: TRANSITION_PRIVATE_SECRET,
    },
  });
  const outcome = createTransitionOutcomeV11({
    transition_id: transitionId,
    request_id: requestId,
    request_hash: payload.normalized_request_hash,
    operation: payload.operation,
    status: 'applied',
    applied_at: '2026-08-12T00:11:00.000Z',
    subject: payload.subject,
    postconditions: after,
    exit_code: 0,
    error_code: null,
    result: { status: 'paused', handoff_token: HANDOFF_SECRET },
  });
  return {
    request_id: requestId,
    type: 'transition',
    status: 'applied',
    payload,
    claimed_by_run_id: null,
    outcome,
  };
}

function v20Session(overrides: Partial<SessionIdentityV20> = {}): SessionIdentityV20 {
  return sessionStateV20Schema.parse({
    schema_version: 'session/2.0',
    session_id: 's',
    intent: 'migrate statusless session',
    topic_identity: null,
    identity_revision: 4,
    activity_revision: 11,
    current_execution_id: 'execution-7',
    latest_execution_id: 'execution-7',
    latest_completed_run_id: 'run-1',
    archived_at: null,
    archived_by: null,
    ...overrides,
  });
}

function openV20Input(): LegacyV3MigrationInput {
  const run = runV14();
  run.retry_fence = {
    token: RETRY_SECRET,
    chain_step_id: 'step-1',
    issued_at: '2026-08-12T00:00:00.000Z',
    expires_at: '2026-08-13T00:00:00.000Z',
    consumed_at: null,
  };
  run.input.args = ['--focused', '--handoff-token', HANDOFF_SECRET];
  const registry = registries();
  return {
    session: v20Session(),
    execution: execution('active'),
    runs: [run],
    retired_state: [{
      source_id: 'operation-registry.json',
      value: { operation_token: OPERATION_SECRET, heartbeat_at: '2026-08-12T00:05:00.000Z' },
      reason: 'operation registry is retired by session/3.0',
    }],
    ...registry,
  };
}

function enableV3(projectRoot: string): void {
  const workflowRoot = join(projectRoot, '.workflow');
  mkdirSync(workflowRoot, { recursive: true });
  writeFileSync(join(workflowRoot, 'config.json'), jsonBytes({
    session_schema: {
      schema_version: 'session-schema-selection/1.0',
      writer: 'session/3.0',
      features: { session_statusless: false },
    },
  }));
}

function persistLegacy(projectRoot: string, source: LegacyV3MigrationInput): LegacyV3MigrationInput {
  const store = new SessionStore(projectRoot);
  const sessionId = source.session.session_id;
  const dir = store.sessionDir(sessionId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'session.json'), jsonBytes(source.session));
  if (source.session.schema_version === 'session/2.0') {
    const compatibility = createSessionState(sessionId, source.session.intent);
    const compatibilityPath = store.sessionCompatibilityPath(sessionId);
    mkdirSync(join(dir, '.compat'), { recursive: true });
    writeFileSync(compatibilityPath, jsonBytes(compatibility));
  }
  writeFileSync(join(dir, 'gates.json'), jsonBytes(source.gates));
  writeFileSync(join(dir, 'artifacts.json'), jsonBytes(source.artifacts));
  writeFileSync(join(dir, 'evidence.json'), jsonBytes(source.evidence));
  const runBytes: Record<string, Buffer> = {};
  for (const run of source.runs) {
    const runDir = store.runDir(sessionId, (run as { run_id: string }).run_id);
    mkdirSync(runDir, { recursive: true });
    const path = join(runDir, 'run.json');
    writeFileSync(path, jsonBytes(run));
    runBytes[(run as { run_id: string }).run_id] = readFileSync(path);
  }
  let executionBytes: Buffer | undefined;
  const executionTransitionBytes: Record<string, Buffer> = {};
  if (source.execution) {
    const executionDir = store.executionDir(sessionId, source.execution.execution_id);
    mkdirSync(executionDir, { recursive: true });
    const path = store.executionPath(sessionId, source.execution.execution_id);
    writeFileSync(path, jsonBytes(source.execution));
    executionBytes = readFileSync(path);
    for (const transition of source.execution_transitions ?? []) {
      const transitionPath = store.executionTransitionPath(
        sessionId,
        source.execution.execution_id,
        transition.request_id,
      );
      mkdirSync(join(executionDir, 'transitions'), { recursive: true });
      writeFileSync(transitionPath, jsonBytes(transition));
      executionTransitionBytes[transition.request_id] = readFileSync(transitionPath);
    }
  }
  const result: LegacyV3MigrationInput = {
    ...source,
    source_bytes: {
      session: readFileSync(join(dir, 'session.json')),
      ...(executionBytes ? {
        execution: executionBytes,
        execution_transitions: executionTransitionBytes,
      } : {}),
      runs: runBytes,
      gates: readFileSync(join(dir, 'gates.json')),
      artifacts: readFileSync(join(dir, 'artifacts.json')),
      evidence: readFileSync(join(dir, 'evidence.json')),
    },
  };
  enableV3(projectRoot);
  return result;
}

function expectMigrationError(action: () => unknown, code: string): void {
  try {
    action();
    throw new Error('expected migration error');
  } catch (error) {
    expect(error).toBeInstanceOf(V3MigrationError);
    expect(error).toMatchObject({ code });
  }
}

afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('v2 to v3 pure migration projection', () => {
  it('projects a sealed session/1.3 fixture with lossless references and a final transition receipt', () => {
    const input = sealedV13Input();
    const before = structuredClone(input);
    const result = projectLegacySessionToV30(input, {
      actor_id: 'migration-operator',
      recorded_at: RECORDED_AT,
    });

    expect(input).toEqual(before);
    expect(result.session).toMatchObject({
      schema_version: 'session/3.0',
      session_id: 's',
      status: 'completed',
      activity_revision: 6,
      definition_of_done: 'migration tests pass',
      completed_at: '2026-08-12T03:00:00.000Z',
      active_run_ids: [],
    });
    expect(result.session.chain).toEqual([{
      step_id: 'step-1',
      command: 'implement',
      args: ['--focused'],
      status: 'completed',
      run_ids: ['run-1'],
      goal_ref: 'goal-1',
      decision_ref: null,
      decision_refs: ['decision-1'],
    }]);
    expect(result.session.decisions).toEqual([{
      decision_id: 'decision-1',
      after_step_id: 'step-1',
      status: 'resolved',
      evidence_refs: ['evidence-1'],
    }]);
    expect(result.runs[0]).toMatchObject({
      schema_version: 'run/3.0',
      run_id: 'run-1',
      step_id: 'step-1',
      attempt: 1,
      status: 'sealed',
      input_refs: [],
      output_refs: ['artifact-1'],
      primary_artifact_id: 'artifact-1',
      legacy_execution_generation: null,
    });
    expect(result.transition_receipt).toMatchObject({
      schema_version: 'transition-receipt/2.0',
      target_type: 'session-identity',
      target_id: 's',
      revision_before: 2,
      revision_after: 3,
      activity_revision: 6,
      result: {
        source_status_signal: 'legacy-session-sealed',
        target_status: 'completed',
        final_outcome: 'done',
        seal_summary: 'legacy complete',
      },
    });
    expect(result.report.references).toEqual({
      validated: true,
      run_count: 1,
      chain_step_count: 1,
      gate_count: 1,
      artifact_count: 1,
      evidence_count: 1,
    });
    expect(result.report.source_snapshots.map(snapshot => snapshot.kind)).toEqual([
      'session', 'run', 'gates', 'artifacts', 'evidence',
    ]);
    expect(result.report.source_snapshots.every(snapshot => snapshot.hash_basis === 'canonical-json-v1')).toBe(true);
    expect(result.report.target_hashes.projection).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it('projects session/2.0 + execution/1.0 + command-run/1.4, audits generation, and drops tokens', () => {
    const input = openV20Input();
    const result = projectLegacySessionToV30(input, { recorded_at: RECORDED_AT });
    const output = JSON.stringify(result);

    expect(result.session).toMatchObject({
      status: 'open',
      orchestration_revision: 9,
      activity_revision: 12,
      active_run_ids: [],
    });
    expect(result.runs[0]).toMatchObject({
      status: 'completed',
      legacy_execution_generation: 7,
      actor_id: 'legacy-migration',
      args: ['--focused'],
      output_refs: ['artifact-1'],
    });
    expect(result.report.source_status_signal).toBe('execution-active');
    expect(result.report.discarded_private_state.length).toBeGreaterThanOrEqual(4);
    expect(result.report.discarded_private_state.every(item => item.sha256.startsWith('sha256:'))).toBe(true);
    expect(result.report.publication).toMatchObject({
      api: 'SessionStore.withV30Transaction',
      atomic: true,
      dual_write: false,
      legacy_execution_storage: 'retained-read-only',
      legacy_snapshot_root: expect.stringMatching(/^legacy-v2-snapshot\/migration-/),
      legacy_snapshot_manifest_hash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    });
    for (const secret of [
      LEASE_SECRET,
      RETRY_SECRET,
      HANDOFF_SECRET,
      OPERATION_SECRET,
      SESSION_RETRY_SECRET,
      ORCHESTRATION_LEASE_SECRET,
    ]) {
      expect(output).not.toContain(secret);
    }
  });

  it.each([
    ['archived_at', v20Session({ archived_at: '2026-08-12T03:30:00.000Z', archived_by: 'operator' }), execution('active'), 'archived'],
    // The paused status was retired in the v3 simplification: a legacy paused
    // execution migrates to open instead.
    ['paused execution', v20Session(), execution('paused'), 'open'],
    ['sealed done', v20Session({ current_execution_id: null }), execution('sealed', 'done'), 'completed'],
    ['sealed concerns', v20Session({ current_execution_id: null }), execution('sealed', 'done_with_concerns'), 'completed'],
    ['sealed failed', v20Session({ current_execution_id: null }), execution('sealed', 'failed'), 'failed'],
    ['no execution', v20Session({ current_execution_id: null, latest_execution_id: null }), null, 'open'],
  ])('maps %s to the expected v3 status', (_case, session, legacyExecution, expected) => {
    const run = legacyExecution === null ? runV13() : runV14('sealed');
    const registry = registries();
    const result = projectLegacySessionToV30({
      session: session as SessionIdentityV20,
      execution: legacyExecution as ExecutionState | null,
      runs: [run],
      ...registry,
    }, { recorded_at: RECORDED_AT });
    expect(result.session.status).toBe(expected);
  });

  it('projects orphaned running/failed chain steps (no Run snapshot) to pending so migration cannot deadlock', () => {
    // Crash residue: a chain step marked running/failed without any Run
    // snapshot. Rejecting it would deadlock under the v3 default writer
    // (nothing can repair the legacy step); it must project to pending.
    for (const orphanStatus of ['running', 'failed'] as const) {
      const exec = execution('active');
      exec.chain = [{
        step_id: 'step-1',
        command: 'implement',
        status: orphanStatus,
        run_id: null,
        inserted_by: 'legacy',
        decision_ref: null,
        args: '--orphan',
        stage: null,
        goal_ref: null,
        retry: { count: 0, max: 2 },
      }];
      exec.decision_points = [];
      const input: LegacyV3MigrationInput = {
        session: { ...v20Session(), latest_completed_run_id: null },
        execution: exec,
        runs: [],
        gates: createGateRegistry(),
        artifacts: createArtifactRegistry(),
        evidence: createEvidenceStore(),
      };
      const projected = projectLegacySessionToV30(input, { recorded_at: RECORDED_AT });
      expect(projected.session.chain[0]).toMatchObject({ step_id: 'step-1', status: 'pending' });
      expect(projected.session.active_run_ids).toEqual([]);
    }
  });

  it('migrates a running Run as running (deadlock escape under the v3 default writer) and rejects every dangling reference fail closed', () => {
    // A legacy running Run must migrate as running: rejecting it made
    // `session migrate` demand a Run completion that the v3 surface refused
    // (SESSION_INACCESSIBLE on the legacy Run) — an unreachable precondition.
    const running = openV20Input();
    running.runs = [runV14('running')];
    const projected = projectLegacySessionToV30(running, { recorded_at: RECORDED_AT });
    expect(projected.runs[0]).toMatchObject({ status: 'running' });
    expect(projected.session.active_run_ids).toEqual(['run-1']);
    // The chain step keeps its source status; the active run stays bound.
    expect(projected.session.chain).toEqual(expect.arrayContaining([
      expect.objectContaining({ run_ids: ['run-1'] }),
    ]));

    const mutations: Array<(input: LegacyV3MigrationInput) => void> = [
      input => { (input.runs[0] as ReturnType<typeof runV14>).chain_step_id = 'missing-step'; },
      input => { (input.runs[0] as ReturnType<typeof runV14>).output.produces = ['missing-artifact']; },
      input => { input.gates.gates['gate-1'].evidence_refs = ['missing-evidence']; },
      input => {
        input.gates.gates['gate-1'].check = {
          type: 'schema', artifact_ref: 'missing-artifact', schema_id: 'report/1.0',
        };
      },
      input => { input.artifacts.artifacts['artifact-1'].producer_run_id = 'missing-run'; },
      input => { input.evidence.records['evidence-1'].gate_refs = ['missing-gate']; },
      input => { input.session.latest_completed_run_id = 'missing-run'; },
    ];
    for (const mutate of mutations) {
      const input = openV20Input();
      mutate(input);
      expectMigrationError(
        () => projectLegacySessionToV30(input, { recorded_at: RECORDED_AT }),
        'MIGRATION_REFERENCE_INTEGRITY',
      );
    }
  });
});

describe('v3 migration atomic publication', () => {
  it('uses source-byte hashes, replaces legacy authority atomically, retains old execution bytes, and replays', () => {
    const projectRoot = root();
    const input = persistLegacy(projectRoot, openV20Input());
    const store = new SessionStore(projectRoot);
    const executionPath = store.executionPath('s', 'execution-7');
    const legacyExecutionBytes = readFileSync(executionPath);
    const legacySessionBytes = input.source_bytes!.session as Buffer;

    expect(() => store.writeSessionV30(projectLegacySessionToV30(input, { recorded_at: RECORDED_AT }).session))
      .toThrow(/requires the migration engine/);
    const applied = applyV3Migration(store, input, { recorded_at: RECORDED_AT });

    expect(applied.status).toBe('applied');
    expect(store.readSessionV30('s')).toEqual(applied.session);
    expect(store.readRunV30('s', 'run-1')).toEqual(applied.runs[0]);
    expect(store.readTransitionReceiptV20(
      's',
      applied.transition_receipt.activity_revision,
      applied.transition_receipt.transition_id,
    )).toEqual(applied.transition_receipt);
    expect(migrationReportV1Schema.parse(JSON.parse(readFileSync(applied.report_path, 'utf8'))))
      .toEqual(applied.report);
    expect(readFileSync(executionPath)).toEqual(legacyExecutionBytes);
    expect(applied.report.source_snapshots.find(snapshot => snapshot.kind === 'session')).toMatchObject({
      hash_basis: 'source-bytes',
      sha256: sha256Digest(legacySessionBytes),
    });
    const snapshotRoot = join(store.sessionDir('s'), applied.report.publication.legacy_snapshot_root);
    const snapshotSessionBytes = readFileSync(join(snapshotRoot, 'session.json'));
    const snapshotRunBytes = readFileSync(join(snapshotRoot, 'runs', 'run-1', 'run.json'));
    const manifestBytes = readFileSync(join(snapshotRoot, 'manifest.json'));
    expect(JSON.parse(manifestBytes.toString('utf8'))).toMatchObject({
      schema_version: 'legacy-v2-snapshot-manifest/1.0',
      migration_id: applied.report.migration_id,
      files: expect.arrayContaining([
        {
          path: 'session.json',
          source_sha256: sha256Digest(legacySessionBytes),
          snapshot_sha256: sha256Digest(snapshotSessionBytes),
        },
        {
          path: 'runs/run-1/run.json',
          source_sha256: sha256Digest(input.source_bytes!.runs!['run-1']),
          snapshot_sha256: sha256Digest(snapshotRunBytes),
        },
      ]),
    });

    const authorityTexts = [
      readFileSync(join(store.sessionDir('s'), 'session.json'), 'utf8'),
      readFileSync(join(store.runDir('s', 'run-1'), 'run.json'), 'utf8'),
      readFileSync(applied.report_path, 'utf8'),
      readFileSync(store.transitionReceiptV20Path(
        's',
        applied.transition_receipt.activity_revision,
        applied.transition_receipt.transition_id,
      ), 'utf8'),
    ].join('\n');
    const snapshotTexts = [
      snapshotSessionBytes.toString('utf8'),
      snapshotRunBytes.toString('utf8'),
      readFileSync(join(snapshotRoot, 'executions', 'execution-7', 'execution.json'), 'utf8'),
      manifestBytes.toString('utf8'),
    ].join('\n');
    for (const secret of [LEASE_SECRET, RETRY_SECRET, HANDOFF_SECRET, OPERATION_SECRET]) {
      expect(authorityTexts).not.toContain(secret);
      expect(snapshotTexts).not.toContain(secret);
    }

    const replay = applyV3Migration(store, input, { recorded_at: RECORDED_AT });
    expect(replay.status).toBe('already-applied');
    expect(replay.report).toEqual(applied.report);
    expect(readAppliedV3Migration(store, 's')).toMatchObject({
      status: 'already-applied', report: applied.report, transition_receipt: applied.transition_receipt,
    });
    const snapshotSessionBeforeTamper = readFileSync(join(snapshotRoot, 'session.json'));
    writeFileSync(join(snapshotRoot, 'session.json'), '{}\n');
    expect(() => readAppliedV3Migration(store, 's'))
      .toThrowError(expect.objectContaining({ code: 'MIGRATION_CONFLICT' }));
    writeFileSync(join(snapshotRoot, 'session.json'), snapshotSessionBeforeTamper);
    expect(() => applyV3Migration(store, input, {
      recorded_at: '2026-08-12T05:00:00.000Z',
    })).toThrowError(expect.objectContaining({ code: 'MIGRATION_CONFLICT' }));
  });

  it('loads, hashes, audits, redacts, and projects selected Execution transition history', () => {
    const projectRoot = root();
    const source = openV20Input();
    source.execution = execution('paused');
    const transition = executionTransition();
    source.execution_transitions = [transition];
    persistLegacy(projectRoot, source);
    const store = new SessionStore(projectRoot);
    const transitionPath = store.executionTransitionPath('s', 'execution-7', transition.request_id);
    const transitionBytes = readFileSync(transitionPath);

    const loaded = loadLegacyV3MigrationInput(store, 's');
    expect(loaded.execution_transitions).toEqual([transition]);
    expect(loaded.source_bytes!.execution_transitions![transition.request_id]).toEqual(transitionBytes);

    const applied = applyV3Migration(store, loaded, { recorded_at: RECORDED_AT });
    expect(applied.report.source_snapshots.find(snapshot => (
      snapshot.kind === 'execution-transition' && snapshot.source_id === transition.request_id
    ))).toEqual({
      kind: 'execution-transition',
      source_id: transition.request_id,
      sha256: sha256Digest(transitionBytes),
      hash_basis: 'source-bytes',
    });
    expect(applied.report.retired_execution_transitions).toEqual([{
      source_id: transition.request_id,
      disposition: 'projected-v3-receipt',
      projected_transition_id: transition.outcome.transition_id,
      projected_activity_revision: transition.outcome.postconditions.session_activity_revision,
      reason: 'legacy Execution transition projected without private lease or handoff credentials',
    }]);
    expect(applied.legacy_transition_receipts).toHaveLength(1);
    const migratedReceipt = applied.legacy_transition_receipts[0];
    expect(store.readTransitionReceiptV20(
      's', migratedReceipt.activity_revision, migratedReceipt.transition_id,
    )).toEqual(migratedReceipt);
    expect(migratedReceipt).toMatchObject({
      transition_id: transition.outcome.transition_id,
      request_id: transition.request_id,
      target_type: 'orchestration',
      revision_before: 8,
      revision_after: 9,
      actor_id: 'migration-reviewer',
      result: {
        legacy_operation: 'execution-pause',
        legacy_request_hash: transition.payload.normalized_request_hash,
        legacy_result_hash: transition.outcome.result_hash,
      },
    });

    const snapshotTransition = readFileSync(join(
      store.sessionDir('s'),
      applied.report.publication.legacy_snapshot_root,
      'executions',
      'execution-7',
      'transitions',
      `${transition.request_id}.json`,
    ), 'utf8');
    const authority = JSON.stringify({
      report: applied.report,
      receipt: migratedReceipt,
      session: applied.session,
      runs: applied.runs,
    });
    for (const secret of [HANDOFF_SECRET, TRANSITION_PRIVATE_SECRET]) {
      expect(snapshotTransition).not.toContain(secret);
      expect(authority).not.toContain(secret);
    }
    expect(applied.report.discarded_private_state.length).toBeGreaterThan(0);
    const replay = applyV3Migration(store, loaded, { recorded_at: RECORDED_AT });
    expect(replay).toMatchObject({
      status: 'already-applied',
      legacy_transition_receipts: [migratedReceipt],
    });
    expect(readAppliedV3Migration(store, 's')).toMatchObject({
      status: 'already-applied',
      legacy_transition_receipts: [migratedReceipt],
    });
  });

  it('rejects a changed source before enqueueing any transaction writes', () => {
    const projectRoot = root();
    const input = persistLegacy(projectRoot, sealedV13Input());
    const store = new SessionStore(projectRoot);
    const sessionPath = join(store.sessionDir('s'), 'session.json');
    const changed = JSON.parse(readFileSync(sessionPath, 'utf8')) as SessionState;
    changed.intent = 'changed after projection';
    writeFileSync(sessionPath, jsonBytes(changed));

    expectMigrationError(
      () => applyV3Migration(store, input, { recorded_at: RECORDED_AT }),
      'MIGRATION_SOURCE_CHANGED',
    );
    expect(JSON.parse(readFileSync(sessionPath, 'utf8')).schema_version).toBe('session/1.3');
    expect(JSON.parse(readFileSync(join(store.runDir('s', 'run-1'), 'run.json'), 'utf8')).schema_version)
      .toBe('command-run/1.3');
    expect(() => readFileSync(join(store.sessionDir('s'), 'v3-migration-report.json'))).toThrow();
    expect(() => readFileSync(store.transitionReceiptV20Path(
      's',
      input.session.activity_revision + 1,
      projectLegacySessionToV30(input, { recorded_at: RECORDED_AT }).transition_receipt.transition_id,
    ))).toThrow();
  });

  it('rejects invalid references before any store publication and migrates running Runs atomically', () => {
    for (const source of [openV20Input(), openV20Input()]) {
      const projectRoot = root();
      if (roots.length % 2 === 0) {
        // A running Run is a valid migration subject (deadlock escape); apply
        // it atomically and verify the v3 state became authoritative.
        const input = persistLegacy(projectRoot, { ...source, runs: [runV14('running')] });
        const store = new SessionStore(projectRoot);
        const applied = applyV3Migration(store, input, { recorded_at: RECORDED_AT });
        expect(applied.runs[0]).toMatchObject({ status: 'running' });
        expect(JSON.parse(readFileSync(join(store.sessionDir('s'), 'session.json'), 'utf8')).schema_version)
          .toBe('session/3.0');
        continue;
      } else {
        source.gates.gates['gate-1'].evidence_refs = ['missing-evidence'];
      }
      const input = persistLegacy(projectRoot, source);
      const store = new SessionStore(projectRoot);
      expect(() => applyV3Migration(store, input, { recorded_at: RECORDED_AT })).toThrow();
      expect(JSON.parse(readFileSync(join(store.sessionDir('s'), 'session.json'), 'utf8')).schema_version)
        .toBe('session/2.0');
      expect(() => readFileSync(join(store.sessionDir('s'), 'v3-migration-report.json'))).toThrow();
    }
  });

  it('migrates a multi-generation Session: the selected Execution binds its own Runs while historical sealed Runs stay read-only', () => {
    // session/2.0 references execution-B (current) but historical generation-1
    // Runs remain under runs/ bound to a sealed execution-A. The projection
    // must not assert those historical Runs against the selected Execution.
    const session = v20Session();
    const execB = execution('active');
    const execA = executionStateSchema.parse({
      ...execution('sealed', 'done'),
      execution_id: 'execution-1',
      generation: 1,
    });
    const runB = runV14();
    const runA = commandRunV14Schema.parse({
      ...runV14('sealed'),
      run_id: 'run-0',
      execution_id: 'execution-1',
      generation: 1,
      chain_step_id: 'step-1',
      handoff: null,
    });
    const input: LegacyV3MigrationInput = {
      session,
      execution: execB,
      runs: [runA, runB],
      ...registries(),
    };
    const result = projectLegacySessionToV30(input, { recorded_at: RECORDED_AT });
    expect(result.runs.map(run => run.run_id).sort()).toEqual(['run-0', 'run-1']);
    const historical = result.runs.find(run => run.run_id === 'run-0');
    expect(historical).toMatchObject({
      status: 'sealed',
      legacy_execution_generation: 1,
    });
    expect(result.report.publication).toMatchObject({
      legacy_execution_storage: 'retained-read-only',
    });
    // The migrated Session owns both Runs; the current Run binds the selected
    // Execution's generation.
    const current = result.runs.find(run => run.run_id === 'run-1');
    expect(current).toMatchObject({ legacy_execution_generation: 7 });
  });
});
