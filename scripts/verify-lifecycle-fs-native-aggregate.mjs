import { createHash } from 'node:crypto';
import {
  cpSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import {
  DISPATCH_NONCE_PATTERN,
  NATIVE_PROTOCOL,
  NATIVE_RECEIPT_SCHEMA,
  NATIVE_TARGETS,
  NATIVE_TASK_ID,
  SOURCE_SHA_PATTERN,
} from './write-lifecycle-fs-native-receipt.mjs';

export const NATIVE_AGGREGATE_SCHEMA = 'lifecycle-fs-native-aggregate/1.0';
export const NATIVE_JOB_IDS = Object.freeze(Object.keys(NATIVE_TARGETS));
export const NATIVE_WORKFLOW_NAME = 'Native Lifecycle Artifact Build';
export const NATIVE_RUN_NAME = 'native-lifecycle-${{ inputs.source_sha }}-${{ inputs.dispatch_nonce }}';
const NONCE_REGEX_SOURCE = '^maestro-search-ranking-exec-20260723-102551-20260724-010-plan-TASK-013-attempt-[1-9][0-9]{0,5}$';

function fail(message) {
  throw new Error(`native aggregate: ${message}`);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
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

function assertDispatchIdentity(sourceSha, dispatchNonce) {
  if (!SOURCE_SHA_PATTERN.test(sourceSha)) {
    fail('source_sha must be a lowercase 40-character Git SHA');
  }
  if (dispatchNonce.length > 128 || !DISPATCH_NONCE_PATTERN.test(dispatchNonce)) {
    fail('dispatch_nonce does not match the pinned TASK-013 attempt format');
  }
}

function assertContainedRegularFile(root, path, label) {
  const rootReal = realpathSync(root);
  const pathReal = realpathSync(path);
  const fromRoot = relative(rootReal, pathReal);
  if (fromRoot === '' || fromRoot === '..' || fromRoot.startsWith(`..${sep}`)) {
    fail(`${label} escapes its artifact root`);
  }
  if (!lstatSync(path).isFile()) {
    fail(`${label} must be a regular file`);
  }
  return pathReal;
}

function validateReceipt(receipt, jobId, sourceSha, dispatchNonce) {
  const expected = NATIVE_TARGETS[jobId];
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
  ], `${jobId} receipt`);
  const fields = {
    schema_version: NATIVE_RECEIPT_SCHEMA,
    task_id: NATIVE_TASK_ID,
    job_id: jobId,
    runner: expected.runner,
    target: expected.target,
    platform: expected.platform,
    arch: expected.arch,
    artifact_name: `lifecycle-fs-${expected.platform}-${expected.arch}-${sourceSha}`,
    binary_path: expected.binaryPath,
    protocol: NATIVE_PROTOCOL,
    source_sha: sourceSha,
    dispatch_nonce: dispatchNonce,
    run_name: `native-lifecycle-${sourceSha}-${dispatchNonce}`,
  };
  for (const [field, value] of Object.entries(fields)) {
    if (receipt[field] !== value) {
      fail(`${jobId} receipt ${field} mismatch`);
    }
  }
  if (!/^[0-9a-f]{64}$/.test(receipt.binary_sha256)) {
    fail(`${jobId} receipt binary_sha256 is invalid`);
  }
}

function assertValidationStep(job, jobId, minimumSteps = 6) {
  if (!Array.isArray(job.steps) || job.steps.length < minimumSteps) {
    fail(`${jobId} must declare the complete native step surface`);
  }
  const first = job.steps[0];
  if (first.name !== 'Validate dispatch identity' || typeof first.run !== 'string') {
    fail(`${jobId} must validate dispatch identity before every build step`);
  }
  for (const literal of [
    '${{ inputs.source_sha }}',
    '${{ inputs.dispatch_nonce }}',
    '[0-9a-f]{40}',
    NONCE_REGEX_SOURCE,
    '128',
  ]) {
    if (!first.run.includes(literal)) {
      fail(`${jobId} dispatch validation is missing ${literal}`);
    }
  }
  const exactCeiling = first.shell === 'pwsh'
    ? '$nonce.Length -gt 128'
    : '${#nonce} -le 128';
  if (!first.run.includes(exactCeiling)) {
    fail(`${jobId} dispatch validation has the wrong 128-character ceiling`);
  }
}

