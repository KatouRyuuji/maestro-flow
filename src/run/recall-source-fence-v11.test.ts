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

import { sealExecution, startExecution } from './execution.js';
import { executeRecallAction } from './recall-actions.js';
import { issueRecallConfirmation } from './recall-confirmation.js';
import { createIntentIdentity, canonicalWorkspaceId } from './intent-identity.js';
import {
  assessReceiptBackedArtifactReuse,
  buildReuseExecutionAnchor,
  validateReuseSourceFence,
} from './reuse-acceptance.js';
import type { ReuseSourceFenceV11 } from './reuse-assessment.js';
import { buildSourceFence } from './recall.js';
import { completeExecutionRun, createExecutionRun } from './runtime.js';
import { SessionStore } from './store.js';
import type { SourceFenceV11 } from './protocol-schemas.js';

function v2Workspace(root: string): void {
  mkdirSync(join(root, ".workflow"), { recursive: true });
  writeFileSync(join(root, ".workflow", "config.json"), JSON.stringify({
    session_schema: { schema_version: "session-schema-selection/1.0", writer: "session/1.3", features: { session_statusless: false } },
  }));
}

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'maestro-recall-v11-'));

  v2Workspace(value);
  roots.push(value);
  mkdirSync(join(value, '.workflow'), { recursive: true });
  writeFileSync(join(value, '.workflow', 'config.json'), JSON.stringify({
    session_schema: {
      schema_version: 'session-schema-selection/1.0',
      writer: 'session/2.0',
      features: { session_statusless: true },
    },
  }, null, 2));
  const commandDir = join(value, '.claude', 'commands');
  mkdirSync(commandDir, { recursive: true });
  writeFileSync(join(commandDir, 'produce.md'), [
    '<contract>',
    'contract_version: 2.1',
    'arguments: []',
    'consumes: []',
    'produces:',
    '  - kind: report',
    '    alias: current-report',
    '    role: primary',
    '    required: true',
    '    schema: report/1.0',
    '    path: outputs/report.json',
    'gates: { entry: [], exit: [] }',
    '</contract>',
  ].join('\n'));
  return value;
}

function claim(value: { owner_id: string; owner_kind: 'codex'; epoch: number; lease_id: string }) {
  return { ownerId: value.owner_id, ownerKind: value.owner_kind, epoch: value.epoch, leaseId: value.lease_id };
}

function sealedSource(projectRoot: string, sessionId = 'source') {
  const store = new SessionStore(projectRoot);
  store.createSession(sessionId, `sealed ${sessionId}`, { command: 'produce' });
  const started = startExecution(projectRoot, sessionId, {
    requestId: `req-start-${sessionId}`, ownerId: 'worker', ownerKind: 'codex',
  });
  const run = createExecutionRun({
    projectRoot,
    sessionId,
    command: 'produce',
    intent: `sealed ${sessionId}`,
    executionId: started.execution.execution_id,
    generation: started.execution.generation,
    expectedExecutionRevision: 1,
    executionLease: claim(started.lease_claim),
    requestId: `req-create-${sessionId}`,
  });
  const runDir = store.runDir(sessionId, run.run_id);
  mkdirSync(join(runDir, 'outputs'), { recursive: true });
  writeFileSync(join(runDir, 'outputs', 'report.json'), JSON.stringify({
    _meta: { kind: 'report', schema: 'report/1.0', role: 'primary', alias: 'current-report' },
    result: sessionId,
  }));
  writeFileSync(join(runDir, 'report.md'), [
    '---', 'verdict: ready', 'summary: sealed report', 'constraints: []',
    'decisions: []', 'concerns: []', 'next: []', '---', '',
  ].join('\n'));
  expect(completeExecutionRun(projectRoot, run.run_id, {
    sessionId,
    executionId: started.execution.execution_id,
    generation: started.execution.generation,
    expectedExecutionRevision: 2,
    executionLease: claim(started.lease_claim),
    requestId: `req-complete-${sessionId}`,
  }).sealed).toBe(true);
  sealExecution(projectRoot, {
    sessionId,
    executionId: started.execution.execution_id,
    requestId: `req-seal-${sessionId}`,
    expectedExecutionRevision: 3,
    lease: claim(started.lease_claim),
    summary: 'source complete',
    outcome: 'done',
  });
  const bundle = store.readBundle(sessionId);
  const artifact = Object.entries(bundle.artifacts.artifacts)
    .find(([, item]) => item.producer_run_id === run.run_id)!;
  const fence = buildSourceFence(projectRoot, sessionId, run.run_id) as SourceFenceV11;
  return { store, runId: run.run_id, artifactId: artifact[0], artifact: artifact[1], fence };
}

