import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  assessArtifactReuse,
  schemaMatch,
  type ReuseAssessmentInput,
} from './reuse-assessment.js';

const HASH_A = `sha256:${'a'.repeat(64)}`;
const HASH_B = `sha256:${'b'.repeat(64)}`;
const HASH_C = `sha256:${'c'.repeat(64)}`;

interface LegacyAttachmentFixture {
  review: { required_role: 'primary' };
  authority: {
    output: { _meta: { kind: string; schema: string; role: 'attachment'; alias: string } };
    contract_snapshot: {
      snapshot_hash: string;
      normalized: { produces: Array<{ kind: string; schema: string; role: 'attachment' }> };
    };
    registry: {
      kind: string;
      schema_version: string;
      role: 'attachment';
      status: 'sealed';
    };
  };
  current_contract_hash: string;
  expected_reason_codes: string[];
}

const legacyAttachmentFixture = JSON.parse(readFileSync(
  new URL('./__fixtures__/sealed-legacy-attachment-execution.json', import.meta.url),
  'utf8',
)) as LegacyAttachmentFixture;

function compatibleInput(): ReuseAssessmentInput {
  return {
    candidate: {
      workspaceId: HASH_C,
      sessionId: 'session-source',
      producerRunId: 'run-source',
      producerRunHash: HASH_C,
      producerStatus: 'sealed',
      artifactId: 'artifact-primary',
      artifactRole: 'primary',
      artifactStatus: 'sealed',
      artifactHash: HASH_A,
      observedArtifactHash: HASH_A,
      artifactSchema: 'architecture-report/1.0',
      artifactRegistryRevision: 7,
    },
    acceptedArtifactSchemas: ['architecture-report/1.0'],
    contract: {
      producerHash: HASH_B,
      currentHash: HASH_B,
      drift: 'none',
    },
    freshness: 'fresh',
    quality: {
      status: 'high',
      concernCodes: [],
    },
    supersession: {
      status: 'current',
      supersedesArtifactIds: [],
      supersededByArtifactIds: [],
    },
    conflicts: {
      sameRoleCandidates: [],
    },
  };
}

