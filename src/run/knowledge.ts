import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

import type { CommandRun } from './schemas.js';
import { SessionStore, type StoreTransaction } from './store.js';
import { parseSpecEntries } from '../tools/spec-entry-parser.js';
import { appendSpecEntry } from '../tools/spec-writer.js';
import { resolveSpecDir, type SpecCategory } from '../tools/spec-loader.js';
import { executeAdd } from '../tools/store-knowhow.js';

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
  promotion_receipt: z.object({
    outcome: z.enum(['created', 'reaffirmed']),
    promoted_at: nonEmptyString,
    content_hash: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict().nullable().optional(),
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

export interface PromoteSessionKnowledgeOptions {
  candidateIds?: string[];
  all?: boolean;
  includeObserved?: boolean;
}

export interface KnowledgePromotionResult {
  schema_version: 'knowledge-promotion-result/1.0';
  session_id: string;
  promoted: Array<{
    candidate_id: string;
    target: KnowledgeCandidate['target'];
    promoted_id: string;
    outcome: 'created' | 'reaffirmed';
  }>;
  already_promoted: Array<{
    candidate_id: string;
    promoted_id: string;
  }>;
  skipped_observed: string[];
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

function normalizedText(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

function contentHash(value: string): string {
  return createHash('sha256').update(normalizedText(value)).digest('hex');
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
    promotion_receipt: null,
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
        if (candidate.status === 'promoted') {
          existing.status = 'promoted';
          existing.promoted_id = candidate.promoted_id;
          existing.promotion_receipt = candidate.promotion_receipt;
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

function specBody(content: string): string {
  return content.replace(/^###\s+.*?(?:\r?\n){1,2}/, '').trim();
}

function findExistingSpec(
  projectRoot: string,
  title: string,
): { id: string; content: string } | null {
  const specsDir = resolveSpecDir(projectRoot, 'project');
  if (!existsSync(specsDir)) return null;
  for (const file of readdirSync(specsDir).filter(name => name.endsWith('.md')).sort()) {
    const parsed = parseSpecEntries(readFileSync(join(specsDir, file), 'utf8'));
    const entry = parsed.entries.find(item => normalizedText(item.title) === normalizedText(title));
    if (entry) {
      return {
        id: entry.sid ?? `legacy:${file}:${entry.lineStart}`,
        content: specBody(entry.content),
      };
    }
    const legacy = parsed.legacy.find(item => normalizedText(item.title) === normalizedText(title));
    if (legacy) return { id: `legacy:${file}:${legacy.lineStart}`, content: legacy.content.trim() };
  }
  return null;
}

function promoteSpecCandidate(
  projectRoot: string,
  sessionId: string,
  candidate: KnowledgeCandidate,
): { promoted_id: string; outcome: 'created' | 'reaffirmed' } {
  const existing = findExistingSpec(projectRoot, candidate.title);
  if (existing) {
    if (normalizedText(existing.content) !== normalizedText(candidate.content)) {
      throw new Error(
        `Candidate ${candidate.candidate_id} conflicts with existing spec title "${candidate.title}"; `
        + 'resolve with spec supersede/conflict before promotion',
      );
    }
    return { promoted_id: existing.id, outcome: 'reaffirmed' };
  }

  const validCategories: SpecCategory[] = ['coding', 'arch', 'debug', 'test', 'review', 'learning', 'ui'];
  const category = validCategories.includes(candidate.category as SpecCategory)
    ? candidate.category as SpecCategory
    : 'learning';
  const result = appendSpecEntry(
    projectRoot,
    category,
    candidate.title,
    candidate.content,
    ['session-knowledge', candidate.source_kind],
    `session:${sessionId}:${candidate.candidate_id}`,
    'project',
    undefined,
    `Promoted from ${candidate.evidence_refs.join(', ')}`,
  );
  if (!result.ok || !result.sid) {
    const replay = findExistingSpec(projectRoot, candidate.title);
    if (result.duplicate && replay && normalizedText(replay.content) === normalizedText(candidate.content)) {
      return { promoted_id: replay.id, outcome: 'reaffirmed' };
    }
    throw new Error(`Failed to promote spec candidate ${candidate.candidate_id}`);
  }
  return { promoted_id: result.sid, outcome: 'created' };
}

function promoteKnowhowCandidate(
  projectRoot: string,
  candidate: KnowledgeCandidate,
): { promoted_id: string; outcome: 'created' | 'reaffirmed' } {
  const date = candidate.first_recorded_at.slice(0, 10).replace(/-/g, '');
  const explicitId = `tip-${date}-${candidate.candidate_id.slice(4)}`;
  const previousRoot = process.env.MAESTRO_PROJECT_ROOT;
  process.env.MAESTRO_PROJECT_ROOT = projectRoot;
  try {
    const response = executeAdd({
      operation: 'add',
      limit: 20,
      id: explicitId,
      type: 'tip',
      title: candidate.title,
      description: `Promoted from ${candidate.evidence_refs.join(', ')}`,
      body: candidate.content,
      keywords: ['session-knowledge', candidate.source_kind],
      tags: ['promoted'],
    });
    if (!response.success) throw new Error(response.error ?? 'unknown knowhow promotion error');
    const result = response.result as { id: string; replayed: boolean };
    return { promoted_id: result.id, outcome: result.replayed ? 'reaffirmed' : 'created' };
  } finally {
    if (previousRoot === undefined) delete process.env.MAESTRO_PROJECT_ROOT;
    else process.env.MAESTRO_PROJECT_ROOT = previousRoot;
  }
}

/**
 * Promote selected pending candidates. `--all` remains conservative: observed
 * candidates require an explicit id or includeObserved=true.
 */
export function promoteSessionKnowledge(
  projectRoot: string,
  sessionId: string,
  options: PromoteSessionKnowledgeOptions,
): KnowledgePromotionResult {
  if (options.all && options.candidateIds?.length) {
    throw new Error('Use either candidate IDs or --all, not both');
  }
  if (!options.all && !options.candidateIds?.length) {
    throw new Error('Select candidates with --candidate <ids> or --all');
  }

  const summary = summarizeSessionKnowledge(projectRoot, sessionId);
  const requested = new Set(options.candidateIds ?? []);
  const unknown = [...requested].filter(id => !summary.candidates.some(candidate => candidate.candidate_id === id));
  if (unknown.length > 0) throw new Error(`Unknown candidate IDs: ${unknown.join(', ')}`);

  const pending = summary.candidates.filter(candidate => candidate.status === 'pending');
  const alreadyPromoted = options.candidateIds
    ? summary.candidates
      .filter(candidate => requested.has(candidate.candidate_id)
        && candidate.status === 'promoted'
        && candidate.promoted_id)
      .map(candidate => ({
        candidate_id: candidate.candidate_id,
        promoted_id: candidate.promoted_id!,
      }))
    : [];
  const selected = options.all
    ? pending.filter(candidate => options.includeObserved || candidate.stage === 'corroborated')
    : pending.filter(candidate => requested.has(candidate.candidate_id));
  const skippedObserved = options.all && !options.includeObserved
    ? pending.filter(candidate => candidate.stage === 'observed').map(candidate => candidate.candidate_id)
    : [];
  if (selected.length === 0 && alreadyPromoted.length === 0) {
    if (options.all && skippedObserved.length === 0) {
      return {
        schema_version: 'knowledge-promotion-result/1.0',
        session_id: sessionId,
        promoted: [],
        already_promoted: [],
        skipped_observed: [],
      };
    }
    throw new Error(
      skippedObserved.length > 0
        ? 'No corroborated pending candidates; pass --include-observed or select explicit candidate IDs'
        : 'No pending candidates selected',
    );
  }

  // Preflight title conflicts before the first project knowledge write.
  for (const candidate of selected.filter(item => item.target === 'spec')) {
    const existing = findExistingSpec(projectRoot, candidate.title);
    if (existing && normalizedText(existing.content) !== normalizedText(candidate.content)) {
      throw new Error(
        `Candidate ${candidate.candidate_id} conflicts with existing spec title "${candidate.title}"; `
        + 'resolve with spec supersede/conflict before promotion',
      );
    }
  }

  const promoted = selected.map(candidate => {
    const result = candidate.target === 'spec'
      ? promoteSpecCandidate(projectRoot, sessionId, candidate)
      : promoteKnowhowCandidate(projectRoot, candidate);
    return {
      candidate_id: candidate.candidate_id,
      target: candidate.target,
      promoted_id: result.promoted_id,
      outcome: result.outcome,
    };
  });

  const store = new SessionStore(projectRoot);
  const promotedAt = nowIso();
  store.updateKnowledgeLifecycle(sessionId, (lifecycle, tx) => {
    for (const item of promoted) {
      const target = item.target === 'spec'
        ? lifecycle.promoted_spec_ids
        : lifecycle.promoted_knowhow_ids;
      if (!target.includes(item.promoted_id)) target.push(item.promoted_id);
    }
    for (const runId of new Set(summary.candidates.flatMap(candidate => candidate.run_ids))) {
      const delta = readRunKnowledgeDelta(store, sessionId, runId);
      let changed = false;
      for (const candidate of delta.candidates) {
        const item = promoted.find(entry => entry.candidate_id === candidate.candidate_id);
        if (!item) continue;
        candidate.status = 'promoted';
        candidate.promoted_id = item.promoted_id;
        candidate.promotion_receipt = {
          outcome: item.outcome,
          promoted_at: promotedAt,
          content_hash: contentHash(candidate.content),
        };
        changed = true;
      }
      if (changed) {
        delta.revision++;
        delta.updated_at = promotedAt;
        tx.writeJson(deltaPath(store, sessionId, runId), delta, runKnowledgeDeltaSchema);
      }
    }
  });

  return {
    schema_version: 'knowledge-promotion-result/1.0',
    session_id: sessionId,
    promoted,
    already_promoted: alreadyPromoted,
    skipped_observed: skippedObserved,
  };
}
