import { readFileSync, mkdirSync, writeFileSync,} from 'node:fs';
import { describe, expect, it } from 'vitest';

function v2Workspace(root: string): void {
  mkdirSync(join(root, ".workflow"), { recursive: true });
  writeFileSync(join(root, ".workflow", "config.json"), JSON.stringify({
    session_schema: { schema_version: "session-schema-selection/1.0", writer: "session/1.3", features: { session_statusless: false } },
  }));
}
import {
  commandRunReadSchema,
  commandRunSchema,
  commandRunV12Schema,
  commandRunV13Schema,
  commandRunV14Schema,
  commandRunV11Schema,
  executionLeaseSchema,
  executionStateSchema,
  goalBindingSchema,
  normalizeCommandRunV14,
  projectSessionSchemaConfigSchema,
  runReadSchema,
  runV30Schema,
  sessionSchemaSelectionSchema,
  sessionStateReadSchema,
  sessionStateV12Schema,
  sessionStateV13Schema,
  sessionStateV20Schema,
  sessionStateV30Schema,
  sessionStateSchema,
} from './schemas.js';
import {
  DEFAULT_SESSION_SCHEMA_SELECTION,
  createSessionIdentityV20,
  createSessionState,
} from './defaults.js';

const hash = 'a'.repeat(64);

function legacyRun(): Record<string, unknown> {
  return {
    schema_version: 'command-run/1.0',
    session_id: 's',
    run_id: 'r1',
    sequence: 1,
    parent_run_id: null,
    command: {
      name: 'demo', version: '1.0', source_path: 'demo.md', content_hash: hash, resolved_prompt_hash: hash,
    },
    status: 'running',
    input: { args: [], consumes: [], context_identity_revision: 0 },
    gate_ids: [],
    output: { produces: [], primary_artifact_id: null, verdict: null },
    handoff: null,
    started_at: '2026-07-17T00:00:00.000Z',
    completed_at: null,
    sealed_at: null,
  };
}

