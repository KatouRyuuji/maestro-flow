import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

import type { CommandRun, ReportFrontmatter } from './schemas.js';
import { SessionStore, type StoreTransaction } from './store.js';
import { parseSpecEntries } from '../tools/spec-entry-parser.js';
import { appendSpecEntry } from '../tools/spec-writer.js';
import { resolveSpecDir, type SpecCategory } from '../tools/spec-loader.js';
import { executeAdd } from '../tools/store-knowhow.js';
import { supersedeEntry } from '../tools/spec-conflict-marker.js';
import { supersedeKnowhowEntry } from '../tools/knowhow-lifecycle.js';
import {
  knowledgeReconciliationSchema,
  type KnowledgeCandidateReconciliation,
} from '../knowledge/reconciliation-schema.js';

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
  status: z.enum(['pending', 'promoting', 'promoted', 'rejected']),
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
  skipped_review_required: string[];
  skipped_suppressed: string[];
}

export interface KnowledgeReconciliationCard {
  schema_version: 'knowledge-reconciliation-card/1.0';
  run: {
    unique_inputs: number;
    signals: Record<KnowledgeInputSignal, number>;
    knowledge_ids: string[];
  };
  session: {
    unique_inputs: number;
    pending_candidates: number;
    corroborated_candidates: number;
    promoting_candidates: number;
    promoted_candidates: number;
  };
  policy: {
    search_and_injection: 'exposure_only';
    explicit_load: 'consumed';
    completion: 'stage_candidates';
    promotion: 'explicit_review';
  };
  review: {
    command: string;
    promote_template: string;
  };
  reconciliation?: {
    status: 'missing' | 'fresh' | 'stale';
    duplicates: number;
    conflicts: number;
    review_required: number;
    suppressed: number;
    command: string;
  };
}

