import { createHash } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

import type { CommandRun } from './schemas.js';
import { SessionStore, type StoreTransaction } from './store.js';

const nonEmptyString = z.string().min(1);

export const knowledgeInputSignalSchema = z.enum([
  'consumed', 'cited', 'validated', 'contradicted',
]);

export const knowledgeInputSchema = z.object({
  knowledge_id: nonEmptyString,
  signal: knowledgeInputSignalSchema,
  source: z.enum(['load', 'search', 'injection', 'manual']),
  count: z.number().int().positive(),
  first_recorded_at: nonEmptyString,
  last_recorded_at: nonEmptyString,
}).strict();

export const knowledgeCandidateSchema = z.object({
  candidate_id: z.string().regex(/^KDC-[a-f0-9]{16}$/),
  target: z.enum(['spec', 'knowhow']),
  action: z.enum(['propose', 'reaffirm', 'supersede', 'contest']),
  title: nonEmptyString,
  content: nonEmptyString,
  category: z.string().nullable(),
  source_kind: z.enum(['decision', 'constraint', 'manual']),
  evidence_refs: z.array(nonEmptyString),
  occurrences: z.number().int().positive(),
  first_recorded_at: nonEmptyString,
  last_recorded_at: nonEmptyString,
  status: z.enum(['pending', 'promoted', 'rejected']),
  promoted_id: z.string().nullable(),
}).strict();

export const runKnowledgeDeltaSchema = z.object({
  schema_version: z.literal('run-knowledge-delta/1.0'),
  session_id: nonEmptyString,
  run_id: nonEmptyString,
  revision: z.number().int().nonnegative(),
  created_at: nonEmptyString,
  updated_at: nonEmptyString,
  inputs: z.array(knowledgeInputSchema),
  candidates: z.array(knowledgeCandidateSchema),
}).strict();

export type RunKnowledgeDelta = z.infer<typeof runKnowledgeDeltaSchema>;
export type KnowledgeCandidate = z.infer<typeof knowledgeCandidateSchema>;
export type KnowledgeInputSignal = z.infer<typeof knowledgeInputSignalSchema>;

export interface SessionKnowledgeSummary {
  schema_version: 'session-knowledge-summary/1.0';
  session_id: string;
  run_count: number;
  ledger_count: number;
  input_totals: Record<KnowledgeInputSignal, number>;
  unique_inputs: number;
  candidates: Array<KnowledgeCandidate & {
    run_ids: string[];
    stage: 'observed' | 'corroborated';
  }>;
}

function nowIso(): string {
  return new Date().toISOString();
}

function createDelta(sessionId: string, runId: string, now: string = nowIso()): RunKnowledgeDelta {
  return {
    schema_version: 'run-knowledge-delta/1.0',
    session_id: sessionId,
    run_id: runId,
    revision: 0,
    created_at: now,
    updated_at: now,
    inputs: [],
    candidates: [],
  };
}

function deltaPath(store: SessionStore, sessionId: string, runId: string): string {
  return join(store.runDir(sessionId, runId), 'knowledge-delta.json');
}

function candidateId(target: KnowledgeCandidate['target'], content: string): string {
  const normalized = content.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
  const hash = createHash('sha256').update(`${target}\0${normalized}`).digest('hex').slice(0, 16);
  return `KDC-${hash}`;
}

function addInput(
  draft: RunKnowledgeDelta,
  knowledgeId: string,
  signal: KnowledgeInputSignal,
  source: z.infer<typeof knowledgeInputSchema>['source'],
  now: string,
): void {
  const existing = draft.inputs.find(item =>
    item.knowledge_id === knowledgeId && item.signal === signal && item.source === source
  );
  if (existing) {
    existing.count++;
    existing.last_recorded_at = now;
  } else {
    draft.inputs.push({
      knowledge_id: knowledgeId,
      signal,
      source,
      count: 1,
      first_recorded_at: now,
      last_recorded_at: now,
    });
  }
}

function addCandidate(
  draft: RunKnowledgeDelta,
  input: Pick<KnowledgeCandidate, 'target' | 'action' | 'title' | 'content' | 'category' | 'source_kind'>
    & { evidence_refs: string[] },
  now: string,
): void {
  const id = candidateId(input.target, input.content);
  const existing = draft.candidates.find(candidate => candidate.candidate_id === id);
  if (existing) {
    existing.occurrences++;
    existing.last_recorded_at = now;
    existing.evidence_refs = [...new Set([...existing.evidence_refs, ...input.evidence_refs])];
    return;
  }
  draft.candidates.push({
    candidate_id: id,
    ...input,
    evidence_refs: [...new Set(input.evidence_refs)],
    occurrences: 1,
    first_recorded_at: now,
    last_recorded_at: now,
    status: 'pending',
    promoted_id: null,
  });
}

export function readRunKnowledgeDelta(
  store: SessionStore,
  sessionId: string,
  runId: string,
): RunKnowledgeDelta {
  return store.readJsonFile(
    deltaPath(store, sessionId, runId),
    runKnowledgeDeltaSchema,
    createDelta(sessionId, runId),
  );
}

/**
 * Attach explicit knowledge use to the unique active Run. Ambiguous/no-active
 * cases are intentionally ignored because analytics must never guess authority.
 */
