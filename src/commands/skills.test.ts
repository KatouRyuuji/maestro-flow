import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

  it('warns when an installed package declares a missing Pi skill directory', async () => {
    const root = mkdtempSync(join(tmpdir(), 'maestro-skills-warning-'));
    const packageRoot = join(root, 'node_modules', 'pi-maestro-flow');
    const previousCwd = process.cwd();
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({
      name: 'pi-maestro-flow',
      pi: { skills: ['./.pi/skills'] },
    }));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      process.chdir(root);
      await expect(runSkills({ platform: 'pi', quiet: true })).resolves.toBe(0);
      expect(error).toHaveBeenCalledWith(expect.stringContaining('WARNING PI_SKILL_DIR_MISSING'));
      expect(error).toHaveBeenCalledWith(expect.stringContaining(join(packageRoot, '.pi', 'skills')));
    } finally {
      process.chdir(previousCwd);
      error.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