describe('reuse-assessment/1.0', () => {
  it('reuses a fresh, compatible, integrity-verified artifact', () => {
    const input = compatibleInput();
    const result = assessArtifactReuse(input);

    expect(result).toMatchObject({
      schema_version: 'reuse-assessment/1.0',
      decision: 'REUSE',
      reason_codes: ['REUSE_ELIGIBLE'],
      source_fence: {
        schema_version: 'reuse-source-fence/1.0',
        session_id: 'session-source',
        producer_run_id: 'run-source',
        producer_run_hash: HASH_C,
        artifact_id: 'artifact-primary',
        artifact_hash: HASH_A,
        producer_contract_hash: HASH_B,
      },
    });
    expect(result.assessment_hash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(assessArtifactReuse(input)).toEqual(result);
  });

  it('emits additive 1.1 only with a sealed Execution anchor and rejects a required missing anchor', () => {
    const anchored = compatibleInput();
    anchored.candidate.executionSourceRequired = true;
    anchored.candidate.executionSealReceipt = {
      execution_id: 'execution-001',
      generation: 1,
      sealed_at: '2026-07-21T00:00:00.000Z',
      relative_path: 'executions/execution-001/seal-receipt.json',
      overall_hash: HASH_B,
    };
    expect(assessArtifactReuse(anchored)).toMatchObject({
      schema_version: 'reuse-assessment/1.1',
      decision: 'REUSE',
      source_fence: {
        schema_version: 'reuse-source-fence/1.1',
        execution_seal_receipt: { execution_id: 'execution-001', generation: 1 },
      },
    });

    const missing = compatibleInput();
    missing.candidate.executionSourceRequired = true;
    expect(assessArtifactReuse(missing)).toMatchObject({
      schema_version: 'reuse-assessment/1.0',
      decision: 'REJECT',
      reason_codes: expect.arrayContaining(['SOURCE_FENCE_INCOMPLETE']),
    });
  });

  it('allows compatible freshness but rejects stale and reviews unknown freshness', () => {
    const compatible = compatibleInput();
    compatible.freshness = 'compatible';
    expect(assessArtifactReuse(compatible)).toMatchObject({
      decision: 'REUSE',
      reason_codes: ['FRESHNESS_COMPATIBLE', 'REUSE_ELIGIBLE'],
    });

    const stale = compatibleInput();
    stale.freshness = 'stale';
    expect(assessArtifactReuse(stale)).toMatchObject({
      decision: 'REJECT',
      reason_codes: ['FRESHNESS_STALE'],
    });

    const unknown = compatibleInput();
    unknown.freshness = 'unknown';
    expect(assessArtifactReuse(unknown)).toMatchObject({
      decision: 'REVIEW',
      reason_codes: ['FRESHNESS_UNKNOWN'],
    });
  });

  it('routes unknown compatibility evidence to review', () => {
    const input = compatibleInput();
    input.contract = { producerHash: null, currentHash: null, drift: 'unknown' };

    expect(assessArtifactReuse(input)).toMatchObject({
      decision: 'REVIEW',
      reason_codes: ['CONTRACT_COMPATIBILITY_UNKNOWN'],
    });
  });

  it('rejects breaking contract drift', () => {
    const input = compatibleInput();
    input.contract = { producerHash: HASH_A, currentHash: HASH_B, drift: 'breaking' };

    expect(assessArtifactReuse(input)).toMatchObject({
      decision: 'REJECT',
      reason_codes: ['CONTRACT_BREAKING_DRIFT', 'CONTRACT_HASH_MISMATCH'],
    });
  });

  it('rejects sealed legacy attachment authority when the current review requires primary', () => {
    const fixture = legacyAttachmentFixture;
    const storedProduce = fixture.authority.contract_snapshot.normalized.produces[0];
    expect([
      fixture.authority.output._meta.role,
      storedProduce.role,
      fixture.authority.registry.role,
    ]).toEqual(['attachment', 'attachment', 'attachment']);

    const input = compatibleInput();
    input.candidate.artifactRole = fixture.authority.registry.role;
    input.candidate.artifactStatus = fixture.authority.registry.status;
    input.candidate.artifactSchema = fixture.authority.registry.schema_version;
    input.consumer = {
      kind: fixture.authority.registry.kind,
      alias: fixture.authority.output._meta.alias,
      schema: fixture.authority.registry.schema_version,
      role: fixture.review.required_role,
    };
    input.acceptedArtifactSchemas = [fixture.authority.registry.schema_version];
    input.acceptedArtifactRoles = [fixture.review.required_role];
    input.contract = {
      producerHash: fixture.authority.contract_snapshot.snapshot_hash,
      currentHash: fixture.current_contract_hash,
      drift: 'breaking',
    };

    const result = assessArtifactReuse(input);
    expect(result.decision).toBe('REJECT');
    expect(result.reason_codes).toEqual(fixture.expected_reason_codes);
    expect(result.source_fence.artifact_role).toBe('attachment');
  });

  it('accepts an explicitly compatible output contract despite a producer hash change', () => {
    const input = compatibleInput();
    input.contract = { producerHash: HASH_A, currentHash: HASH_B, drift: 'compatible_output' };

    expect(assessArtifactReuse(input)).toMatchObject({
      decision: 'REUSE',
      reason_codes: ['CONTRACT_COMPATIBLE_OUTPUT', 'REUSE_ELIGIBLE'],
    });
  });

  it('rejects artifact schema mismatch', () => {
    const input = compatibleInput();
    input.acceptedArtifactSchemas = ['architecture-report/2.0'];

    expect(assessArtifactReuse(input)).toMatchObject({
      decision: 'REJECT',
      reason_codes: ['ARTIFACT_SCHEMA_MISMATCH'],
    });
  });

  it('rejects artifact hash mismatch', () => {
    const input = compatibleInput();
    input.candidate.observedArtifactHash = HASH_B;

    expect(assessArtifactReuse(input)).toMatchObject({
      decision: 'REJECT',
      reason_codes: ['ARTIFACT_HASH_MISMATCH'],
    });
  });

  it('routes medium quality concerns to review and low quality to reject', () => {
    const concern = compatibleInput();
    concern.quality = { status: 'medium', concernCodes: ['missing-citation'] };
    expect(assessArtifactReuse(concern)).toMatchObject({
      decision: 'REVIEW',
      reason_codes: ['QUALITY_MEDIUM'],
    });

    const low = compatibleInput();
    low.quality = { status: 'low', concernCodes: ['failed-gate'] };
    expect(assessArtifactReuse(low)).toMatchObject({
      decision: 'REJECT',
      reason_codes: ['QUALITY_LOW'],
    });
  });

  it('rejects an artifact superseded by a newer artifact', () => {
    const input = compatibleInput();
    input.supersession = {
      status: 'superseded',
      supersedesArtifactIds: [],
      supersededByArtifactIds: ['artifact-newer'],
    };

    expect(assessArtifactReuse(input)).toMatchObject({
      decision: 'REJECT',
      reason_codes: ['SUPERSEDED_BY_NEWER_ARTIFACT'],
    });
  });

  it('conflicts only for an eligible same-role artifact with different bytes and no supersession', () => {
    const input = compatibleInput();
    input.conflicts.sameRoleCandidates = [
      { artifactId: 'artifact-peer', artifactHash: HASH_B, eligible: true },
    ];
    expect(assessArtifactReuse(input)).toMatchObject({
      decision: 'CONFLICT',
      reason_codes: ['SAME_ROLE_CONFLICT'],
    });

    const duplicate = compatibleInput();
    duplicate.conflicts.sameRoleCandidates = [
      { artifactId: 'artifact-copy', artifactHash: HASH_A, eligible: true },
    ];
    expect(assessArtifactReuse(duplicate).decision).toBe('REUSE');

    const superseding = compatibleInput();
    superseding.supersession.supersedesArtifactIds = ['artifact-old'];
    superseding.conflicts.sameRoleCandidates = [
      { artifactId: 'artifact-old', artifactHash: HASH_B, eligible: true },
    ];
    expect(assessArtifactReuse(superseding).decision).toBe('REUSE');
  });

  it('rejects non-sealed producer and artifact states', () => {
    const producer = compatibleInput();
    producer.candidate.producerStatus = 'completed';
    expect(assessArtifactReuse(producer)).toMatchObject({
      decision: 'REJECT',
      reason_codes: ['PRODUCER_NOT_SEALED'],
    });

    const draft = compatibleInput();
    draft.candidate.artifactStatus = 'draft';
    expect(assessArtifactReuse(draft)).toMatchObject({
      decision: 'REJECT',
      reason_codes: ['ARTIFACT_NOT_SEALED'],
    });

    const invalid = compatibleInput();
    invalid.candidate.artifactStatus = 'invalid';
    expect(assessArtifactReuse(invalid)).toMatchObject({
      decision: 'REJECT',
      reason_codes: ['ARTIFACT_INVALID'],
    });
  });

  it('normalizes unordered evidence for a stable hash and leaves input untouched', () => {
    const left = compatibleInput();
    left.acceptedArtifactSchemas = ['architecture-report/2.0', 'architecture-report/1.0'];
    left.quality.concernCodes = ['zeta', 'alpha', 'zeta'];
    left.conflicts.sameRoleCandidates = [
      { artifactId: 'artifact-z', artifactHash: HASH_B, eligible: true },
      { artifactId: 'artifact-a', artifactHash: HASH_B, eligible: true },
    ];
    const before = structuredClone(left);

    const right = structuredClone(left);
    right.acceptedArtifactSchemas.reverse();
    right.quality.concernCodes.reverse();
    right.conflicts.sameRoleCandidates.reverse();

    expect(assessArtifactReuse(left).assessment_hash)
      .toBe(assessArtifactReuse(right).assessment_hash);
    expect(left).toEqual(before);
  });

  it('schemaMatch accepts exact, major-compatible and rejects mismatched/unknown inputs', () => {
    expect(schemaMatch('execution/1.0', ['execution/1.0'], [])).toBe('exact');
    expect(schemaMatch('execution/1.1', ['execution/1.0'], [])).toBe('mismatch');
    expect(schemaMatch('execution/1.1', ['execution/1.0'], ['execution/1.x'])).toBe('major-compatible');
    expect(schemaMatch('execution/1.0', [], ['execution/1.x'])).toBe('major-compatible');
    expect(schemaMatch('execution/2.0', [], ['execution/1.x'])).toBe('mismatch');
    expect(schemaMatch('review-findings/1.0', [], ['execution/1.x'])).toBe('mismatch');
    expect(schemaMatch('execution/1', [], ['execution/1.x'])).toBe('unknown');
    expect(schemaMatch(null, [], ['execution/1.x'])).toBe('unknown');
    expect(schemaMatch('execution/1.0', [], [])).toBe('unknown');
    expect(schemaMatch('execution/1.0', ['execution/1.0'], ['execution/1.x'])).toBe('exact');
  });

  it('assesses a major-compatible range as REUSE with ARTIFACT_SCHEMA_MAJOR_COMPATIBLE', () => {
    const input = compatibleInput();
    input.acceptedArtifactSchemas = [];
    input.acceptedSchemaRanges = ['architecture-report/1.x'];
    input.candidate.artifactSchema = 'architecture-report/1.4';

    expect(assessArtifactReuse(input)).toMatchObject({
      decision: 'REUSE',
      reason_codes: ['ARTIFACT_SCHEMA_MAJOR_COMPATIBLE', 'REUSE_ELIGIBLE'],
    });
  });

  it('rejects a range whose major does not match the producer schema', () => {
    const input = compatibleInput();
    input.acceptedArtifactSchemas = [];
    input.acceptedSchemaRanges = ['architecture-report/1.x'];
    input.candidate.artifactSchema = 'architecture-report/2.0';

    expect(assessArtifactReuse(input)).toMatchObject({
      decision: 'REJECT',
      reason_codes: expect.arrayContaining(['ARTIFACT_SCHEMA_MISMATCH']),
    });
  });

  it('keeps exact schema semantics unchanged when no range is declared', () => {
    const input = compatibleInput();
    input.acceptedArtifactSchemas = ['architecture-report/1.0'];
    input.candidate.artifactSchema = 'architecture-report/1.1';

    expect(assessArtifactReuse(input)).toMatchObject({
      decision: 'REJECT',
      reason_codes: expect.arrayContaining(['ARTIFACT_SCHEMA_MISMATCH']),
    });
  });

  it('flags ARTIFACT_SCHEMA_UNKNOWN when the consumer declares no accepted schema', () => {
    const input = compatibleInput();
    input.acceptedArtifactSchemas = [];

    expect(assessArtifactReuse(input)).toMatchObject({
      decision: 'REVIEW',
      reason_codes: expect.arrayContaining(['ARTIFACT_SCHEMA_UNKNOWN']),
    });
  });

  it('flags ARTIFACT_SCHEMA_UNKNOWN when the artifact carries no schema', () => {
    const input = compatibleInput();
    input.candidate.artifactSchema = null as unknown as string;

    expect(assessArtifactReuse(input)).toMatchObject({
      decision: 'REVIEW',
      reason_codes: expect.arrayContaining(['ARTIFACT_SCHEMA_UNKNOWN']),
    });
  });
});
