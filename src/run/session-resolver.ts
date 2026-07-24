import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { SessionStore, type SessionBundle } from './store.js';
import { readStateJson } from '../utils/state-schema.js';

export interface ResolvedSession {
  sessionId: string;
  sessionDir: string;
  bundle: SessionBundle;
}

export interface ResolveCompatibleSessionOptions {
  statuses?: SessionBundle['session']['status'][];
}

/**
 * Resolve an explicit Session or the newest compatible Session.
 *
 * Resolution priority (multi-session safe):
 *   1. Explicit `sessionId` argument → O(1) direct read
 *   2. `MAESTRO_SESSION_ID` environment variable → O(1) direct read
 *   3. `state.json` sessions list — unique running candidate → O(1)
 *   4. Multiple running candidates → null (caller must pass --session)
 *   5. Full directory scan fallback (sorted by mtime)
 */
export function resolveCompatibleSession(
  projectRoot: string,
  sessionId?: string,
  options: ResolveCompatibleSessionOptions = {},
): ResolvedSession | null {
  const store = new SessionStore(projectRoot);
  const allowed = options.statuses ? new Set(options.statuses) : null;

  // 1. Explicit session ID
  if (sessionId) {
    if (!store.sessionExists(sessionId)) return null;
    const bundle = store.readBundle(sessionId);
    if (allowed && !allowed.has(bundle.session.status)) return null;
    return { sessionId, sessionDir: store.sessionDir(sessionId), bundle };
  }

  // 2. Environment variable (orchestrator-injected)
  const envSessionId = process.env.MAESTRO_SESSION_ID;
  if (envSessionId && store.sessionExists(envSessionId)) {
    const bundle = store.readBundle(envSessionId);
    if (!allowed || allowed.has(bundle.session.status)) {
      return { sessionId: envSessionId, sessionDir: store.sessionDir(envSessionId), bundle };
    }
  }

  // 3. state.json sessions list — fast path for unique running session
  const state = readStateJson(projectRoot);
  if (state?.sessions && state.sessions.length > 0) {
    const statusFilter = allowed ?? new Set(['running']);
    const matching = state.sessions.filter(s => statusFilter.has(s.status as never));
    if (matching.length === 1 && store.sessionExists(matching[0].session_id)) {
      const bundle = store.readBundle(matching[0].session_id);
      if (!allowed || allowed.has(bundle.session.status)) {
        return { sessionId: matching[0].session_id, sessionDir: store.sessionDir(matching[0].session_id), bundle };
      }
    }
    // Multiple candidates: fall through to full scan (which picks newest by mtime)
  }

  // 4. Full directory scan fallback
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
