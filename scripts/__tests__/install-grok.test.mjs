import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { APPLY_ENTRIES } from '../apply-to-official.mjs';

import {
  buildMaestroInstallArgs,
  buildMaestroProjectInstallArgs,
  grokInstallHint,
  GROK_COMPONENT_IDS,
  inspectDependencies,
  inspectGrokCli,
  inspectOfficial,
  inspectOverlay,
  inspectGrokFolderTrust,
  isGrokFolderTrusted,
  parseTrustedFolderEntries,
  needsOfficialPackage,
  needsRepoBuild,
  needsRepoDependencies,
  nodeCanRunOverlay,
  nodeInstallHint,
  nodeMeetsMinimum,
  officialInstallHint,
  parseInstallArgs,
  parseNodeMajorMinor,
  planInstallSteps,
  resolveMaestroBin,
  runInstallGrok,
  SHARED_COMPONENT_IDS,
} from '../install-grok.mjs';

const temps = [];

function tempDir(label) {
  const dir = mkdtempSync(join(tmpdir(), `maestro-install-grok-${label}-`));
  temps.push(dir);
  return dir;
}

function writeFile(root, rel, content) {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

afterEach(() => {
  while (temps.length > 0) {
    rmSync(temps.pop(), { recursive: true, force: true });
  }
});

describe('install-grok helpers', () => {
  it('accepts Node 22.19+ and rejects older minors', () => {
    expect(parseNodeMajorMinor('v22.19.1')).toEqual({ major: 22, minor: 19 });
    expect(nodeMeetsMinimum('v22.19.0')).toBe(true);
    expect(nodeMeetsMinimum('v22.18.0')).toBe(false);
    expect(nodeMeetsMinimum('v20.19.0')).toBe(false);
    expect(nodeMeetsMinimum('v24.0.0')).toBe(true);
    expect(nodeCanRunOverlay('v22.14.0')).toBe(true);
    expect(nodeCanRunOverlay('v22.19.0')).toBe(true);
    expect(nodeCanRunOverlay('v20.10.0')).toBe(false);
    expect(nodeCanRunOverlay('not-a-version')).toBe(false);
  });

  it('detects official package / deps / build gaps', () => {
    expect(needsOfficialPackage(null, '0.5.81')).toBe(true);
    expect(needsOfficialPackage('0.5.80', '0.5.81')).toBe(true);
    expect(needsOfficialPackage('0.5.81', '0.5.81')).toBe(false);

    const empty = tempDir('empty');
    expect(needsRepoDependencies(empty)).toBe(true);
    expect(needsRepoBuild(empty)).toBe(true);
  });

  it('resolves maestro bin and install args', () => {
    expect(resolveMaestroBin('C:\\\\npm', 'win32')).toMatch(/maestro(\.cmd)?$/);
    expect(resolveMaestroBin('/usr/local', 'linux')).toBe(join('/usr/local', 'bin', 'maestro'));

    const args = buildMaestroInstallArgs();
    expect(args).toEqual([
      'install',
      '--force',
      '--global',
      '--components',
      [...SHARED_COMPONENT_IDS, ...GROK_COMPONENT_IDS].join(','),
      '--extra-mcp',
      'grok',
    ]);
    expect(buildMaestroProjectInstallArgs('D:\\\\proj')).toEqual([
      'install',
      '--force',
      '--path',
      'D:\\\\proj',
      '--components',
      GROK_COMPONENT_IDS.join(','),
    ]);
    expect(parseInstallArgs(['--dry-run', '--rebuild', '-y'])).toMatchObject({
      dryRun: true,
      rebuild: true,
      yes: true,
      projectPath: undefined,
    });
    expect(parseInstallArgs(['--path', 'D:\\proj', '--dry-run'])).toMatchObject({
      dryRun: true,
      projectPath: resolve('D:\\proj'),
    });
  });

  it('does not Set-Location / cd into repo/ before invoking install-grok', () => {
    const repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
    const workspaceRoot = resolve(repoRoot, '..');
    const ps1 = readFileSync(join(repoRoot, 'install.ps1'), 'utf8');
    const sh = readFileSync(join(repoRoot, 'install.sh'), 'utf8');
    const rootPs1 = readFileSync(join(workspaceRoot, 'install.ps1'), 'utf8');
    const rootSh = readFileSync(join(workspaceRoot, 'install.sh'), 'utf8');
    expect(ps1).not.toMatch(/Set-Location\s+-LiteralPath/);
    expect(ps1).toContain('install-grok.mjs');
    expect(sh).not.toMatch(/^cd "/m);
    expect(sh).toContain('install-grok.mjs');
    expect(rootPs1).not.toMatch(/Set-Location\s+-LiteralPath/);
    expect(rootSh).not.toMatch(/^cd "/m);
  });

  it('prints current status and how-to for each check', () => {
    const repo = tempDir('inspect');
    const official = tempDir('official-inspect');
    const deps = inspectDependencies({
      repoRoot: repo,
      nodeVersion: 'v20.10.0',
      npmProbe: { ok: false, version: null },
      fts5Probe: { ok: false },
      platform: 'win32',
    });
    expect(deps.blocking).toBe(true);
    expect(deps.node.how).toContain('nodejs.org');
    expect(deps.npm.how).toContain('npm');
    expect(deps.repoDeps.how).toContain('npm install');
    expect(deps.build.how).toContain('npm run build');
    expect(deps.build.how).not.toContain('build:dashboard');
    expect(deps.fts5.ok).toBe(false);
    expect(nodeInstallHint('win32')).toContain('winget');

    const warnOnly = inspectDependencies({
      repoRoot: repo,
      nodeVersion: 'v22.14.0',
      npmProbe: { ok: true, version: '11.18.0' },
      fts5Probe: { ok: false },
      platform: 'win32',
    });
    expect(warnOnly.node.ok).toBe(false);
    expect(warnOnly.blocking).toBe(false);
    expect(inspectOverlay(official).ok).toBe(false);

    const officialInfo = inspectOfficial({
      officialRoot: official,
      officialVersion: null,
      expectedVersion: '0.5.81',
    });
    expect(officialInfo.ok).toBe(false);
    expect(officialInfo.how).toBe(officialInstallHint('0.5.81'));
    expect(officialInfo.current).toContain('未安装');

    const grok = inspectGrokCli({ grokProbe: { ok: false }, platform: 'win32' });
    expect(grok.ok).toBe(false);
    expect(grok.how).toBe(grokInstallHint('win32'));
    expect(grok.how).toContain('install.ps1');
  });
});

describe('runInstallGrok interactive flow', () => {
  it('warns on Node 22.14 but still dry-runs the overlay', async () => {
    const repo = tempDir('warn-node');
    writeFile(repo, 'package.json', JSON.stringify({ name: 'maestro-flow', version: '0.5.81' }));
    const ran = [];
    const logs = [];
    const result = await runInstallGrok({
      repoRoot: repo,
      officialRoot: tempDir('official-warn'),
      projectPath: tempDir('proj-warn'),
      nodeVersion: 'v22.14.0',
      dryRun: true,
      probeNpm: () => ({ ok: true, version: '11.0.0' }),
      probeFts5: () => ({ ok: false }),
      probeGrok: () => ({ ok: true, version: 'grok 1.0.5' }),
      run: (cmd) => ran.push(cmd),
      log: (line) => logs.push(line),
    });
    expect(result.ok).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(ran).toEqual([]);
    expect(logs.some((line) => line.includes('低于 22.19'))).toBe(true);
    expect(result.steps.some((step) => step.includes('覆盖官方安装目录'))).toBe(true);
    expect(result.steps.some((step) => step.includes('--path'))).toBe(true);
  });

  it('refuses old Node after printing checks, and does not install', async () => {
    const repo = tempDir('old-node');
    writeFile(repo, 'package.json', JSON.stringify({ name: 'maestro-flow', version: '0.5.81' }));
    const ran = [];
    const logs = [];
    const result = await runInstallGrok({
      repoRoot: repo,
      officialRoot: tempDir('official-old'),
      nodeVersion: 'v20.10.0',
      probeNpm: () => ({ ok: true, version: '11.0.0' }),
      probeGrok: () => ({ ok: false }),
      run: (cmd) => ran.push(cmd),
      log: (line) => logs.push(line),
    });
    expect(result).toMatchObject({ ok: false, code: 1, reason: 'node' });
    expect(ran).toEqual([]);
    expect(logs.some((line) => line.includes('[1/5] 检查依赖'))).toBe(true);
    expect(logs.some((line) => line.includes('需要 ≥ 22.19'))).toBe(true);
    expect(logs.some((line) => line.includes('nodejs.org'))).toBe(true);
  });

  it('dry-run prints all five steps and writes nothing', async () => {
    const repo = tempDir('dry-repo');
    writeFile(repo, 'package.json', JSON.stringify({ name: 'maestro-flow', version: '0.5.81' }));
    const official = tempDir('dry-official');
    const ran = [];
    const logs = [];

    const result = await runInstallGrok({
      repoRoot: repo,
      officialRoot: official,
      nodeVersion: 'v22.19.0',
      dryRun: true,
      probeNpm: () => ({ ok: true, version: '11.18.0' }),
      probeGrok: () => ({ ok: false }),
      run: (cmd) => ran.push(cmd),
      log: (line) => logs.push(line),
    });

    expect(result.ok).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(ran).toEqual([]);
    expect(result.steps.some((step) => step.includes('maestro-flow@0.5.81'))).toBe(true);
    expect(result.steps.some((step) => step.includes('不会自动安装或降级'))).toBe(true);
    expect(result.steps.some((step) => step.includes('npm install'))).toBe(true);
    expect(result.steps.some((step) => step.includes('npm run build'))).toBe(true);
    expect(result.steps.some((step) => step.includes('build:dashboard'))).toBe(false);
    expect(result.steps.some((step) => step.includes('--extra-mcp grok'))).toBe(true);
    expect(logs.some((line) => line.includes('[4/5] 模拟安装'))).toBe(true);
    expect(logs.some((line) => line.includes('[5/5] 确认安装'))).toBe(true);
    expect(logs.some((line) => line.includes('--dry-run'))).toBe(true);
  });

  it('does not reinstall official when versions already match', () => {
    const steps = planInstallSteps({
      deps: {
        repoDeps: { ok: true },
        build: { ok: true },
      },
      official: { ok: true, expected: '0.5.81' },
      skipBuild: true,
      skipAssets: true,
    });
    expect(steps).toEqual(['覆盖官方安装目录（不改官方 node_modules）']);
  });

  it('cancels at confirm without writing', async () => {
    const repo = tempDir('cancel-repo');
    writeFile(repo, 'package.json', JSON.stringify({ name: 'maestro-flow', version: '0.5.81' }));
    const official = tempDir('cancel-official');
    writeFile(official, 'package.json', JSON.stringify({ name: 'maestro-flow', version: '0.5.81' }));
    const ran = [];

    const result = await runInstallGrok({
      repoRoot: repo,
      officialRoot: official,
      nodeVersion: 'v22.20.0',
      skipBuild: true,
      skipAssets: true,
      probeNpm: () => ({ ok: true, version: '11.18.0' }),
      probeGrok: () => ({ ok: true, version: 'grok 1.0.3' }),
      confirm: async () => false,
      run: (cmd) => ran.push(cmd),
      log: () => {},
    });

    expect(result).toMatchObject({ ok: false, code: 0, reason: 'cancelled' });
    expect(ran).toEqual([]);
  });

  it('runs planned commands after confirm', async () => {
    const repo = tempDir('yes-repo');
    writeFile(repo, 'package.json', JSON.stringify({ name: 'maestro-flow', version: '0.5.81' }));
    const official = tempDir('yes-official');
    const ran = [];
    const logs = [];

    const result = await runInstallGrok({
      repoRoot: repo,
      officialRoot: official,
      nodeVersion: 'v22.19.0',
      skipBuild: true,
      skipAssets: true,
      probeNpm: () => ({ ok: true, version: '11.18.0' }),
      probeGrok: () => ({ ok: false }),
      confirm: async () => true,
      run: (cmd) => ran.push(cmd),
      log: (line) => logs.push(line),
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('official');
    expect(ran).toEqual([]);
    expect(logs.some((line) => line.includes('不会自动安装或降级'))).toBe(true);
    expect(logs.some((line) => line.includes('[3/5] 检查 Grok CLI'))).toBe(true);
    expect(logs.some((line) => line.includes('install.ps1') || line.includes('install.sh'))).toBe(true);
  });

  it('runs maestro install --path against the project directory after overlay', async () => {
    const repo = tempDir('path-repo');
    const official = tempDir('path-official');
    const project = tempDir('path-project');
    const prefix = tempDir('path-prefix');
    writeFile(repo, 'package.json', JSON.stringify({ name: 'maestro-flow', version: '0.5.81' }));
    writeFile(official, 'package.json', JSON.stringify({ name: 'maestro-flow', version: '0.5.81' }));
    for (const entry of APPLY_ENTRIES) {
      writeFile(repo, entry.from, `${(entry.markers ?? []).join('\n')}\n`);
    }
    const ran = [];

    const stripped = [];
    const result = await runInstallGrok({
      repoRoot: repo,
      officialRoot: official,
      projectPath: project,
      npmPrefix: prefix,
      nodeVersion: 'v22.20.0',
      skipBuild: true,
      yes: true,
      probeNpm: () => ({ ok: true, version: '11.18.0' }),
      probeGrok: () => ({ ok: true, version: 'grok 1.0.3' }),
      stripLegacyGrokAgents: async (filePath) => {
        stripped.push(filePath);
        return 'stripped';
      },
      trustedFoldersToml: '',
      run: (cmd, options = {}) => ran.push({ cmd, cwd: options.cwd }),
      log: () => {},
    });

    expect(result.ok).toBe(true);
    expect(stripped).toHaveLength(2);
    expect(stripped.some((file) => file.replace(/\\/g, '/').endsWith('.grok/AGENTS.md'))).toBe(true);
    expect(result.trust.ok).toBe(false);
    expect(ran).toHaveLength(2);
    expect(ran[0].cmd).toContain('--extra-mcp');
    expect(ran[0].cmd).toContain('grok');
    expect(ran[0].cwd).toBe(repo);
    expect(ran[1].cmd).toContain('--path');
    expect(ran[1].cmd).toContain(project);
    expect(ran[1].cwd).toBe(project);
  });
});

describe('Grok folder trust', () => {
  it('treats a folder and its children as trusted', () => {
    const toml = [
      "[folders.'D:\\\\PersonalProject']",
      'trusted = true',
      '',
      "[folders.'D:\\\\other']",
      'trusted = false',
      '',
    ].join('\n');
    const entries = parseTrustedFolderEntries(toml);
    expect(isGrokFolderTrusted('D:\\\\PersonalProject\\\\maestrogrok', entries)).toBe(true);
    expect(isGrokFolderTrusted('D:\\\\other\\\\repo', entries)).toBe(false);
    expect(inspectGrokFolderTrust({
      projectPath: 'D:\\\\untrusted\\\\proj',
      tomlText: toml,
    }).ok).toBe(false);
  });
});
