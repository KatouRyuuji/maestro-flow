import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  collectGlobalAutoWrites,
  kkmemCaptureBase,
  markTriageDone,
  parseSince,
  readTriageDone,
} from './triage.js';

const roots: string[] = [];

function makeRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'maestro-triage-'));
  roots.push(dir);
  return dir;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: process.platform === 'win32' ? 8 : 0, retryDelay: 50 });
    } catch {
      /* Windows may briefly retain a just-closed file */
    }
  }
});

function writeLog(dir: string, entries: object[]): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'auto-writes.jsonl'), entries.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
}

describe('kkmemCaptureBase', () => {
  it('honours MEM0_CONFIG_DIR override', () => {
    expect(kkmemCaptureBase({ MEM0_CONFIG_DIR: 'D:\\x\\cfg' }, '/home/u')).toBe('D:\\x\\cfg');
  });

  it('defaults to ~/.config/mem0-claude', () => {
    expect(kkmemCaptureBase({}, '/home/u')).toBe(join('/home/u', '.config', 'mem0-claude'));
  });
});

describe('collectGlobalAutoWrites', () => {
  it('collects project=null ADD/UPDATE events across hosts', () => {
    const base = makeRoot();
    writeLog(base, [
      { at: '2026-09-11T10:00:00', project: null, text: 'global fact', events: [{ event: 'ADD', id: 'a1' }] },
      { at: '2026-09-11T10:01:00', project: 'proj@x', text: 'project fact', events: [{ event: 'ADD', id: 'b1' }] },
      { at: '2026-09-11T10:02:00', project: null, text: 'noop', events: [{ event: 'NOOP', id: 'c1' }] },
    ]);
    writeLog(join(base, 'grok'), [
      { at: '2026-09-11T10:03:00', project: null, text: 'grok fact', events: [{ event: 'UPDATE', id: 'd1' }] },
    ]);
    const out = collectGlobalAutoWrites({ env: { MEM0_CONFIG_DIR: base }, home: makeRoot() });
    expect(out.map((c) => c.id)).toEqual(['a1', 'd1']);
    expect(out[1].host).toBe('grok');
  });

  it('dedupes ids and skips malformed lines', () => {
    const base = makeRoot();
    writeLog(base, [
      { at: '2026-09-11T10:00:00', project: null, text: 'fact', events: [{ event: 'ADD', id: 'a1' }] },
      { at: '2026-09-11T10:01:00', project: null, text: 'fact dup', events: [{ event: 'ADD', id: 'a1' }] },
    ]);
    writeFileSync(join(base, 'auto-writes.jsonl'), '{"broken":\n' + JSON.stringify({ at: '2026-09-11T10:00:00', project: null, text: 'fact', events: [{ event: 'ADD', id: 'a1' }] }) + '\n', 'utf8');
    const out = collectGlobalAutoWrites({ env: { MEM0_CONFIG_DIR: base }, home: makeRoot() });
    expect(out).toHaveLength(1);
  });

  it('filters by sinceMs', () => {
    const base = makeRoot();
    writeLog(base, [
      { at: new Date(Date.now() - 86400_000 * 10).toISOString(), project: null, text: 'old', events: [{ event: 'ADD', id: 'old1' }] },
      { at: new Date().toISOString(), project: null, text: 'new', events: [{ event: 'ADD', id: 'new1' }] },
    ]);
    const out = collectGlobalAutoWrites({ env: { MEM0_CONFIG_DIR: base }, home: makeRoot(), sinceMs: Date.now() - 86400_000 });
    expect(out.map((c) => c.id)).toEqual(['new1']);
  });

  it('returns empty when no logs exist', () => {
    expect(collectGlobalAutoWrites({ env: { MEM0_CONFIG_DIR: makeRoot() }, home: makeRoot() })).toEqual([]);
  });
});

describe('triage done state', () => {
  it('markTriageDone persists and is idempotent', () => {
    const home = makeRoot();
    expect(markTriageDone(['a1', 'a2'], home)).toBe(2);
    expect(markTriageDone(['a1'], home)).toBe(0);
    expect([...readTriageDone(home)].sort()).toEqual(['a1', 'a2']);
  });

  it('readTriageDone returns empty set when file missing', () => {
    expect(readTriageDone(makeRoot()).size).toBe(0);
  });
});

describe('parseSince', () => {
  it('parses hours and days', () => {
    expect(parseSince('24h')).toBe(86400_000);
    expect(parseSince('7d')).toBe(604800_000);
  });

  it('rejects invalid input', () => {
    expect(parseSince('abc')).toBeUndefined();
    expect(parseSince('10m')).toBeUndefined();
  });
});
