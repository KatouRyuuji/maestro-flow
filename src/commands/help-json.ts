import { Command, type Option } from 'commander';
import { resolve } from 'node:path';

import { SessionStore } from '../run/store.js';

import { registerArtifactCommand } from './artifact.js';
import { registerExecutionV3RetiredCommand } from './execution-v3-retired.js';
import { registerRunV3Command } from './run-v3.js';
import { registerSessionV3Command } from './session-v3.js';

export interface HelpCatalogCommand {
  command: string;
  description: string;
  mutation_scope: 'read' | 'run' | 'orchestration' | 'artifact' | 'retired';
  cas_target: 'none' | 'run' | 'orchestration' | 'artifact';
  options: string[];
  examples: string[];
  deprecated: boolean;
  replacement: string | null;
}

function optionName(option: Option): string {
  return option.long ?? option.short ?? option.flags;
}

function classify(path: string, options: string[]): Pick<HelpCatalogCommand, 'mutation_scope' | 'cas_target'> {
  if (path === 'artifact republish') return { mutation_scope: 'artifact', cas_target: 'artifact' };
  if (path.startsWith('execution ')) return { mutation_scope: 'retired', cas_target: 'none' };
  if (path === 'session open') return { mutation_scope: 'orchestration', cas_target: 'none' };
  if (path === 'session migrate') return { mutation_scope: 'orchestration', cas_target: 'none' };
  if (!options.includes('--request-id')) return { mutation_scope: 'read', cas_target: 'none' };
  if (options.includes('--expected-run-revision')) return { mutation_scope: 'run', cas_target: 'run' };
  if (options.includes('--expected-orchestration-revision')) {
    return { mutation_scope: 'orchestration', cas_target: 'orchestration' };
  }
  throw new Error(`unclassifiable v3 command: ${path}`);
}

function walk(command: Command, prefix: string[] = []): HelpCatalogCommand[] {
  const path = [...prefix, command.name()].filter(Boolean);
  if (command.commands.length > 0) return command.commands.flatMap(child => walk(child, path));
  if (path.length === 0) return [];
  const commandPath = path.join(' ');
  const options = command.options.map(optionName).sort();
  const classification = classify(commandPath, options);
  const deprecated = commandPath.startsWith('execution ');
  return [{
    command: commandPath,
    description: command.description(),
    ...classification,
    options,
    examples: [`maestro ${commandPath} --help`],
    deprecated,
    replacement: deprecated ? 'session status / run check' : null,
  }];
}

export function buildV3HelpCatalog(): HelpCatalogCommand[] {
  const root = new Command('');
  root.helpCommand(false);
  root.exitOverride();
  registerArtifactCommand(root);
  registerRunV3Command(root);
  registerSessionV3Command(root);
  registerExecutionV3RetiredCommand(root);
  return root.commands.flatMap(command => walk(command, [])).sort((left, right) => left.command.localeCompare(right.command));
}

export function registerHelpJsonCommand(program: Command): void {
  program
    .command('help')
    .description('Emit the registered v3 command catalog')
    .requiredOption('--json', 'emit help-catalog/1.0 JSON')
    .option('--workflow-root <path>', 'project root containing .workflow', process.cwd())
    .action((options: { workflowRoot: string }) => {
      const writer = new SessionStore(resolve(options.workflowRoot)).sessionSchemaSelection().writer;
      if (writer !== 'session/3.0') {
        throw new Error('help --json v3 catalog requires the session/3.0 writer');
      }
      process.stdout.write(`${JSON.stringify({
        schema_version: 'help-catalog/1.0',
        commands: buildV3HelpCatalog(),
      })}\n`);
    });
}
