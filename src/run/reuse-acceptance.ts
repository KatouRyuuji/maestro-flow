import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { hashDirectory } from './artifacts.js';
import { canonicalWorkspaceId } from './intent-identity.js';
import type {
  ExecutionSealReceiptAnchor,
  ReuseAssessmentInput,
  ReuseAssessmentRead,
  ReuseSourceFenceRead,
  ReuseSourceFenceV11,
} from './reuse-assessment.js';
import { assessArtifactReuse } from './reuse-assessment.js';
import { SessionStore } from './store.js';
import { sha256Digest } from './transition-receipts.js';

function observedPathHash(path: string): string {
  if (!existsSync(path)) throw new Error('reuse source artifact is missing');
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw new Error('reuse source artifact cannot be a symbolic link');
  return stat.isDirectory()
    ? `sha256:${hashDirectory(path).hash}`
    : sha256Digest(readFileSync(path));
}

export function buildReuseExecutionAnchor(
  projectRoot: string,
  sessionId: string,
  producerRunId: string,
  artifactId: string,
  authorityStore?: SessionStore,
): ExecutionSealReceiptAnchor | null {
  const store = authorityStore ?? new SessionStore(projectRoot);
  const session = store.readSessionRecord(sessionId);
  let executionId: string | null = null;
  try {
    executionId = store.readExecutionRun(sessionId, producerRunId).execution_id;
  } catch {
    const migratedExecutionId = 'execution-legacy-g1';
    if (existsSync(store.executionPath(sessionId, migratedExecutionId))) {
      store.readExecution(sessionId, migratedExecutionId);
      executionId = migratedExecutionId;
    } else if (session.schema_version === 'session/2.0') {
      executionId = migratedExecutionId;
    }
  }
  if (!executionId) return null;
  const receipt = store.readExecutionSealReceipt(sessionId, executionId);
  if (!receipt) throw new Error('reuse source requires a sealed Execution receipt');
  if (!receipt.runs.some(item => item.run_id === producerRunId)) {
    throw new Error('reuse producer Run is not present in the sealed Execution receipt');
  }
  const currentArtifact = store.readBundle(sessionId).artifacts.artifacts[artifactId];
  if (receipt.schema_version === 'execution-seal-receipt/1.1') {
    const snapshot = receipt.artifacts.snapshots.find(item => item.artifact_id === artifactId);
    if (!snapshot || snapshot.producer_run_id !== producerRunId) {
      throw new Error('reuse artifact does not belong to the producer Run');
    }
  } else if (!currentArtifact
    || currentArtifact.producer_run_id !== producerRunId
    || receipt.artifacts.content_hashes[artifactId] !== `sha256:${currentArtifact.content_hash}`) {
    throw new Error('reuse artifact is not present in the sealed Execution receipt');
  }
  return {
    execution_id: receipt.execution_id,
    generation: receipt.generation,
    sealed_at: receipt.sealed_at,
    relative_path: `executions/${receipt.execution_id}/seal-receipt.json`,
    overall_hash: receipt.overall_hash,
  };
}

export function assessReceiptBackedArtifactReuse(
  projectRoot: string,
  input: ReuseAssessmentInput,
  authorityStore?: SessionStore,
): ReuseAssessmentRead {
  const store = authorityStore ?? new SessionStore(projectRoot);
  const anchor = buildReuseExecutionAnchor(
    projectRoot,
    input.candidate.sessionId,
    input.candidate.producerRunId,
    input.candidate.artifactId,
    store,
  );
  if (!anchor) return assessArtifactReuse(input);
  const assessment = assessArtifactReuse({
    ...input,
    candidate: {
      ...input.candidate,
      executionSourceRequired: true,
      executionSealReceipt: anchor,
    },
  });
  validateReuseAcceptance(projectRoot, assessment, store);
  return assessment;
}

export function validateReuseSourceFence(
  projectRoot: string,
  fence: ReuseSourceFenceRead,
  authorityStore?: SessionStore,
): void {
  if (fence.schema_version === 'reuse-source-fence/1.0') return;
  validateReceiptBackedReuseFence(projectRoot, fence, authorityStore);
}

