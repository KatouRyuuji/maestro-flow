import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  APPLY_ENTRIES,
  applyLocalOverlay,
  collectApplyProblems,
  overlayNeedsBuild,
  OVERLAY_MANIFEST_REL,
  runApplyToOfficial,
  verifyLocalOverlay,
} from '../apply-to-official.mjs';

const GROK_ADAPTER_REL = join(
  'dashboard', 'dist-server', 'dashboard', 'src', 'server', 'agents', 'grok-adapter.js',
);
const GROK_FACTORY_REL = join(
  'dashboard', 'dist-server', 'dashboard', 'src', 'server', 'agents', 'adapter-factory.js',
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
  for (const entry of APPLY_ENTRIES) {
    if (entry.source && entry.source !== entry.from) {
      writeFile(root, entry.source, `source ${entry.source}\n`);
    }
    writeFile(root, entry.from, `${(entry.markers ?? []).join('\n')}\n`);
  }
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

    expect(readFileSync(join(official, GROK_ADAPTER_REL), 'utf8')).toContain('--no-auto-update');
    expect(readFileSync(join(official, GROK_FACTORY_REL), 'utf8')).toContain('grok');
    expect(readFileSync(join(official, GROK_DEFAULTS_REL), 'utf8')).toContain('"name": "grok"');
    expect(readFileSync(join(official, 'workflows', 'delegate-usage.md'), 'utf8')).toContain('grok');
    expect(verifyLocalOverlay(official).ok).toBe(true);
    expect(APPLY_ENTRIES.every((entry) => entry.kind === 'file')).toBe(true);
    expect(APPLY_ENTRIES.some((entry) => entry.from.includes('dist') && entry.kind === 'dir')).toBe(false);
    const required = [
      'grok-adapter.js',
      'adapter-factory.js',
      'cli-tools-defaults.json',
      'component-defs.js',
      'install-backend.js',
      'grok-legacy-agents.js',
      'manifest.js',
      'session-context.js',
      'continuation.js',
      'knowledge-v3.js',
      'mutation-engine.js',
      'run-v3.js',
    ];
    for (const name of required) {
      expect(APPLY_ENTRIES.some((entry) => entry.from.replace(/\\/g, '/').endsWith(name))).toBe(true);
    }
    expect(APPLY_ENTRIES.some((entry) => entry.from.includes('agent-types'))).toBe(false);
    const manifest = JSON.parse(readFileSync(join(official, OVERLAY_MANIFEST_REL), 'utf8'));
    expect(manifest.schema).toBe('maestro-grok-overlay/1.0');
    expect(manifest.files).toHaveLength(APPLY_ENTRIES.length);
  });

  it('treats newer source files as needing a rebuild', () => {
    const repo = tempDir('stale');
    seedRepo(repo);
    expect(overlayNeedsBuild(repo)).toBe(false);
    const later = new Date(Date.now() + 120_000);
    utimesSync(join(repo, APPLY_ENTRIES[0].source), later, later);
    expect(overlayNeedsBuild(repo)).toBe(true);
  });

  it('fails verify when a required marker is missing', () => {
    const official = tempDir('bad-marker');
    seedRepo(official);
    writeFile(official, GROK_ADAPTER_REL, 'export const grok = true;\n');
    const verified = verifyLocalOverlay(official);
    expect(verified.ok).toBe(false);
    expect(verified.reason).toContain('--no-auto-update');
  });

  it('prechecks repo markers before writing official files', () => {
    const repo = tempDir('repo-precheck');
    const official = tempDir('official-precheck');
    seedRepo(repo);
    seedOfficial(official);
    writeFile(repo, GROK_ADAPTER_REL, 'export const grok = true;\n');

    const problems = collectApplyProblems(repo, official);
    expect(problems.some((item) => item.includes('未通过覆盖预检'))).toBe(true);
    expect(problems.some((item) => item.includes('--no-auto-update'))).toBe(true);
    expect(() => applyLocalOverlay(repo, official)).toThrow(/未通过覆盖预检/);
    expect(existsSync(join(official, GROK_ADAPTER_REL))).toBe(false);
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

  it('fails a version mismatch even with -y and never overlays', async () => {
    const repo = tempDir('repo-mismatch');
    const official = tempDir('official-mismatch');
    seedRepo(repo, '0.5.81');
    seedOfficial(official, '0.5.80');
    const lines = [];

    const result = await runApplyToOfficial({
      repoRoot: repo,
      officialRoot: official,
      yes: true,
      log: (line) => lines.push(line),
      confirm: async () => true,
    });

    expect(result).toMatchObject({ ok: false, code: 1, reason: 'official-version' });
    expect(verifyLocalOverlay(official).ok).toBe(false);
    expect(lines.some((line) => line.includes('不会自动安装或降级'))).toBe(true);
    expect(existsSync(join(official, GROK_ADAPTER_REL))).toBe(false);
  });
});
