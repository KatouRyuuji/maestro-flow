import type { Command } from 'commander';
import type { SkillPlatform } from '../skills/skill-scanner.js';

async function loadSkillsCommand() {
  return (await import('../skills/cmd-skills.js')).runSkills;
}

export function registerSkillsCommand(program: Command): void {
  program
    .command('skills')
    .description('List effective commands, Skills, and optional Run-resolvable steps')
    .option('--json', 'Machine-readable output (one JSON line per entry)')
    .option('--quiet', 'Suppress decorative output')
    .option('--platform <platform>', 'Filter by platform: claude | codex | agent | agy | pi')
    .option('--steps', 'Include prepare/workflow step names resolvable by maestro run next')
    .action(async (opts: { json?: boolean; quiet?: boolean; platform?: string; steps?: boolean }) => {
      const run = await loadSkillsCommand();
      const code = await run({
        json: Boolean(opts.json),
        quiet: Boolean(opts.quiet),
        platform: opts.platform as SkillPlatform | undefined,
        steps: Boolean(opts.steps),
      });
      process.exitCode = code;
    });
}
