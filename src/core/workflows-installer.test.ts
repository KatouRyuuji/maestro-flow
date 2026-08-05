import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  installArchKb,
  installPrepareFiles,
  installRefFiles,
  installWorkflowsOnly,
} from './workflows-installer.js';

describe('installWorkflowsOnly', () => {
  it('copies only workflows and preserves unrelated target files', () => {
    const root = mkdtempSync(join(tmpdir(), 'maestro-workflows-only-'));
    const source = join(root, 'package');
    const target = join(root, '.maestro', 'workflows');
    mkdirSync(join(source, 'workflows', 'nested'), { recursive: true });
    mkdirSync(target, { recursive: true });
    writeFileSync(join(source, 'workflows', 'analyze.md'), 'new analyze');
    writeFileSync(join(source, 'workflows', 'nested', 'review.md'), 'review');
    writeFileSync(join(target, 'custom.md'), 'keep me');

    const result = installWorkflowsOnly(source, target);

    expect(result.filesInstalled).toBe(2);
    expect(readFileSync(join(target, 'analyze.md'), 'utf8')).toBe('new analyze');
    expect(readFileSync(join(target, 'nested', 'review.md'), 'utf8')).toBe('review');
    expect(readFileSync(join(target, 'custom.md'), 'utf8')).toBe('keep me');
  });

  it('fails clearly when the package has no workflows directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'maestro-workflows-only-'));
    expect(() => installWorkflowsOnly(root, join(root, 'target'))).toThrow(/workflows directory not found/);
  });
});

describe('installArchKb', () => {
  it('copies index and nested source markdown', () => {
    const root = mkdtempSync(join(tmpdir(), 'maestro-arch-kb-'));
    const source = join(root, 'package');
    const target = join(root, '.maestro', 'arch-kb');
    mkdirSync(join(source, 'resources', 'arch-kb', 'templates', 'web-app'), { recursive: true });
    const index = JSON.stringify({ entries: [{ path: 'templates/web-app/README.md' }] });
    writeFileSync(join(source, 'resources', 'arch-kb', 'index.json'), index);
    writeFileSync(join(source, 'resources', 'arch-kb', 'templates', 'web-app', 'README.md'), '# Web app');

    const result = installArchKb(source, target);

    expect(result.filesInstalled).toBe(2);
    expect(readFileSync(join(target, 'index.json'), 'utf8')).toBe(index);
    expect(readFileSync(join(target, 'templates', 'web-app', 'README.md'), 'utf8')).toBe('# Web app');
  });

  it('rejects an index whose source markdown is missing', () => {
    const root = mkdtempSync(join(tmpdir(), 'maestro-arch-kb-'));
    const sourceDir = join(root, 'resources', 'arch-kb');
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(join(sourceDir, 'index.json'), JSON.stringify({
      entries: [{ path: 'templates/missing/README.md' }],
    }));

    expect(() => installArchKb(root, join(root, 'target'))).toThrow(/source files are missing/);
  });
});

describe('installPrepareFiles / installRefFiles', () => {
  it('copies prepare files when the source directory exists', () => {
    const root = mkdtempSync(join(tmpdir(), 'maestro-prepare-'));
    const source = join(root, 'package');
    const target = join(root, '.maestro', 'prepare');
    mkdirSync(join(source, 'prepare'), { recursive: true });
    writeFileSync(join(source, 'prepare', 'step.md'), 'prep');

    const result = installPrepareFiles(source, target);

    expect(result.filesInstalled).toBe(1);
    expect(readFileSync(join(target, 'step.md'), 'utf8')).toBe('prep');
  });

  it('degrades gracefully when prepare/ref source is missing', () => {
    const root = mkdtempSync(join(tmpdir(), 'maestro-prepare-'));
    expect(installPrepareFiles(root, join(root, 'p')).filesInstalled).toBe(0);
    expect(installRefFiles(root, join(root, 'r')).filesInstalled).toBe(0);
  });
});
