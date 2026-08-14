import type { Command } from 'commander';

import { emitV3Error } from './v3-cli-shared.js';
import { V3StructuredError } from '../run/v3/errors.js';

const TOP_LEVEL = ['start', 'attach', 'status', 'pause', 'resolve', 'resume', 'seal'] as const;
const LEASE = ['status', 'heartbeat', 'release', 'recover'] as const;
const HANDOFF = ['prepare', 'accept', 'cancel'] as const;
const OPERATION = ['claim', 'heartbeat', 'release', 'status'] as const;

function responseOperation(path: string) {
  return path.replaceAll(' ', '-') as Parameters<typeof emitV3Error>[0];
}

function retiredAction(path: string) {
  return (options: { session?: string; requestId?: string }): void => {
    emitV3Error(responseOperation(path), new V3StructuredError(
      'SESSION_SCHEMA_UNSUPPORTED',
      `${path} is retired for session/3.0 workspaces`,
      {
        details: { deprecated_command: path, replacement_command: 'session status / run check' },
        next_actions: ['use-session-status', 'use-run-check'],
      },
    ), { session: options.session, requestId: options.requestId });
  };
}

function retiredOptions(command: Command): Command {
  return command
    .option('--session <id>', 'Session ID')
    .option('--request-id <id>', 'request ID')
    .option('--json', 'emit run-response/1.2 JSON')
    .option('--workflow-root <path>', 'project root', process.cwd())
    .allowUnknownOption(true);
}

export function registerExecutionV3RetiredCommand(program: Command): void {
  const execution = program.command('execution').description('Retired Execution commands for session/3.0');
  for (const name of TOP_LEVEL) {
    retiredOptions(execution.command(name).description('Deprecated in session/3.0'))
      .action(retiredAction(`execution ${name}`));
  }
  const lease = execution.command('lease').description('Deprecated lease commands');
  for (const name of LEASE) {
    retiredOptions(lease.command(name).description('Deprecated in session/3.0'))
      .action(retiredAction(`execution lease ${name}`));
  }
  const handoff = execution.command('handoff').description('Deprecated handoff commands');
  for (const name of HANDOFF) {
    retiredOptions(handoff.command(name).description('Deprecated in session/3.0'))
      .action(retiredAction(`execution handoff ${name}`));
  }
  const operation = execution.command('operation').description('Deprecated operation commands');
  for (const name of OPERATION) {
    retiredOptions(operation.command(name).description('Deprecated in session/3.0'))
      .action(retiredAction(`execution operation ${name}`));
  }
}