export function validateReuseAcceptance(
  projectRoot: string,
  assessment: ReuseAssessmentRead,
  authorityStore?: SessionStore,
): void {
  validateReuseSourceFence(projectRoot, assessment.source_fence, authorityStore);
}

function validateReceiptBackedReuseFence(
  projectRoot: string,
  fence: ReuseSourceFenceV11,
  authorityStore?: SessionStore,
): void {
  if (canonicalWorkspaceId(projectRoot) !== fence.workspace_id) {
    throw new Error('reuse source workspace identity changed');
  }
  const store = authorityStore ?? new SessionStore(projectRoot);
  const locator = fence.execution_seal_receipt;
  const expectedPath = `executions/${locator.execution_id}/seal-receipt.json`;
  if (locator.relative_path.replaceAll('\\', '/') !== expectedPath) {
    throw new Error('reuse Execution seal receipt path changed');
  }
  const receipt = store.readExecutionSealReceipt(fence.session_id, locator.execution_id);
  if (!receipt) throw new Error('reuse Execution seal receipt is missing');
  const execution = store.readExecution(fence.session_id, locator.execution_id);
  if (receipt.overall_hash !== locator.overall_hash
    || receipt.session_id !== fence.session_id
    || receipt.execution_id !== locator.execution_id
    || receipt.generation !== locator.generation
    || receipt.sealed_at !== locator.sealed_at
    || execution.status !== 'sealed'
    || execution.generation !== locator.generation
    || execution.revision !== receipt.execution_revision
    || execution.sealed_at !== locator.sealed_at) {
    throw new Error('reuse sealed Execution source anchor changed');
  }
  const runPath = join(store.runDir(fence.session_id, fence.producer_run_id), 'run.json');
  const run = store.readRun(fence.session_id, fence.producer_run_id);
  const runSnapshot = receipt.runs.find(item => item.run_id === fence.producer_run_id);
  if (run.status !== 'sealed'
    || !runSnapshot
    || runSnapshot.content_hash !== fence.producer_run_hash
    || sha256Digest(readFileSync(runPath)) !== fence.producer_run_hash) {
    throw new Error('reuse sealed Run content or receipt binding changed');
  }
  try {
    const executionRun = store.readExecutionRun(fence.session_id, fence.producer_run_id);
    if (executionRun.execution_id !== locator.execution_id
      || executionRun.generation !== locator.generation) {
      throw new Error('reuse Run belongs to a different Execution generation');
    }
  } catch (error) {
    if (runSnapshot.schema_version === 'command-run/1.4') throw error;
  }
  const bundleArtifact = store.readBundle(fence.session_id).artifacts.artifacts[fence.artifact_id];
  const receiptArtifact = receipt.schema_version === 'execution-seal-receipt/1.1'
    ? receipt.artifacts.snapshots.find(item => item.artifact_id === fence.artifact_id)
    : null;
  const artifact = receiptArtifact ?? bundleArtifact;
  const artifactHash = artifact
    ? ('content_hash' in artifact && artifact.content_hash.startsWith('sha256:')
        ? artifact.content_hash
        : `sha256:${artifact.content_hash}`)
    : null;
  if (!artifact
    || artifact.producer_run_id !== fence.producer_run_id
    || artifact.role !== fence.artifact_role
    || artifact.schema_version !== fence.artifact_schema
    || (receiptArtifact ? receiptArtifact.status !== 'sealed' : bundleArtifact?.status !== 'sealed')
    || artifactHash !== fence.artifact_hash
    || receipt.artifacts.content_hashes[fence.artifact_id] !== fence.artifact_hash) {
    throw new Error('reuse source artifact receipt binding changed');
  }
  const artifactPath = join(store.sessionDir(fence.session_id), artifact.relative_path);
  if (observedPathHash(artifactPath) !== fence.artifact_hash
    || fence.observed_artifact_hash !== fence.artifact_hash) {
    throw new Error('reuse source artifact content hash changed');
  }
}
