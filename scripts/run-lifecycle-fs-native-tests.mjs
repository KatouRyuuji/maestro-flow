import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { verifyIntegratedResources } from './verify-lifecycle-fs-native-matrix.mjs';

const PLATFORM_ARCH = Object.freeze({
  'win32-x64': 'x86_64-pc-windows-msvc',
  'linux-x64': 'x86_64-unknown-linux-gnu',
  'linux-arm64': 'aarch64-unknown-linux-gnu',
  'darwin-x64': 'x86_64-apple-darwin',
  'darwin-arm64': 'aarch64-apple-darwin',
});

function fail(message) {
  throw new Error(`lifecycle native probe: ${message}`);
}

export function runLifecycleFsNativeProbe(workspaceRoot, platform = process.platform, arch = process.arch) {
  const verified = verifyIntegratedResources({ workspaceRoot });
  const target = PLATFORM_ARCH[`${platform}-${arch}`];
  if (!target) fail(`unsupported platform/arch ${platform}/${arch}`);
  const artifact = verified.manifest.artifacts.find(item => item.target === target);
  if (!artifact) fail(`verified manifest is missing ${target}`);
  const requestId = randomUUID();
  const request = {
    protocol: 'lifecycle-fs-helper/1.0',
    requestId,
    projectRoot: workspaceRoot,
    op: 'read',
    relativePath: '.workflow/native-probe-does-not-exist',
  };
  const result = spawnSync(resolve(workspaceRoot, artifact.path), [], {
    cwd: workspaceRoot,
    encoding: 'utf8',
    windowsHide: true,
    input: `${JSON.stringify(request)}\n`,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    fail(result.error?.message ?? (result.stderr.trim() || `helper exited ${result.status}`));
  }
  let response;
  try {
    response = JSON.parse(result.stdout.trim());
  } catch {
    fail('helper response is not JSON');
  }
  if (response.protocol !== request.protocol
    || response.requestId !== requestId
    || response.ok !== false
    || response.code !== 'MISSING') {
    fail('helper protocol probe returned an unexpected response');
  }
  return response;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const workspaceRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
    runLifecycleFsNativeProbe(workspaceRoot);
    process.stdout.write(`lifecycle native probe passed for ${process.platform}/${process.arch}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
