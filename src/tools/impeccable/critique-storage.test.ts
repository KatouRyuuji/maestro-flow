import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertValidCritiqueSlug,
  readLatestSnapshot,
  readTrend,
  writeSnapshot,
} from './critique-storage.js';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'maestro-critique-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('critique slug storage boundary', () => {
  it('round-trips snapshots with portable slugs', () => {
    const cwd = makeTempDir();
    const path = writeSnapshot({
      slug: 'site-home',
      body: 'first critique',
      cwd,
      now: new Date('2026-07-31T12:00:00.000Z'),
    });

    expect(basename(path)).toBe('2026-07-31T12-00-00Z__site-home.md');
    expect(readLatestSnapshot('site-home', { cwd })?.body).toContain('first critique');
    expect(readTrend('site-home', { cwd })).toHaveLength(1);
  });

  it.each(['site:home', '../site', 'site/home', 'site home', '中文', '-site', 'site-', 'a'.repeat(51)])(
    'rejects slugs that are unsafe as portable filenames: %s',
    (slug) => {
      expect(() => assertValidCritiqueSlug(slug)).toThrow(/Invalid critique slug/);
      expect(() => writeSnapshot({ slug, body: '', cwd: makeTempDir() })).toThrow(/Invalid critique slug/);
    },
  );
});