export interface KnowledgeCandidateReceipt {
  schema_version: 'knowledge-candidate-receipt/1.0';
  staged_candidate_ids: string[];
  staged_count: number;
  review_command: string;
  promote_template: string;
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

export function runKnowledgeDeltaPath(store: SessionStore, sessionId: string, runId: string): string {
  return join(store.runDir(sessionId, runId), 'knowledge-delta.json');
}

export function knowledgeCandidateId(target: KnowledgeCandidate['target'], content: string): string {
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
): string {
  const id = knowledgeCandidateId(input.target, input.content);
  const existing = draft.candidates.find(candidate => candidate.candidate_id === id);
  if (existing) {
    if (existing.action !== input.action && input.source_kind === 'manual') {
      throw new Error(
        `Candidate ${id} already exists with action ${existing.action}; `
        + `cannot restage the same content as ${input.action}`,
      );
    }
    existing.occurrences++;
    existing.last_recorded_at = now;
    existing.evidence_refs = [...new Set([...existing.evidence_refs, ...input.evidence_refs])];
    return id;
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
  return id;
}

export interface KnowledgeCandidateDraft {
  candidate_id: string;
  target: KnowledgeCandidate['target'];
  action: KnowledgeCandidate['action'];
  title: string;
  content: string;
  category: string | null;
  source_kind: KnowledgeCandidate['source_kind'];
  evidence_refs: string[];
}

/**
 * Project accepted report decisions and locked constraints without mutating the
 * Run ledger. Reconciliation uses this view before completion; the same facts
 * are persisted by stageHandoffKnowledgeCandidates in the completion transaction.
 */
export function reportKnowledgeCandidateDrafts(
  frontmatter: ReportFrontmatter,
  runId: string,
): KnowledgeCandidateDraft[] {
  const evidence = [`run:${runId}`];
  const drafts: KnowledgeCandidateDraft[] = [];
  for (const decision of frontmatter.decisions) {
    const content = decision.text.trim();
    if (decision.status !== 'accepted' || !content) continue;
    drafts.push({
      candidate_id: knowledgeCandidateId('spec', content),
      target: 'spec',
      action: 'propose',
      title: content.slice(0, 120),
      content,
      category: 'arch',
      source_kind: 'decision',
      evidence_refs: evidence,
    });
  }
  for (const constraint of frontmatter.constraints) {
    const content = constraint.text.trim();
    if (constraint.status !== 'locked' || !content) continue;
    drafts.push({
      candidate_id: knowledgeCandidateId('spec', content),
      target: 'spec',
      action: 'propose',
      title: content.slice(0, 120),
      content,
      category: 'arch',
      source_kind: 'constraint',
      evidence_refs: evidence,
    });
  }
  return drafts;
}

export function readRunKnowledgeDelta(
  store: SessionStore,
  sessionId: string,
  runId: string,
  readOnly = false,
): RunKnowledgeDelta {
  const path = runKnowledgeDeltaPath(store, sessionId, runId);
  const fallback = createDelta(sessionId, runId);
  return readOnly
    ? store.readJsonFileReadOnly(path, runKnowledgeDeltaSchema, fallback)
    : store.readJsonFile(path, runKnowledgeDeltaSchema, fallback);
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
    const target = store.findUniqueActiveRun();
    if (!target) return null;
    return recordRunKnowledgeInputs(
      projectRoot,
      target.runId,
      ids,
      signal,
      source,
      target.sessionId,
    );
  } catch {
    return null;
  }
}

/**
 * Record an explicit knowledge relation against one authoritative active Run.
 * Unlike the best-effort load hook, this command-facing surface fails closed.
 */
export function recordRunKnowledgeInputs(
  projectRoot: string,
  runId: string,
  knowledgeIds: string[],
  signal: KnowledgeInputSignal = 'consumed',
  source: z.infer<typeof knowledgeInputSchema>['source'] = 'manual',
  sessionId?: string,
): { session_id: string; run_id: string; recorded: number } {
  const ids = [...new Set(knowledgeIds.map(id => id.trim()).filter(Boolean))];
  if (ids.length === 0) throw new Error('At least one knowledge ID is required');
  const store = new SessionStore(projectRoot);
  const located = store.findRun(runId, sessionId);
  const now = nowIso();
  const path = runKnowledgeDeltaPath(store, located.sessionId, runId);
  return store.updateActiveRunSidecar(
    located.sessionId,
    runId,
    path,
    runKnowledgeDeltaSchema,
    createDelta(located.sessionId, runId, now),
    draft => {
      for (const id of ids) addInput(draft, id, signal, source, now);
      draft.revision++;
      draft.updated_at = now;
      return { session_id: located.sessionId, run_id: runId, recorded: ids.length };
    },
  );
}

export function stageRunKnowledgeCandidate(
  projectRoot: string,
  runId: string,
  input: {
    target: KnowledgeCandidate['target'];
    action?: KnowledgeCandidate['action'];
    title: string;
    content: string;
    category?: string | null;
    evidenceRefs?: string[];
  },
  sessionId?: string,
): { session_id: string; run_id: string; candidate_id: string } {
  const title = input.title.trim();
  const content = input.content.trim();
  if (!title || !content) throw new Error('Knowledge candidate title and content are required');
  const store = new SessionStore(projectRoot);
  const located = store.findRun(runId, sessionId);
  const candidateId = knowledgeCandidateId(input.target, content);
  const prior = summarizeSessionKnowledge(projectRoot, located.sessionId, {
    readOnly: true,
    strict: true,
  }).candidates.find(candidate => candidate.candidate_id === candidateId);
  if (prior && prior.action !== (input.action ?? 'propose')) {
    throw new Error(
      `Candidate ${candidateId} already exists in Session ${located.sessionId} `
      + `with action ${prior.action}; resolve or promote it instead of restaging as `
      + `${input.action ?? 'propose'}`,
    );
  }
  const now = nowIso();
  const path = runKnowledgeDeltaPath(store, located.sessionId, runId);
  return store.updateActiveRunSidecar(
    located.sessionId,
    runId,
    path,
    runKnowledgeDeltaSchema,
    createDelta(located.sessionId, runId, now),
    draft => {
      const candidateId = addCandidate(draft, {
        target: input.target,
        action: input.action ?? 'propose',
        title,
        content,
        category: input.category?.trim() || null,
        source_kind: 'manual',
        evidence_refs: [...new Set([
          `run:${runId}`,
          ...(input.evidenceRefs ?? []).map(ref => ref.trim()).filter(Boolean),
        ])],
      }, now);
      draft.revision++;
      draft.updated_at = now;
      return { session_id: located.sessionId, run_id: runId, candidate_id: candidateId };
    },
  );
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
  const path = runKnowledgeDeltaPath(store, sessionId, run.run_id);
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
  options: { readOnly?: boolean; strict?: boolean } = {},
): SessionKnowledgeSummary {
  const store = new SessionStore(projectRoot);
  if (!store.sessionExists(sessionId)) throw new Error(`Session not found: ${sessionId}`);
  const runsDir = join(store.sessionDir(sessionId), 'runs');
  const runIds = existsSync(runsDir)
    ? readdirSync(runsDir).filter(runId => {
      if (!existsSync(join(store.runDir(sessionId, runId), 'run.json'))) return false;
      try {
        const run = options.readOnly
          ? store.readRunReadOnly(sessionId, runId)
          : store.readRun(sessionId, runId);
        if (run.run_id !== runId) {
          throw new Error(`Run authority mismatch: directory ${runId} contains ${run.run_id}`);
        }
        return true;
      } catch (error) {
        if (options.strict) throw error;
        return false;
      }
    }).sort()
    : [];
  const ledgers = runIds
    .filter(runId => existsSync(runKnowledgeDeltaPath(store, sessionId, runId)))
    .map(runId => readRunKnowledgeDelta(store, sessionId, runId, options.readOnly));

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
        } else if (candidate.status === 'promoting' && existing.status === 'pending') {
          existing.status = 'promoting';
          existing.promoted_id = candidate.promoted_id;
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

export function buildKnowledgeReconciliationCard(
  projectRoot: string,
  sessionId: string,
  runId: string,
): KnowledgeReconciliationCard {
  const store = new SessionStore(projectRoot);
  const delta = readRunKnowledgeDelta(store, sessionId, runId, true);
  const summary = summarizeSessionKnowledge(projectRoot, sessionId, { readOnly: true });
  const runSignals: Record<KnowledgeInputSignal, number> = {
    consumed: 0,
    cited: 0,
    validated: 0,
    contradicted: 0,
  };
  const knowledgeIds = new Set<string>();
  for (const input of delta.inputs) {
    runSignals[input.signal] += input.count;
    knowledgeIds.add(input.knowledge_id);
  }
  const pending = summary.candidates.filter(candidate => candidate.status === 'pending');
  return {
    schema_version: 'knowledge-reconciliation-card/1.0',
    run: {
      unique_inputs: knowledgeIds.size,
      signals: runSignals,
      knowledge_ids: [...knowledgeIds].sort(),
    },
    session: {
      unique_inputs: summary.unique_inputs,
      pending_candidates: pending.length,
      corroborated_candidates: pending.filter(candidate => candidate.stage === 'corroborated').length,
      promoting_candidates: summary.candidates.filter(candidate => candidate.status === 'promoting').length,
      promoted_candidates: summary.candidates.filter(candidate => candidate.status === 'promoted').length,
    },
    policy: {
      search_and_injection: 'exposure_only',
      explicit_load: 'consumed',
      completion: 'stage_candidates',
      promotion: 'explicit_review',
    },
    review: {
      command: `maestro knowledge review ${sessionId}`,
      promote_template: `maestro knowledge promote ${sessionId} --candidate <candidate-id>`,
    },
  };
}

export function knowledgeCandidateReceipt(
  sessionId: string,
  delta: RunKnowledgeDelta | null,
): KnowledgeCandidateReceipt {
  const candidateIds = delta?.candidates.map(candidate => candidate.candidate_id).sort() ?? [];
  return {
    schema_version: 'knowledge-candidate-receipt/1.0',
    staged_candidate_ids: candidateIds,
    staged_count: candidateIds.length,
    review_command: `maestro knowledge review ${sessionId}`,
    promote_template: `maestro knowledge promote ${sessionId} --candidate <candidate-id>`,
  };
}

function specBody(content: string): string {
  return content.replace(/^###\s+.*?(?:\r?\n){1,2}/, '').trim();
}

function safeSpecContent(content: string): string {
  return content.replace(/<(\/?spec-entry\b)/gi, '&lt;$1');
}

function plannedSpecId(candidate: KnowledgeCandidate): string {
  return `S-${candidate.first_recorded_at.slice(0, 10).replace(/-/g, '')}-${candidate.candidate_id.slice(4)}`;
}

function plannedKnowhowId(candidate: KnowledgeCandidate): string {
  const date = candidate.first_recorded_at.slice(0, 10).replace(/-/g, '');
  return `tip-${date}-${candidate.candidate_id.slice(4)}`;
}

function findExistingSpec(
  projectRoot: string,
  title: string,
): { id: string; content: string } | null {
  const specsDir = resolveSpecDir(projectRoot, 'project');
  if (!existsSync(specsDir)) return null;
  for (const file of readdirSync(specsDir).filter(name => name.endsWith('.md')).sort()) {
    const parsed = parseSpecEntries(readFileSync(join(specsDir, file), 'utf8'));
    const entry = parsed.entries.find(item =>
      normalizedText(item.title) === normalizedText(title)
      && item.status !== 'deprecated'
    );
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

function findSpecById(
  projectRoot: string,
  sid: string,
): { id: string; content: string } | null {
  const specsDir = resolveSpecDir(projectRoot, 'project');
  if (!existsSync(specsDir)) return null;
  for (const file of readdirSync(specsDir).filter(name => name.endsWith('.md')).sort()) {
    const entry = parseSpecEntries(readFileSync(join(specsDir, file), 'utf8'))
      .entries.find(item => item.sid === sid);
    if (entry) return { id: sid, content: specBody(entry.content) };
  }
  return null;
}

function promoteSpecCandidate(
  projectRoot: string,
  sessionId: string,
  candidate: KnowledgeCandidate,
  plannedId: string,
  supersessionTarget: string | null,
): { promoted_id: string; outcome: 'created' | 'reaffirmed' } {
  const content = safeSpecContent(candidate.content);
  const plannedExisting = findSpecById(projectRoot, plannedId);
  if (plannedExisting) {
    if (normalizedText(plannedExisting.content) !== normalizedText(content)) {
      throw new Error(
        `Persisted promotion ID ${plannedId} has different content for ${candidate.candidate_id}`,
      );
    }
    return { promoted_id: plannedId, outcome: 'reaffirmed' };
  }
  const existing = findExistingSpec(projectRoot, candidate.title);
  if (existing) {
    if (normalizedText(existing.content) !== normalizedText(content)
      && existing.id !== supersessionTarget) {
      throw new Error(
        `Candidate ${candidate.candidate_id} conflicts with existing spec title "${candidate.title}"; `
        + 'resolve with spec supersede/conflict before promotion',
      );
    }
    if (normalizedText(existing.content) === normalizedText(content)) {
      return { promoted_id: existing.id, outcome: 'reaffirmed' };
    }
  }

  const validCategories: SpecCategory[] = ['coding', 'arch', 'debug', 'test', 'review', 'learning', 'ui'];
  const category = validCategories.includes(candidate.category as SpecCategory)
    ? candidate.category as SpecCategory
    : 'learning';
  const result = appendSpecEntry(
    projectRoot,
    category,
    candidate.title,
    content,
    ['session-knowledge', candidate.source_kind],
    `session:${sessionId}:${candidate.candidate_id}`,
    'project',
    undefined,
    `Promoted from ${candidate.evidence_refs.join(', ')}`,
    plannedId,
    { allowDuplicateTitle: supersessionTarget !== null },
  );
  if (!result.ok || !result.sid) {
    const replay = findExistingSpec(projectRoot, candidate.title);
    if (result.duplicate && replay && normalizedText(replay.content) === normalizedText(content)) {
      return { promoted_id: replay.id, outcome: 'reaffirmed' };
    }
    throw new Error(`Failed to promote spec candidate ${candidate.candidate_id}`);
  }
  return { promoted_id: result.sid, outcome: 'created' };
}

function promoteKnowhowCandidate(
  projectRoot: string,
  candidate: KnowledgeCandidate,
  plannedId: string,
): { promoted_id: string; outcome: 'created' | 'reaffirmed' } {
  const previousRoot = process.env.MAESTRO_PROJECT_ROOT;
  process.env.MAESTRO_PROJECT_ROOT = projectRoot;
  try {
    const response = executeAdd({
      operation: 'add',
      limit: 20,
      id: plannedId,
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

function candidateReconciliationPolicies(
  store: SessionStore,
  sessionId: string,
  candidate: SessionKnowledgeSummary['candidates'][number],
): KnowledgeCandidateReconciliation[] {
  return candidate.run_ids.flatMap(runId => {
    const path = join(store.runDir(sessionId, runId), 'knowledge-reconciliation.json');
    if (!existsSync(path)) return [];
    const receipt = store.readJsonFileReadOnly(path, knowledgeReconciliationSchema, null);
    const policy = receipt?.candidates.find(item => item.candidate_id === candidate.candidate_id);
    return policy ? [policy] : [];
  });
}

function blockingCandidatePolicy(
  policies: KnowledgeCandidateReconciliation[],
): KnowledgeCandidateReconciliation | null {
  return policies.find(policy => policy.promotion_eligibility === 'suppressed')
    ?? policies.find(policy => policy.promotion_eligibility === 'review_required')
    ?? null;
}

function confirmedSupersessionTarget(
  policies: KnowledgeCandidateReconciliation[],
): string | null {
  return policies.find(policy =>
    policy.disposition === 'supersede_candidate'
    && policy.promotion_eligibility === 'eligible'
    && policy.resolution?.status === 'confirmed'
    && policy.canonical_id
  )?.canonical_id ?? null;
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
  const store = new SessionStore(projectRoot);
  const requested = new Set(options.candidateIds ?? []);
  const unknown = [...requested].filter(id => !summary.candidates.some(candidate => candidate.candidate_id === id));
  if (unknown.length > 0) throw new Error(`Unknown candidate IDs: ${unknown.join(', ')}`);

  const policyByCandidate = new Map(summary.candidates.map(candidate => [
    candidate.candidate_id,
    candidateReconciliationPolicies(store, sessionId, candidate),
  ]));
  if (!options.all) {
    const blocked = summary.candidates
      .filter(candidate => requested.has(candidate.candidate_id))
      .map(candidate => ({
        candidate,
        policy: blockingCandidatePolicy(policyByCandidate.get(candidate.candidate_id) ?? []),
      }))
      .find(item => item.policy);
    if (blocked?.policy) {
      throw new Error(
        `Candidate ${blocked.candidate.candidate_id} promotion is ${blocked.policy.promotion_eligibility} `
        + `(${blocked.policy.disposition}); resolve it with 'maestro knowledge resolve' first`,
      );
    }
  }

  const pending = summary.candidates.filter(candidate =>
    candidate.status === 'pending' || candidate.status === 'promoting'
  );
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
  const eligiblePending = options.all
    ? pending.filter(candidate => options.includeObserved || candidate.stage === 'corroborated')
    : pending.filter(candidate => requested.has(candidate.candidate_id));
  const skippedReviewRequired = options.all
    ? eligiblePending
      .filter(candidate => blockingCandidatePolicy(
        policyByCandidate.get(candidate.candidate_id) ?? [],
      )?.promotion_eligibility === 'review_required')
      .map(candidate => candidate.candidate_id)
    : [];
  const skippedSuppressed = options.all
    ? summary.candidates
      .filter(candidate => candidate.status !== 'promoted')
      .filter(candidate => blockingCandidatePolicy(
        policyByCandidate.get(candidate.candidate_id) ?? [],
      )?.promotion_eligibility === 'suppressed')
      .map(candidate => candidate.candidate_id)
    : [];
  const blockedForAll = new Set([...skippedReviewRequired, ...skippedSuppressed]);
  const selected = eligiblePending.filter(candidate => !blockedForAll.has(candidate.candidate_id));
  const skippedObserved = options.all && !options.includeObserved
    ? pending.filter(candidate => candidate.stage === 'observed').map(candidate => candidate.candidate_id)
    : [];
  const unsealedSources = selected.flatMap(candidate =>
    candidate.run_ids
      .filter(runId => store.readRun(sessionId, runId).status !== 'sealed')
      .map(runId => `${candidate.candidate_id}:${runId}`)
  );
  if (unsealedSources.length > 0) {
    throw new Error(
      `Knowledge candidates require sealed source Runs before promotion: ${unsealedSources.join(', ')}`,
    );
  }
  if (selected.length === 0 && alreadyPromoted.length === 0) {
    if (options.all && skippedObserved.length === 0) {
      return {
        schema_version: 'knowledge-promotion-result/1.0',
        session_id: sessionId,
        promoted: [],
        already_promoted: [],
        skipped_observed: [],
        skipped_review_required: skippedReviewRequired,
        skipped_suppressed: skippedSuppressed,
      };
    }
    throw new Error(
      skippedObserved.length > 0
        ? 'No corroborated pending candidates; pass --include-observed or select explicit candidate IDs'
        : 'No pending candidates selected',
    );
  }

  // Preflight every selected spec before recording the promotion intent.
  // This also catches two candidates whose truncated titles collide.
  const selectedSpecTitles = new Map<string, KnowledgeCandidate>();
  for (const candidate of selected.filter(item => item.target === 'spec')) {
    const supersessionTarget = confirmedSupersessionTarget(
      policyByCandidate.get(candidate.candidate_id) ?? [],
    );
    const normalizedTitle = normalizedText(candidate.title);
    const prior = selectedSpecTitles.get(normalizedTitle);
    if (prior && normalizedText(safeSpecContent(prior.content)) !== normalizedText(safeSpecContent(candidate.content))) {
      throw new Error(
        `Candidates ${prior.candidate_id} and ${candidate.candidate_id} conflict on spec title "${candidate.title}"`,
      );
    }
    selectedSpecTitles.set(normalizedTitle, candidate);
    const existing = findExistingSpec(projectRoot, candidate.title);
    if (existing
      && normalizedText(existing.content) !== normalizedText(safeSpecContent(candidate.content))
      && existing.id !== supersessionTarget) {
      throw new Error(
        `Candidate ${candidate.candidate_id} conflicts with existing spec title "${candidate.title}"; `
        + 'resolve with spec supersede/conflict before promotion',
      );
    }
  }

  const plan = selected.map(candidate => {
    const existing = candidate.target === 'spec'
      ? findExistingSpec(projectRoot, candidate.title)
      : null;
    const supersessionTarget = confirmedSupersessionTarget(
      policyByCandidate.get(candidate.candidate_id) ?? [],
    );
    const promotedId = candidate.promoted_id
      ?? (existing && !supersessionTarget ? existing.id : null)
      ?? (candidate.target === 'spec' ? plannedSpecId(candidate) : plannedKnowhowId(candidate));
    return { candidate, promotedId, supersessionTarget };
  });

  // Phase 1: persist deterministic promotion intents before any project write.
  // A crash after this point is resumable because `promoting` candidates remain selectable.
  const intentAt = nowIso();
  store.updateKnowledgeLifecycle(sessionId, (_lifecycle, tx) => {
    for (const runId of new Set(plan.flatMap(item => item.candidate.run_ids))) {
      const delta = readRunKnowledgeDelta(store, sessionId, runId);
      let changed = false;
      for (const candidate of delta.candidates) {
        const item = plan.find(entry => entry.candidate.candidate_id === candidate.candidate_id);
        if (!item || candidate.status === 'promoted') continue;
        candidate.status = 'promoting';
        candidate.promoted_id = item.promotedId;
        changed = true;
      }
      if (changed) {
        delta.revision++;
        delta.updated_at = intentAt;
        tx.writeJson(runKnowledgeDeltaPath(store, sessionId, runId), delta, runKnowledgeDeltaSchema);
      }
    }
  });

  const promoted = plan.map(({ candidate, promotedId, supersessionTarget }) => {
    const result = candidate.target === 'spec'
      ? promoteSpecCandidate(projectRoot, sessionId, candidate, promotedId, supersessionTarget)
      : promoteKnowhowCandidate(projectRoot, candidate, promotedId);
    if (supersessionTarget) {
      const superseded = candidate.target === 'spec'
        ? supersedeEntry(projectRoot, supersessionTarget, result.promoted_id)
        : supersedeKnowhowEntry(projectRoot, supersessionTarget, result.promoted_id);
      if (!superseded.success) {
        throw new Error(
          `Promoted ${candidate.candidate_id}, but failed to supersede ${supersessionTarget}: `
          + (superseded.error ?? 'unknown supersession error'),
        );
      }
    }
    return {
      candidate_id: candidate.candidate_id,
      target: candidate.target,
      promoted_id: result.promoted_id,
      outcome: result.outcome,
    };
  });

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
        tx.writeJson(runKnowledgeDeltaPath(store, sessionId, runId), delta, runKnowledgeDeltaSchema);
      }
    }
  });

  return {
    schema_version: 'knowledge-promotion-result/1.0',
    session_id: sessionId,
    promoted,
    already_promoted: alreadyPromoted,
    skipped_observed: skippedObserved,
    skipped_review_required: skippedReviewRequired,
    skipped_suppressed: skippedSuppressed,
  };
}
