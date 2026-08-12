import type { Command } from 'commander';

/**
 * Keep the retired command parseable for existing scripts without exposing or
 * starting the dashboard. The legacy options are intentionally accepted as
 * no-ops so upgrades do not turn them into Commander usage errors.
 */
export function registerViewCommand(program: Command): void {
  program
    .command('view', { hidden: true })
    .description('[retired] Dashboard compatibility placeholder')
    .option('-p, --port <port>')
    .option('--host <host>')
    .option('--path <dir>')
    .option('--no-browser')
    .option('--tui')
    .option('--dev')
    .action(() => {
      console.error('');
      console.error('  Maestro Dashboard has been retired and is disabled.');
      console.error('  The `view` command is retained only for backward compatibility.');
      console.error('');
      console.error('  Use `maestro run brief` or `maestro run check` for workflow status.');
      console.error('');
      console.error('  💡 Want a resident desktop view of agent calls / Session·Run / knowledge?');
      console.error('     Try the Maestro Sidebar desktop app (maestro-sidebar/).');
      console.error('');
    });
}
