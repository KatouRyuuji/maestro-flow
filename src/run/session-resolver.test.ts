import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from './store.js';
import { resolveCompatibleSession } from './session-resolver.js';
import { archiveSession } from './session-transition.js';

function v2Workspace(root: string): void {
  mkdirSync(join(root, ".workflow"), { recursive: true });
  writeFileSync(join(root, ".workflow", "config.json"), JSON.stringify({
    session_schema: { schema_version: "session-schema-selection/1.0", writer: "session/1.3", features: { session_statusless: false } },
  }));
}

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'session-resolver-'));

  v2Workspace(value);
  roots.push(value);
  return value;
}

function enableV20(projectRoot: string): void {
  mkdirSync(join(projectRoot, '.workflow'), { recursive: true });
  writeFileSync(join(projectRoot, '.workflow', 'config.json'), JSON.stringify({
    session_schema: {
      schema_version: 'session-schema-selection/1.0',
      writer: 'session/2.0',
      features: { session_statusless: true },
    },
  }));
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

  it('excludes archived session/2.0 identities automatically but preserves explicit reads', () => {
    const projectRoot = root();
    enableV20(projectRoot);
    const store = new SessionStore(projectRoot);
    store.createSession('statusless', 'statusless');
    archiveSession(projectRoot, 'statusless', {
      requestId: 'archive-statusless',
      actor: 'operator',
      reason: 'historical identity',
      evidence: ['evidence/archive.json'],
      expectedIdentityRevision: 1,
      expectedActivityRevision: 0,
      now: new Date('2026-08-03T00:00:00.000Z'),
    });

    expect(resolveCompatibleSession(projectRoot)).toBeNull();
    expect(resolveCompatibleSession(projectRoot, 'statusless')).toMatchObject({
      sessionId: 'statusless',
      derivedStatus: 'archived',
      record: { schema_version: 'session/2.0', archived_by: 'operator' },
    });
  });
});
