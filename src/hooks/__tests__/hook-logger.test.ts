/**
 * Tests for hook-logger.ts — centralized hook error/warning sink.
 *
 * Fixture strategy: `paths` (src/config/paths.ts) captures `MAESTRO_HOME`
 * at module-load time. Rather than fighting module caching, we `vi.mock`
 * `config/paths.js` with getters so each test sees a fresh temp `logs`
 * directory. The statusline alert seen-marker lives in os.tmpdir() keyed
 * by session id, so we use a unique session per test and clean it up.
 */

import { describe, it, beforeEach, afterEach, vi } from 'vitest';
import assert from 'node:assert';
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ---------------------------------------------------------------------------
// Mock paths so paths.logs points at a fresh temp dir per test.
// ---------------------------------------------------------------------------

let mockLogs: string;
vi.mock('../../config/paths.js', () => ({
  paths: {
    get logs() { return mockLogs; },
  },
}));

import {
  logHookError,
  logHookWarn,
  buildHookErrorAlertSegment,
} from '../hook-logger.js';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

let tmpHome: string;
let prevDebug: string | undefined;

const SESSION_ID = 'test-session-hook-logger';

function seenPath(session: string = SESSION_ID): string {
  return join(tmpdir(), `maestro-err-seen-${session}.json`);
}

function clearSeen(session: string = SESSION_ID): void {
  const p = seenPath(session);
  if (existsSync(p)) {
    try { unlinkSync(p); } catch { /* ignore */ }
  }
}

function setup(): void {
  tmpHome = mkdtempSync(join(tmpdir(), 'hook-logger-test-'));
  mockLogs = join(tmpHome, 'logs'); // hook-logger creates this lazily
  prevDebug = process.env.MAESTRO_DEBUG;
  delete process.env.MAESTRO_DEBUG;
  clearSeen();
}

function teardown(): void {
  clearSeen();
  if (prevDebug === undefined) {
    delete process.env.MAESTRO_DEBUG;
  } else {
    process.env.MAESTRO_DEBUG = prevDebug;
  }
  if (tmpHome && existsSync(tmpHome)) {
    rmSync(tmpHome, { recursive: true, force: true });
  }
}

function logFile(): string {
  return join(mockLogs, 'hooks-error.log');
}

function readLogLines(): unknown[] {
  const p = logFile();
  if (!existsSync(p)) return [];
  const raw = readFileSync(p, 'utf-8');
  return raw.split('\n').filter((l) => l.trim().length > 0).map((l) => JSON.parse(l));
}

// ---------------------------------------------------------------------------
// Writer tests
// ---------------------------------------------------------------------------