describe('command Run schema compatibility', () => {
  it('strictly reads 1.0 and normalizes it for runtime use', () => {
    expect(commandRunReadSchema.parse(legacyRun()).schema_version).toBe('command-run/1.0');
    const normalized = commandRunSchema.parse(legacyRun());
    expect(normalized).toMatchObject({
      schema_version: 'command-run/1.3',
      chain_step_id: null,
      resolved_platform: 'claude',
      goal_binding: null,
      checkpoint_expectation: null,
      checkpoint: null,
      retry_fence: null,
      contract_snapshot: null,
      guidance_snapshot: null,
      creation_decision: null,
      creation_provenance: expect.objectContaining({ provenance: 'legacy-inferred' }),
      transition: null,
      input: expect.objectContaining({ reuse_assessments: [] }),
      command: expect.not.objectContaining({ contract_hash: expect.anything() }),
    });
  });

  it('strictly reads 1.1 and normalizes its authority fields to 1.3', () => {
    const current = {
      ...legacyRun(),
      schema_version: 'command-run/1.1',
      chain_step_id: 'step-001-demo',
      resolved_platform: 'codex',
      goal_binding: null,
      checkpoint_expectation: null,
      checkpoint: null,
      retry_fence: null,
      command: { ...legacyRun().command as Record<string, unknown>, contract_hash: hash },
    };
    expect(commandRunV11Schema.parse(current)).toMatchObject({
      resolved_platform: 'codex',
      command: { contract_hash: hash },
    });
    expect(commandRunSchema.parse(current)).toMatchObject({
      schema_version: 'command-run/1.3',
      resolved_platform: 'codex',
      contract_snapshot: null,
      guidance_snapshot: null,
      creation_decision: null,
      creation_provenance: { provenance: 'verified-v1' },
      transition: null,
      input: expect.objectContaining({ reuse_assessments: [] }),
    });
    expect(() => commandRunV11Schema.parse({ ...current, unexpected: true })).toThrow();
    expect(() => commandRunReadSchema.parse({ ...legacyRun(), resolved_platform: 'codex' })).toThrow();
  });

  it('writes command-run/1.3 while preserving a strict 1.2 reader', () => {
    const normalized = commandRunSchema.parse(legacyRun());
    expect(commandRunV13Schema.parse(normalized).schema_version).toBe('command-run/1.3');
    expect(() => commandRunV12Schema.parse({ ...normalized, schema_version: 'command-run/1.2' })).toThrow(/reuse_assessments/);
    const oldShape = structuredClone(normalized);
    oldShape.schema_version = 'command-run/1.2';
    delete (oldShape.input as Record<string, unknown>).reuse_assessments;
    expect(commandRunV12Schema.parse(oldShape).schema_version).toBe('command-run/1.2');
    // Unknown future versions are accepted via passthrough fallback
    const unknownRun = commandRunReadSchema.parse({ ...legacyRun(), schema_version: 'command-run/9.0' });
    expect(unknownRun.schema_version).toBe('command-run/9.0');
  });

  it('keeps command-run/1.3 as the compatibility writer and supports explicit 1.4 binding', () => {
    const compatibilityRun = commandRunSchema.parse(legacyRun());
    expect(compatibilityRun.schema_version).toBe('command-run/1.3');

    const bound = normalizeCommandRunV14(legacyRun(), { execution_id: 'exec-1', generation: 1 });
    expect(commandRunV14Schema.parse(bound)).toMatchObject({
      schema_version: 'command-run/1.4',
      session_id: 's',
      execution_id: 'exec-1',
      generation: 1,
    });
    expect(commandRunReadSchema.parse(bound).schema_version).toBe('command-run/1.4');
    expect(commandRunSchema.parse(bound)).toMatchObject({ schema_version: 'command-run/1.3' });
    expect(() => normalizeCommandRunV14(legacyRun())).toThrow(/execution binding is required/);
    expect(() => commandRunV14Schema.parse({ ...bound, unexpected: true })).toThrow();
    expect(() => commandRunV14Schema.parse({ ...bound, generation: 0 })).toThrow();
  });

  it('adds reuse-assessment/1.1 only to command-run/1.4 read/write support', () => {
    const bound = normalizeCommandRunV14(legacyRun(), { execution_id: 'exec-1', generation: 1 });
    const receiptHash = `sha256:${hash}`;
    const assessment = {
      schema_version: 'reuse-assessment/1.1' as const,
      decision: 'REUSE' as const,
      reason_codes: ['REUSE_ELIGIBLE'],
      consumer: { kind: 'context', alias: 'current-context', schema: 'context/1.0', role: 'primary' as const },
      source_fence: {
        schema_version: 'reuse-source-fence/1.1' as const,
        workspace_id: receiptHash,
        session_id: 's',
        producer_run_id: 'producer',
        producer_run_hash: receiptHash,
        producer_status: 'sealed' as const,
        artifact_id: 'artifact-1',
        artifact_role: 'primary',
        artifact_status: 'sealed' as const,
        artifact_hash: receiptHash,
        observed_artifact_hash: receiptHash,
        artifact_schema: 'context/1.0',
        artifact_registry_revision: 1,
        producer_contract_hash: receiptHash,
        execution_seal_receipt: {
          execution_id: 'exec-source', generation: 1, sealed_at: '2026-07-20T00:00:00.000Z',
          relative_path: 'executions/exec-source/seal-receipt.json', overall_hash: receiptHash,
        },
      },
      assessment_hash: receiptHash,
    };
    const current = {
      ...bound,
      input: { ...bound.input, reuse_assessments: [assessment] },
    };
    expect(commandRunV14Schema.parse(current).input.reuse_assessments).toEqual([assessment]);
    expect(commandRunReadSchema.parse(current).schema_version).toBe('command-run/1.4');
    expect(commandRunSchema.parse(current).input.reuse_assessments).toEqual([assessment]);
    const {
      execution_id: _executionId,
      generation: _generation,
      ...legacyWriterShape
    } = current;
    expect(() => commandRunV13Schema.parse({
      ...legacyWriterShape,
      schema_version: 'command-run/1.3',
    })).toThrow();
  });

  it('validates strict execution and execution lease 1.0 entities', () => {
    const lease = {
      schema_version: 'execution-lease/1.0' as const,
      session_id: 's',
      execution_id: 'exec-1',
      owner_id: 'pi-session-1',
      owner_kind: 'pi' as const,
      epoch: 1,
      lease_id: 'private-token',
      acquired_at: '2026-07-20T00:00:00.000Z',
      heartbeat_at: '2026-07-20T00:00:01.000Z',
      handoff_to: null,
    };
    expect(executionLeaseSchema.parse(lease)).toEqual(lease);

    const execution = {
      schema_version: 'execution/1.0' as const,
      execution_id: 'exec-1',
      session_id: 's',
      generation: 1,
      status: 'active' as const,
      revision: 0,
      active_run_id: null,
      chain: [],
      decision_points: [],
      gates_ref: 'gates.json',
      artifacts_ref: 'artifacts.json',
      evidence_ref: 'evidence.json',
      lease,
      started_at: '2026-07-20T00:00:00.000Z',
      sealed_at: null,
      seal_summary: null,
      final_outcome: null,
    };
    expect(executionStateSchema.parse(execution)).toEqual(execution);
    expect(() => executionLeaseSchema.parse({ ...lease, unexpected: true })).toThrow();
    expect(() => executionLeaseSchema.parse({ ...lease, epoch: 0 })).toThrow();
    expect(() => executionStateSchema.parse({ ...execution, unexpected: true })).toThrow();
  });

  it('accepts an observational Goal binding with a nullable external ID', () => {
    expect(goalBindingSchema.parse({
      provider: 'codex',
      external_id: null,
      step_goal_ref: 'G1',
      observed_status: 'active',
      observed_at: '2026-07-17T00:00:00.000Z',
    }).external_id).toBeNull();
    expect(() => goalBindingSchema.parse({
      provider: 'codex', external_id: null, step_goal_ref: null, observed_status: 'done', observed_at: 'now',
    })).toThrow();
  });
});

