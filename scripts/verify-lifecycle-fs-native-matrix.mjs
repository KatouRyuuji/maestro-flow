import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import { fileURLToPath } from 'node:url';

export const NATIVE_PROTOCOL = 'lifecycle-fs-helper/1.0';
export const DISPATCH_RECEIPT_SCHEMA = 'native-lifecycle-dispatch-receipt/1';
export const CLEANUP_RECEIPT_SCHEMA = 'native-lifecycle-cleanup-complete/1';
export const MANIFEST_SCHEMA = 'lifecycle-fs-native-manifest/1.0';
export const PROVENANCE_SCHEMA = 'lifecycle-fs-native-provenance/1.0';
export const RUN_KEY = '20260724-010-plan';
export const WORKFLOW_ID = 247776234;
export const WORKFLOW_PATH = '.github/workflows/deploy-docs.yml';
export const DEFAULT_REF = 'refs/heads/master';
export const DEFAULT_BLOB_SHA = 'd070327596e52788a309d4aeea84d54339b545b6';
export const EXPECTED_REPO = 'catlog22/maestro-flow';

export const NATIVE_TARGETS = Object.freeze({
  'x86_64-pc-windows-msvc': Object.freeze({
    jobId: 'win32-x64',
    runner: 'windows-2025',
    platform: 'win32',
    arch: 'x64',
    artifactId: 'win32-x64',
    binaryPath: 'resources/lifecycle-fs/win32-x64/maestro-lifecycle-fs.exe',
  }),
  'x86_64-unknown-linux-gnu': Object.freeze({
    jobId: 'linux-x64',
    runner: 'ubuntu-24.04',
    platform: 'linux',
    arch: 'x64',
    artifactId: 'linux-x64',
    binaryPath: 'resources/lifecycle-fs/linux-x64/maestro-lifecycle-fs',
  }),
  'aarch64-unknown-linux-gnu': Object.freeze({
    jobId: 'linux-arm64',
    runner: 'ubuntu-24.04-arm',
    platform: 'linux',
    arch: 'arm64',
    artifactId: 'linux-arm64',
    binaryPath: 'resources/lifecycle-fs/linux-arm64/maestro-lifecycle-fs',
  }),
  'x86_64-apple-darwin': Object.freeze({
    jobId: 'darwin-x64',
    runner: 'macos-15-intel',
    platform: 'darwin',
    arch: 'x64',
    artifactId: 'darwin-x64',
    binaryPath: 'resources/lifecycle-fs/darwin-x64/maestro-lifecycle-fs',
  }),
  'aarch64-apple-darwin': Object.freeze({
    jobId: 'darwin-arm64',
    runner: 'macos-15',
    platform: 'darwin',
    arch: 'arm64',
    artifactId: 'darwin-arm64',
    binaryPath: 'resources/lifecycle-fs/darwin-arm64/maestro-lifecycle-fs',
  }),
});

const TARGET_ORDER = Object.freeze(Object.keys(NATIVE_TARGETS));
const HEX_40 = /^[0-9a-f]{40}$/;
const HEX_64 = /^[0-9a-f]{64}$/;
const NONCE = /^native-[0-9a-f]{32}$/;
const BRANCH = /^maestro\/native-lifecycle-20260724-010-plan-[0-9a-f]{12}$/;
const parsedEvidence = new WeakMap();

function fail(message) {
  throw new Error(`native matrix: ${message}`);
}

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function jcs(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('JCS rejects non-finite numbers');
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(item => {
      if (item === undefined || typeof item === 'function' || typeof item === 'symbol') {
        fail('JCS rejects non-JSON array values');
      }
      return jcs(item);
    }).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      fail('JCS accepts plain JSON objects only');
    }
    return `{${Object.keys(value).sort().map(key => {
      const child = value[key];
      if (child === undefined || typeof child === 'function' || typeof child === 'symbol') {
        fail(`JCS rejects non-JSON value at ${key}`);
      }
      return `${JSON.stringify(key)}:${jcs(child)}`;
    }).join(',')}}`;
  }
  fail(`JCS rejects ${typeof value}`);
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    fail(`${label} keys must be exactly ${wanted.join(', ')}`);
  }
}

function parseJson(raw, label) {
  if (Buffer.isBuffer(raw)) {
    try {
      return JSON.parse(raw.toString('utf8'));
    } catch {
      fail(`${label} is not valid UTF-8 JSON`);
    }
  }
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw);
    } catch {
      fail(`${label} is not valid JSON`);
    }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    fail(`${label} must be an object, Buffer, or JSON string`);
  }
  return raw;
}

