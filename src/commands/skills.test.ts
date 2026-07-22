import { describe, expect, it } from 'vitest';
import { Command } from 'commander';
import { registerSkillsCommand } from './skills.js';

describe('maestro skills CLI', () => {
  it('registers the canonical scanner surface', () => {
    const program = new Command();
    registerSkillsCommand(program);
    const command = program.commands.find(candidate => candidate.name() === 'skills');
    expect(command?.description()).toContain('effective commands');
    const flags = command?.options.map(option => option.long).sort();
    expect(flags).toEqual(['--json', '--platform', '--quiet', '--steps']);
  });
});