describe('Session schema compatibility', () => {
  it('strictly discriminates mixed 1.x/2.0 fixtures without projecting 2.0 to 1.3', () => {
    const fixtures = JSON.parse(readFileSync(
      new URL('./__fixtures__/session-mixed-versions.json', import.meta.url),
      'utf8',
    )) as unknown[];
    const records = fixtures.map(fixture => sessionStateReadSchema.parse(fixture));
    expect(records.map(record => record.schema_version)).toEqual(['session/1.0', 'session/2.0']);
    expect(records[1]).toEqual(fixtures[1]);
    expect(() => sessionStateSchema.parse(fixtures[1])).toThrow();
  });

  it('keeps session/2.0 statusless and rejects legacy execution authority fields', () => {
    const identity = createSessionIdentityV20('s-v2', 'statusless', {
      currentExecutionId: 'execution-1',
      latestExecutionId: 'execution-1',
    });
    expect(sessionStateV20Schema.parse(identity)).toEqual(identity);
    for (const forbidden of [
      'status', 'active_run_id', 'orchestration', 'chain', 'decision_points',
      'gates', 'artifacts', 'evidence',
    ]) {
      expect(() => sessionStateV20Schema.parse({ ...identity, [forbidden]: null })).toThrow();
    }
    expect(() => sessionStateV20Schema.parse({ ...identity, archived_at: 'now', archived_by: null })).toThrow();
  });

  it('strictly reads session/3.0 and run/3.0 without legacy normalization', () => {
    const session = {
      schema_version: 'session/3.0' as const,
      session_id: 's-v3',
      objective: 'ship minimal v3',
      definition_of_done: 'contract tests pass',
      status: 'open' as const,
      orchestration_revision: 2,
      activity_revision: 3,
      chain: [{
        step_id: 'step-1', command: 'implement', args: [], status: 'running' as const,
        run_ids: ['run-1'], goal_ref: null, decision_ref: null, decision_refs: ['decision-1'],
      }],
      decisions: [{
        decision_id: 'decision-1', after_step_id: 'step-1', status: 'open' as const, evidence_refs: [],
      }],
      active_run_ids: ['run-1'],
      artifacts_ref: 'artifacts.json', evidence_ref: 'evidence.json',
      created_at: '2026-08-12T00:00:00.000Z', updated_at: '2026-08-12T00:01:00.000Z',
      completed_at: null, archived_at: null,
    };
    const run = {
      schema_version: 'run/3.0' as const,
      run_id: 'run-1', session_id: 's-v3', step_id: 'step-1',
      parent_run_id: null, retry_of_run_id: 'run-0', attempt: 2,
      command: 'implement', args: ['--focused'], goal: 'contract foundation',
      status: 'running' as const, revision: 4,
      actor_id: 'codex', input_refs: ['artifact-input'], output_refs: [], primary_artifact_id: null,
      verdict: null, summary: null, legacy_execution_generation: 7,
      created_at: '2026-08-12T00:00:00.000Z', started_at: '2026-08-12T00:00:01.000Z',
      ended_at: null, sealed_at: null,
    };

    expect(sessionStateV30Schema.parse(session)).toEqual(session);
    expect(sessionStateReadSchema.parse(session)).toEqual(session);
    expect(() => sessionStateSchema.parse(session)).toThrow();
    expect(runV30Schema.parse(run)).toEqual(run);
    expect(runReadSchema.parse(run)).toEqual(run);
    expect(() => commandRunReadSchema.parse(run)).toThrow();
    expect(() => sessionStateV30Schema.parse({ ...session, current_execution_id: null })).toThrow();
    expect(() => runV30Schema.parse({ ...run, execution_id: 'exec-1' })).toThrow();
  });

  it('reads pre-simplification session/3.0 and run/3.0 documents with retired fields and the retired paused status', () => {
    const newSession = sessionStateV30Schema.parse({
      schema_version: 'session/3.0', session_id: 's-old', objective: 'old', definition_of_done: 'done',
      status: 'open', orchestration_revision: 1, activity_revision: 1,
      chain: [], decisions: [], active_run_ids: [],
      artifacts_ref: 'artifacts.json', evidence_ref: 'evidence.json',
      created_at: '2026-08-12T00:00:00.000Z', updated_at: '2026-08-12T00:00:00.000Z',
      completed_at: null, archived_at: null,
    });
    const legacySession = {
      ...newSession,
      // Retired fields and status written by pre-simplification engines.
      identity_revision: 1,
      gates_ref: 'gates.json',
      status: 'paused',
    };
    // The strict writer schema rejects retired fields and the retired status...
    expect(() => sessionStateV30Schema.parse(legacySession)).toThrow();
    // ...while the read path tolerates them: retired keys are stripped and the
    // paused status stays readable (callers map it to open on the engine read).
    const parsed = sessionStateReadSchema.parse(legacySession);
    expect(parsed).toMatchObject({ schema_version: 'session/3.0', status: 'paused' });
    expect(parsed).not.toHaveProperty('identity_revision');
    expect(parsed).not.toHaveProperty('gates_ref');

    const legacyRun = {
      schema_version: 'run/3.0' as const,
      run_id: 'run-old', session_id: 's-old', step_id: 'step-1',
      parent_run_id: null, retry_of_run_id: null, attempt: 1,
      command: 'implement', args: [], goal: null,
      status: 'running' as const, revision: 0,
      actor_id: 'codex',
      participant_id: 'pi-window-a',
      gate_refs: ['gate-1'],
      input_refs: [], output_refs: [], primary_artifact_id: null,
      verdict: null, summary: null,
      created_at: '2026-08-12T00:00:00.000Z', started_at: null, ended_at: null, sealed_at: null,
    };
    expect(() => runV30Schema.parse(legacyRun)).toThrow();
    const parsedRun = runReadSchema.parse(legacyRun);
    expect(parsedRun).toMatchObject({ schema_version: 'run/3.0', actor_id: 'codex' });
    expect(parsedRun).not.toHaveProperty('participant_id');
    expect(parsedRun).not.toHaveProperty('gate_refs');
  });

  it('defaults to session/3.0 and requires a coherent explicit 2.0 feature selection', () => {
    expect(DEFAULT_SESSION_SCHEMA_SELECTION).toEqual({
      schema_version: 'session-schema-selection/1.0',
      writer: 'session/3.0',
      features: { session_statusless: false },
    });
    const enabled = {
      schema_version: 'session-schema-selection/1.0' as const,
      writer: 'session/2.0' as const,
      features: { session_statusless: true },
    };
    expect(sessionSchemaSelectionSchema.parse(enabled)).toEqual(enabled);
    const v3 = {
      schema_version: 'session-schema-selection/1.0' as const,
      writer: 'session/3.0' as const,
      features: { session_statusless: false },
    };
    expect(sessionSchemaSelectionSchema.parse(v3)).toEqual(v3);
    expect(projectSessionSchemaConfigSchema.parse({ session_schema: enabled, workspaces: { linked: [] } }))
      .toMatchObject({ session_schema: enabled });
    expect(() => sessionSchemaSelectionSchema.parse({
      ...enabled,
      features: { session_statusless: false },
    })).toThrow(/session_statusless/);
  });

  it('writes session/1.3 while preserving a strict 1.2 reader', () => {
    const current = createSessionState('s', 'intent');
    expect(sessionStateV13Schema.parse(current).schema_version).toBe('session/1.3');
    expect(() => sessionStateV12Schema.parse({ ...current, schema_version: 'session/1.2' })).toThrow(/topic_identity/);
    const oldShape = structuredClone(current) as Record<string, unknown>;
    delete oldShape.topic_identity;
    oldShape.schema_version = 'session/1.2';
    expect(sessionStateV12Schema.parse(oldShape).schema_version).toBe('session/1.2');
    const legacy = structuredClone(current) as Record<string, unknown>;
    delete legacy.intent_identity;
    delete legacy.topic_identity;
    delete legacy.provenance;
    delete legacy.ralph_authority;
    legacy.schema_version = 'session/1.1';
    expect(sessionStateSchema.parse(legacy)).toMatchObject({
      schema_version: 'session/1.3',
      topic_identity: null,
      provenance: { source: 'legacy-inferred' },
    });
    // Unknown future versions are accepted via passthrough fallback
    const unknownSession = sessionStateSchema.parse({ ...current, schema_version: 'session/9.0' });
    expect(unknownSession.schema_version).toBe('session/9.0');
  });
});
