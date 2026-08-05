import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createRunResponseError,
  createRunResponseSuccess,
  emitRunResponse,
  runResponseSchema,
  stableRunResponseErrorCode,
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