function assertNativeJob(job, jobId) {
  const expected = NATIVE_TARGETS[jobId];
  if (job['runs-on'] !== expected.runner) {
    fail(`${jobId} runner mismatch`);
  }
  assertValidationStep(job, jobId);
  const steps = job.steps;
  const checkout = steps.find(step => step.uses === 'actions/checkout@v4');
  if (checkout?.with?.ref !== '${{ inputs.source_sha }}') {
    fail(`${jobId} checkout is not pinned to source_sha`);
  }
  const commands = steps.filter(step => typeof step.run === 'string').map(step => step.run).join('\n');
  const compiledBinary = `native/lifecycle-fs/target/${expected.target}/release/lifecycle-fs-helper${jobId === 'win32-x64' ? '.exe' : ''}`;
  for (const literal of [
    `rustup target add ${expected.target}`,
    'cargo build --release --locked',
    'cargo test --release --locked',
    `--target ${expected.target}`,
    'write-lifecycle-fs-native-receipt.mjs',
    `--job-id ${jobId}`,
    `--compiled-binary "${compiledBinary}"`,
    `--output-root ".workflow/native-artifacts/${jobId}"`,
    '--source-sha "${{ inputs.source_sha }}"',
    '--dispatch-nonce "${{ inputs.dispatch_nonce }}"',
  ]) {
    if (!commands.includes(literal)) {
      fail(`${jobId} native command surface is missing ${literal}`);
    }
  }
  const upload = steps.find(step => step.uses === 'actions/upload-artifact@v4');
  if (upload?.with?.name !== `lifecycle-fs-${expected.platform}-${expected.arch}-${'${{ inputs.source_sha }}'}`) {
    fail(`${jobId} artifact name mismatch`);
  }
  if (upload.with.path !== `.workflow/native-artifacts/${jobId}` || upload.with['if-no-files-found'] !== 'error') {
    fail(`${jobId} artifact upload path or fail-closed policy mismatch`);
  }
}

export function verifyNativeWorkflowDocument(source) {
  const workflow = YAML.parse(source);
  if (workflow?.name !== NATIVE_WORKFLOW_NAME || workflow?.['run-name'] !== NATIVE_RUN_NAME) {
    fail('workflow name or run-name mismatch');
  }
  exactKeys(workflow.on, ['workflow_dispatch'], 'workflow trigger');
  exactKeys(workflow.on.workflow_dispatch, ['inputs'], 'workflow_dispatch');
  exactKeys(workflow.on.workflow_dispatch.inputs, ['source_sha', 'dispatch_nonce'], 'workflow inputs');
  for (const input of Object.values(workflow.on.workflow_dispatch.inputs)) {
    if (input.required !== true) {
      fail('both workflow inputs must be required');
    }
  }
  exactKeys(workflow.jobs, [...NATIVE_JOB_IDS, 'aggregate'], 'workflow jobs');
  exactKeys(workflow.permissions, ['contents'], 'workflow permissions');
  if (workflow.permissions.contents !== 'read') {
    fail('workflow permissions must be read-only contents');
  }
  for (const jobId of NATIVE_JOB_IDS) {
    assertNativeJob(workflow.jobs[jobId], jobId);
  }

  const aggregate = workflow.jobs.aggregate;
  if (aggregate['runs-on'] !== 'ubuntu-24.04'
    || JSON.stringify(aggregate.needs) !== JSON.stringify(NATIVE_JOB_IDS)) {
    fail('aggregate needs exactly the five pinned native jobs');
  }
  assertValidationStep(aggregate, 'aggregate', 5);
  const download = aggregate.steps.find(step => step.uses === 'actions/download-artifact@v4');
  if (download?.with?.pattern !== 'lifecycle-fs-*-${{ inputs.source_sha }}'
    || download.with.path !== '.workflow/native-download') {
    fail('aggregate download contract mismatch');
  }
  const commands = aggregate.steps
    .filter(step => typeof step.run === 'string')
    .map(step => step.run)
    .join('\n');
  for (const literal of [
    'verify-lifecycle-fs-native-aggregate.mjs',
    '--source-sha "${{ inputs.source_sha }}"',
    '--dispatch-nonce "${{ inputs.dispatch_nonce }}"',
  ]) {
    if (!commands.includes(literal)) {
      fail(`aggregate verifier is missing ${literal}`);
    }
  }
  const upload = aggregate.steps.find(step => step.uses === 'actions/upload-artifact@v4');
  if (upload?.with?.name !== 'lifecycle-fs-aggregate-${{ inputs.source_sha }}'
    || upload.with.path !== '.workflow/native-aggregate'
    || upload.with['if-no-files-found'] !== 'error') {
    fail('aggregate upload contract mismatch');
  }

  const forbidden = /\b(deploy-pages|configure-pages|upload-pages-artifact|github-pages|docs-site|check:docs-reference|VITE_BASE_URL|pages:\s*write|packages:\s*write|npm\s+publish)\b/i;
  if (forbidden.test(source)) {
    fail('workflow contains docs, Pages, package, or publish behavior');
  }
  if (Object.values(workflow.jobs).some(job => Object.hasOwn(job, 'environment'))) {
    fail('workflow jobs must not declare an environment');
  }
  return workflow;
}

