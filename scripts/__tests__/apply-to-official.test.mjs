import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  APPLY_ENTRIES,
  applyLocalOverlay,
  collectApplyProblems,
  runApplyToOfficial,
  verifyLocalOverlay,
} from '../apply-to-official.mjs';

const GROK_ADAPTER_REL = join(
  'dashboard', 'dist-server', 'dashboard', 'src', 'server', 'agents', 'grok-adapter.js',
);
const GROK_DEFAULTS_REL = join('dist', 'src', 'config', 'cli-tools-defaults.json');

const temps = [];

function tempDir(label) {
  const dir = mkdtempSync(join(tmpdir(), `maestro-apply-${label}-`));
  temps.push(dir);
  return dir;
}

function writeFile(root, rel, content) {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function seedRepo(root, version = '0.5.81') {
  writeFile(root, 'package.json', JSON.stringify({ name: 'maestro-flow', version }));
  writeFile(root, GROK_ADAPTER_REL, 'export const grok = true;\n');
  writeFile(root, GROK_DEFAULTS_REL, JSON.stringify({
    tools: [{ name: 'grok', cmd: 'grok', type: 'builtin' }],
  }, null, 2));
  writeFile(root, join('dist', 'src', 'commands', 'delegate.js'), 'export const grok = "ok";\n');
  writeFile(root, join('shared', 'agent-types.js'), 'export const AgentType = "grok";\n');
  writeFile(root, join('workflows', 'delegate-usage.md'), 'grok prefix grk\n');
  writeFile(root, join('dashboard', 'dist', 'index.html'), '<html>grok</html>\n');
}

function seedOfficial(root, version = '0.5.81') {
  writeFile(root, 'package.json', JSON.stringify({ name: 'maestro-flow', version }));
  writeFile(root, join('dist', 'src', 'commands', 'delegate.js'), 'export const official = true;\n');
}

afterEach(() => {
  while (temps.length > 0) {
    rmSync(temps.pop(), { recursive: true, force: true });
  }
});

describe('apply-to-official', () => {
  it('reports missing official install and missing build artifacts', () => {
    const repo = tempDir('repo-empty');
    const official = join(tempDir('missing'), 'maestro-flow');
    const problems = collectApplyProblems(repo, official);
    expect(problems.some((item) => item.includes('未找到官方全局安装'))).toBe(true);
    expect(problems.some((item) => item.includes('尚未编译'))).toBe(true);
  });

  it('copies published artifacts and verifies grok markers', () => {
    const repo = tempDir('repo');
    const official = tempDir('official');
    seedRepo(repo);
    seedOfficial(official);

    applyLocalOverlay(repo, official);

    expect(readFileSync(join(official, GROK_ADAPTER_REL), 'utf8')).toContain('grok');
    expect(readFileSync(join(official, GROK_DEFAULTS_REL), 'utf8')).toContain('"name": "grok"');
    expect(readFileSync(join(official, 'workflows', 'delegate-usage.md'), 'utf8')).toContain('grk');
    expect(verifyLocalOverlay(official).ok).toBe(true);
    expect(APPLY_ENTRIES).toHaveLength(5);
  });

  it('interactive success path overlays and can skip maestro install', async () => {
    const repo = tempDir('repo-run');
    const official = tempDir('official-run');
    seedRepo(repo);
    seedOfficial(official);
    const lines = [];

    const result = await runApplyToOfficial({
      repoRoot: repo,
      officialRoot: official,
      yes: false,
      skipInstall: true,
      log: (line) => lines.push(line),
      confirm: async () => true,
    });

    expect(result).toEqual({ ok: true, code: 0 });
    expect(lines.some((line) => line.includes('覆盖完成'))).toBe(true);
    expect(verifyLocalOverlay(official).ok).toBe(true);
  });

  it('refuses a version mismatch unless confirmed', async () => {
    const repo = tempDir('repo-mismatch');
    const official = tempDir('official-mismatch');
    seedRepo(repo, '0.5.81');
    seedOfficial(official, '0.5.80');

    const result = await runApplyToOfficial({
      repoRoot: repo,
      officialRoot: official,
      log: () => {},
      confirm: async () => false,
    });

    expect(result).toEqual({ ok: false, code: 0 });
    expect(verifyLocalOverlay(official).ok).toBe(false);
  });
});
