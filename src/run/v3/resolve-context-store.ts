import { existsSync, readdirSync } from 'node:fs';

import { assertSafePathSegment } from '../ids.js';
import { runV30Schema, sessionStateV30Schema, type RunV30, type SessionStateV30 } from '../schemas.js';
import { SessionStore } from '../store.js';
import { readStateJson } from '../../utils/state-schema.js';
import {
  resolveSessionContext,
  type ResolveSessionContextResult,
  type SessionContextCandidateInput,
  type SessionReferenceInput,
} from './resolve-context.js';

export interface ResolveSessionContextStoreOptions {
  explicit_session_id?: string;
  env?: Readonly<Record<string, string | undefined>>;
}

const PAUSED_RUNNABLE_STATUSES = new Set<RunV30['status']>([
  'running', 'blocked', 'completed', 'failed', 'cancelled',
]);

function canonicalSessionId(sessionId: string): string {
  return sessionId.trim();
}

function sessionReference(store: SessionStore, sessionIdInput: string): SessionReferenceInput {
  const sessionId = canonicalSessionId(sessionIdInput);
  if (sessionId.length === 0) return { session_id: sessionIdInput, access: 'inaccessible' };

  try {
    assertSafePathSegment(sessionId, 'session ID');
    if (!store.sessionExists(sessionId)) return { session_id: sessionId, access: 'not_found' };
    const session = store.readSessionRecordReadOnly(sessionId);
    return {
      session_id: sessionId,
      access: session.schema_version === 'session/3.0' ? 'accessible' : 'inaccessible',
    };
  } catch {
    return { session_id: sessionId, access: 'inaccessible' };
  }
}

function currentBinding(
  store: SessionStore,
  env: Readonly<Record<string, string | undefined>>,
): SessionReferenceInput | null {
  if (env.MAESTRO_SESSION_ID !== undefined) {
    return sessionReference(store, env.MAESTRO_SESSION_ID);
  }

  const activeSessionId = readStateJson(store.projectRoot)?.active_session_id;
  if (activeSessionId === undefined || activeSessionId === null) return null;
  if (typeof activeSessionId !== 'string') {
    return { session_id: '', access: 'inaccessible' };
  }
  return sessionReference(store, activeSessionId);
}

function isRunnablePausedSession(store: SessionStore, session: SessionStateV30): boolean {
  if (session.status !== 'paused' || session.active_run_ids.length === 0) return false;

  let runnable = false;
  for (const runId of [...new Set(session.active_run_ids)].sort()) {
    try {
      const runRecord = store.readRunRecordReadOnly(session.session_id, runId);
      const run = runV30Schema.safeParse(runRecord);
      if (!run.success) return false;
      if (PAUSED_RUNNABLE_STATUSES.has(run.data.status)) runnable = true;
    } catch {
      return false;
    }
  }
  return runnable;
}

function scanV3Candidates(store: SessionStore): {
  open_sessions: SessionContextCandidateInput[];
  runnable_candidates: SessionContextCandidateInput[];
} {
  const open_sessions: SessionContextCandidateInput[] = [];
  const runnable_candidates: SessionContextCandidateInput[] = [];
  if (!existsSync(store.sessionsRoot)) return { open_sessions, runnable_candidates };

  const entries = readdirSync(store.sessionsRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);

  for (const entry of entries) {
    try {
      assertSafePathSegment(entry.name, 'session ID');
      if (!store.sessionExists(entry.name)) continue;
      const record = store.readSessionRecordReadOnly(entry.name);
      const parsed = sessionStateV30Schema.safeParse(record);
      if (!parsed.success) continue;
      const session = parsed.data;
      if (session.status === 'open') open_sessions.push({ session_id: session.session_id });
      else if (isRunnablePausedSession(store, session)) {
        runnable_candidates.push({ session_id: session.session_id });
      }
    } catch {
      // Corrupt, inaccessible, and legacy projections cannot become v3 authority.
    }
  }
  return { open_sessions, runnable_candidates };
}

/** Resolve v3 Session authority without consulting legacy projections or file timestamps. */
export function resolveSessionContextFromStore(
  store: SessionStore,
  options: ResolveSessionContextStoreOptions = {},
): ResolveSessionContextResult {
  const explicit_session = options.explicit_session_id === undefined
    ? null
    : sessionReference(store, options.explicit_session_id);
  const current_binding = explicit_session
    ? null
    : currentBinding(store, options.env ?? process.env);
  const candidates = explicit_session || current_binding
    ? { open_sessions: [], runnable_candidates: [] }
    : scanV3Candidates(store);

  return resolveSessionContext({ explicit_session, current_binding, ...candidates });
}