function sameIdentity(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function contained(root, path) {
  const rel = relative(root, path);
  return rel !== ''
    && rel !== '..'
    && !rel.startsWith(`..${sep}`)
    && !isAbsolute(rel);
}

function readRegularFileOnce(path, root, label) {
  const rootReal = realpathSync(root);
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink()) fail(`${label} must be a regular non-symlink file`);
  const pathReal = realpathSync(path);
  if (!contained(rootReal, pathReal)) fail(`${label} escapes its authorized root`);
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(fd);
    if (!opened.isFile()
      || opened.dev !== before.dev
      || opened.ino !== before.ino
      || opened.mode !== before.mode) {
      fail(`${label} changed identity before read`);
    }
    const bytes = readFileSync(fd);
    const after = fstatSync(fd);
    if (!sameIdentity(opened, after)) fail(`${label} changed while being read`);
    const afterPath = lstatSync(path);
    if (afterPath.dev !== after.dev || afterPath.ino !== after.ino || afterPath.mode !== after.mode) {
      fail(`${label} path identity changed after read`);
    }
    return bytes;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function workspaceRelativePath(workspaceRoot, absolutePath, label) {
  const rel = relative(workspaceRoot, absolutePath).replaceAll('\\', '/');
  if (!rel || rel === '..' || rel.startsWith('../') || isAbsolute(rel)) {
    fail(`${label} escapes the workspace`);
  }
  return rel;
}

function validateRelativePath(path, expected, label) {
  if (typeof path !== 'string'
    || path !== expected
    || path.includes('\\')
    || path.startsWith('/')
    || /^[A-Za-z]:/.test(path)
    || path.split('/').includes('..')) {
    fail(`${label} is not the exact contained canonical path`);
  }
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function validateJobReceipt(receipt, artifact, mapping, dispatch) {
  exactKeys(receipt, [
    'schema_version',
    'task_id',
    'job_id',
    'runner',
    'target',
    'platform',
    'arch',
    'artifact_name',
    'binary_path',
    'protocol',
    'binary_sha256',
    'source_sha',
    'dispatch_nonce',
    'run_name',
  ], `${artifact.target} job receipt`);
  const expected = {
    schema_version: 'lifecycle-fs-native-receipt/1.0',
    task_id: 'TASK-004',
    job_id: mapping.jobId,
    runner: mapping.runner,
    target: artifact.target,
    platform: mapping.platform,
    arch: mapping.arch,
    artifact_name: artifact.artifact_name,
    binary_path: mapping.binaryPath,
    protocol: NATIVE_PROTOCOL,
    binary_sha256: artifact.binary_sha256,
    source_sha: dispatch.tuple.head_sha,
    dispatch_nonce: dispatch.dispatch_nonce,
    run_name: dispatch.workflow_run.display_title,
  };
  for (const [key, value] of Object.entries(expected)) {
    if (receipt[key] !== value) fail(`${artifact.target} job receipt ${key} mismatch`);
  }
}

function validateAggregate(aggregate, dispatch, evidenceByTarget) {
  exactKeys(aggregate, [
    'schema_version',
    'task_id',
    'source_sha',
    'dispatch_nonce',
    'run_name',
    'protocol',
    'artifacts',
    'aggregate_sha256',
  ], 'aggregate provenance');
  const { aggregate_sha256: storedHash, ...body } = aggregate;
  if (aggregate.schema_version !== 'lifecycle-fs-native-aggregate/1.0'
    || aggregate.task_id !== 'TASK-004'
    || aggregate.source_sha !== dispatch.tuple.head_sha
    || aggregate.dispatch_nonce !== dispatch.dispatch_nonce
    || aggregate.run_name !== dispatch.workflow_run.display_title
    || aggregate.protocol !== NATIVE_PROTOCOL
    || storedHash !== sha256(JSON.stringify(body))
    || !Array.isArray(aggregate.artifacts)
    || aggregate.artifacts.length !== 5) {
    fail('aggregate provenance identity or self-hash mismatch');
  }
  const seen = new Set();
  for (const item of aggregate.artifacts) {
    exactKeys(item, [
      'job_id',
      'runner',
      'target',
      'platform',
      'arch',
      'artifact_name',
      'binary_path',
      'protocol',
      'binary_sha256',
      'receipt_sha256',
    ], 'aggregate artifact');
    const mapping = NATIVE_TARGETS[item.target];
    const evidence = evidenceByTarget.get(item.target);
    if (!mapping || !evidence || seen.has(item.target)) fail('aggregate target set mismatch');
    seen.add(item.target);
    if (item.job_id !== mapping.jobId
      || item.runner !== mapping.runner
      || item.platform !== mapping.platform
      || item.arch !== mapping.arch
      || item.artifact_name !== evidence.artifact.artifact_name
      || item.binary_path !== mapping.binaryPath
      || item.protocol !== NATIVE_PROTOCOL
      || item.binary_sha256 !== evidence.artifact.binary_sha256
      || item.receipt_sha256 !== evidence.artifact.job_receipt_sha256) {
      fail(`${item.target} aggregate mapping mismatch`);
    }
  }
  if (seen.size !== 5 || TARGET_ORDER.some(target => !seen.has(target))) {
    fail('aggregate provenance does not contain the exact five targets');
  }
}

/**
 * Parse and fully verify the sole TASK-013 handoff. This function performs no
 * writes and exposes no integration or cleanup input until every receipt,
 * provenance, path, and byte hash has converged.
 */
export function parseNativeLifecycleDispatchReceipt(raw, context) {
  exactKeys(context, [
    'receiptPath',
    'transactionRoot',
    'expectedRepo',
    'expectedWorkflowId',
    'expectedDefaultRef',
    'expectedDefaultBlobSha',
  ], 'dispatch receipt context');
  const receiptPath = resolve(context.receiptPath);
  const transactionRoot = resolve(context.transactionRoot);
  if (receiptPath !== resolve(transactionRoot, 'dispatch-receipt.json')) {
    fail('receiptPath is not the canonical transaction receipt');
  }
  const transactionName = transactionRoot.split(/[\\/]/).at(-1);
  if (!HEX_64.test(transactionName)) fail('transaction root tuple hash is invalid');
  const workspaceRoot = resolve(transactionRoot, '..', '..', '..', '..', '..', '..');
  const expectedRelativeRoot = `.workflow/tmp/lifecycle-native/${RUN_KEY}/dispatch-transactions/${transactionName}`;
  if (workspaceRelativePath(workspaceRoot, transactionRoot, 'transaction root') !== expectedRelativeRoot) {
    fail('transaction root is not the canonical run path');
  }

  const receipt = parseJson(raw, 'canonical dispatch receipt');
  exactKeys(receipt, [
    'schema_version',
    'transaction_state',
    'cleanup',
    'cleanup_required',
    'tuple',
    'tuple_hash',
    'canonical_inputs',
    'dispatch_nonce',
    'branch',
    'ref',
    'default_ref',
    'default_blob_sha',
    'overlay_commit_sha',
    'workflow_run',
    'artifacts',
    'aggregate_provenance',
    'intent_path',
    'receipt_path',
    'created_at',
    'receipted_at',
    'receipt_sha256',
  ], 'canonical dispatch receipt');
  exactKeys(receipt.cleanup, ['state', 'required'], 'cleanup');
  exactKeys(receipt.tuple, ['repo', 'workflow_id', 'ref', 'head_sha', 'inputs_hash'], 'tuple');
  exactKeys(receipt.canonical_inputs, ['source_sha'], 'canonical_inputs');
  exactKeys(receipt.workflow_run, [
    'id',
    'attempt',
    'workflow_id',
    'event',
    'head_sha',
    'head_branch',
    'head_ref',
    'display_title',
  ], 'workflow_run');
  exactKeys(receipt.aggregate_provenance, ['path', 'sha256'], 'aggregate_provenance');

  const { receipt_sha256: storedReceiptHash, ...receiptBody } = receipt;
  const inputsHash = sha256(jcs(receipt.canonical_inputs));
  const tupleHash = sha256(jcs(receipt.tuple));
  const expectedNonce = `native-${tupleHash.slice(0, 32)}`;
  const expectedTitle = `native-lifecycle-${receipt.tuple.head_sha}-${expectedNonce}`;
  const createdAt = Date.parse(receipt.created_at);
  const receiptedAt = Date.parse(receipt.receipted_at);
  if (receipt.schema_version !== DISPATCH_RECEIPT_SCHEMA
    || receipt.transaction_state !== 'receipted'
    || receipt.cleanup.state !== 'pending'
    || receipt.cleanup.required !== true
    || receipt.cleanup_required !== true
    || receipt.tuple.repo !== context.expectedRepo
    || receipt.tuple.workflow_id !== context.expectedWorkflowId
    || !HEX_40.test(receipt.tuple.head_sha)
    || !HEX_64.test(receipt.tuple.inputs_hash)
    || receipt.tuple.inputs_hash !== inputsHash
    || receipt.canonical_inputs.source_sha !== receipt.tuple.head_sha
    || receipt.tuple_hash !== tupleHash
    || receipt.tuple_hash !== transactionName
    || !NONCE.test(receipt.dispatch_nonce)
    || receipt.dispatch_nonce !== expectedNonce
    || !BRANCH.test(receipt.branch)
    || receipt.ref !== `refs/heads/${receipt.branch}`
    || receipt.tuple.ref !== receipt.ref
    || receipt.default_ref !== context.expectedDefaultRef
    || receipt.default_blob_sha !== context.expectedDefaultBlobSha
    || receipt.overlay_commit_sha !== receipt.tuple.head_sha
    || !Number.isInteger(receipt.workflow_run.id)
    || receipt.workflow_run.id <= 0
    || !Number.isInteger(receipt.workflow_run.attempt)
    || receipt.workflow_run.attempt < 1
    || receipt.workflow_run.workflow_id !== context.expectedWorkflowId
    || receipt.workflow_run.event !== 'workflow_dispatch'
    || receipt.workflow_run.head_sha !== receipt.tuple.head_sha
    || receipt.workflow_run.head_branch !== receipt.branch
    || receipt.workflow_run.head_ref !== receipt.ref
    || receipt.workflow_run.display_title !== expectedTitle
    || !Number.isFinite(createdAt)
    || !Number.isFinite(receiptedAt)
    || receiptedAt < createdAt
    || !HEX_64.test(storedReceiptHash)
    || storedReceiptHash !== sha256(jcs(receiptBody))) {
    fail('canonical dispatch receipt identity, fence, timestamp, or self-hash mismatch');
  }

  validateRelativePath(
    receipt.intent_path,
    `${expectedRelativeRoot}/dispatch-intent.json`,
    'intent_path',
  );
  validateRelativePath(
    receipt.receipt_path,
    `${expectedRelativeRoot}/dispatch-receipt.json`,
    'receipt_path',
  );
  if (receiptPath !== resolve(workspaceRoot, receipt.receipt_path)) {
    fail('receipt path does not resolve to the supplied canonical file');
  }

  if (!Array.isArray(receipt.artifacts) || receipt.artifacts.length !== 5) {
    fail('canonical dispatch receipt must contain exactly five artifacts');
  }
  const evidenceByTarget = new Map();
  const runnerSet = new Set();
  const artifactNameSet = new Set();
  for (const artifact of receipt.artifacts) {
    exactKeys(artifact, [
      'target',
      'runner_label',
      'artifact_name',
      'download_path',
      'binary_path',
      'binary_sha256',
      'protocol_version',
      'job_receipt_sha256',
      'provenance_path',
      'provenance_sha256',
    ], 'canonical artifact');
    const mapping = NATIVE_TARGETS[artifact.target];
    if (!mapping
      || evidenceByTarget.has(artifact.target)
      || runnerSet.has(artifact.runner_label)
      || artifactNameSet.has(artifact.artifact_name)) {
      fail('artifact target, runner, and name mappings must be unique');
    }
    runnerSet.add(artifact.runner_label);
    artifactNameSet.add(artifact.artifact_name);
    const expectedArtifactName = `lifecycle-fs-${mapping.platform}-${mapping.arch}-${receipt.tuple.head_sha}`;
    const expectedDownload = `${expectedRelativeRoot}/download/${expectedArtifactName}`;
    const expectedBinary = `${expectedDownload}/${mapping.binaryPath}`;
    const expectedProvenance = `${expectedDownload}/receipt.json`;
    if (artifact.runner_label !== mapping.runner
      || artifact.artifact_name !== expectedArtifactName
      || artifact.protocol_version !== NATIVE_PROTOCOL
      || !HEX_64.test(artifact.binary_sha256)
      || !HEX_64.test(artifact.job_receipt_sha256)
      || artifact.provenance_sha256 !== artifact.job_receipt_sha256) {
      fail(`${artifact.target} canonical mapping mismatch`);
    }
    validateRelativePath(artifact.download_path, expectedDownload, `${artifact.target} download_path`);
    validateRelativePath(artifact.binary_path, expectedBinary, `${artifact.target} binary_path`);
    validateRelativePath(
      artifact.provenance_path,
      expectedProvenance,
      `${artifact.target} provenance_path`,
    );
    const binaryAbsolute = resolve(workspaceRoot, artifact.binary_path);
    const provenanceAbsolute = resolve(workspaceRoot, artifact.provenance_path);
    const artifactRoot = resolve(workspaceRoot, artifact.download_path);
    const binaryBytes = readRegularFileOnce(binaryAbsolute, artifactRoot, `${artifact.target} binary`);
    const provenanceBytes = readRegularFileOnce(
      provenanceAbsolute,
      artifactRoot,
      `${artifact.target} provenance`,
    );
    if (sha256(binaryBytes) !== artifact.binary_sha256
      || sha256(provenanceBytes) !== artifact.provenance_sha256) {
      fail(`${artifact.target} binary or provenance rehash mismatch`);
    }
    validateJobReceipt(parseJson(provenanceBytes, `${artifact.target} provenance`), artifact, mapping, receipt);
    evidenceByTarget.set(artifact.target, {
      artifact,
      binaryAbsolute,
      provenanceAbsolute,
      binaryBytes,
      provenanceBytes,
    });
  }
  if (evidenceByTarget.size !== 5 || TARGET_ORDER.some(target => !evidenceByTarget.has(target))) {
    fail('dispatch receipt does not contain the exact target set');
  }

  const aggregateRelative = `${expectedRelativeRoot}/download/aggregate-provenance.json`;
  validateRelativePath(
    receipt.aggregate_provenance.path,
    aggregateRelative,
    'aggregate provenance path',
  );
  if (!HEX_64.test(receipt.aggregate_provenance.sha256)) {
    fail('aggregate provenance SHA-256 is invalid');
  }
  const aggregateAbsolute = resolve(workspaceRoot, aggregateRelative);
  const aggregateBytes = readRegularFileOnce(
    aggregateAbsolute,
    resolve(workspaceRoot, `${expectedRelativeRoot}/download`),
    'aggregate provenance',
  );
  if (sha256(aggregateBytes) !== receipt.aggregate_provenance.sha256) {
    fail('aggregate provenance rehash mismatch');
  }
  validateAggregate(parseJson(aggregateBytes, 'aggregate provenance'), receipt, evidenceByTarget);

  const accepted = deepFreeze(receipt);
  parsedEvidence.set(accepted, {
    workspaceRoot,
    transactionRoot,
    receiptPath,
    receiptBytes: Buffer.isBuffer(raw) ? raw : Buffer.from(jcs(receipt)),
    aggregateAbsolute,
    aggregateBytes,
    evidenceByTarget,
  });
  return accepted;
}

export function readNativeLifecycleDispatchReceipt(context) {
  const transactionRoot = resolve(context.transactionRoot);
  const receiptPath = resolve(context.receiptPath);
  const bytes = readRegularFileOnce(receiptPath, transactionRoot, 'canonical dispatch receipt');
  return parseNativeLifecycleDispatchReceipt(bytes, context);
}

function fsyncDirectory(path) {
  let fd;
  try {
    fd = openSync(path, 'r');
    fsyncSync(fd);
  } catch (error) {
    if (!(process.platform === 'win32' && error?.code === 'EPERM')) throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function atomicWrite(path, bytes, mode = 0o600) {
  mkdirSync(dirname(path), { recursive: true });
  const tempPath = `${path}.tmp-${process.pid}-${randomBytes(16).toString('hex')}`;
  let fd;
  try {
    fd = openSync(tempPath, 'wx', mode);
    writeSync(fd, bytes);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tempPath, path);
    fsyncDirectory(dirname(path));
  } catch (error) {
    try {
      if (existsSync(tempPath)) unlinkSync(tempPath);
    } catch {
      // Preserve the primary error.
    }
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function atomicInstallExact(path, bytes, expectedHash, executable) {
  if (existsSync(path)) {
    const existing = readFileSync(path);
    if (sha256(existing) !== expectedHash) fail(`existing resource is not the expected byte: ${path}`);
    return;
  }
  atomicWrite(path, bytes, executable ? 0o755 : 0o600);
  if (executable && process.platform !== 'win32') chmodSync(path, 0o755);
  if (sha256(readFileSync(path)) !== expectedHash) fail(`installed resource rehash failed: ${path}`);
}

export function integrateNativeLifecycleResources(receipt, options = {}) {
  const evidence = parsedEvidence.get(receipt);
  if (!evidence) fail('integration requires a receipt returned by the production parser');
  const workspaceRoot = resolve(options.workspaceRoot ?? evidence.workspaceRoot);
  if (workspaceRoot !== evidence.workspaceRoot) fail('integration workspace differs from parsed receipt');
  const resourcesRoot = resolve(workspaceRoot, 'resources/lifecycle-fs');
  const manifestPath = resolve(resourcesRoot, 'manifest.json');
  const provenancePath = resolve(resourcesRoot, 'provenance.json');
  const cleanupReceiptPath = `.workflow/tmp/lifecycle-native/${RUN_KEY}/${receipt.tuple.head_sha}/${receipt.dispatch_nonce}/cleanup-complete.json`;

  const manifestArtifacts = TARGET_ORDER.map(target => {
    const mapping = NATIVE_TARGETS[target];
    const source = evidence.evidenceByTarget.get(target);
    const destination = resolve(workspaceRoot, mapping.binaryPath);
    atomicInstallExact(destination, source.binaryBytes, source.artifact.binary_sha256, mapping.platform !== 'win32');
    return {
      target,
      platform: mapping.platform,
      arch: mapping.arch,
      path: mapping.binaryPath,
      sha256: source.artifact.binary_sha256,
      protocol: NATIVE_PROTOCOL,
    };
  });
  const manifest = {
    schema_version: MANIFEST_SCHEMA,
    protocol: NATIVE_PROTOCOL,
    artifacts: manifestArtifacts,
  };
  const provenance = {
    schema_version: PROVENANCE_SCHEMA,
    repo: receipt.tuple.repo,
    workflow_id: receipt.workflow_run.workflow_id,
    workflow_path: WORKFLOW_PATH,
    run_name: receipt.workflow_run.display_title,
    database_id: receipt.workflow_run.id,
    run_attempt: receipt.workflow_run.attempt,
    ref: receipt.ref,
    source_sha: receipt.tuple.head_sha,
    dispatch_nonce: receipt.dispatch_nonce,
    workflow_tuple_sha256: receipt.tuple_hash,
    dispatch_receipt_path: receipt.receipt_path,
    dispatch_receipt_self_sha256: receipt.receipt_sha256,
    dispatch_receipt_file_sha256: sha256(evidence.receiptBytes),
    aggregate_provenance_path: receipt.aggregate_provenance.path,
    aggregate_provenance_sha256: receipt.aggregate_provenance.sha256,
    default_ref: receipt.default_ref,
    default_blob_pre_sha: receipt.default_blob_sha,
    default_blob_post_sha: DEFAULT_BLOB_SHA,
    cleanup_receipt_path: cleanupReceiptPath,
    artifacts: TARGET_ORDER.map(target => {
      const source = evidence.evidenceByTarget.get(target);
      return {
        target,
        job_receipt_sha256: source.artifact.job_receipt_sha256,
        binary_sha256: source.artifact.binary_sha256,
      };
    }),
  };
  atomicInstallExact(
    manifestPath,
    Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`),
    sha256(Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`)),
    false,
  );
  atomicInstallExact(
    provenancePath,
    Buffer.from(`${JSON.stringify(provenance, null, 2)}\n`),
    sha256(Buffer.from(`${JSON.stringify(provenance, null, 2)}\n`)),
    false,
  );
  return verifyIntegratedResources({ workspaceRoot, receipt });
}

export function verifyIntegratedResources({ workspaceRoot, receipt = null }) {
  const root = resolve(workspaceRoot);
  const manifestPath = resolve(root, 'resources/lifecycle-fs/manifest.json');
  const provenancePath = resolve(root, 'resources/lifecycle-fs/provenance.json');
  const manifestBytes = readFileSync(manifestPath);
  const provenanceBytes = readFileSync(provenancePath);
  const manifest = parseJson(manifestBytes, 'native manifest');
  const provenance = parseJson(provenanceBytes, 'native provenance');
  exactKeys(manifest, ['schema_version', 'protocol', 'artifacts'], 'native manifest');
  if (manifest.schema_version !== MANIFEST_SCHEMA
    || manifest.protocol !== NATIVE_PROTOCOL
    || !Array.isArray(manifest.artifacts)
    || manifest.artifacts.length !== 5) {
    fail('native manifest identity mismatch');
  }
  const seen = new Set();
  for (const artifact of manifest.artifacts) {
    exactKeys(artifact, ['target', 'platform', 'arch', 'path', 'sha256', 'protocol'], 'manifest artifact');
    const mapping = NATIVE_TARGETS[artifact.target];
    if (!mapping || seen.has(artifact.target)) fail('manifest target set mismatch');
    seen.add(artifact.target);
    if (artifact.platform !== mapping.platform
      || artifact.arch !== mapping.arch
      || artifact.path !== mapping.binaryPath
      || artifact.protocol !== NATIVE_PROTOCOL
      || !HEX_64.test(artifact.sha256)
      || sha256(readFileSync(resolve(root, artifact.path))) !== artifact.sha256) {
      fail(`${artifact.target} checked-in resource mismatch`);
    }
  }
  if (seen.size !== 5 || TARGET_ORDER.some(target => !seen.has(target))) {
    fail('manifest must contain exactly five targets');
  }
  exactKeys(provenance, [
    'schema_version',
    'repo',
    'workflow_id',
    'workflow_path',
    'run_name',
    'database_id',
    'run_attempt',
    'ref',
    'source_sha',
    'dispatch_nonce',
    'workflow_tuple_sha256',
    'dispatch_receipt_path',
    'dispatch_receipt_self_sha256',
    'dispatch_receipt_file_sha256',
    'aggregate_provenance_path',
    'aggregate_provenance_sha256',
    'default_ref',
    'default_blob_pre_sha',
    'default_blob_post_sha',
    'cleanup_receipt_path',
    'artifacts',
  ], 'native provenance');
  if (provenance.schema_version !== PROVENANCE_SCHEMA
    || provenance.repo !== EXPECTED_REPO
    || provenance.workflow_id !== WORKFLOW_ID
    || provenance.workflow_path !== WORKFLOW_PATH
    || provenance.default_ref !== DEFAULT_REF
    || provenance.default_blob_pre_sha !== DEFAULT_BLOB_SHA
    || provenance.default_blob_post_sha !== DEFAULT_BLOB_SHA
    || !HEX_40.test(provenance.source_sha)
    || !NONCE.test(provenance.dispatch_nonce)
    || !HEX_64.test(provenance.workflow_tuple_sha256)
    || !Array.isArray(provenance.artifacts)
    || provenance.artifacts.length !== 5) {
    fail('native provenance identity mismatch');
  }
  if (receipt && (provenance.source_sha !== receipt.tuple.head_sha
    || provenance.ref !== receipt.ref
    || provenance.database_id !== receipt.workflow_run.id
    || provenance.workflow_tuple_sha256 !== receipt.tuple_hash
    || provenance.dispatch_receipt_self_sha256 !== receipt.receipt_sha256)) {
    fail('native provenance does not bind the accepted dispatch receipt');
  }
  return {
    manifest,
    provenance,
    manifest_sha256: sha256(manifestBytes),
    provenance_sha256: sha256(provenanceBytes),
  };
}

function command(commandName, args, options = {}) {
  return spawnSync(commandName, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
  });
}

function requireCommand(commandName, args, options = {}) {
  const result = command(commandName, args, options);
  if (result.error || result.status !== 0) {
    fail(`${commandName} ${args.join(' ')} failed: ${
      result.error?.message ?? (result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`)
    }`);
  }
  return result.stdout.trim();
}

function parseWorktrees(output) {
  return output.split(/\r?\n\r?\n/).filter(Boolean).map(block => {
    const record = {};
    for (const line of block.split(/\r?\n/)) {
      const [key, ...rest] = line.split(' ');
      record[key] = rest.join(' ');
    }
    return record;
  });
}

export function cleanupNativeLifecycleDispatch({
  receiptPath,
  workspaceRoot,
  finalImplementationCommitSha,
  remote = 'origin',
}) {
  const root = resolve(workspaceRoot);
  if (!HEX_40.test(finalImplementationCommitSha)) fail('final implementation commit SHA is invalid');
  const transactionRoot = dirname(resolve(receiptPath));
  const receipt = readNativeLifecycleDispatchReceipt({
    receiptPath,
    transactionRoot,
    expectedRepo: EXPECTED_REPO,
    expectedWorkflowId: WORKFLOW_ID,
    expectedDefaultRef: DEFAULT_REF,
    expectedDefaultBlobSha: DEFAULT_BLOB_SHA,
  });
  const integrated = verifyIntegratedResources({ workspaceRoot: root, receipt });
  const branch = receipt.branch;
  const ref = receipt.ref;
  const overlay = receipt.overlay_commit_sha;
  const worktree = resolve(
    root,
    '.workflow',
    'tmp',
    'lifecycle-native',
    RUN_KEY,
    `worktree-${branch.slice(-12)}`,
  );

  const remoteBefore = requireCommand('git', ['ls-remote', '--heads', remote, ref], { cwd: root });
  const [remoteSha, remoteRef] = remoteBefore.split(/\s+/);
  if (remoteSha !== overlay || remoteRef !== ref) fail('cleanup remote ref does not equal the receipt head');
  const localSha = requireCommand('git', ['rev-parse', ref], { cwd: root });
  if (localSha !== overlay) fail('cleanup local branch does not equal the receipt head');
  const worktreeRecords = parseWorktrees(requireCommand('git', ['worktree', 'list', '--porcelain'], { cwd: root }));
  const worktreeRecord = worktreeRecords.find(record => resolve(record.worktree) === worktree);
  if (!worktreeRecord
    || worktreeRecord.branch !== ref
    || worktreeRecord.HEAD !== overlay
    || requireCommand('git', ['status', '--porcelain'], { cwd: worktree }) !== '') {
    fail('cleanup worktree identity or cleanliness mismatch');
  }
  const preBlob = requireCommand(
    'gh',
    ['api', `repos/${EXPECTED_REPO}/contents/${WORKFLOW_PATH}?ref=master`, '--jq', '.sha'],
    { cwd: root },
  );
  if (preBlob !== DEFAULT_BLOB_SHA) fail('pre-cleanup default blob fence mismatch');

  const mutations = [];
  requireCommand('git', ['push', remote, '--delete', branch], { cwd: root });
  mutations.push({
    command: `git push ${remote} --delete ${branch}`,
    ref,
    expected_sha: overlay,
    result_sha256: sha256(Buffer.from(`${ref}\0${overlay}\0deleted`)),
  });
  requireCommand('git', ['worktree', 'remove', worktree], { cwd: root });
  mutations.push({
    command: `git worktree remove ${workspaceRelativePath(root, worktree, 'cleanup worktree')}`,
    ref,
    expected_sha: overlay,
    result_sha256: sha256(Buffer.from(`${worktree}\0${overlay}\0removed`)),
  });
  requireCommand('git', ['branch', '-D', '--', branch], { cwd: root });
  mutations.push({
    command: `git branch -D -- ${branch}`,
    ref,
    expected_sha: overlay,
    result_sha256: sha256(Buffer.from(`${branch}\0${overlay}\0deleted`)),
  });

  const remoteAfter = command('git', ['ls-remote', '--exit-code', '--heads', remote, ref], { cwd: root });
  if (remoteAfter.error || remoteAfter.status !== 2 || remoteAfter.stdout.trim() !== '') {
    fail('temporary remote ref still exists after cleanup');
  }
  const localAfter = command('git', ['show-ref', '--verify', '--quiet', ref], { cwd: root });
  if (localAfter.error || localAfter.status !== 1) fail('temporary local branch still exists after cleanup');
  if (existsSync(worktree)
    || parseWorktrees(requireCommand('git', ['worktree', 'list', '--porcelain'], { cwd: root }))
      .some(record => resolve(record.worktree) === worktree)) {
    fail('temporary worktree still exists after cleanup');
  }
  const postBlob = requireCommand(
    'gh',
    ['api', `repos/${EXPECTED_REPO}/contents/${WORKFLOW_PATH}?ref=master`, '--jq', '.sha'],
    { cwd: root },
  );
  if (postBlob !== DEFAULT_BLOB_SHA) fail('post-cleanup default blob fence mismatch');
  const ancestry = command(
    'git',
    ['merge-base', '--is-ancestor', overlay, finalImplementationCommitSha],
    { cwd: root },
  );
  if (ancestry.error || ancestry.status !== 1) fail('overlay commit is an ancestor of final implementation');
  const finalFiles = requireCommand(
    'git',
    ['diff-tree', '--no-commit-id', '--name-only', '-r', finalImplementationCommitSha],
    { cwd: root },
  ).split(/\r?\n/).filter(Boolean);
  if (finalFiles.includes(WORKFLOW_PATH)) fail('final implementation commit contains the workflow overlay');

  const evidence = parsedEvidence.get(receipt);
  const body = {
    schema_version: CLEANUP_RECEIPT_SCHEMA,
    dispatch_receipt_sha256: sha256(evidence.receiptBytes),
    workflow_tuple_sha256: receipt.tuple_hash,
    database_id: receipt.workflow_run.id,
    integrated_manifest_sha256: integrated.manifest_sha256,
    integrated_provenance_sha256: integrated.provenance_sha256,
    remote_branch_deleted: true,
    local_worktree_removed: true,
    local_branch_deleted: true,
    post_default_blob_sha: postBlob,
    overlay_excluded: true,
    overlay_commit_sha: overlay,
    final_implementation_commit_sha: finalImplementationCommitSha,
    status: 'cleanup_complete',
    external_mutations: mutations,
  };
  const cleanupReceipt = { ...body, receipt_sha256: sha256(jcs(body)) };
  const cleanupPath = resolve(root, integrated.provenance.cleanup_receipt_path);
  atomicWrite(cleanupPath, Buffer.from(`${jcs(cleanupReceipt)}\n`));
  return { receipt: cleanupReceipt, path: cleanupPath };
}

export function verifyCleanupCompleteReceipt({ workspaceRoot, receiptPath }) {
  const root = resolve(workspaceRoot);
  const bytes = readFileSync(receiptPath);
  const receipt = parseJson(bytes, 'cleanup-complete receipt');
  exactKeys(receipt, [
    'schema_version',
    'dispatch_receipt_sha256',
    'workflow_tuple_sha256',
    'database_id',
    'integrated_manifest_sha256',
    'integrated_provenance_sha256',
    'remote_branch_deleted',
    'local_worktree_removed',
    'local_branch_deleted',
    'post_default_blob_sha',
    'overlay_excluded',
    'overlay_commit_sha',
    'final_implementation_commit_sha',
    'status',
    'external_mutations',
    'receipt_sha256',
  ], 'cleanup-complete receipt');
  const { receipt_sha256: storedHash, ...body } = receipt;
  if (receipt.schema_version !== CLEANUP_RECEIPT_SCHEMA
    || receipt.status !== 'cleanup_complete'
    || receipt.remote_branch_deleted !== true
    || receipt.local_worktree_removed !== true
    || receipt.local_branch_deleted !== true
    || receipt.post_default_blob_sha !== DEFAULT_BLOB_SHA
    || receipt.overlay_excluded !== true
    || !HEX_40.test(receipt.overlay_commit_sha)
    || !HEX_40.test(receipt.final_implementation_commit_sha)
    || !HEX_64.test(receipt.dispatch_receipt_sha256)
    || !HEX_64.test(receipt.workflow_tuple_sha256)
    || !HEX_64.test(receipt.integrated_manifest_sha256)
    || !HEX_64.test(receipt.integrated_provenance_sha256)
    || !Array.isArray(receipt.external_mutations)
    || receipt.external_mutations.length !== 3
    || storedHash !== sha256(jcs(body))) {
    fail('cleanup-complete receipt invariant or self-hash mismatch');
  }
  const integrated = verifyIntegratedResources({ workspaceRoot: root });
  if (integrated.manifest_sha256 !== receipt.integrated_manifest_sha256
    || integrated.provenance_sha256 !== receipt.integrated_provenance_sha256) {
    fail('cleanup-complete receipt does not bind the integrated resources');
  }
  const dispatchBytes = readFileSync(resolve(root, integrated.provenance.dispatch_receipt_path));
  if (sha256(dispatchBytes) !== receipt.dispatch_receipt_sha256
    || integrated.provenance.workflow_tuple_sha256 !== receipt.workflow_tuple_sha256
    || integrated.provenance.database_id !== receipt.database_id) {
    fail('cleanup-complete receipt does not bind the canonical dispatch receipt');
  }
  const remote = command(
    'git',
    ['ls-remote', '--exit-code', '--heads', 'origin', integrated.provenance.ref],
    { cwd: root },
  );
  if (remote.error || remote.status !== 2 || remote.stdout.trim() !== '') {
    fail('cleanup-complete remote absence fence failed');
  }
  const ancestry = command(
    'git',
    ['merge-base', '--is-ancestor', receipt.overlay_commit_sha, receipt.final_implementation_commit_sha],
    { cwd: root },
  );
  if (ancestry.error || ancestry.status !== 1) fail('cleanup-complete overlay exclusion failed');
  return receipt;
}

function parseArguments(argv) {
  const flags = new Set([
    '--require-five',
    '--rehash-download',
    '--rehash-resources',
    '--verify-post-fence',
    '--integrate',
  ]);
  const values = new Set(['--receipt', '--workspace-root']);
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (flags.has(key)) {
      if (parsed[key]) fail(`duplicate argument ${key}`);
      parsed[key] = true;
      continue;
    }
    if (!values.has(key) || parsed[key] !== undefined || argv[index + 1] === undefined) {
      fail(`invalid or duplicate argument ${key ?? '<missing>'}`);
    }
    parsed[key] = argv[index + 1];
    index += 1;
  }
  if (!parsed['--receipt']) fail('--receipt is required');
  return parsed;
}

function main(argv) {
  const args = parseArguments(argv);
  const workspaceRoot = resolve(
    args['--workspace-root'] ?? resolve(dirname(fileURLToPath(import.meta.url)), '..'),
  );
  const receiptPath = resolve(workspaceRoot, args['--receipt']);
  const initial = parseJson(readFileSync(receiptPath), 'receipt');
  if (initial.schema_version === CLEANUP_RECEIPT_SCHEMA) {
    if (!args['--verify-post-fence']) fail('cleanup receipt requires --verify-post-fence');
    verifyCleanupCompleteReceipt({ workspaceRoot, receiptPath });
    process.stdout.write('native cleanup verification passed\n');
    return;
  }
  const receipt = readNativeLifecycleDispatchReceipt({
    receiptPath,
    transactionRoot: dirname(receiptPath),
    expectedRepo: EXPECTED_REPO,
    expectedWorkflowId: WORKFLOW_ID,
    expectedDefaultRef: DEFAULT_REF,
    expectedDefaultBlobSha: DEFAULT_BLOB_SHA,
  });
  if (args['--integrate']) integrateNativeLifecycleResources(receipt, { workspaceRoot });
  if (args['--rehash-resources']) verifyIntegratedResources({ workspaceRoot, receipt });
  process.stdout.write(`native matrix verified run ${receipt.workflow_run.id}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
