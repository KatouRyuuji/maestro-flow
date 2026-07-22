import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from './store.js';
import { resolveCompatibleSession } from './session-resolver.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'session-resolver-'));
  roots.push(value);
  return value;
}

describe('resolveCompatibleSession', () => {
  it('resolves explicit Sessions without engine filtering', () => {
    const projectRoot = root();
    const store = new SessionStore(projectRoot);
    store.createSession('manual-session', 'manual');
    store.update('manual-session', draft => { draft.session.orchestration.engine = 'manual'; });

    expect(resolveCompatibleSession(projectRoot, 'manual-session')?.bundle.session.orchestration.engine).toBe('manual');
  });

  it('applies status filtering without treating engine as a capability', () => {
    const projectRoot = root();
    const store = new SessionStore(projectRoot);
    store.createSession('coordinator-session', 'coordinator');
    store.update('coordinator-session', draft => {
      draft.session.orchestration.engine = 'coordinator';
      draft.session.status = 'paused';
    });

    expect(resolveCompatibleSession(projectRoot, 'coordinator-session', { statuses: ['running'] })).toBeNull();
    expect(resolveCompatibleSession(projectRoot, 'coordinator-session', { statuses: ['paused'] })?.sessionId).toBe('coordinator-session');
  });
});
