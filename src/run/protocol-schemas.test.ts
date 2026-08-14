import { describe, expect, it } from 'vitest';

import {
  executionLocatorSchema,
  executionSealReceiptReadSchema,
  executionSealReceiptSchema,
  executionSealReceiptV11Schema,
  maestroCapabilitiesSchema,
  requestReceiptV20Schema,
  resumeMapV1Schema,
  runOperationSchema,
  runOperationV12Schema,
  runResponseV12Schema,
  transitionReceiptV20Schema,
  recallConfirmationRecordReadSchema,
  recallConfirmationRecordSchema,
  recallConfirmationRecordV11Schema,
  reuseAssessmentReadSchema,
  reuseAssessmentSchema,
  reuseAssessmentV11Schema,
  sessionArchiveReceiptSchema,
  sourceFenceReadSchema,
  sourceFenceSchema,
  sourceFenceV11Schema,
  transitionOutcomeReadSchema,
  transitionOutcomeV11Schema,
  transitionRequestReadSchema,
  transitionRequestSchema,
  transitionRequestV11Schema,
  validatedRecallSourceReadSchema,
  validatedRecallSourceSchema,
  validatedRecallSourceV11Schema,
} from './protocol-schemas.js';

const hash = `sha256:${'a'.repeat(64)}`;

function executionFence() {
  return {
    session_identity_revision: 1,
    session_activity_revision: 2,
    execution_id: 'exec-1',
    execution_generation: 1,
    execution_revision: 3,
    execution_status: 'active' as const,
    lease_epoch: 4,
    active_run_id: 'run-1',
    run_hash: hash,
    artifact_registry_revision: 5,
  };
}

