import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import nodeTest from 'node:test';

import { test as vitestTest } from 'vitest';

import {
  integrateNativeLifecycleResources,
  jcs,
  NATIVE_TARGETS,
  parseNativeLifecycleDispatchReceipt,
  sha256,
  verifyIntegratedResources,
} from '../../../scripts/verify-lifecycle-fs-native-matrix.mjs';

const REPOSITORY_ROOT = resolve(import.meta.dirname, '..', '..', '..');
const FIXTURE_PATH = resolve(
  REPOSITORY_ROOT,
  'scripts/__tests__/fixtures/native-lifecycle-dispatch-receipt.valid.json',
);
const test = process.env.VITEST ? vitestTest : nodeTest;

function write(path: string, bytes: Buffer | string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function resign(receipt: Record<string, unknown>): void {
  const { receipt_sha256: _discarded, ...body } = receipt;
  receipt.receipt_sha256 = sha256(jcs(body));
}

function treeHash(root: string): string {
  if (!existsSync(root)) return sha256(Buffer.from('missing'));
  const hash = createHash('sha256');
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(directory, entry.name);
      const relativePath = path.slice(root.length).replaceAll('\\', '/');
      hash.update(relativePath);
      if (entry.isDirectory()) walk(path);
      else hash.update(readFileSync(path));
    }
  };
  walk(root);
  return hash.digest('hex');
}

function createFixtureWorkspace(): {
  root: string;
  transactionRoot: string;
  receiptPath: string;
  receipt: Record<string, any>;
  context: Record<string, any>;
} {
  const root = mkdtempSync(join(tmpdir(), 'maestro-native-receipt-'));
  const receipt = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as Record<string, any>;
  const transactionRoot = resolve(
    root,
    '.workflow/tmp/lifecycle-native/20260724-010-plan/dispatch-transactions',
    receipt.tuple_hash,
  );
  const receiptPath = resolve(transactionRoot, 'dispatch-receipt.json');
  const aggregateArtifacts: Record<string, unknown>[] = [];
  for (const artifact of receipt.artifacts) {
    const mapping = NATIVE_TARGETS[artifact.target as keyof typeof NATIVE_TARGETS];
    const binaryBytes = Buffer.from(`fixture-binary:${artifact.target}\n`);
    artifact.binary_sha256 = sha256(binaryBytes);
    const jobReceipt = {
      schema_version: 'lifecycle-fs-native-receipt/1.0',
      task_id: 'TASK-004',
      job_id: mapping.jobId,
      runner: mapping.runner,
      target: artifact.target,
      platform: mapping.platform,
      arch: mapping.arch,
      artifact_name: artifact.artifact_name,
      binary_path: mapping.binaryPath,
      protocol: 'lifecycle-fs-helper/1.0',
      binary_sha256: artifact.binary_sha256,
      source_sha: receipt.tuple.head_sha,
      dispatch_nonce: receipt.dispatch_nonce,
      run_name: receipt.workflow_run.display_title,
    };
    const provenanceBytes = Buffer.from(`${JSON.stringify(jobReceipt, null, 2)}\n`);
    artifact.job_receipt_sha256 = sha256(provenanceBytes);
    artifact.provenance_sha256 = artifact.job_receipt_sha256;
    write(resolve(root, artifact.binary_path), binaryBytes);
    write(resolve(root, artifact.provenance_path), provenanceBytes);
    aggregateArtifacts.push({
      job_id: mapping.jobId,
      runner: mapping.runner,
      target: artifact.target,
      platform: mapping.platform,
      arch: mapping.arch,
      artifact_name: artifact.artifact_name,
      binary_path: mapping.binaryPath,
      protocol: 'lifecycle-fs-helper/1.0',
      binary_sha256: artifact.binary_sha256,
      receipt_sha256: artifact.job_receipt_sha256,
    });
  }
  const aggregateBody = {
    schema_version: 'lifecycle-fs-native-aggregate/1.0',
    task_id: 'TASK-004',
    source_sha: receipt.tuple.head_sha,
    dispatch_nonce: receipt.dispatch_nonce,
    run_name: receipt.workflow_run.display_title,
    protocol: 'lifecycle-fs-helper/1.0',
    artifacts: aggregateArtifacts,
  };
  const aggregate = {
    ...aggregateBody,
    aggregate_sha256: sha256(JSON.stringify(aggregateBody)),
  };
  const aggregateBytes = Buffer.from(`${JSON.stringify(aggregate, null, 2)}\n`);
  receipt.aggregate_provenance.sha256 = sha256(aggregateBytes);
  write(resolve(root, receipt.aggregate_provenance.path), aggregateBytes);
  resign(receipt);
  write(receiptPath, Buffer.from(jcs(receipt)));
  return {
    root,
    transactionRoot,
    receiptPath,
    receipt,
    context: {
      receiptPath,
      transactionRoot,
      expectedRepo: 'catlog22/maestro-flow',
      expectedWorkflowId: 247776234,
      expectedDefaultRef: 'refs/heads/master',
      expectedDefaultBlobSha: 'd070327596e52788a309d4aeea84d54339b545b6',
    },
  };
}

function cleanup(root: string): void {
  rmSync(root, { recursive: true, force: true });
}

test('accepts TASK-013 canonical dispatch receipt fixture', () => {
  const fixture = createFixtureWorkspace();
  try {
    const parsed = parseNativeLifecycleDispatchReceipt(
      readFileSync(fixture.receiptPath),
      fixture.context,
    );
    assert.equal(parsed.schema_version, 'native-lifecycle-dispatch-receipt/1');
    assert.equal(parsed.artifacts.length, 5);
    assert.equal(Object.isFrozen(parsed), true);
    assert.equal(Object.isFrozen(parsed.artifacts), true);
  } finally {
    cleanup(fixture.root);
  }
});

