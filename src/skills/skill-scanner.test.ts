import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  diagnosePiSkillSources,
  discoverPiSkillSources,
  scanAllSkills,
} from './skill-scanner.js';

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('Pi skill package discovery', () => {
  it('uses the pi-maestro-flow package manifest instead of a bare project .pi directory', () => {
    const root = makeTempRoot();
    const packageRoot = join(root, 'node_modules', 'pi-maestro-flow');
    writePiPackage(packageRoot);
    writeSkill(join(packageRoot, '.pi', 'skills'), 'package-skill');
    writeSkill(join(root, '.pi', 'skills'), 'bare-project-skill');

    const skills = scanAllSkills(root, { platform: 'pi' });

    expect(skills.map(skill => skill.name)).toEqual(['package-skill']);
    expect(skills[0]).toMatchObject({
      platform: 'pi',
      scope: 'project',
      filePath: join(packageRoot, '.pi', 'skills', 'package-skill', 'SKILL.md'),
    });
  });

  it('reports a package manifest whose declared Pi skill directory is missing', () => {
    const root = makeTempRoot();
    const nodeModules = join(root, 'node_modules');
    const packageRoot = join(nodeModules, 'pi-maestro-flow');
    writePiPackage(packageRoot);
    const runtimeModulePath = join(
      nodeModules,
      'maestro-flow',
      'dist',
      'src',
      'skills',
      'skill-scanner.js',
    );

    expect(diagnosePiSkillSources(join(root, 'workspace'), runtimeModulePath)).toEqual([{
      code: 'PI_SKILL_DIR_MISSING',
      dir: join(packageRoot, '.pi', 'skills'),
      scope: 'global',
    }]);
  });

  it('finds an explicitly advertised Pi package outside the Maestro install tree', () => {
    const root = makeTempRoot();
    const packageRoot = join(root, 'external', 'pi-maestro-flow');
    writePiPackage(packageRoot);
    writeSkill(join(packageRoot, '.pi', 'skills'), 'advertised-skill');
    const runtimeModulePath = join(
      root,
      'global',
      'node_modules',
      'maestro-flow',
      'dist',
      'src',
      'skills',
      'skill-scanner.js',
    );

    expect(discoverPiSkillSources(
      join(root, 'workspace'),
      runtimeModulePath,
      packageRoot,
    )).toContainEqual({
      dir: join(packageRoot, '.pi', 'skills'),
      scope: 'global',
    });
  });

  it('finds pi-maestro-flow when maestro-flow is nested inside that npm package', () => {
    const root = makeTempRoot();
    const packageRoot = join(root, 'node_modules', 'pi-maestro-flow');
    writePiPackage(packageRoot);
    const runtimeModulePath = join(
      packageRoot,
      'node_modules',
      'maestro-flow',
      'dist',
      'src',
      'skills',
      'skill-scanner.js',
    );

    expect(discoverPiSkillSources(join(root, 'workspace'), runtimeModulePath)).toContainEqual({
      dir: join(packageRoot, '.pi', 'skills'),
      scope: 'global',
    });
  });

  it('finds a deduped pi-maestro-flow sibling in node_modules', () => {
    const root = makeTempRoot();
    const nodeModules = join(root, 'node_modules');
    const packageRoot = join(nodeModules, 'pi-maestro-flow');
    writePiPackage(packageRoot);
    const runtimeModulePath = join(
      nodeModules,
      'maestro-flow',
      'dist',
      'src',
      'skills',
      'skill-scanner.js',
    );

    expect(discoverPiSkillSources(join(root, 'workspace'), runtimeModulePath)).toContainEqual({
      dir: join(packageRoot, '.pi', 'skills'),
      scope: 'global',
    });
  });
});

function makeTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'maestro-pi-skills-'));
  tempRoots.push(root);
  return root;
}

function writePiPackage(packageRoot: string): void {
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({
    name: 'pi-maestro-flow',
    pi: { skills: ['./.pi/skills'] },
  }));
}

function writeSkill(skillsRoot: string, name: string): void {
  const skillDir = join(skillsRoot, name);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, 'SKILL.md'), `---\nname: ${name}\ndescription: test\n---\n`);
}
