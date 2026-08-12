import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  recordSearchUsage,
  SEARCH_USAGE_COMMAND,
  SEARCH_USAGE_FILE,
  type SearchUsageRow,
} from './search-usage.js';

let tempDirs: string[] = [];

function tmpProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'search-usage-'));
  mkdirSync(join(dir, '.workflow', 'learning'), { recursive: true });
  tempDirs.push(dir);
  return dir;
}

function readRows(projectRoot: string): SearchUsageRow[] {
  const file = join(projectRoot, '.workflow', 'learning', SEARCH_USAGE_FILE);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(line => line.trim())
    .map(line => JSON.parse(line) as SearchUsageRow);
}

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

describe('recordSearchUsage', () => {
  it('appends a new maestro-search row when file is absent', () => {
    const project = tmpProject();
    recordSearchUsage(project, { success: true, contexts: ['query A'] });
    const rows = readRows(project);
    expect(rows).toHaveLength(1);
    expect(rows[0].command).toBe(SEARCH_USAGE_COMMAND);
    expect(rows[0].frequency).toBe(1);
    expect(rows[0].successRate).toBe(1);
    expect(rows[0].contexts).toEqual(['query A']);
    expect(rows[0].lastUsed).toBeTruthy();
  });

  it('merges into existing row: frequency+1, rolling rate/duration, lastUsed refresh', () => {
    const project = tmpProject();
    recordSearchUsage(project, { success: true, durationMs: 1000 });
    recordSearchUsage(project, { success: true, durationMs: 3000 });
    recordSearchUsage(project, { success: false, durationMs: 5000 });
    const rows = readRows(project);
    expect(rows).toHaveLength(1);
    expect(rows[0].frequency).toBe(3);
    expect(rows[0].successRate).toBeCloseTo(2 / 3, 6);
    expect(rows[0].avgDuration).toBeCloseTo(3000, 6);
  });

  it('preserves unrelated rows from other files/commands', () => {
    const project = tmpProject();
    const file = join(project, '.workflow', 'learning', 'patterns.jsonl');
    writeFileSync(
      file,
      '{"command":"claude-code","frequency":1,"successRate":1,"avgDuration":100,"lastUsed":"2026-01-01T00:00:00.000Z","contexts":[]}\n',
      'utf8',
    );
    recordSearchUsage(project, { success: true });
    // maestro-search.jsonl 只含自己的行
    expect(readRows(project)).toHaveLength(1);
    // patterns.jsonl 原样保留
    const patterns = readFileSync(file, 'utf8');
    expect(patterns).toContain('claude-code');
    expect(patterns).not.toContain(SEARCH_USAGE_COMMAND);
  });

  it('merges context tags with dedup and cap (recent first)', () => {
    const project = tmpProject();
    recordSearchUsage(project, { contexts: ['a', 'b'] });
    recordSearchUsage(project, { contexts: ['b', 'c', 'd', 'e', 'f', 'g'] });
    const rows = readRows(project);
    expect(rows[0].contexts).toEqual(['b', 'c', 'd', 'e', 'f']);
  });

  it('truncates each context to 40 chars', () => {
    const project = tmpProject();
    recordSearchUsage(project, { contexts: ['x'.repeat(80)] });
    expect(readRows(project)[0].contexts[0]).toHaveLength(40);
  });

  it('never throws on missing .workflow or IO errors', () => {
    const project = join(tmpdir(), `search-usage-nosuch-${Date.now()}`);
    expect(() => recordSearchUsage(project, { success: true })).not.toThrow();
  });

  it('keeps a stable deterministic row shape for the sidebar scanner', () => {
    const project = tmpProject();
    recordSearchUsage(project, { success: true });
    const row = readRows(project)[0];
    // scan_top_learning 依赖的字段
    expect(typeof row.command).toBe('string');
    expect(typeof row.frequency).toBe('number');
    expect(typeof row.successRate).toBe('number');
    expect(typeof row.lastUsed).toBe('string');
    expect(Array.isArray(row.contexts)).toBe(true);
  });
});