describe('hook-logger writers', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('logHookError writes a JSONL entry to hooks-error.log', () => {
    logHookError('kg-sync', new Error('boom'), { message: 'sync failed' });
    const lines = readLogLines();
    assert.strictEqual(lines.length, 1);
    const entry = lines[0] as Record<string, unknown>;
    assert.strictEqual(entry['level'], 'error');
    assert.strictEqual(entry['source'], 'kg-sync');
    assert.strictEqual(entry['message'], 'sync failed');
    assert.strictEqual(entry['error'], 'boom');
    assert.ok(typeof entry['stack'] === 'string' && (entry['stack'] as string).length > 0);
    assert.ok(typeof entry['ts'] === 'string');
  });

  it('logHookError derives message from the error when opts.message omitted', () => {
    logHookError('kg-auto-init', new Error('init boom'));
    const lines = readLogLines();
    assert.strictEqual(lines.length, 1);
    const entry = lines[0] as Record<string, unknown>;
    assert.strictEqual(entry['message'], 'init boom');
    assert.strictEqual(entry['error'], 'init boom');
  });

  it('logHookError handles non-Error throwables (string, null, object)', () => {
    logHookError('team-monitor', 'a bare string');
    logHookError('wiki-role-loader', null);
    logHookError('kg-sync', { code: 42 });
    const lines = readLogLines();
    assert.strictEqual(lines.length, 3);
    assert.strictEqual((lines[0] as Record<string, unknown>)['message'], 'a bare string');
    assert.strictEqual((lines[1] as Record<string, unknown>)['message'], 'hook error');
    assert.ok(typeof (lines[2] as Record<string, unknown>)['message'] === 'string');
  });

  it('logHookWarn writes a warn-level entry', () => {
    logHookWarn('team-monitor', 'namespace violation (advisory): out-of-bounds write');
    const lines = readLogLines();
    assert.strictEqual(lines.length, 1);
    const entry = lines[0] as Record<string, unknown>;
    assert.strictEqual(entry['level'], 'warn');
    assert.strictEqual(entry['source'], 'team-monitor');
    assert.ok(typeof entry['message'] === 'string');
  });

  it('creates the logs directory (and archive subdir) lazily on first write', () => {
    assert.ok(!existsSync(mockLogs), 'logs dir should not exist before first write');
    logHookError('kg-sync', new Error('x'));
    assert.ok(existsSync(mockLogs), 'logs dir should exist after first write');
    assert.ok(existsSync(join(mockLogs, 'archive')), 'archive subdir should exist');
  });

  it('never throws — swallows filesystem failures gracefully', () => {
    // Point mockLogs at a path that cannot be created (a file, not a dir).
    const blocker = join(tmpHome, 'blocker-file');
    writeFileSync(blocker, '', 'utf-8');
    mockLogs = blocker; // hooks-error.log cannot be created inside a file
    // Must not throw — should no-op.
    assert.doesNotThrow(() => logHookError('kg-sync', new Error('boom')));
  });

  it('MAESTRO_DEBUG=1 echoes to console; off by default', () => {
    const calls: string[] = [];
    const origError = console.error;
    const origWarn = console.warn;
    console.error = (msg: string) => { calls.push(`error:${msg}`); };
    console.warn = (msg: string) => { calls.push(`warn:${msg}`); };
    try {
      // Debug OFF — no console output.
      logHookError('kg-sync', new Error('quiet'), { message: 'sync failed' });
      assert.strictEqual(calls.length, 0, 'no console echo when MAESTRO_DEBUG unset');

      // Debug ON — echo expected.
      process.env.MAESTRO_DEBUG = '1';
      logHookError('kg-sync', new Error('loud'), { message: 'sync failed' });
      const echo = calls.find((c) => c.includes('kg-sync'));
      assert.ok(echo, 'MAESTRO_DEBUG=1 should echo to console');
      assert.ok(echo!.includes('sync failed'), 'echo should include message');
    } finally {
      console.error = origError;
      console.warn = origWarn;
    }
  });
});

// ---------------------------------------------------------------------------
// Statusline alert segment tests
// ---------------------------------------------------------------------------

describe('hook-logger buildHookErrorAlertSegment', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('returns empty string when there are no log entries', () => {
    assert.strictEqual(buildHookErrorAlertSegment(SESSION_ID), '');
  });

  it('renders ⚠N for N unread error entries within 24h', () => {
    logHookError('kg-sync', new Error('e1'));
    logHookError('kg-auto-init', new Error('e2'));
    assert.strictEqual(buildHookErrorAlertSegment(SESSION_ID), '⚠2');
  });

  it('caps the count at 9+ when more than 9 unread entries exist', () => {
    for (let i = 0; i < 12; i++) logHookError('kg-sync', new Error(`e${i}`));
    // tailLast default is 50, so all 12 are visible; count > 9 -> "9+".
    assert.strictEqual(buildHookErrorAlertSegment(SESSION_ID), '⚠9+');
  });

  it('marks entries as seen: a second render with no new errors returns empty', () => {
    logHookError('kg-sync', new Error('e1'));
    assert.strictEqual(buildHookErrorAlertSegment(SESSION_ID), '⚠1');
    // Second render: seenTs has advanced to the entry ts, so no unread.
    assert.strictEqual(buildHookErrorAlertSegment(SESSION_ID), '');
  });

  it('new errors after a read become unread again', () => {
    logHookError('kg-sync', new Error('e1'));
    assert.strictEqual(buildHookErrorAlertSegment(SESSION_ID), '⚠1');
    logHookError('kg-auto-init', new Error('e2'));
    assert.strictEqual(buildHookErrorAlertSegment(SESSION_ID), '⚠1');
  });

  it('returns empty string when no session id is provided', () => {
    logHookError('kg-sync', new Error('e1'));
    assert.strictEqual(buildHookErrorAlertSegment(''), '');
  });

  it('ignores entries older than the 24h window', () => {
    // Manually write a stale entry (older than 24h) plus a fresh one.
    const stale = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    const fresh = new Date().toISOString();
    mkdirSync(mockLogs, { recursive: true });
    writeFileSync(
      logFile(),
      JSON.stringify({ ts: stale, level: 'error', source: 'kg-sync', message: 'old' }) + '\n' +
      JSON.stringify({ ts: fresh, level: 'error', source: 'kg-sync', message: 'new' }) + '\n',
      'utf-8',
    );
    assert.strictEqual(buildHookErrorAlertSegment(SESSION_ID), '⚠1', 'only the fresh entry counts as unread');
  });
});
