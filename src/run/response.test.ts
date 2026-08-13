import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createRunResponseError,
  createRunResponseSuccess,
  emitRunResponse,
  redactRunResponseLeaseTokens,
  runResponseSchema,
  stableRunResponseErrorCode,
  stableRunResponseErrorCodeV11,
  stableRunResponseErrorCodeV12,
} from './response.js';

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

describe('run-response/1.0', () => {
  it('accepts every required run-response operation', () => {
    const next = { suggest_only: true as const, command: 'maestro run check r', reason: 'check the Run' };
    const hash = `sha256:${'a'.repeat(64)}`;
    const briefResult = {
      schema_version: 'brief-result/1.1' as const,
      session_id: 's', run_id: 'r', run_dir: '.workflow/sessions/s/runs/r', upstream: {},
      session: {
        session_id: 's', intent: 'test brief', status: 'running' as const,
        identity_revision: 0, activity_revision: 0, active_run_id: 'r', open_decisions: [],
      },
      run: {
        run_id: 'r', run_dir: '.workflow/sessions/s/runs/r', chain_step_id: null,
        resolved_platform: 'codex' as const, status: 'running' as const,
      },
      guidance: {
        prepare: null, workflow: null, run_mode: null, refs: [], goal_mode: null,
        freshness: {
          status: 'unavailable' as const, changed: [], captured: null,
          current: {
            schema_version: 'guidance-snapshot/1.0' as const,
            source_path: '.claude/commands/demo.md', content_hash: hash, resolved_prompt_hash: hash,
            prepare_hash: null, workflow_hash: null, run_mode_hash: null,
          },
        },
      },
      execution_contract: {
        schema_version: 'execution-contract/1.1' as const,
        command: 'demo', invocation: { args: [] },
        guidance: { prepare_path: null, workflow_path: null, run_mode_path: null },
        inputs: [], outputs: { declared: [], actual: [] }, gates: { registry_revision: 0, items: [] },
        contract: { version: 'command-contract/1.0' as const, snapshot_hash: null, warnings: [], drift: 'none' as const },
        freshness: {
          captured_at: '2026-07-19T00:00:00.000Z', run_context_identity_revision: 0,
          session_identity_revision: 0, session_activity_revision: 0,
          identity_current: true, command_contract_hash: null,
        },
        argument_requirements: [], reuse_assessments: [],
      },
      knowledge_context: {
        schema_version: 'knowledge-reconciliation-card/1.0' as const,
        run: {
          unique_inputs: 0,
          signals: { consumed: 0, cited: 0, validated: 0, contradicted: 0 },
          knowledge_ids: [],
        },
        session: {
          unique_inputs: 0,
          pending_candidates: 0,
          corroborated_candidates: 0,
          promoting_candidates: 0,
          promoted_candidates: 0,
        },
        policy: {
          search_and_injection: 'exposure_only' as const,
          explicit_load: 'consumed' as const,
          record: 'explicit_attribution' as const,
          completion: 'stage_candidates' as const,
          promotion: 'explicit_review' as const,
        },
        review: {
          command: 'maestro knowledge review s',
          promote_template: 'maestro knowledge promote s --candidate <candidate-id>',
        },
      },
      continuity: {
        prev_handoff: null,
        anchor: { intent: null, boundary_contract: null, progress: null, signals: null },
      },
      recovery: { next },
    };
    const operations = [
      'create', 'next', 'complete', 'brief', 'recall', 'resolve', 'resume', 'fork', 'import',
      'check', 'decide', 'seal-session', 'chain-insert', 'chain-replace', 'chain-skip', 'meta-update',
    ] as const;
    for (const operation of operations) {
      const replay = ['decide', 'resolve', 'resume', 'chain-insert', 'chain-replace', 'chain-skip', 'meta-update']
        .includes(operation)
        ? { status: 'applied' as const, transition_id: `tr-${operation}` }
        : null;
      const success = createRunResponseSuccess({
        operation,
        request_id: replay ? `req-${operation}` : null,
        locator: { session_id: 's', run_id: operation === 'check' ? 'r' : null },
        replay,
        result: operation === 'brief' ? briefResult : { operation },
        next: operation === 'brief' ? next : undefined,
      });
      const failure = createRunResponseError({
        operation,
        exit_code: 1,
        code: operation === 'seal-session' ? 'SESSION_SEAL_BLOCKED' : 'INTERNAL_ERROR',
        message: `${operation} failed`,
      });
      expect(runResponseSchema.parse(success)).toMatchObject({ operation, ok: true, exit_code: 0 });
      expect(success.continuation).toBeNull();
      expect(runResponseSchema.parse(failure)).toMatchObject({ operation, ok: false, exit_code: 1 });
    }
    const { knowledge_context: _knowledgeContext, ...legacyBrief } = briefResult;
    expect(runResponseSchema.parse(createRunResponseSuccess({
      operation: 'brief',
      locator: { session_id: 's', run_id: 'r' },
      result: { ...legacyBrief, schema_version: 'brief-result/1.0' as const },
      next,
    }))).toMatchObject({
      operation: 'brief',
      ok: true,
      result: { schema_version: 'brief-result/1.0' },
    });
  });

  it('writes explicit 1.1 envelopes with locator, fence, warnings, and redaction', () => {
    const response = createRunResponseSuccess({
      schema_version: 'run-response/1.1',
      operation: 'execution-attach',
      request_id: 'req-attach',
      locator: { session_id: 's', execution_id: 'exec-1', generation: 1, run_id: null },
      fence: {
        session_identity_revision: 2,
        session_activity_revision: 3,
        execution_revision: 4,
        lease_epoch: 5,
      },
      replay: { status: 'applied', transition_id: 'tr-attach' },
      warnings: [{
        code: 'DEPRECATED_ALIAS',
        message: 'legacy alias used',
        replacement_command: 'maestro execution attach',
      }],
      result: {
        lease_claim: {
          owner_id: 'pi-session-1',
          epoch: 5,
          lease_id: 'private-token',
        },
      },
    });

    expect(runResponseSchema.parse(response)).toMatchObject({
      schema_version: 'run-response/1.1',
      disposition: 'success',
      locator: { execution_id: 'exec-1', generation: 1 },
      fence: { execution_revision: 4, lease_epoch: 5 },
      warnings: [{ code: 'DEPRECATED_ALIAS' }],
    });
    const redacted = redactRunResponseLeaseTokens(response);
    expect(redacted.result).toEqual({ lease_claim: { owner_id: 'pi-session-1', epoch: 5 } });
    expect(JSON.stringify(redacted)).not.toContain('private-token');

    expect(() => runResponseSchema.parse({ ...response, unexpected: true })).toThrow();
    expect(() => runResponseSchema.parse({
      ...response,
      operation: 'execution-status',
    })).toThrow(/raw lease_id/);
  });

  it('writes typed 1.1 errors without changing the default 1.0 writer', () => {
    const legacy = createRunResponseError({
      operation: 'next',
      exit_code: 1,
      code: 'LEASE_CONFLICT',
      message: 'legacy conflict',
    });
    expect(legacy.schema_version).toBe('run-response/1.0');
    expect(() => runResponseSchema.parse({ ...legacy, warnings: [] })).toThrow();

    const current = createRunResponseError({
      schema_version: 'run-response/1.1',
      operation: 'execution-resume',
      exit_code: 1,
      disposition: 'domain_error',
      code: 'LEASE_FENCE_CONFLICT',
      message: 'owner epoch is stale',
      retryable: true,
      recovery_command: 'maestro execution lease status',
      locator: { session_id: 's', execution_id: 'exec-1', generation: 1, run_id: null },
    });
    expect(current).toMatchObject({
      schema_version: 'run-response/1.1',
      disposition: 'domain_error',
      error: {
        code: 'LEASE_FENCE_CONFLICT',
        retryable: true,
        recovery_command: 'maestro execution lease status',
      },
    });
    expect(() => runResponseSchema.parse({ ...current, exit_code: 2 })).toThrow();
    expect(stableRunResponseErrorCodeV11(new Error('execution revision conflict')))
      .toBe('EXECUTION_REVISION_CONFLICT');
  });

  it('writes strict 1.2 success and revision conflict envelopes with line/exit parity', () => {
    const success = createRunResponseSuccess({
      schema_version: 'run-response/1.2',
      operation: 'session-status',
      request_id: null,
      locator: { session_id: 's-v3', run_id: null },
      revision: { target_type: 'orchestration', target_id: 's-v3', revision: 2 },
      result: { status: 'open' },
    });
    expect(runResponseSchema.parse(success)).toMatchObject({
      schema_version: 'run-response/1.2', ok: true, exit_code: 0,
      revision: { target_type: 'orchestration', revision: 2 },
    });
    expect(success).not.toHaveProperty('fence');
    expect(success).not.toHaveProperty('continuation');

    const conflict = createRunResponseError({
      schema_version: 'run-response/1.2',
      operation: 'complete',
      exit_code: 1,
      disposition: 'domain_error',
      code: 'RUN_REVISION_CONFLICT',
      message: 'run revision conflict: expected 3, current 4',
      retryable: true,
      request_id: 'req-conflict',
      locator: { session_id: 's-v3', run_id: 'run-1' },
      conflict: {
        target_type: 'run', target_id: 'run-1',
        expected_revision: 3, current_revision: 4, changed_by: 'pi-window-b',
        next_actions: ['reload-run', 're-evaluate-intent', 'resubmit-with-new-request-id'],
      },
    });
    expect(runResponseSchema.parse(conflict)).toMatchObject({
      schema_version: 'run-response/1.2', ok: false, exit_code: 1,
      error: {
        code: 'RUN_REVISION_CONFLICT', target_type: 'run', target_id: 'run-1',
        expected_revision: 3, current_revision: 4, changed_by: 'pi-window-b',
      },
    });
    expect(() => createRunResponseError({
      schema_version: 'run-response/1.2',
      operation: 'complete',
      exit_code: 1,
      disposition: 'domain_error',
      code: 'RUN_REVISION_CONFLICT',
      message: 'missing conflict payload',
    })).toThrow(/required for revision conflicts/);
    expect(stableRunResponseErrorCodeV12(new Error('stale run revision: expected 3, current 4')))
      .toBe('RUN_REVISION_CONFLICT');
    expect(stableRunResponseErrorCodeV12({ code: 'SESSION_SCHEMA_UNSUPPORTED' }))
      .toBe('SESSION_SCHEMA_UNSUPPORTED');

    const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    emitRunResponse(conflict);
    expect(String(write.mock.calls[0][0]).split('\n')).toHaveLength(2);
    expect(process.exitCode).toBe(conflict.exit_code);
  });

  it('parses and emits a success envelope with exit 0', () => {
    const response = createRunResponseSuccess({
      operation: 'next',
      locator: { session_id: 's', run_id: 'r' },
      result: { run_id: 'r' },
    });
    expect(runResponseSchema.parse(response)).toMatchObject({ ok: true, exit_code: 0 });
    const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    emitRunResponse(response);
    expect(JSON.parse(String(write.mock.calls[0][0]))).toEqual(response);
    expect(process.exitCode).toBe(0);
  });

  it('parses a stable error envelope and rejects exit/code drift', () => {
    const response = createRunResponseError({
      operation: 'next',
      exit_code: 2,
      code: 'DECISION_REQUIRED',
      message: 'decision required',
      details: { point_id: 'DP-1' },
    });
    expect(response).toMatchObject({ ok: false, exit_code: 2, error: { code: 'DECISION_REQUIRED' } });
    expect(() => runResponseSchema.parse({ ...response, exit_code: 0 })).toThrow();
    expect(() => runResponseSchema.parse({
      ...response,
      error: { code: 'UNSTABLE_CODE', message: 'bad', details: {} },
    })).toThrow();
    for (const exit_code of [1, 2, 3] as const) {
      expect(createRunResponseError({
        operation: 'next',
        exit_code,
        code: exit_code === 3 ? 'RUNNING_STEP' : 'INTERNAL_ERROR',
        message: `exit ${exit_code}`,
      }).exit_code).toBe(exit_code);
    }
    expect(stableRunResponseErrorCode(new Error('chain proposal is missing or invalid')))
      .toBe('CHAIN_PROPOSAL_INVALID');
  });
});
