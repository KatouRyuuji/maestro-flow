import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { SessionStore, type SessionBundle } from './store.js';
import { sessionStateV20Schema, type ExecutionState, type SessionState, type SessionStateRead } from './schemas.js';
import { readStateJson } from '../utils/state-schema.js';

export interface ResolvedSession {
  sessionId: string;
  sessionDir: string;
  bundle: SessionBundle;
  record: SessionStateRead;
  currentExecution: ExecutionState | null;
  latestExecution: ExecutionState | null;
  /** Compatibility lifecycle derived from Execution for session/2.0. */
  derivedStatus: SessionState['status'];
}

export interface ResolveCompatibleSessionOptions {
  statuses?: SessionState['status'][];
}

export function readResolvedSession(store: SessionStore, sessionId: string): ResolvedSession {
  const record = store.readSessionRecord(sessionId);
  const bundle = store.readBundle(sessionId);
  if (record.schema_version !== 'session/2.0') {
    return {
      sessionId,
      sessionDir: store.sessionDir(sessionId),
      bundle,
      record,
      currentExecution: null,
      latestExecution: null,
      derivedStatus: bundle.session.status,
    };
  }

  const identity = sessionStateV20Schema.parse(record);
  const currentExecution = identity.current_execution_id
    ? store.readExecution(sessionId, identity.current_execution_id)
    : null;
  const latestExecution = identity.latest_execution_id
    ? (currentExecution?.execution_id === identity.latest_execution_id
        ? currentExecution
        : store.readExecution(sessionId, identity.latest_execution_id))
    : null;
  const derivedStatus: SessionState['status'] = identity.archived_at
    ? 'archived'
    : currentExecution?.status === 'paused'
      ? 'paused'
      : 'running';
  return {
    sessionId,
    sessionDir: store.sessionDir(sessionId),
    bundle,
    record: identity,
    currentExecution,
    latestExecution,
    derivedStatus,
  };
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
  const readAllowed = (id: string): ResolvedSession | null => {
    const resolved = readResolvedSession(store, id);
    return allowed && !allowed.has(resolved.derivedStatus) ? null : resolved;
  };

  // Explicit reads remain available for archived session/2.0 identities.
  if (sessionId) {
    if (!store.sessionExists(sessionId)) return null;
    return readAllowed(sessionId);
  }

  // An injected exact Session ID is also an explicit selection.
  const envSessionId = process.env.MAESTRO_SESSION_ID;
  if (envSessionId && store.sessionExists(envSessionId)) {
    const resolved = readAllowed(envSessionId);
    if (resolved) return resolved;
  }

  // state.json is a projection only. Re-read canonical authority before use and
  // never automatically select an archived session/2.0 identity.
  const state = readStateJson(projectRoot);
  if (state?.sessions && state.sessions.length > 0) {
    const matching = state.sessions.flatMap((entry) => {
      if (!store.sessionExists(entry.session_id)) return [];
      try {
        const resolved = readAllowed(entry.session_id);
        if (!resolved || resolved.derivedStatus === 'archived') return [];
        if (!allowed && resolved.derivedStatus !== 'running') return [];
        return [resolved];
      } catch {
        return [];
      }
    });
    if (matching.length === 1) return matching[0];
  }

  if (!existsSync(store.sessionsRoot)) return null;
  const candidates = store.listSessionsReadOnly().candidates.flatMap((candidate) => {
    try {
      const resolved = readAllowed(candidate.sessionId);
      if (!resolved || resolved.derivedStatus === 'archived') return [];
      if (!allowed && resolved.derivedStatus !== 'running') return [];
      return [{
        resolved,
        mtimeMs: statSync(join(store.sessionDir(candidate.sessionId), 'session.json')).mtimeMs,
      }];
    } catch {
      return [];
    }
  }).sort((left, right) => right.mtimeMs - left.mtimeMs
    || left.resolved.sessionId.localeCompare(right.resolved.sessionId));
  return candidates[0]?.resolved ?? null;
}
