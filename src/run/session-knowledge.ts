/**
 * Session-level knowledge ledger operations (origin=session).
 *
 * Implements K1/K2 of docs/knowledge-session-decoupling-mvp.md
 * (pi-maestro-flow repo):
 *   K1 — session-knowledge-delta sidecar writes; sealed Sessions refuse
 *        writes (S8), run delta v1.0 remains byte-for-byte untouched (S1).
 *   K2 — idempotent synthetic knowledge Session creation for run-less
 *        daily sessions (ID = ksyn-<hash(host+project+date)>, host ids are
 *        mapping keys only, never Session-directory authority, S4).
 *
 * The schema, path, read helpers and summarize aggregation live in
 * knowledge.ts to keep ledger primitives single-sourced; this module owns the
 * write operations so knowledge.ts stays free of synthetic-session policy.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { basename, resolve } from 'node:path';

import {
  addCandidate,
  addInput,
  createSessionDelta,
  knowledgeCandidateId,
  sessionKnowledgeDeltaPath,
  sessionKnowledgeDeltaSchema,
  summarizeSessionKnowledge,
  type KnowledgeCandidate,
  type KnowledgeInputSignal,
  type KnowledgeInputSource,
  type SessionKnowledgeDelta,
} from './knowledge.js';
import { SessionStore } from './store.js';

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Mutate the Session-level knowledge sidecar atomically under the store lock.
 * Sealed/archived/failed Sessions refuse writes (S8 time-order invariant).
 */
export function updateSessionKnowledgeSidecar<T>(
  projectRoot: string,
  sessionId: string,
  mutator: (draft: SessionKnowledgeDelta) => T,
): T {
  const store = new SessionStore(projectRoot);
  if (!store.sessionExists(sessionId)) throw new Error(`Session not found: ${sessionId}`);
  return store.updateKnowledgeLifecycle(sessionId, (_lifecycle, tx) => {
    // Re-check under the lock (readBundle is re-entrancy safe via isHeld).
    const status = store.readBundle(sessionId).session.status;
    if (status !== 'running' && status !== 'paused') {
      throw new Error(`Session ${sessionId} is ${status} and cannot mutate knowledge sidecars`);
    }
    const path = sessionKnowledgeDeltaPath(store, sessionId);
    const now = nowIso();
    const draft = existsSync(path)
      ? structuredClone(store.readJsonFileReadOnly(path, sessionKnowledgeDeltaSchema))
      : createSessionDelta(sessionId, now);
    const result = mutator(draft);
    sessionKnowledgeDeltaSchema.parse(draft);
    tx.writeJson(path, draft, sessionKnowledgeDeltaSchema);
    return result;
  });
}

// ---------------------------------------------------------------------------
// K2 — synthetic knowledge Session
// ---------------------------------------------------------------------------

export const SYNTHETIC_SESSION_PREFIX = 'ksyn-';
const SYNTHETIC_SESSION_INTENT = 'knowledge-sedimentation';

/**
 * Deterministic synthetic Session ID: ksyn-<sha256(host|project|date)[:16]>.
 * Date partitioning rotates identity daily so there is no need for an
 * abandon/cleanup lifecycle (MVP-cut decision). Host identifiers are hash
 * inputs only — they never become Session-directory names (S4).
 */
export function syntheticKnowledgeSessionId(
  host: string,
  projectRoot: string,
  date: Date = new Date(),
): string {
  const normalizedHost = host.trim() || 'adhoc';
  const project = basename(resolve(projectRoot)) || 'project';
  const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  const digest = createHash('sha256')
    .update(`${normalizedHost}\u0000${project}\u0000${day}`)
    .digest('hex')
    .slice(0, 16);
  return `${SYNTHETIC_SESSION_PREFIX}${digest}`;
}

/**
 * Idempotently ensure the synthetic knowledge Session for (host, project,
 * today) exists. Reuses the existing Session bundle when present.
 */
export function ensureSyntheticKnowledgeSession(
  projectRoot: string,
  host: string,
): { sessionId: string; created: boolean } {
  const store = new SessionStore(projectRoot);
  const sessionId = syntheticKnowledgeSessionId(host, projectRoot);
  const existed = store.sessionExists(sessionId);
  store.createSession(sessionId, SYNTHETIC_SESSION_INTENT, { ifExists: 'reuse' });
  return { sessionId, created: !existed };
}

// ---------------------------------------------------------------------------
// K1 — stage / record against the Session ledger
// ---------------------------------------------------------------------------

/**
 * Stage a candidate on the Session-level ledger (origin=session).
 * Session-source candidates require non-empty evidence (S2/K5 precondition).
 */
export function stageSessionKnowledgeCandidate(
  projectRoot: string,
  sessionId: string,
  input: {
    target: KnowledgeCandidate['target'];
    action?: KnowledgeCandidate['action'];
    title: string;
    content: string;
    category?: string | null;
    evidenceRefs?: string[];
  },
): { session_id: string; candidate_id: string; origin: 'session' } {
  const title = input.title.trim();
  const content = input.content.trim();
  if (!title || !content) throw new Error('Knowledge candidate title and content are required');
  const evidence = [...new Set(
    (input.evidenceRefs ?? []).map(ref => ref.trim()).filter(Boolean),
  )];
  if (evidence.length === 0) {
    throw new Error(
      'Session-source candidates require non-empty --evidence '
      + '(file:line / artifact / output anchors)',
    );
  }
  const candidateId = knowledgeCandidateId(input.target, content);
  const prior = summarizeSessionKnowledge(projectRoot, sessionId, {
    readOnly: true,
    strict: true,
  }).candidates.find(candidate =>
    candidate.candidate_id === candidateId && (candidate.origin ?? 'run') === 'session'
  );
  if (prior && prior.action !== (input.action ?? 'propose')) {
    throw new Error(
      `Candidate ${candidateId} already exists in Session ${sessionId} `
      + `with action ${prior.action}; resolve or promote it instead of restaging as `
      + `${input.action ?? 'propose'}`,
    );
  }
  const now = nowIso();
  return updateSessionKnowledgeSidecar(projectRoot, sessionId, (draft) => {
    const id = addCandidate(draft, {
      target: input.target,
      action: input.action ?? 'propose',
      title,
      content,
      category: input.category?.trim() || null,
      source_kind: 'manual',
      evidence_refs: [...new Set([`session:${sessionId}`, ...evidence])],
    }, now);
    draft.revision++;
    draft.updated_at = now;
    return { session_id: sessionId, candidate_id: id, origin: 'session' as const };
  });
}

/**
 * Record explicit knowledge attribution on the Session-level ledger.
 */
export function recordSessionKnowledgeInputs(
  projectRoot: string,
  sessionId: string,
  knowledgeIds: string[],
  signal: KnowledgeInputSignal = 'consumed',
  source: KnowledgeInputSource = 'manual',
  evidence: readonly string[] = [],
): { session_id: string; recorded: number; origin: 'session' } {
  const ids = [...new Set(knowledgeIds.map(id => id.trim()).filter(Boolean))];
  if (ids.length === 0) throw new Error('At least one knowledge ID is required');
  const now = nowIso();
  return updateSessionKnowledgeSidecar(projectRoot, sessionId, (draft) => {
    for (const id of ids) addInput(draft, id, signal, source, now, evidence);
    draft.revision++;
    draft.updated_at = now;
    return { session_id: sessionId, recorded: ids.length, origin: 'session' as const };
  });
}