export function verifyNativeAggregate({
  inputRoot,
  outputRoot,
  sourceSha,
  dispatchNonce,
}) {
  assertDispatchIdentity(sourceSha, dispatchNonce);
  const expectedNames = NATIVE_JOB_IDS.map(jobId => {
    const item = NATIVE_TARGETS[jobId];
    return `lifecycle-fs-${item.platform}-${item.arch}-${sourceSha}`;
  });
  const actualNames = readdirSync(inputRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort();
  if (JSON.stringify(actualNames) !== JSON.stringify([...expectedNames].sort())) {
    fail('download root must contain exactly the five expected artifacts');
  }

  const artifacts = [];
  for (const jobId of NATIVE_JOB_IDS) {
    const expected = NATIVE_TARGETS[jobId];
    const artifactName = `lifecycle-fs-${expected.platform}-${expected.arch}-${sourceSha}`;
    const artifactRoot = resolve(inputRoot, artifactName);
    const receiptPath = assertContainedRegularFile(
      artifactRoot,
      resolve(artifactRoot, 'receipt.json'),
      `${jobId} receipt`,
    );
    const receiptBytes = readFileSync(receiptPath);
    let receipt;
    try {
      receipt = JSON.parse(receiptBytes);
    } catch {
      fail(`${jobId} receipt is not JSON`);
    }
    validateReceipt(receipt, jobId, sourceSha, dispatchNonce);
    const binaryPath = assertContainedRegularFile(
      artifactRoot,
      resolve(artifactRoot, receipt.binary_path),
      `${jobId} binary`,
    );
    const binaryBytes = readFileSync(binaryPath);
    if (sha256(binaryBytes) !== receipt.binary_sha256) {
      fail(`${jobId} uploaded binary SHA-256 mismatch`);
    }
    artifacts.push({
      job_id: jobId,
      runner: receipt.runner,
      target: receipt.target,
      platform: receipt.platform,
      arch: receipt.arch,
      artifact_name: artifactName,
      binary_path: receipt.binary_path,
      protocol: receipt.protocol,
      binary_sha256: receipt.binary_sha256,
      receipt_sha256: sha256(receiptBytes),
    });
  }

  const body = {
    schema_version: NATIVE_AGGREGATE_SCHEMA,
    task_id: NATIVE_TASK_ID,
    source_sha: sourceSha,
    dispatch_nonce: dispatchNonce,
    run_name: `native-lifecycle-${sourceSha}-${dispatchNonce}`,
    protocol: NATIVE_PROTOCOL,
    artifacts,
  };
  const aggregate = {
    ...body,
    aggregate_sha256: sha256(JSON.stringify(body)),
  };
  mkdirSync(outputRoot, { recursive: true });
  for (const artifactName of expectedNames) {
    cpSync(resolve(inputRoot, artifactName), resolve(outputRoot, artifactName), {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
  }
  const provenancePath = resolve(outputRoot, 'aggregate-provenance.json');
  writeFileSync(provenancePath, `${JSON.stringify(aggregate, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
  });
  return aggregate;
}

function parseArguments(argv) {
  const known = new Set([
    '--input-root',
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
    fail('all four named arguments are required');
  }
  return {
    inputRoot: parsed['--input-root'],
    outputRoot: parsed['--output-root'],
    sourceSha: parsed['--source-sha'],
    dispatchNonce: parsed['--dispatch-nonce'],
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    verifyNativeAggregate(parseArguments(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