describe('versioned source and seal protocols', () => {
  it('preserves the strict legacy source fence and adds 2.0 linkage in source-fence/1.1', () => {
    const legacy = {
      workspace_id: hash,
      workspace_link_name: null,
      session_id: 's',
      session_schema_version: 'session/1.3' as const,
      session_identity_revision: 1,
      session_activity_revision: 2,
      session_hash: hash,
      run_id: 'run-1',
      run_schema_version: 'command-run/1.3' as const,
      run_hash: hash,
      artifact_registry_revision: 3,
      selected_artifacts: [],
    };
    expect(sourceFenceSchema.parse(legacy)).toEqual(legacy);
    expect(sourceFenceReadSchema.parse(legacy)).toEqual(legacy);
    expect(() => sourceFenceSchema.parse({ ...legacy, schema_version: 'source-fence/1.1' })).toThrow();
    expect(() => sourceFenceSchema.parse({ ...legacy, run_schema_version: 'command-run/1.4' })).toThrow();

    const current = {
      ...legacy,
      schema_version: 'source-fence/1.1' as const,
      session_schema_version: 'session/2.0' as const,
      run_schema_version: 'command-run/1.4' as const,
      execution_seal_receipt: {
        execution_id: 'execution-1',
        generation: 1,
        sealed_at: '2026-07-21T00:00:00.000Z',
        relative_path: 'executions/execution-1/seal-receipt.json',
        overall_hash: hash,
      },
    };
    expect(sourceFenceV11Schema.parse(current)).toEqual(current);
    expect(sourceFenceReadSchema.parse(current)).toEqual(current);
    expect(() => sourceFenceV11Schema.parse({ ...current, execution_seal_receipt: null })).toThrow();
  });

  it('keeps reuse-assessment/1.0 strict and adds a receipt-anchored 1.1 reader', () => {
    const legacy = {
      schema_version: 'reuse-assessment/1.0' as const,
      decision: 'REUSE' as const,
      reason_codes: ['REUSE_ELIGIBLE'],
      consumer: { kind: 'report', alias: 'current-report', schema: 'report/1.0', role: 'primary' as const },
      source_fence: {
        schema_version: 'reuse-source-fence/1.0' as const,
        workspace_id: hash,
        session_id: 's',
        producer_run_id: 'run-1',
        producer_run_hash: hash,
        producer_status: 'sealed' as const,
        artifact_id: 'artifact-1',
        artifact_role: 'primary',
        artifact_status: 'sealed' as const,
        artifact_hash: hash,
        observed_artifact_hash: hash,
        artifact_schema: 'report/1.0',
        artifact_registry_revision: 3,
        producer_contract_hash: hash,
      },
      assessment_hash: hash,
    };
    expect(reuseAssessmentSchema.parse(legacy)).toEqual(legacy);
    expect(reuseAssessmentReadSchema.parse(legacy)).toEqual(legacy);
    expect(() => reuseAssessmentSchema.parse({
      ...legacy,
      schema_version: 'reuse-assessment/1.1',
      source_fence: {
        ...legacy.source_fence,
        schema_version: 'reuse-source-fence/1.1',
        execution_seal_receipt: {
          execution_id: 'execution-1', generation: 1, sealed_at: 'now',
          relative_path: 'executions/execution-1/seal-receipt.json', overall_hash: hash,
        },
      },
    })).toThrow();
    const current = {
      ...legacy,
      schema_version: 'reuse-assessment/1.1' as const,
      source_fence: {
        ...legacy.source_fence,
        schema_version: 'reuse-source-fence/1.1' as const,
        execution_seal_receipt: {
          execution_id: 'execution-1', generation: 1, sealed_at: 'now',
          relative_path: 'executions/execution-1/seal-receipt.json', overall_hash: hash,
        },
      },
    };
    expect(reuseAssessmentV11Schema.parse(current)).toEqual(current);
    expect(reuseAssessmentReadSchema.parse(current)).toEqual(current);
  });

  it('keeps recall-confirmation and validated-source 1.0 strict while dual-reading 1.1', () => {
    const legacyFence = {
      workspace_id: hash,
      workspace_link_name: null,
      session_id: 's',
      session_schema_version: 'session/1.3' as const,
      session_identity_revision: 1,
      session_activity_revision: 2,
      session_hash: hash,
      run_id: 'run-1',
      run_schema_version: 'command-run/1.3' as const,
      run_hash: hash,
      artifact_registry_revision: 3,
      selected_artifacts: [],
    };
    const target = {
      workspace_id: hash, session_id: 'target', must_not_exist: true,
      status: null, identity_revision: null, activity_revision: null,
      active_run_id: null, artifact_registry_revision: null,
    };
    const legacyRecord = {
      schema_version: 'recall-confirmation/1.0' as const,
      token_hash: hash, action: 'fork' as const, candidate_id: 'history:s:run-1',
      request_hash: hash, issued_at: 'now', expires_at: 'later', consumed_at: null,
      source_fence: legacyFence, target_fence: target, target_session_id: 'target',
      result_session_id: null, result_run_id: null, reservation: null, outcome: null,
    };
    expect(recallConfirmationRecordSchema.parse(legacyRecord)).toEqual(legacyRecord);
    expect(recallConfirmationRecordReadSchema.parse(legacyRecord)).toEqual(legacyRecord);
    const currentFence = {
      ...legacyFence,
      schema_version: 'source-fence/1.1' as const,
      session_schema_version: 'session/2.0' as const,
      run_schema_version: 'command-run/1.4' as const,
      execution_seal_receipt: {
        execution_id: 'execution-1', generation: 1, sealed_at: 'now',
        relative_path: 'executions/execution-1/seal-receipt.json', overall_hash: hash,
      },
    };
    const currentRecord = {
      ...legacyRecord,
      schema_version: 'recall-confirmation/1.1' as const,
      source_fence: currentFence,
    };
    expect(() => recallConfirmationRecordSchema.parse(currentRecord)).toThrow();
    expect(recallConfirmationRecordV11Schema.parse(currentRecord)).toEqual(currentRecord);
    expect(recallConfirmationRecordReadSchema.parse(currentRecord)).toEqual(currentRecord);

    const legacyValidated = {
      schema_version: 'validated-recall-source/1.0' as const,
      scope: 'local' as const, workspace_link_name: null,
      source_project_root: 'C:/source', source_workflow_root: 'C:/source/.workflow',
      workspace_id: hash, session_id: 's', run_id: 'run-1',
      session_status: 'sealed' as const, run_status: 'sealed' as const,
      session_intent_identity: null, fence: legacyFence,
    };
    expect(validatedRecallSourceSchema.parse(legacyValidated)).toEqual(legacyValidated);
    const currentValidated = {
      ...legacyValidated,
      schema_version: 'validated-recall-source/1.1' as const,
      session_status: null,
      fence: currentFence,
    };
    expect(() => validatedRecallSourceSchema.parse(currentValidated)).toThrow();
    expect(validatedRecallSourceV11Schema.parse(currentValidated)).toEqual(currentValidated);
    expect(validatedRecallSourceReadSchema.parse(currentValidated)).toEqual(currentValidated);
  });

  it('validates strict immutable Execution seal and archive receipt shapes', () => {
    const seal = {
      schema_version: 'execution-seal-receipt/1.0' as const,
      session_id: 's',
      execution_id: 'execution-1',
      generation: 1,
      sealed_at: '2026-07-21T00:00:00.000Z',
      execution_revision: 5,
      session_identity_revision: 2,
      session_activity_revision: 9,
      runs: [{ run_id: 'run-1', schema_version: 'command-run/1.4' as const, content_hash: hash }],
      chain_snapshot: [],
      chain_hash: hash,
      gates: { clean: true, blocking_gate_ids: [], registry_revision: 4, registry_hash: hash },
      artifacts: { registry_revision: 7, registry_hash: hash, content_hashes: { artifact: hash } },
      evidence: { store_revision: 3, store_hash: hash, record_refs: ['evidence-1'] },
      corpus_refs: [{ kind: 'knowledge', id: 'K-1', content_hash: hash }],
      overall_hash: hash,
    };
    expect(executionSealReceiptSchema.parse(seal)).toEqual(seal);
    expect(executionSealReceiptReadSchema.parse(seal)).toEqual(seal);
    expect(() => executionSealReceiptSchema.parse({ ...seal, status: 'sealed' })).toThrow();

    const sealV11 = {
      ...seal,
      schema_version: 'execution-seal-receipt/1.1' as const,
      execution_hash: hash,
      gates: { ...seal.gates, snapshots: [], snapshot_hash: hash },
      artifacts: { ...seal.artifacts, snapshots: [], snapshot_hash: hash },
      evidence: { ...seal.evidence, snapshots: [], snapshot_hash: hash },
    };
    expect(executionSealReceiptV11Schema.parse(sealV11)).toEqual(sealV11);
    expect(executionSealReceiptReadSchema.parse(sealV11)).toEqual(sealV11);
    expect(() => executionSealReceiptSchema.parse(sealV11)).toThrow();

    const archive = {
      schema_version: 'session-archive-receipt/1.0' as const,
      receipt_id: 'archive-10',
      operation: 'archive' as const,
      session_id: 's',
      actor: 'operator',
      reason: 'complete',
      evidence_refs: ['execution-seal:execution-1'],
      recorded_at: '2026-07-21T00:00:00.000Z',
      before: { identity_revision: 2, activity_revision: 9, archived_at: null, archived_by: null },
      after: {
        identity_revision: 2,
        activity_revision: 10,
        archived_at: '2026-07-21T00:00:00.000Z',
        archived_by: 'operator',
      },
      previous_receipt_hash: null,
      receipt_hash: hash,
    };
    expect(sessionArchiveReceiptSchema.parse(archive)).toEqual(archive);
    expect(() => sessionArchiveReceiptSchema.parse({ ...archive, evidence_refs: [null] })).toThrow();
  });
});

