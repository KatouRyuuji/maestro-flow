import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyToggle, scanToggleItems } from './toggle.js';

const testRoot = mkdtempSync(join(tmpdir(), 'maestro-toggle-optional-test-'));
const pkgRoot = join(testRoot, 'package');
const targetBase = join(testRoot, 'target');

function writeSkill(dir: string, name: string): void {
  mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(join(dir, name, 'SKILL.md'), `---\nname: ${name}\ndescription: test skill\n---\nbody`);
}

beforeAll(() => {
  // Standard (default-shipped) skill source
  writeSkill(join(pkgRoot, '.claude', 'skills'), 'kept-skill');
  // Optional (选装) skill source — not installed by default
  writeSkill(join(pkgRoot, 'optional', 'skills'), 'opt-skill');
  // Already-installed skill in the target
  writeSkill(join(targetBase, '.claude', 'skills'), 'installed-skill');
});

afterAll(() => {
  rmSync(testRoot, { recursive: true, force: true });
});

describe('scanToggleItems optional skills', () => {
  it('surfaces optional/skills entries as available (选装)', () => {
    const items = scanToggleItems(pkgRoot, targetBase);
    const byName = new Map(items.map(i => [i.name, i]));

    expect(byName.get('kept-skill')?.state).toBe('available');
    expect(byName.get('installed-skill')?.state).toBe('on');
    // Optional skill visible but NOT installed by default
    expect(byName.get('opt-skill')?.state).toBe('available');
    expect(existsSync(join(targetBase, '.claude', 'skills', 'opt-skill', 'SKILL.md'))).toBe(false);
  });

  it('applyToggle installs an optional skill into the target .claude/skills/', () => {
    const items = scanToggleItems(pkgRoot, targetBase);
    const opt = items.find(i => i.name === 'opt-skill');
    expect(opt).toBeDefined();
    expect(applyToggle(opt!, pkgRoot)).toBe(true);

    const installedPath = join(targetBase, '.claude', 'skills', 'opt-skill', 'SKILL.md');
    expect(existsSync(installedPath)).toBe(true);
  });
});
