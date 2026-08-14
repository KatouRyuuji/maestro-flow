import { describe, expect, it } from 'vitest';

import {
  assessArtifactCompatibility,
  type AssessArtifactCompatibilityInput,
} from './artifact-compatibility.js';

const HASH = `sha256:${'a'.repeat(64)}`;

function input(): AssessArtifactCompatibilityInput {
  return {
    source: {
      session_id: 's-1',
      session_schema_version: 'session/1.3',
      session_revision: 4,
      artifact_id: 'ART-1',
      artifact_registry_revision: 7,
      artifact_path: 'runs/r-1/outputs/execution.json',
      artifact_hash: HASH,
      artifact_size: 42,
      producer_run_id: 'r-1',
      producer_run_hash: HASH,
      producer_contract_hash: HASH,
      producer_contract_source: 'captured_snapshot',
      raw_slot: { kind: 'execution', schema: 'execution/1.0', role: 'attachment', alias: 'latest-execution' },
      registry_slot: { kind: 'execution', schema: 'execution/1.0', role: 'attachment', alias: 'latest-execution' },
      producer_slot: { kind: 'execution', schema: 'execution/1.0', role: 'attachment', alias: 'latest-execution' },
    },
    consumer: {
      command: 'review',
      command_contract_hash: HASH,
      slot_index: 0,
      slot: { kind: 'execution', schema: 'execution/1.0', role: 'primary', alias: 'latest-execution' },
    },
    source_status: 'sealed',
    producer_status: 'sealed',
    source_hash_valid: true,
    source_is_top_level_json: true,
    source_metadata_valid: true,
    producer_contract_captured: true,
  };
}

describe('artifact compatibility assessment', () => {
  it('classifies the sealed legacy attachment fixture as semantic republish required with a stable hash', () => {
    const first = assessArtifactCompatibility(input());
    const second = assessArtifactCompatibility(structuredClone(input()));
    expect(first).toMatchObject({
      schema_version: 'artifact-compatibility/1.0',
      classification: 'semantic_republish_required',
      reason_codes: ['CONSUMER_ROLE_REPUBLISH_REQUIRED'],
      assessment_hash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    });
    expect(second).toEqual(first);
  });

  it('distinguishes compatible authority, representation drift, and invalid semantics', () => {
    const compatible = input();
    compatible.consumer.slot.role = 'attachment';
    expect(assessArtifactCompatibility(compatible)).toMatchObject({
      classification: 'compatible', reason_codes: ['COMPATIBLE'],
    });

    const representation = input();
    representation.source_status = 'draft';
    representation.producer_status = 'running';
    representation.source.registry_slot.role = 'primary';
    expect(assessArtifactCompatibility(representation)).toMatchObject({
      classification: 'representation_repairable',
      reason_codes: ['SOURCE_NOT_SEALED', 'PRODUCER_NOT_SEALED', 'SOURCE_ROLE_REPRESENTATION_DRIFT'],
    });

    const sealedConflict = input();
    sealedConflict.source.registry_slot.role = 'primary';
    expect(assessArtifactCompatibility(sealedConflict)).toMatchObject({
      classification: 'invalid',
      reason_codes: ['SOURCE_ROLE_REPRESENTATION_DRIFT', 'SEALED_SOURCE_REPRESENTATION_CONFLICT'],
    });

    const unproven = input();
    unproven.source_status = 'draft';
    unproven.producer_status = 'running';
    unproven.producer_contract_captured = false;
    unproven.source.producer_contract_source = 'unavailable';
    unproven.source.registry_slot.role = 'primary';
    expect(assessArtifactCompatibility(unproven)).toMatchObject({
      classification: 'invalid',
      reason_codes: expect.arrayContaining(['PRODUCER_CONTRACT_UNAVAILABLE']),
    });

    const invalid = input();
    invalid.source_hash_valid = false;
    invalid.consumer.slot.schema = 'execution/2.0';
    expect(assessArtifactCompatibility(invalid)).toMatchObject({
      classification: 'invalid',
      reason_codes: ['SOURCE_HASH_MISMATCH', 'CONSUMER_SCHEMA_MISMATCH'],
    });
  });

  it('accepts only explicit same-major schema ranges', () => {
    const ranged = input();
    ranged.consumer.slot.schema = 'execution/1.x';
    expect(assessArtifactCompatibility(ranged).classification).toBe('semantic_republish_required');
    ranged.consumer.slot.schema = 'execution/2.x';
    expect(assessArtifactCompatibility(ranged).classification).toBe('invalid');
  });
});
