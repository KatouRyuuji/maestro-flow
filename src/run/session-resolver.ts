import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { SessionStore, type SessionBundle } from './store.js';

export interface ResolvedSession {
  sessionId: string;
  sessionDir: string;
  bundle: SessionBundle;
}

export interface ResolveCompatibleSessionOptions {
  statuses?: SessionBundle['session']['status'][];
}

/** Resolve an explicit Session or the newest compatible Session without engine filtering. */
export function resolveCompatibleSession(
  projectRoot: string,
  sessionId?: string,
  options: ResolveCompatibleSessionOptions = {},
): ResolvedSession | null {
  const store = new SessionStore(projectRoot);
  const allowed = options.statuses ? new Set(options.statuses) : null;

  if (sessionId) {
    if (!store.sessionExists(sessionId)) return null;
    const bundle = store.readBundle(sessionId);
    if (allowed && !allowed.has(bundle.session.status)) return null;
    return { sessionId, sessionDir: store.sessionDir(sessionId), bundle };
  }

  if (!existsSync(store.sessionsRoot)) return null;
  const candidates = store.listSessions(allowed ? { statuses: [...allowed] } : {}).candidates
    .map(candidate => ({
      ...candidate,
      mtimeMs: statSync(join(store.sessionDir(candidate.sessionId), 'session.json')).mtimeMs,
    }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs || a.sessionId.localeCompare(b.sessionId));
  const candidate = candidates[0];
  if (!candidate) return null;
  return {
    sessionId: candidate.sessionId,
    sessionDir: store.sessionDir(candidate.sessionId),
    bundle: store.readBundle(candidate.sessionId),
  };
}
