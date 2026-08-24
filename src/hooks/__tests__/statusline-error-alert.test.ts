/**
 * Tests for the hook-error alert segment integrated into formatStatusline.
 *
 * Verifies that when hook-logger has unread error entries, the statusline's
 * first line renders a `⚠N` alert segment (ctxAlert color), and that the
 * badge clears once entries are marked seen.
 */

import { describe, it, beforeEach, afterEach, vi } from 'vitest';
import assert from 'node:assert';
import {
  mkdtempSync,
  rmSync,
  existsSync,
  unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ---------------------------------------------------------------------------
// Mock paths so hook-logger writes to a fresh temp logs dir per test.
// (formatStatusline reads many .workflow files; we keep its workspace empty
//  so the workflow line is absent and line 1 is the only rendered line.)
// ---------------------------------------------------------------------------

let mockLogs: string;
vi.mock('../../config/paths.js', () => ({
  paths: {
    get logs() { return mockLogs; },
  },
}));

import { logHookError } from '../hook-logger.js';
import { formatStatusline } from '../statusline.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let tmpHome: string;
const SESSION_ID = 'test-session-statusline-alert';

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
  tmpHome = mkdtempSync(join(tmpdir(), 'statusline-alert-test-'));
  mockLogs = join(tmpHome, 'logs');
  clearSeen();
}

function teardown(): void {
  clearSeen();
  if (tmpHome && existsSync(tmpHome)) {
    rmSync(tmpHome, { recursive: true, force: true });
  }
}

function minimalInput(): Parameters<typeof formatStatusline>[0] {
  return {
    model: { display_name: 'TestModel' },
    workspace: { current_dir: tmpHome },
    session_id: SESSION_ID,
    context_window: { remaining_percentage: 90 },
  };
}

// Strip ANSI escape sequences so assertions match against plain text.
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('statusline hook-error alert segment', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('renders ⚠N at the front of line 1 when there are unread errors', () => {
    logHookError('kg-sync', new Error('boom'));
    logHookError('kg-auto-init', new Error('boom2'));
    const out = stripAnsi(formatStatusline(minimalInput()));
    const line1 = out.split('\n')[0];
    // Alert segment is the FIRST segment (before the model segment).
    assert.ok(line1.startsWith('⚠2'), `line1 should start with ⚠2, got: ${line1}`);
  });

  it('does not render an alert when there are no errors', () => {
    const out = stripAnsi(formatStatusline(minimalInput()));
    const line1 = out.split('\n')[0];
    assert.ok(!line1.includes('⚠'), `line1 should not contain alert, got: ${line1}`);
  });

  it('clears the alert after the entries are marked seen (second render)', () => {
    logHookError('kg-sync', new Error('boom'));
    // First render shows the badge and advances seenTs.
    const first = stripAnsi(formatStatusline(minimalInput()));
    assert.ok(first.split('\n')[0].startsWith('⚠1'), 'first render should show ⚠1');
    // Second render with no new errors: badge gone.
    const second = stripAnsi(formatStatusline(minimalInput()));
    assert.ok(!second.split('\n')[0].includes('⚠'), 'second render should clear the alert');
  });

  it('shows a fresh alert for new errors arriving after a read', () => {
    logHookError('kg-sync', new Error('e1'));
    formatStatusline(minimalInput()); // marks seen
    logHookError('kg-auto-init', new Error('e2'));
    const out = stripAnsi(formatStatusline(minimalInput()));
    assert.ok(out.split('\n')[0].startsWith('⚠1'), 'new error should produce ⚠1');
  });

  it('omits the alert when no session id is provided', () => {
    logHookError('kg-sync', new Error('boom'));
    const input = minimalInput();
    input.session_id = '';
    const out = stripAnsi(formatStatusline(input));
    assert.ok(!out.split('\n')[0].includes('⚠'), 'no alert without a session id');
  });
});
