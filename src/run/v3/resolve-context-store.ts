import { existsSync, readdirSync } from 'node:fs';

import { assertSafePathSegment } from '../ids.js';
import { sessionStateV30ReadSchema, type SessionStateV30 } from '../schemas.js';
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

// The retired `paused` Session status had a dedicated runnable-candidate tier
// (a paused Session with active Runs could be picked as the CLI context).
// With paused gone, only open Sessions are v3 context candidates; the
// runnable_candidates tier stays empty and the pure resolver API is unchanged.
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
      const parsed = sessionStateV30ReadSchema.safeParse(record);
      if (!parsed.success) continue;
      const session = parsed.data as SessionStateV30;
      if (session.status === 'open') open_sessions.push({ session_id: session.session_id });
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
