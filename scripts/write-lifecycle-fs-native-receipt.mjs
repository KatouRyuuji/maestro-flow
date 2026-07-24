import { createHash } from 'node:crypto';
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const NATIVE_RECEIPT_SCHEMA = 'lifecycle-fs-native-receipt/1.0';
export const NATIVE_PROTOCOL = 'lifecycle-fs-helper/1.0';
export const NATIVE_TASK_ID = 'TASK-004';
export const DISPATCH_NONCE_PATTERN = /^maestro-search-ranking-exec-20260723-102551-20260724-010-plan-TASK-013-attempt-[1-9][0-9]{0,5}$/;
export const SOURCE_SHA_PATTERN = /^[0-9a-f]{40}$/;

export const NATIVE_TARGETS = Object.freeze({
  'win32-x64': Object.freeze({
    runner: 'windows-2025',
    target: 'x86_64-pc-windows-msvc',
    platform: 'win32',
    arch: 'x64',
    binaryPath: 'resources/lifecycle-fs/win32-x64/maestro-lifecycle-fs.exe',
  }),
  'linux-x64': Object.freeze({
    runner: 'ubuntu-24.04',
    target: 'x86_64-unknown-linux-gnu',
    platform: 'linux',
    arch: 'x64',
    binaryPath: 'resources/lifecycle-fs/linux-x64/maestro-lifecycle-fs',
  }),
  'linux-arm64': Object.freeze({
    runner: 'ubuntu-24.04-arm',
    target: 'aarch64-unknown-linux-gnu',
    platform: 'linux',
    arch: 'arm64',
    binaryPath: 'resources/lifecycle-fs/linux-arm64/maestro-lifecycle-fs',
  }),
  'darwin-x64': Object.freeze({
    runner: 'macos-15-intel',
    target: 'x86_64-apple-darwin',
    platform: 'darwin',
    arch: 'x64',
    binaryPath: 'resources/lifecycle-fs/darwin-x64/maestro-lifecycle-fs',
  }),
  'darwin-arm64': Object.freeze({
    runner: 'macos-15',
    target: 'aarch64-apple-darwin',
    platform: 'darwin',
    arch: 'arm64',
    binaryPath: 'resources/lifecycle-fs/darwin-arm64/maestro-lifecycle-fs',
  }),
});

function fail(message) {
  throw new Error(`native receipt: ${message}`);
}

function assertDispatchIdentity(sourceSha, dispatchNonce) {
  if (!SOURCE_SHA_PATTERN.test(sourceSha)) {
    fail('source_sha must be a lowercase 40-character Git SHA');
  }
  if (dispatchNonce.length > 128 || !DISPATCH_NONCE_PATTERN.test(dispatchNonce)) {
    fail('dispatch_nonce does not match the pinned TASK-013 attempt format');
  }
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function probeProtocol(binaryPath, sourceSha) {
  const requestId = `native-probe-${sourceSha}`;
  const result = spawnSync(binaryPath, {
    input: JSON.stringify({ requestId }),
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.error) {
    fail(`protocol probe failed to start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    fail(`protocol probe exited ${result.status}: ${result.stderr.trim()}`);
  }
  let response;
  try {
    response = JSON.parse(result.stdout);
  } catch {
    fail('protocol probe did not emit one JSON response');
  }
  if (response.protocol !== NATIVE_PROTOCOL || response.requestId !== requestId) {
    fail('protocol probe response is not bound to lifecycle-fs-helper/1.0 and source_sha');
  }
}

function canonicalJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function writeNativeReceipt({
  jobId,
  compiledBinary,
  outputRoot,
  sourceSha,
  dispatchNonce,
}) {
  const target = NATIVE_TARGETS[jobId];
  if (!target) {
    fail(`unknown job_id: ${jobId}`);
  }
  assertDispatchIdentity(sourceSha, dispatchNonce);

  const compiledPath = resolve(compiledBinary);
  probeProtocol(compiledPath, sourceSha);
  const binaryBytes = readFileSync(compiledPath);
  const artifactName = `lifecycle-fs-${target.platform}-${target.arch}-${sourceSha}`;
  const runName = `native-lifecycle-${sourceSha}-${dispatchNonce}`;
  const destination = resolve(outputRoot, target.binaryPath);
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(compiledPath, destination);

  const receipt = {
    schema_version: NATIVE_RECEIPT_SCHEMA,
    task_id: NATIVE_TASK_ID,
    job_id: jobId,
    runner: target.runner,
    target: target.target,
    platform: target.platform,
    arch: target.arch,
    artifact_name: artifactName,
    binary_path: target.binaryPath,
    protocol: NATIVE_PROTOCOL,
    binary_sha256: sha256(binaryBytes),
    source_sha: sourceSha,
    dispatch_nonce: dispatchNonce,
    run_name: runName,
  };
  const receiptPath = resolve(outputRoot, 'receipt.json');
  mkdirSync(dirname(receiptPath), { recursive: true });
  writeFileSync(receiptPath, canonicalJson(receipt), { encoding: 'utf8', flag: 'wx' });
  return receipt;
}

function parseArguments(argv) {
  const known = new Set([
    '--job-id',
    '--compiled-binary',
    '--output-root',
    '--source-sha',
    '--dispatch-nonce',
  ]);
  const parsed = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!known.has(key) || value === undefined || parsed[key] !== undefined) {
      fail(`invalid or duplicate argument: ${key ?? '<missing>'}`);
    }
    parsed[key] = value;
  }
  if (Object.keys(parsed).length !== known.size) {
    fail('all five named arguments are required');
  }
  return {
    jobId: parsed['--job-id'],
    compiledBinary: parsed['--compiled-binary'],
    outputRoot: parsed['--output-root'],
    sourceSha: parsed['--source-sha'],
    dispatchNonce: parsed['--dispatch-nonce'],
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    writeNativeReceipt(parseArguments(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
