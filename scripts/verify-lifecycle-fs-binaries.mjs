import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { verifyIntegratedResources } from './verify-lifecycle-fs-native-matrix.mjs';

export function verifyLifecycleFsBinaries(workspaceRoot) {
  return verifyIntegratedResources({ workspaceRoot });
}

function main() {
  const workspaceRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const result = verifyLifecycleFsBinaries(workspaceRoot);
  process.stdout.write(
    `verified ${result.manifest.artifacts.length} lifecycle native binaries `
      + `for run ${result.provenance.database_id}\n`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
