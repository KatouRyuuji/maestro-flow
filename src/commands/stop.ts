import type { Command } from 'commander';

/**
 * Compatibility placeholder paired with the retired `maestro view` command.
 * Accept legacy flags but never inspect or terminate arbitrary port owners.
 */
export function registerStopCommand(program: Command): void {
  program
    .command('stop', { hidden: true })
    .description('[retired] Dashboard compatibility placeholder')
    .option('-p, --port <port>')
    .option('-f, --force')
    .action(() => {
      console.error('');
      console.error('  Maestro Dashboard has been retired and is disabled.');
      console.error('  The `stop` command is retained only for backward compatibility.');
      console.error('');
    });
}
