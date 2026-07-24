import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function fail(message) {
  throw new Error(`lifecycle native local build: ${message}`);
}

export function buildLifecycleFsHelper(workspaceRoot) {
  const manifestPath = resolve(workspaceRoot, 'native/lifecycle-fs/Cargo.toml');
  const result = spawnSync(
    'cargo',
    ['build', '--release', '--locked', '--manifest-path', manifestPath],
    {
      cwd: workspaceRoot,
      encoding: 'utf8',
      windowsHide: true,
      stdio: 'inherit',
    },
  );
  if (result.error || result.status !== 0) {
    fail(result.error?.message ?? `cargo exited ${result.status}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    buildLifecycleFsHelper(resolve(fileURLToPath(new URL('..', import.meta.url))));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