export function recordActiveRunKnowledgeInputs(
  projectRoot: string,
  knowledgeIds: string[],
  signal: KnowledgeInputSignal = 'consumed',
  source: z.infer<typeof knowledgeInputSchema>['source'] = 'load',
): { session_id: string; run_id: string; recorded: number } | null {
  const ids = [...new Set(knowledgeIds.filter(Boolean))];
  if (ids.length === 0) return null;
  try {
    const store = new SessionStore(projectRoot);
    const active = store.listSessions({ statuses: ['running'] }).candidates
      .filter(candidate => candidate.session.active_run_id)
      .map(candidate => ({
        sessionId: candidate.sessionId,
        runId: candidate.session.active_run_id!,
      }));
    if (active.length !== 1) return null;

    const target = active[0];
    const path = deltaPath(store, target.sessionId, target.runId);
    const now = nowIso();
    store.updateJsonFile(
      path,
      runKnowledgeDeltaSchema,
      createDelta(target.sessionId, target.runId, now),
      draft => {
        for (const id of ids) addInput(draft, id, signal, source, now);
        draft.revision++;
        draft.updated_at = now;
      },
    );
    return { session_id: target.sessionId, run_id: target.runId, recorded: ids.length };
  } catch {
    return null;
  }
}

/**
 * Convert structured handoff facts into pending candidates in the same atomic
 * SessionStore transaction that seals the Run. No project knowledge is written.
 */
export function stageHandoffKnowledgeCandidates(
  store: SessionStore,
  tx: StoreTransaction,
  sessionId: string,
  run: CommandRun,
): RunKnowledgeDelta | null {
  if (!run.handoff) return null;
  const path = deltaPath(store, sessionId, run.run_id);
  const draft = readRunKnowledgeDelta(store, sessionId, run.run_id);
  const now = nowIso();
  const evidence = [`run:${run.run_id}`, ...run.handoff.artifact_refs.map(id => `artifact:${id}`)];

  for (const decision of run.handoff.decisions) {
    if (decision.status !== 'accepted' || !decision.text.trim()) continue;
    addCandidate(draft, {
      target: 'spec',
      action: 'propose',
      title: decision.text.trim().slice(0, 120),
      content: decision.text.trim(),
      category: 'arch',
      source_kind: 'decision',
      evidence_refs: evidence,
    }, now);
  }
  for (const constraint of run.handoff.constraints) {
    if (constraint.status !== 'locked' || !constraint.text.trim()) continue;
    addCandidate(draft, {
      target: 'spec',
      action: 'propose',
      title: constraint.text.trim().slice(0, 120),
      content: constraint.text.trim(),
      category: 'arch',
      source_kind: 'constraint',
      evidence_refs: evidence,
    }, now);
  }

  draft.revision++;
  draft.updated_at = now;
  tx.writeJson(path, draft, runKnowledgeDeltaSchema);
  return draft;
}

export function summarizeSessionKnowledge(
  projectRoot: string,
  sessionId: string,
): SessionKnowledgeSummary {
  const store = new SessionStore(projectRoot);
  if (!store.sessionExists(sessionId)) throw new Error(`Session not found: ${sessionId}`);
  const runsDir = join(store.sessionDir(sessionId), 'runs');
  const runIds = existsSync(runsDir)
    ? readdirSync(runsDir).filter(runId => existsSync(join(store.runDir(sessionId, runId), 'run.json'))).sort()
    : [];
  const ledgers = runIds
    .filter(runId => existsSync(deltaPath(store, sessionId, runId)))
    .map(runId => readRunKnowledgeDelta(store, sessionId, runId));

  const inputTotals: Record<KnowledgeInputSignal, number> = {
    consumed: 0,
    cited: 0,
    validated: 0,
    contradicted: 0,
  };
  const uniqueInputs = new Set<string>();
  const candidates = new Map<string, KnowledgeCandidate & { run_ids: string[] }>();
  for (const ledger of ledgers) {
    for (const input of ledger.inputs) {
      inputTotals[input.signal] += input.count;
      uniqueInputs.add(input.knowledge_id);
    }
    for (const candidate of ledger.candidates) {
      const existing = candidates.get(candidate.candidate_id);
      if (existing) {
        existing.occurrences += candidate.occurrences;
        existing.run_ids.push(ledger.run_id);
        existing.evidence_refs = [...new Set([...existing.evidence_refs, ...candidate.evidence_refs])];
        if (candidate.last_recorded_at > existing.last_recorded_at) {
          existing.last_recorded_at = candidate.last_recorded_at;
        }
      } else {
        candidates.set(candidate.candidate_id, { ...structuredClone(candidate), run_ids: [ledger.run_id] });
      }
    }
  }

  return {
    schema_version: 'session-knowledge-summary/1.0',
    session_id: sessionId,
    run_count: runIds.length,
    ledger_count: ledgers.length,
    input_totals: inputTotals,
    unique_inputs: uniqueInputs.size,
    candidates: [...candidates.values()]
      .map(candidate => {
        const runIds = [...new Set(candidate.run_ids)].sort();
        return {
          ...candidate,
          run_ids: runIds,
          stage: runIds.length > 1 ? 'corroborated' as const : 'observed' as const,
        };
      })
      .sort((left, right) =>
        right.run_ids.length - left.run_ids.length
        || right.occurrences - left.occurrences
        || left.candidate_id.localeCompare(right.candidate_id)
      ),
  };
}
