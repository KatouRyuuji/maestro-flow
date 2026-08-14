import type { Command } from 'commander';
import { resolve } from 'node:path';

import { maestroCapabilitiesSchema } from '../run/protocol-schemas.js';
import { SessionStore } from '../run/store.js';
import { getPackageVersion } from '../utils/get-version.js';

export function registerCapabilitiesCommand(program: Command): void {
  program
    .command('capabilities')
    .description('Report strict CLI protocol capabilities')
    .option('--json', 'emit maestro-capabilities/1.0 JSON')
    .option('--workflow-root <path>', 'project root containing .workflow', process.cwd())
    .action((options: { workflowRoot: string }) => {
      const writer = new SessionStore(resolve(options.workflowRoot)).sessionSchemaSelection().writer;
      const v3 = writer === 'session/3.0';
      const v3Ready = v3;
      // session_schema_writes declares which Session schema versions this CLI
      // can write for the selected writer. It is intentionally writer-scoped
      // (a strict declaration, not a feature matrix): Pi-side
      // hasCompleteV3Support reads features below, so the features block stays
      // the authority for capability gating.
      const sessionSchemaWrites = writer === 'session/3.0'
        ? ['session/3.0']
        : writer === 'session/2.0'
          ? ['session/1.3', 'session/2.0']
          : ['session/1.3'];
      const result = maestroCapabilitiesSchema.parse({
        schema_version: 'maestro-capabilities/1.0',
        cli_version: getPackageVersion(),
        session_schema_writes: sessionSchemaWrites,
        execution_schema_writes: v3 ? [] : ['execution/1.0'],
        run_response_writes: ['run-response/1.0', 'run-response/1.1', 'run-response/1.2'],
        features: {
          execution_generation: !v3,
          core_execution_lease: !v3,
          execution_handoff: !v3,
          session_statusless: !v3,
          legacy_session_aliases: !v3,
          session_run_minimal_v3: v3Ready,
          entity_revision_cas: v3Ready,
          participant_identity: v3Ready,
          request_receipts_v2: v3Ready,
          execution_lease: !v3,
          operation_registry: false,
          artifact_compatibility_v1: true,
          atomic_run_complete_seal: true,
          generation_scoped_seal_receipts: true,
        },
      });
      process.stdout.write(`${JSON.stringify(result)}\n`);
    });
}