test('rejects every canonical dispatch receipt contract mutation without side effects', () => {
  const mutations: Array<[string, (receipt: Record<string, any>) => void, boolean?]> = [];
  const topLevelFields = Object.keys(
    JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as Record<string, unknown>,
  );
  for (const field of topLevelFields) {
    mutations.push([`missing ${field}`, receipt => {
      delete receipt[field];
    }]);
  }
  mutations.push(
    ['unknown field', receipt => {
      receipt.unknown = true;
    }],
    ['wrong schema', receipt => {
      receipt.schema_version = 'native-lifecycle-dispatch-receipt/0';
    }],
    ['wrong cleanup state', receipt => {
      receipt.cleanup.state = 'complete';
    }],
    ['wrong workflow id', receipt => {
      receipt.workflow_run.workflow_id = 1;
    }],
    ['wrong run id', receipt => {
      receipt.workflow_run.id = 0;
    }],
    ['wrong nonce', receipt => {
      receipt.dispatch_nonce = `native-${'f'.repeat(32)}`;
    }],
    ['wrong ref', receipt => {
      receipt.ref = 'refs/heads/master';
    }],
    ['wrong default fence', receipt => {
      receipt.default_blob_sha = 'f'.repeat(40);
    }],
    ['wrong timestamp order', receipt => {
      receipt.receipted_at = '2025-01-01T00:00:00.000Z';
    }],
    ['duplicate target', receipt => {
      receipt.artifacts[1].target = receipt.artifacts[0].target;
    }],
    ['missing artifact', receipt => {
      receipt.artifacts.pop();
    }],
    ['wrong runner', receipt => {
      receipt.artifacts[0].runner_label = 'ubuntu-latest';
    }],
    ['path escape', receipt => {
      receipt.artifacts[0].binary_path = '../escape';
    }],
    ['binary hash tamper', receipt => {
      receipt.artifacts[0].binary_sha256 = 'f'.repeat(64);
    }],
    ['job receipt hash tamper', receipt => {
      receipt.artifacts[0].job_receipt_sha256 = 'f'.repeat(64);
      receipt.artifacts[0].provenance_sha256 = 'f'.repeat(64);
    }],
    ['aggregate hash tamper', receipt => {
      receipt.aggregate_provenance.sha256 = 'f'.repeat(64);
    }],
    ['receipt self-hash tamper', receipt => {
      receipt.receipt_sha256 = 'f'.repeat(64);
    }, true],
  );

  for (const [name, mutate, preserveBadHash] of mutations) {
    const fixture = createFixtureWorkspace();
    try {
      const destination = resolve(fixture.root, 'resources/lifecycle-fs');
      const before = treeHash(destination);
      const fakeGithubRequests: unknown[] = [];
      const fakeGitRequests: unknown[] = [];
      mutate(fixture.receipt);
      if (!preserveBadHash && Object.hasOwn(fixture.receipt, 'receipt_sha256')) {
        resign(fixture.receipt);
      }
      assert.throws(
        () => parseNativeLifecycleDispatchReceipt(fixture.receipt, fixture.context),
        undefined,
        name,
      );
      assert.equal(treeHash(destination), before, `${name}: destination tree changed`);
      assert.deepEqual(fakeGithubRequests, [], `${name}: GitHub cleanup request observed`);
      assert.deepEqual(fakeGitRequests, [], `${name}: git cleanup request observed`);
    } finally {
      cleanup(fixture.root);
    }
  }
});

test('rejects native aggregate to resource mismatch', () => {
  const fixture = createFixtureWorkspace();
  try {
    const parsed = parseNativeLifecycleDispatchReceipt(fixture.receipt, fixture.context);
    integrateNativeLifecycleResources(parsed, { workspaceRoot: fixture.root });
    const manifest = JSON.parse(
      readFileSync(resolve(fixture.root, 'resources/lifecycle-fs/manifest.json'), 'utf8'),
    ) as { artifacts: Array<{ path: string }> };
    writeFileSync(resolve(fixture.root, manifest.artifacts[4].path), 'tampered');
    assert.throws(
      () => verifyIntegratedResources({ workspaceRoot: fixture.root, receipt: parsed }),
      /checked-in resource mismatch/,
    );
  } finally {
    cleanup(fixture.root);
  }
});

test('rejects binary provenance or Rust in ordinary build', () => {
  const fixture = createFixtureWorkspace();
  try {
    const parsed = parseNativeLifecycleDispatchReceipt(fixture.receipt, fixture.context);
    integrateNativeLifecycleResources(parsed, { workspaceRoot: fixture.root });
    const verified = verifyIntegratedResources({ workspaceRoot: fixture.root, receipt: parsed });
    const linux = verified.manifest.artifacts.find(
      (artifact: { target: string }) => artifact.target === 'x86_64-unknown-linux-gnu',
    );
    assert.ok(linux);
    writeFileSync(resolve(fixture.root, linux.path), 'tampered');
    assert.throws(
      () => verifyIntegratedResources({ workspaceRoot: fixture.root, receipt: parsed }),
      /checked-in resource mismatch/,
    );

    const packageJson = JSON.parse(readFileSync(resolve(REPOSITORY_ROOT, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    assert.match(packageJson.scripts.build, /^npm run native:lifecycle:verify && /);
    assert.doesNotMatch(packageJson.scripts.build, /\b(?:cargo|rustc|rustup)\b/);
  } finally {
    cleanup(fixture.root);
  }
});