function targetFence(projectRoot: string, sessionId: string) {
  return {
    workspace_id: createIntentIdentity(projectRoot, 'produce', 'target').workspace_id,
    session_id: sessionId,
    must_not_exist: true as const,
    status: null,
    identity_revision: null,
    activity_revision: null,
    active_run_id: null,
    artifact_registry_revision: null,
  };
}

describe('receipt-backed source-fence/1.1', () => {
  it('survives later Session activity and a new Execution through reserve and finalize', () => {
    const projectRoot = root();
    const source = sealedSource(projectRoot);
    expect(source.fence).toMatchObject({
      schema_version: 'source-fence/1.1',
      session_schema_version: 'session/2.0',
      execution_seal_receipt: { generation: 1 },
    });
    const proposedIdentity = createIntentIdentity(projectRoot, 'produce', 'target');
    const proposedTarget = {
      workspace_id: proposedIdentity.workspace_id,
      session_id: 'target',
      intent_identity: proposedIdentity,
    };
    const issued = source.store.issueRecallConfirmation({
      action: 'fork',
      request_hash: `sha256:${'a'.repeat(64)}`,
      source_fence: source.fence,
      target_fence: targetFence(projectRoot, 'target'),
      target_session_id: 'target',
    });
    expect(issued.record.schema_version).toBe('recall-confirmation/1.1');
    const second = startExecution(projectRoot, 'source', {
      requestId: 'req-start-source-2', ownerId: 'worker-2', ownerKind: 'codex',
    });
    expect(second.execution.generation).toBe(2);
    const laterCommandDir = join(projectRoot, '.claude', 'commands');
    writeFileSync(join(laterCommandDir, 'produce-later.md'), [
      '<contract>', 'contract_version: 2.1', 'arguments: []', 'consumes: []', 'produces:',
      '  - kind: report', '    alias: current-report', '    role: primary', '    required: true',
      '    schema: report/1.0', '    path: outputs/later.json',
      'gates: { entry: [], exit: [] }', '</contract>',
    ].join('\n'));
    const laterRun = createExecutionRun({
      projectRoot,
      sessionId: 'source',
      command: 'produce-later',
      intent: 'later generation addition',
      executionId: second.execution.execution_id,
      generation: second.execution.generation,
      expectedExecutionRevision: 1,
      executionLease: claim(second.lease_claim),
      requestId: 'req-create-source-2',
    });
    const laterRunDir = source.store.runDir('source', laterRun.run_id);
    mkdirSync(join(laterRunDir, 'outputs'), { recursive: true });
    writeFileSync(join(laterRunDir, 'outputs', 'later.json'), JSON.stringify({
      _meta: { kind: 'report', schema: 'report/1.0', role: 'primary', alias: 'current-report' },
      result: 'generation-2',
    }));
    writeFileSync(join(laterRunDir, 'report.md'), [
      '---', 'verdict: ready', 'summary: later report', 'constraints: []',
      'decisions: []', 'concerns: []', 'next: []', '---', '',
    ].join('\n'));
    expect(completeExecutionRun(projectRoot, laterRun.run_id, {
      sessionId: 'source',
      executionId: second.execution.execution_id,
      generation: second.execution.generation,
      expectedExecutionRevision: 2,
      executionLease: claim(second.lease_claim),
      requestId: 'req-complete-source-2',
    }).sealed).toBe(true);
    expect(source.store.readExecutionSealReceipt(
      'source', source.fence.execution_seal_receipt.execution_id,
    )?.generation).toBe(1);
    const reserved = source.store.reserveRecallConfirmation(issued.token, {
      action: 'fork',
      request_hash: `sha256:${'a'.repeat(64)}`,
      source_fence: source.fence,
      target_fence: targetFence(projectRoot, 'target'),
      proposed_target: proposedTarget,
    });
    expect(reserved.status).toBe('reserved');
    if (reserved.status !== 'reserved') throw new Error('expected reservation');
    expect(reserved.record.reservation?.schema_version).toBe('recall-confirmation-reservation/1.1');
    expect(reserved.validated_source).toMatchObject({
      schema_version: 'validated-recall-source/1.1',
      session_status: null,
      fence: { schema_version: 'source-fence/1.1' },
    });
    source.store.claimRecallConfirmationTarget(reserved.reservation_id);
    source.store.createSession('target', 'target', {
      command: 'produce', intentIdentity: proposedIdentity, ifExists: 'error',
    });
    const target = { ...proposedTarget, run_id: null };
    const targetHash = source.store.readRecallTargetHash(target);
    expect(source.store.finalizeRecallConfirmation(reserved.reservation_id, {
      action: 'fork',
      request_hash: `sha256:${'a'.repeat(64)}`,
      target,
      target_hash: targetHash,
      outcome: { session_id: 'target' },
    }).replayed).toBe(false);
  });

  it('executes a confirmed linked import after later source activity without consulting Session status', () => {
    const sourceRoot = root();
    const source = sealedSource(sourceRoot);
    const projectRoot = mkdtempSync(join(tmpdir(), 'maestro-recall-v11-target-'));
    v2Workspace(projectRoot);
    roots.push(projectRoot);
    const commandDir = join(projectRoot, '.claude', 'commands');
    mkdirSync(commandDir, { recursive: true });
    writeFileSync(join(commandDir, 'produce.md'), '<contract>\nconsumes: []\nproduces: []\ngates: { entry: [], exit: [] }\n</contract>\n');
    mkdirSync(join(projectRoot, '.workflow'), { recursive: true });
    writeFileSync(join(projectRoot, '.workflow', 'config.json'), JSON.stringify({
      session_schema: { schema_version: 'session-schema-selection/1.0', writer: 'session/1.3', features: { session_statusless: false } },
      workspaces: { linked: [{ name: 'source-v2', path: sourceRoot, share: ['session'] }] },
    }, null, 2));
    const request = {
      action: 'import' as const,
      target_session_id: 'import-target',
      command: 'produce',
      intent: 'import target',
      source_session_id: 'source',
      source_run_id: source.runId,
      source_workspace: 'source-v2',
      args: [] as string[],
    };
    const issued = issueRecallConfirmation(projectRoot, request);
    startExecution(sourceRoot, 'source', {
      requestId: 'req-start-after-confirmation', ownerId: 'later', ownerKind: 'codex',
    });
    expect(executeRecallAction(projectRoot, {
      ...request,
      confirmation_token: issued.token,
    })).toMatchObject({ action: 'import', session_id: 'import-target', replayed: false });
  });

  it('revalidates the same Execution anchor for reuse while aliases and later activity stay Session-global', () => {
    const projectRoot = root();
    const source = sealedSource(projectRoot);
    const anchor = buildReuseExecutionAnchor(projectRoot, 'source', source.runId, source.artifactId);
    expect(anchor).toEqual(source.fence.execution_seal_receipt);
    const bundle = source.store.readBundle('source');
    const assessed = assessReceiptBackedArtifactReuse(projectRoot, {
      candidate: {
        workspaceId: canonicalWorkspaceId(projectRoot),
        sessionId: 'source',
        producerRunId: source.runId,
        producerRunHash: source.fence.run_hash,
        producerStatus: 'sealed',
        artifactId: source.artifactId,
        artifactRole: source.artifact.role,
        artifactStatus: 'sealed',
        artifactHash: `sha256:${source.artifact.content_hash}`,
        observedArtifactHash: `sha256:${source.artifact.content_hash}`,
        artifactSchema: source.artifact.schema_version,
        artifactRegistryRevision: bundle.artifacts.revision,
      },
      acceptedArtifactSchemas: [source.artifact.schema_version],
      contract: { producerHash: null, currentHash: null, drift: 'none' },
      freshness: 'fresh',
      quality: { status: 'high', concernCodes: [] },
      supersession: { status: 'current', supersedesArtifactIds: [], supersededByArtifactIds: [] },
      conflicts: { sameRoleCandidates: [] },
    });
    expect(assessed.schema_version).toBe('reuse-assessment/1.1');
    const reuseFence = assessed.source_fence as ReuseSourceFenceV11;
    validateReuseSourceFence(projectRoot, reuseFence);
    expect(() => validateReuseSourceFence(projectRoot, { ...reuseFence, artifact_role: 'attachment' }))
      .toThrow(/artifact|role|binding/i);
    expect(() => validateReuseSourceFence(projectRoot, { ...reuseFence, producer_run_id: 'run-tampered' }))
      .toThrow(/Run|producer|artifact|binding/i);
    expect(() => validateReuseSourceFence(projectRoot, {
      ...reuseFence,
      artifact_hash: `sha256:${'f'.repeat(64)}`,
    })).toThrow(/artifact|hash|binding/i);
    const artifactsPath = join(source.store.sessionDir('source'), 'artifacts.json');
    const registry = JSON.parse(readFileSync(artifactsPath, 'utf8')) as {
      revision: number;
      aliases: Record<string, string>;
      artifacts: Record<string, { status: string }>;
    };
    registry.aliases['session-global-alias'] = source.artifactId;
    registry.artifacts[source.artifactId].status = 'superseded';
    registry.revision++;
    writeFileSync(artifactsPath, JSON.stringify(registry, null, 2));
    startExecution(projectRoot, 'source', {
      requestId: 'req-reuse-later-execution', ownerId: 'later', ownerKind: 'codex',
    });
    validateReuseSourceFence(projectRoot, reuseFence);
    writeFileSync(join(source.store.sessionDir('source'), source.artifact.relative_path), 'reuse drift');
    expect(() => validateReuseSourceFence(projectRoot, reuseFence)).toThrow(/artifact|content|hash/i);
  });

  it.each([
    'receipt',
    'execution',
    'run',
    'artifact',
    'artifact-role',
    'artifact-producer',
    'artifact-hash',
  ] as const)('fails closed on %s drift', drift => {
    const projectRoot = root();
    const source = sealedSource(projectRoot);
    if (drift === 'receipt') {
      const path = source.store.executionSealReceiptPath(
        'source', source.fence.execution_seal_receipt.execution_id,
      );
      const receipt = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
      receipt.overall_hash = `sha256:${'f'.repeat(64)}`;
      writeFileSync(path, JSON.stringify(receipt, null, 2));
    } else if (drift === 'execution') {
      const path = source.store.executionPath('source', source.fence.execution_seal_receipt.execution_id);
      const execution = JSON.parse(readFileSync(path, 'utf8')) as { seal_summary: string };
      execution.seal_summary = 'tampered summary';
      writeFileSync(path, JSON.stringify(execution, null, 2));
    } else if (drift === 'run') {
      const path = join(source.store.runDir('source', source.runId), 'run.json');
      writeFileSync(path, `${readFileSync(path, 'utf8')}\n`);
    } else if (drift === 'artifact') {
      writeFileSync(join(source.store.sessionDir('source'), source.artifact.relative_path), 'drifted');
    } else {
      const path = join(source.store.sessionDir('source'), 'artifacts.json');
      const registry = JSON.parse(readFileSync(path, 'utf8')) as {
        artifacts: Record<string, { role: string; producer_run_id: string; content_hash: string }>;
      };
      const artifact = registry.artifacts[source.artifactId];
      if (drift === 'artifact-role') artifact.role = 'attachment';
      if (drift === 'artifact-producer') artifact.producer_run_id = 'run-tampered';
      if (drift === 'artifact-hash') artifact.content_hash = 'f'.repeat(64);
      writeFileSync(path, JSON.stringify(registry, null, 2));
    }
    expect(() => source.store.validateRecallConfirmationSource('fork', source.fence))
      .toThrow(/receipt|Execution|Run|Artifact|source|hash|content|metadata|producer/i);
  });

  it('rejects wrong Execution generation and cross-Session receipt replay', () => {
    const projectRoot = root();
    const source = sealedSource(projectRoot, 'source');
    const other = sealedSource(projectRoot, 'other');
    const wrongExecution = {
      ...source.fence,
      execution_seal_receipt: other.fence.execution_seal_receipt,
    };
    expect(() => source.store.validateRecallConfirmationSource('fork', wrongExecution))
      .toThrow(/Execution|receipt|source/i);
    const crossSession = {
      ...source.fence,
      session_id: 'other',
      execution_seal_receipt: other.fence.execution_seal_receipt,
    };
    expect(() => source.store.validateRecallConfirmationSource('fork', crossSession))
      .toThrow(/Run|artifact|source|receipt|content/i);
  });
});
