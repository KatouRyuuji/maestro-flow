import { describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { registerSkillsCommand } from './skills.js';
import { runSkills } from '../skills/cmd-skills.js';

describe('maestro skills CLI', () => {
  it('registers the canonical scanner surface', () => {
    const program = new Command();
    registerSkillsCommand(program);
    const command = program.commands.find(candidate => candidate.name() === 'skills');
    expect(command?.description()).toContain('effective commands');
    const flags = command?.options.map(option => option.long).sort();
    expect(flags).toEqual(['--json', '--platform', '--quiet', '--steps']);
    expect(command?.options.find(option => option.long === '--platform')?.description).toContain('pi');
  });

  it('accepts pi as a scanner platform', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(runSkills({ platform: 'pi', quiet: true })).resolves.toBe(0);
      expect(error).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  });
});