describe('execution-generation protocol schemas', () => {
  it('dual-reads strict transition 1.0 and 1.1 records', () => {
    const legacy = {
      schema_version: 'transition-request/1.0' as const,
      request_id: 'req-legacy',
      operation: 'next' as const,
      subject: { session_id: 's', run_id: null, chain_step_id: 'step-1' },
      normalized_request_hash: hash,
      requested_at: '2026-07-20T00:00:00.000Z',
      preconditions: {
        session_identity_revision: 1,
        session_activity_revision: 2,
        active_run_id: null,
        run_hash: null,
        artifact_registry_revision: 5,
      },
      payload: {},
    };
    expect(transitionRequestSchema.parse(legacy).schema_version).toBe('transition-request/1.0');
    expect(transitionRequestReadSchema.parse(legacy).schema_version).toBe('transition-request/1.0');

    const request = {
      schema_version: 'transition-request/1.1' as const,
      request_id: 'req-current',
      operation: 'execution-seal' as const,
      subject: {
        session_id: 's', execution_id: 'exec-1', generation: 1, run_id: null, chain_step_id: null,
      },
      normalized_request_hash: hash,
      requested_at: '2026-07-20T00:00:00.000Z',
      preconditions: executionFence(),
      payload: { lease_id_hash: hash },
    };
    expect(transitionRequestReadSchema.parse(request)).toEqual(request);
    expect(() => transitionRequestV11Schema.parse({ ...request, unexpected: true })).toThrow();
    expect(() => transitionRequestV11Schema.parse({
      ...request,
      payload: { lease_id: 'private-token' },
    })).toThrow(/lease_id_hash/);

    const outcome = {
      schema_version: 'transition-outcome/1.1' as const,
      transition_id: 'tr-current',
      request_id: request.request_id,
      request_hash: hash,
      operation: request.operation,
      status: 'applied' as const,
      applied_at: '2026-07-20T00:00:01.000Z',
      subject: request.subject,
      postconditions: { ...executionFence(), execution_status: 'sealed' as const, active_run_id: null },
      exit_code: 0 as const,
      error_code: null,
      result_hash: hash,
      result: { sealed: true },
    };
    expect(transitionOutcomeV11Schema.parse(outcome)).toEqual(outcome);
    expect(transitionOutcomeReadSchema.parse(outcome).schema_version).toBe('transition-outcome/1.1');
    expect(() => transitionOutcomeV11Schema.parse({ ...outcome, unexpected: true })).toThrow();
  });

  it('validates execution locators and strict capability negotiation', () => {
    expect(() => runOperationSchema.parse('artifact-inspect')).toThrow();
    expect(() => runOperationSchema.parse('artifact-republish')).toThrow();
    expect(runOperationV12Schema.parse('artifact-inspect')).toBe('artifact-inspect');
    expect(runOperationV12Schema.parse('artifact-republish')).toBe('artifact-republish');

    expect(executionLocatorSchema.parse({
      session_id: 's', execution_id: 'exec-1', generation: 1, run_id: null,
    })).toMatchObject({ execution_id: 'exec-1', generation: 1 });

    const capabilities = {
      schema_version: 'maestro-capabilities/1.0' as const,
      cli_version: '0.6.0',
      session_schema_writes: ['session/1.3', 'session/2.0', 'session/3.0'] as const,
      execution_schema_writes: ['execution/1.0'] as const,
      run_response_writes: ['run-response/1.0', 'run-response/1.1', 'run-response/1.2'] as const,
      features: {
        execution_generation: true,
        core_execution_lease: true,
        execution_handoff: true,
        session_statusless: true,
        legacy_session_aliases: true,
        session_run_minimal_v3: false,
        artifact_compatibility_v1: true,
        atomic_run_complete_seal: true,
        generation_scoped_seal_receipts: true,
      },
    };
    expect(maestroCapabilitiesSchema.parse(capabilities)).toEqual(capabilities);
    expect(maestroCapabilitiesSchema.parse({ ...capabilities, execution_schema_writes: [] }))
      .toMatchObject({ execution_schema_writes: [] });
    expect(maestroCapabilitiesSchema.parse({
      ...capabilities,
      features: { ...capabilities.features, future_boolean: true },
    }).features.future_boolean).toBe(true);
    expect(() => maestroCapabilitiesSchema.parse({
      ...capabilities,
      features: { ...capabilities.features, future_boolean: 'yes' },
    })).toThrow();
    expect(() => maestroCapabilitiesSchema.parse({ ...capabilities, unexpected: true })).toThrow();
  });

  it('validates strict v3 receipts, ResumeMapV1, and revision conflict fields', () => {
    const request = {
      schema_version: 'request-receipt/2.0' as const,
      request_id: 'req-1',
      participant_id: 'pi-window-a',
      payload_hash: hash,
      transition_receipt_ref: 'receipts/transitions/000000000001-tr-1.json',
    };
    expect(requestReceiptV20Schema.parse(request)).toEqual(request);
    expect(() => requestReceiptV20Schema.parse({ ...request, payload: {} })).toThrow();

    const transition = {
      schema_version: 'transition-receipt/2.0' as const,
      transition_id: 'tr-1',
      request_id: 'req-1',
      session_id: 's',
      activity_revision: 1,
      target_type: 'run' as const,
      target_id: 'run-1',
      revision_before: 2,
      revision_after: 3,
      actor_id: 'actor-a',
      participant_id: 'pi-window-a',
      reason: 'complete work',
      evidence_refs: ['evidence-1'],
      recorded_at: '2026-08-12T00:00:00.000Z',
      result: { status: 'completed' },
    };
    expect(transitionReceiptV20Schema.parse(transition)).toEqual(transition);
    expect(() => transitionReceiptV20Schema.parse({ ...transition, revision_after: 4 })).toThrow();
    expect(() => transitionReceiptV20Schema.parse({ ...transition, unexpected: true })).toThrow();

    const map = {
      sessionId: 's', sessionStatus: 'open' as const,
      orchestrationRevision: 2, activityRevision: 3,
      activeRuns: [{ runId: 'run-1', stepId: 'step-1', status: 'running' as const, revision: 4 }],
      blockingGates: ['gate-1'], openDecisions: ['decision-1'],
      pendingPublications: [{ publicationId: 'publication-1', resourceUri: 'artifact://publication-1' }],
      nextActions: [{ action: 'run-complete', targetId: 'run-1', expectedRevision: 4 }],
      fingerprint: hash,
    };
    expect(resumeMapV1Schema.parse(map)).toEqual(map);
    expect(() => resumeMapV1Schema.parse({ ...map, executionId: 'exec-1' })).toThrow();
    expect(() => resumeMapV1Schema.parse({
      ...map,
      activeRuns: [{ ...map.activeRuns[0], lease: 'private' }],
    })).toThrow();

    const conflict = {
      schema_version: 'run-response/1.2' as const,
      operation: 'complete' as const,
      ok: false as const,
      exit_code: 1 as const,
      disposition: 'domain_error' as const,
      request_id: 'req-1',
      locator: { session_id: 's', run_id: 'run-1' },
      revision: { target_type: 'run' as const, target_id: 'run-1', revision: 4 },
      replay: null,
      warnings: [],
      result: null,
      error: {
        code: 'RUN_REVISION_CONFLICT' as const,
        message: 'stale Run revision',
        retryable: true,
        details: {},
        target_type: 'run' as const,
        target_id: 'run-1',
        expected_revision: 3,
        current_revision: 4,
        changed_by: 'pi-window-b',
        next_actions: ['reload-run', 're-evaluate-intent'],
      },
    };
    expect(runResponseV12Schema.parse(conflict)).toEqual(conflict);
    expect(() => runResponseV12Schema.parse({
      ...conflict,
      error: { ...conflict.error, current_revision: null },
    })).toThrow(/current_revision/);
  });
});
