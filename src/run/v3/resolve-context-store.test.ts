import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { RunV30, SessionStateV30 } from '../schemas.js';
import { SessionStore } from '../store.js';
import { resolveSessionContextFromStore } from './resolve-context-store.js';

const roots: string[] = [];

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'maestro-v3-context-'));
  roots.push(value);
  mkdirSync(join(value, '.workflow', 'sessions'), { recursive: true });
  return value;
}

function writeSession(
  projectRoot: string,
  sessionId: string,
  status: SessionStateV30['status'] = 'open',
  runStatus?: RunV30['status'],
): string {
  const sessionDir = join(projectRoot, '.workflow', 'sessions', sessionId);
  mkdirSync(sessionDir, { recursive: true });
  const activeRunIds = runStatus === undefined ? [] : [`run-${sessionId}`];
  const session: SessionStateV30 = {
    schema_version: 'session/3.0', session_id: sessionId, objective: `exercise ${sessionId}`,
    definition_of_done: 'context resolves deterministically', status,
    identity_revision: 1, orchestration_revision: 0, activity_revision: 0,
    chain: [], decisions: [], active_run_ids: activeRunIds,
    gates_ref: 'gates.json', artifacts_ref: 'artifacts.json', evidence_ref: 'evidence.json',
    created_at: '2026-08-12T00:00:00.000Z', updated_at: '2026-08-12T00:00:00.000Z',
    completed_at: null, archived_at: null,
  };
  const sessionPath = join(sessionDir, 'session.json');
  writeFileSync(sessionPath, `${JSON.stringify(session, null, 2)}\n`);
  if (runStatus !== undefined) {
    const runId = activeRunIds[0];
    const runDir = join(sessionDir, 'runs', runId);
    mkdirSync(runDir, { recursive: true });
    const run: RunV30 = {
      schema_version: 'run/3.0', run_id: runId, session_id: sessionId, step_id: 'step-1',
      parent_run_id: null, retry_of_run_id: null, attempt: 1, command: 'implement', args: [], goal: null,
      status: runStatus, revision: 0, actor_id: 'actor', participant_id: 'participant',
      gate_refs: [], input_refs: [], output_refs: [], primary_artifact_id: null, verdict: null, summary: null,
      created_at: '2026-08-12T00:00:00.000Z', started_at: null, ended_at: null, sealed_at: null,
    };
    writeFileSync(join(runDir, 'run.json'), `${JSON.stringify(run, null, 2)}\n`);
  }
  return sessionPath;
}

function writeState(projectRoot: string, activeSessionId: unknown): void {
  writeFileSync(join(projectRoot, '.workflow', 'state.json'), JSON.stringify({
    version: '3.0', active_session_id: activeSessionId,
  }));
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('resolveSessionContextFromStore', () => {
  it('uses explicit ID before environment, state, open, and runnable tiers', () => {
    const projectRoot = root();
    for (const id of ['explicit', 'env', 'state', 'open']) writeSession(projectRoot, id);
    writeSession(projectRoot, 'runnable', 'paused', 'running');
    writeState(projectRoot, 'state');

    expect(resolveSessionContextFromStore(new SessionStore(projectRoot), {
      explicit_session_id: ' explicit ', env: { MAESTRO_SESSION_ID: 'env' },
    })).toEqual({ ok: true, session_id: 'explicit', source: 'explicit_session_id' });
  });

  it('orders current binding as environment before state and never falls back from a stale binding', () => {
    const projectRoot = root();
    writeSession(projectRoot, 'state');
    writeSession(projectRoot, 'open');
    writeState(projectRoot, 'state');
    const store = new SessionStore(projectRoot);

    expect(resolveSessionContextFromStore(store, { env: { MAESTRO_SESSION_ID: 'missing' } }))
      .toMatchObject({ ok: false, error: { code: 'SESSION_NOT_FOUND', source: 'current_binding', candidates: ['missing'] } });
    expect(resolveSessionContextFromStore(store, { env: {} }))
      .toEqual({ ok: true, session_id: 'state', source: 'current_binding' });
  });

  it('fails closed when state contains an invalid binding', () => {
    const projectRoot = root();
    writeSession(projectRoot, 'open');
    writeState(projectRoot, 'missing');

    expect(resolveSessionContextFromStore(new SessionStore(projectRoot), { env: {} }))
      .toMatchObject({ ok: false, error: { code: 'SESSION_NOT_FOUND', source: 'current_binding', candidates: ['missing'] } });
  });

  it('uses a unique open Session before a runnable paused Session', () => {
    const projectRoot = root();
    writeSession(projectRoot, 'open');
    writeSession(projectRoot, 'paused-active', 'paused', 'blocked');

    expect(resolveSessionContextFromStore(new SessionStore(projectRoot), { env: {} }))
      .toEqual({ ok: true, session_id: 'open', source: 'open_sessions' });
  });

  it('uses a unique runnable paused Session when no Session is open', () => {
    const projectRoot = root();
    writeSession(projectRoot, 'paused-pending', 'paused', 'pending');
    writeSession(projectRoot, 'paused-active', 'paused', 'running');

    expect(resolveSessionContextFromStore(new SessionStore(projectRoot), { env: {} }))
      .toEqual({ ok: true, session_id: 'paused-active', source: 'runnable_candidates' });
  });

  it('reports multiple open candidates in canonical ID order regardless of mtime', () => {
    const projectRoot = root();
    const aPath = writeSession(projectRoot, 'session-a');
    const zPath = writeSession(projectRoot, 'session-z');
    utimesSync(aPath, new Date(4_000_000), new Date(4_000_000));
    utimesSync(zPath, new Date(1_000_000), new Date(1_000_000));

    expect(resolveSessionContextFromStore(new SessionStore(projectRoot), { env: {} }))
      .toMatchObject({
        ok: false,
        error: {
          code: 'SESSION_AMBIGUOUS', source: 'open_sessions',
          candidates: ['session-a', 'session-z'],
        },
      });
  });

  it('reports multiple runnable candidates in canonical ID order', () => {
    const projectRoot = root();
    writeSession(projectRoot, 'session-z', 'paused', 'completed');
    writeSession(projectRoot, 'session-a', 'paused', 'blocked');

    expect(resolveSessionContextFromStore(new SessionStore(projectRoot), { env: {} }))
      .toMatchObject({
        ok: false,
        error: {
          code: 'SESSION_AMBIGUOUS', source: 'runnable_candidates',
          candidates: ['session-a', 'session-z'],
        },
      });
  });

  it('never scans a legacy Session into v3 authority and rejects an explicit legacy reference', () => {
    const projectRoot = root();
    const legacyDir = join(projectRoot, '.workflow', 'sessions', 'legacy');
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(join(legacyDir, 'session.json'), JSON.stringify({
      schema_version: 'session/1.3', session_id: 'legacy', intent: 'legacy', status: 'running',
    }));

    expect(resolveSessionContextFromStore(new SessionStore(projectRoot), { env: {} }))
      .toMatchObject({ ok: false, error: { code: 'SESSION_CONTEXT_UNRESOLVED' } });
    expect(resolveSessionContextFromStore(new SessionStore(projectRoot), {
      explicit_session_id: 'legacy', env: {},
    })).toMatchObject({
      ok: false, error: { code: 'SESSION_INACCESSIBLE', source: 'explicit_session_id', candidates: ['legacy'] },
    });
  });
});
