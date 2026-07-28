import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join, relative } from 'node:path';

import { tryDaemonSearch } from '../search/daemon-client.js';
import {
  knowledgeCandidateId,
  promoteSessionKnowledge,
  readRunKnowledgeDelta,
  reportKnowledgeCandidateDrafts,
  runKnowledgeDeltaPath,
  runKnowledgeDeltaSchema,
  summarizeSessionKnowledge,
  type KnowledgeCandidate,
  type KnowledgeCandidateDraft,
  type KnowledgePromotionResult,
  type PromoteSessionKnowledgeOptions,
  type RunKnowledgeDelta,
} from '../run/knowledge.js';
import { readReportFrontmatter } from '../run/report.js';
import type { ReportFrontmatter } from '../run/schemas.js';
import { SessionStore, type StoreTransaction } from '../run/store.js';
import { parseSpecEntries } from '../tools/spec-entry-parser.js';
import { markConflict } from '../tools/spec-conflict-marker.js';
import { knowhowFileToWikiId, parseFrontmatter } from '../utils/frontmatter.js';
import {
  knowledgeCandidateReconciliationSchema,
  knowledgeReconciliationMatchSchema,
  knowledgeReconciliationSchema,
  type KnowledgeCandidateReconciliation,
  type KnowledgeDisposition,
  type KnowledgePromotionEligibility,
  type KnowledgeReconciliation,
} from './reconciliation-schema.js';

export {
  knowledgeCandidateReconciliationSchema,
  knowledgeReconciliationMatchSchema,
  knowledgeReconciliationSchema,
} from './reconciliation-schema.js';
export type {
  KnowledgeCandidateReconciliation,
  KnowledgeDisposition,
  KnowledgePromotionEligibility,
  KnowledgeReconciliation,
} from './reconciliation-schema.js';

interface KnowledgeDocument {
  id: string;
  aliases: string[];
  target: 'spec' | 'knowhow';
  title: string;
  content: string;
  category: string | null;
  status: string;
  confidence: string | null;
  sourcePath: string;
  sourceLine: number | null;
  related: string[];
  supersedes: string[];
  supersededBy: string | null;
}

interface CandidateView {
  candidate_id: string;
  target: KnowledgeCandidate['target'];
  action: KnowledgeCandidate['action'];
  title: string;
  content: string;
  category: string | null;
  source_kind: KnowledgeCandidate['source_kind'];
}

interface ReconcileOptions {
  embeddingScores?: Map<string, Map<string, number>>;
  retrievalMode?: 'lexical-kg' | 'hybrid';
  embeddingUsed?: boolean;
  prior?: KnowledgeReconciliation | null;
}

const MATCH_LIMIT = 12;
const DISCOVERY_LIMIT = 16;
const FAMILY_CAP = 2;

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function normalized(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[“”‘’"'`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function contentHash(value: string): string {
  return sha256(normalized(value));
}

function splitList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map(item => String(item).trim()).filter(Boolean);
  }
  if (typeof value !== 'string') return [];
  return value.split(',').map(item => item.trim()).filter(Boolean);
}

function activeStatus(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : 'active';
}

function isActiveDocument(document: KnowledgeDocument): boolean {
  return document.status !== 'deprecated' && document.status !== 'superseded';
}

function specBody(content: string): string {
  return content.replace(/^###\s+.*?(?:\r?\n){1,2}/, '').trim();
}

function specDocuments(projectRoot: string): KnowledgeDocument[] {
  const dir = join(projectRoot, '.workflow', 'specs');
  if (!existsSync(dir)) return [];
  const documents: KnowledgeDocument[] = [];
  for (const file of readdirSync(dir).filter(name => name.endsWith('.md')).sort()) {
    const filePath = join(dir, file);
    const raw = readFileSync(filePath, 'utf8');
    const parsed = parseSpecEntries(raw);
    const sourcePath = relative(join(projectRoot, '.workflow'), filePath).replaceAll('\\', '/');
    for (const entry of parsed.entries) {
      const id = entry.sid ?? `legacy:${file}:${entry.lineStart}`;
      documents.push({
        id,
        aliases: [...new Set([id, `spec:${id}`])],
        target: 'spec',
        title: entry.title,
        content: specBody(entry.content),
        category: entry.category ?? null,
        status: activeStatus(entry.status),
        confidence: entry.confidence ?? null,
        sourcePath,
        sourceLine: entry.lineStart,
        related: entry.ref ? [entry.ref] : [],
        supersedes: splitList(entry.supersedes),
        supersededBy: entry.supersededBy ?? null,
      });
    }
    for (const entry of parsed.legacy) {
      const id = `legacy:${file}:${entry.lineStart}`;
      documents.push({
        id,
        aliases: [id, `spec:${id}`],
        target: 'spec',
        title: entry.title,
        content: entry.content,
        category: null,
        status: 'active',
        confidence: null,
        sourcePath,
        sourceLine: entry.lineStart,
        related: [],
        supersedes: [],
        supersededBy: null,
      });
    }
  }
  return documents;
}

function knowhowDocuments(projectRoot: string): KnowledgeDocument[] {
  const dir = join(projectRoot, '.workflow', 'knowhow');
  if (!existsSync(dir)) return [];
  const documents: KnowledgeDocument[] = [];
  for (const file of readdirSync(dir).filter(name => name.endsWith('.md')).sort()) {
    const filePath = join(dir, file);
    const raw = readFileSync(filePath, 'utf8');
    const { data, body } = parseFrontmatter(raw);
    const wikiId = knowhowFileToWikiId(file);
    const explicitId = typeof data.id === 'string' ? data.id.trim() : '';
    const id = wikiId;
    documents.push({
      id,
      aliases: [...new Set([
        id,
        ...(explicitId ? [explicitId] : []),
        `knowhow:${id}`,
        ...(explicitId ? [`knowhow:${explicitId}`] : []),
      ])],
      target: 'knowhow',
      title: typeof data.title === 'string' && data.title.trim()
        ? data.title.trim()
        : basename(file, '.md'),
      content: body.trim(),
      category: typeof data.category === 'string'
        ? data.category
        : typeof data.type === 'string' ? data.type : null,
      status: activeStatus(data.status),
      confidence: typeof data.confidence === 'string' ? data.confidence : null,
      sourcePath: relative(join(projectRoot, '.workflow'), filePath).replaceAll('\\', '/'),
      sourceLine: null,
      related: splitList(data.related),
      supersedes: splitList(data.supersedes),
      supersededBy: typeof data.supersededBy === 'string' ? data.supersededBy : null,
    });
  }
  return documents;
}

function loadCorpus(projectRoot: string): KnowledgeDocument[] {
  return [...specDocuments(projectRoot), ...knowhowDocuments(projectRoot)]
    .filter(document => document.title.trim() && document.content.trim())
    .filter(isActiveDocument)
    .sort((left, right) => left.target.localeCompare(right.target) || left.id.localeCompare(right.id));
}

function corpusFingerprint(documents: KnowledgeDocument[]): string {
  return sha256(JSON.stringify(documents.map(document => ({
    id: document.id,
    target: document.target,
    title: normalized(document.title),
    content_hash: contentHash(document.content),
    status: document.status,
    confidence: document.confidence,
    related: [...document.related].sort(),
    supersedes: [...document.supersedes].sort(),
    superseded_by: document.supersededBy,
  }))));
}

function candidateViews(
  delta: RunKnowledgeDelta,
  frontmatter: ReportFrontmatter,
  runId: string,
): CandidateView[] {
  const byId = new Map<string, CandidateView>();
  for (const candidate of delta.candidates) {
    if (candidate.status === 'promoted') continue;
    byId.set(candidate.candidate_id, {
      candidate_id: candidate.candidate_id,
      target: candidate.target,
      action: candidate.action,
      title: candidate.title,
      content: candidate.content,
      category: candidate.category,
      source_kind: candidate.source_kind,
    });
  }
  for (const draft of reportKnowledgeCandidateDrafts(frontmatter, runId)) {
    if (!byId.has(draft.candidate_id)) {
      byId.set(draft.candidate_id, candidateViewFromDraft(draft));
    }
  }
  return [...byId.values()].sort((left, right) => left.candidate_id.localeCompare(right.candidate_id));
}

function candidateViewFromDraft(draft: KnowledgeCandidateDraft): CandidateView {
  return {
    candidate_id: draft.candidate_id,
    target: draft.target,
    action: draft.action,
    title: draft.title,
    content: draft.content,
    category: draft.category,
    source_kind: draft.source_kind,
  };
}

export function knowledgeCandidateSnapshotHash(
  delta: RunKnowledgeDelta,
  frontmatter: ReportFrontmatter,
  runId: string,
): string {
  return sha256(JSON.stringify(candidateViews(delta, frontmatter, runId).map(candidate => ({
    candidate_id: candidate.candidate_id,
    target: candidate.target,
    action: candidate.action,
    title: normalized(candidate.title),
    content: normalized(candidate.content),
    category: candidate.category,
    source_kind: candidate.source_kind,
  }))));
}

function tokens(value: string): Set<string> {
  const text = normalized(value);
  return new Set(text.match(/\p{Script=Han}|[\p{L}\p{N}_-]+/gu) ?? []);
}

function ngrams(value: string, size = 3): Set<string> {
  const text = normalized(value).replace(/\s+/g, '');
  if (!text) return new Set();
  if (text.length <= size) return new Set([text]);
  const result = new Set<string>();
  for (let index = 0; index <= text.length - size; index++) {
    result.add(text.slice(index, index + size));
  }
  return result;
}

function jaccard(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  let overlap = 0;
  for (const item of left) if (right.has(item)) overlap++;
  return overlap / (left.size + right.size - overlap);
}

function dice(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  let overlap = 0;
  for (const item of left) if (right.has(item)) overlap++;
  return (2 * overlap) / (left.size + right.size);
}

function similarity(left: string, right: string): number {
  return Math.min(1, 0.55 * jaccard(tokens(left), tokens(right)) + 0.45 * dice(ngrams(left), ngrams(right)));
}

type Stance = 'positive' | 'negative' | 'unknown';

function stance(value: string): Stance {
  const text = normalized(value);
  const negativePattern = /\b(?:must\s+not|never|forbid(?:den)?|prohibit(?:ed)?)\b|不得|禁止|严禁|不可|不能/gu;
  const negative = negativePattern.test(text);
  const positiveText = text.replace(negativePattern, ' ');
  const positive = /\b(?:must|required?|shall|should|allow(?:ed)?)\b|必须|应当|需要|允许|务必/u.test(positiveText);
  if (negative && !positive) return 'negative';
  if (positive && !negative) return 'positive';
  return 'unknown';
}

function stanceCompatibility(left: string, right: string): number {
  const leftStance = stance(left);
  const rightStance = stance(right);
  if (leftStance === 'unknown' || rightStance === 'unknown') return 0.5;
  return leftStance === rightStance ? 1 : 0;
}

function novelty(candidate: string, existing: string): number {
  const candidateTokens = tokens(candidate);
  if (candidateTokens.size === 0) return 0;
  const existingTokens = tokens(existing);
  let novel = 0;
  for (const token of candidateTokens) if (!existingTokens.has(token)) novel++;
  return novel / candidateTokens.size;
}

function matchesAlias(document: KnowledgeDocument, value: string): boolean {
  const target = normalized(value);
  return document.aliases.some(alias => normalized(alias) === target);
}

function associationDocuments(
  documents: KnowledgeDocument[],
  inputs: RunKnowledgeDelta['inputs'],
): Set<string> {
  const seeds = new Set(inputs.map(input => normalized(input.knowledge_id)));
  const seedDocs = documents.filter(document =>
    document.aliases.some(alias => seeds.has(normalized(alias)))
  );
  const seedAliases = new Set(seedDocs.flatMap(document => [
    ...document.aliases,
    ...document.related,
    ...document.supersedes,
    ...(document.supersededBy ? [document.supersededBy] : []),
  ]).map(normalized));
  return new Set(documents
    .filter(document =>
      document.aliases.some(alias => seedAliases.has(normalized(alias)))
      || document.related.some(value => seedAliases.has(normalized(value)))
      || document.supersedes.some(value => seedAliases.has(normalized(value)))
      || Boolean(document.supersededBy && seedAliases.has(normalized(document.supersededBy)))
    )
    .map(document => document.id));
}

interface ScoredDocument {
  document: KnowledgeDocument;
  lexical: number;
  semantic: number;
  title: number;
  relation: number;
  stance: number;
  composite: number;
  novelty: number;
  exact: boolean;
}

function scoreDocument(
  candidate: CandidateView,
  document: KnowledgeDocument,
  associated: Set<string>,
  embeddingScore: number,
): ScoredDocument {
  const lexical = similarity(candidate.content, document.content);
  const title = similarity(candidate.title, document.title);
  const semantic = Math.max(lexical, embeddingScore);
  const relation = associated.has(document.id) ? 1 : 0;
  const stanceScore = stanceCompatibility(candidate.content, document.content);
  const composite = Math.min(
    1,
    0.2 * title + 0.4 * semantic + 0.25 * lexical + 0.15 * relation,
  );
  return {
    document,
    lexical,
    semantic,
    title,
    relation,
    stance: stanceScore,
    composite,
    novelty: novelty(candidate.content, document.content),
    exact: candidate.target === document.target
      && contentHash(candidate.content) === contentHash(document.content),
  };
}

function family(document: KnowledgeDocument): string {
  return `${document.target}:${document.sourcePath}`;
}

function discoveryPool(scored: ScoredDocument[]): ScoredDocument[] {
  const selected: ScoredDocument[] = [];
  const familyCounts = new Map<string, number>();
  const targetCounts = new Map<KnowledgeDocument['target'], number>();
  for (const item of scored) {
    if (selected.length >= DISCOVERY_LIMIT) break;
    const key = family(item.document);
    const currentFamily = familyCounts.get(key) ?? 0;
    const currentTarget = targetCounts.get(item.document.target) ?? 0;
    if (currentFamily >= FAMILY_CAP || currentTarget >= DISCOVERY_LIMIT / 2) continue;
    selected.push(item);
    familyCounts.set(key, currentFamily + 1);
    targetCounts.set(item.document.target, currentTarget + 1);
  }
  return selected;
}

function relationFor(candidate: CandidateView, item: ScoredDocument): Exclude<KnowledgeDisposition, 'unique'> {
  if (item.exact) return 'exact_duplicate';
  if (candidate.target !== item.document.target) return 'related';
  const sameTitle = normalized(candidate.title) === normalized(item.document.title);
  const oppositeStance = item.stance === 0;
  const sameSubject = Math.max(item.title, item.lexical) >= 0.52;
  if (candidate.action === 'contest' && (sameTitle || item.composite >= 0.42)) return 'potential_conflict';
  if (candidate.action === 'supersede' && (sameTitle || item.composite >= 0.42)) return 'supersede_candidate';
  if (oppositeStance && sameSubject && item.semantic >= 0.58) return 'potential_conflict';
  if (item.composite >= 0.82 && item.novelty <= 0.18 && item.stance >= 0.5) {
    return 'semantic_duplicate';
  }
  if (item.composite >= 0.62 && item.novelty > 0.18 && item.stance >= 0.5) return 'extends';
  return 'related';
}

const relationPriority: Record<Exclude<KnowledgeDisposition, 'unique'>, number> = {
  exact_duplicate: 0,
  potential_conflict: 1,
  supersede_candidate: 2,
  semantic_duplicate: 3,
  extends: 4,
  related: 5,
};

function candidateDisposition(
  candidate: CandidateView,
  matches: KnowledgeCandidateReconciliation['matches'],
): KnowledgeDisposition {
  if (matches.length === 0) return 'unique';
  if (matches.some(match => match.relation === 'exact_duplicate')) return 'exact_duplicate';
  if (candidate.action === 'contest' && matches.some(match => match.relation === 'potential_conflict')) {
    return 'potential_conflict';
  }
  if (candidate.action === 'supersede' && matches.some(match => match.relation === 'supersede_candidate')) {
    return 'supersede_candidate';
  }
  for (const disposition of [
    'potential_conflict',
    'semantic_duplicate',
    'extends',
    'related',
  ] as const) {
    if (matches.some(match => match.relation === disposition)) return disposition;
  }
  return 'unique';
}

function eligibility(disposition: KnowledgeDisposition): KnowledgePromotionEligibility {
  if (disposition === 'exact_duplicate') return 'suppressed';
  if (
    disposition === 'semantic_duplicate'
    || disposition === 'potential_conflict'
    || disposition === 'supersede_candidate'
    || disposition === 'extends'
  ) return 'review_required';
  return 'eligible';
}

function reconcileCandidate(
  candidate: CandidateView,
  documents: KnowledgeDocument[],
  associated: Set<string>,
  embeddingScores: Map<string, number>,
): {
  result: KnowledgeCandidateReconciliation;
  identityCount: number;
  semanticCount: number;
  relationCount: number;
} {
  const scored = documents
    .map(document => scoreDocument(
      candidate,
      document,
      associated,
      embeddingScores.get(document.id) ?? 0,
    ))
    .sort((left, right) =>
      Number(right.exact) - Number(left.exact)
      || right.composite - left.composite
      || right.semantic - left.semantic
      || left.document.id.localeCompare(right.document.id)
    );
  const identity = scored.filter(item =>
    item.exact || normalized(item.document.title) === normalized(candidate.title)
  );
  const semantic = discoveryPool(scored.filter(item => item.composite >= 0.28));
  const related = scored.filter(item => associated.has(item.document.id));
  const pool = new Map<string, ScoredDocument>();
  for (const item of [...identity, ...semantic, ...related]) pool.set(item.document.id, item);
  const matches = [...pool.values()]
    .filter(item =>
      item.exact
      || normalized(item.document.title) === normalized(candidate.title)
      || item.composite >= 0.42
      || item.relation > 0
    )
    .map(item => {
      const relation = relationFor(candidate, item);
      const evidence = [
        ...(item.exact ? ['normalized content hash matches'] : []),
        ...(item.semantic >= 0.58 ? [`semantic similarity ${item.semantic.toFixed(3)}`] : []),
        ...(item.title >= 0.58 ? [`title similarity ${item.title.toFixed(3)}`] : []),
        ...(item.relation > 0 ? ['recorded knowledge or graph relation'] : []),
        ...(item.stance === 0 ? ['opposite normative stance'] : []),
        ...(item.novelty > 0.18 ? [`novel token share ${item.novelty.toFixed(3)}`] : []),
      ];
      return knowledgeReconciliationMatchSchema.parse({
        knowledge_id: item.document.id,
        target: item.document.target,
        title: item.document.title,
        relation,
        scores: {
          lexical: item.lexical,
          semantic: item.semantic,
          title: item.title,
          relation: item.relation,
          stance: item.stance,
          composite: item.composite,
        },
        novelty: item.novelty,
        evidence: evidence.length > 0 ? evidence : ['bounded semantic neighborhood'],
        target_content_hash: contentHash(item.document.content),
        source_path: item.document.sourcePath,
        source_line: item.document.sourceLine,
      });
    })
    .sort((left, right) =>
      relationPriority[left.relation] - relationPriority[right.relation]
      || right.scores.composite - left.scores.composite
      || left.knowledge_id.localeCompare(right.knowledge_id)
    )
    .slice(0, MATCH_LIMIT);
  const disposition = candidateDisposition(candidate, matches);
  const canonical = matches.find(match => match.relation === disposition) ?? matches[0] ?? null;
  return {
    result: knowledgeCandidateReconciliationSchema.parse({
      candidate_id: candidate.candidate_id,
      disposition,
      promotion_eligibility: eligibility(disposition),
      canonical_id: canonical?.knowledge_id ?? null,
      matches,
      resolution: disposition === 'exact_duplicate'
        ? {
            status: 'automatic',
            reason: 'normalized content hash matches active project knowledge',
            resolved_at: new Date().toISOString(),
          }
        : null,
    }),
    identityCount: identity.length,
    semanticCount: semantic.length,
    relationCount: related.length,
  };
}

function countReceipt(candidates: KnowledgeCandidateReconciliation[]): KnowledgeReconciliation['counts'] {
  return {
    candidates: candidates.length,
    unique: candidates.filter(candidate => candidate.disposition === 'unique').length,
    duplicates: candidates.filter(candidate =>
      candidate.disposition === 'exact_duplicate' || candidate.disposition === 'semantic_duplicate'
    ).length,
    related: candidates.filter(candidate =>
      candidate.disposition === 'related' || candidate.disposition === 'extends'
    ).length,
    conflicts: candidates.filter(candidate => candidate.disposition === 'potential_conflict').length,
    review_required: candidates.filter(candidate => candidate.promotion_eligibility === 'review_required').length,
    suppressed: candidates.filter(candidate => candidate.promotion_eligibility === 'suppressed').length,
  };
}

export function reconciliationPath(store: SessionStore, sessionId: string, runId: string): string {
  return join(store.runDir(sessionId, runId), 'knowledge-reconciliation.json');
}

export function readKnowledgeReconciliation(
  store: SessionStore,
  sessionId: string,
  runId: string,
  readOnly = false,
): KnowledgeReconciliation | null {
  const path = reconciliationPath(store, sessionId, runId);
  if (!existsSync(path)) return null;
  return readOnly
    ? store.readJsonFileReadOnly(path, knowledgeReconciliationSchema, null)
    : store.readJsonFile(path, knowledgeReconciliationSchema, null);
}

export function reconcileRunKnowledgeSync(
  projectRoot: string,
  sessionId: string,
  runId: string,
  frontmatter: ReportFrontmatter,
  options: ReconcileOptions = {},
): KnowledgeReconciliation {
  const store = new SessionStore(projectRoot);
  const delta = readRunKnowledgeDelta(store, sessionId, runId, true);
  const documents = loadCorpus(projectRoot);
  const candidates = candidateViews(delta, frontmatter, runId);
  const associated = associationDocuments(documents, delta.inputs);
  let identityDocuments = 0;
  let semanticDocuments = 0;
  let relationDocuments = 0;
  const results = candidates.map(candidate => {
    const reconciled = reconcileCandidate(
      candidate,
      documents,
      associated,
      options.embeddingScores?.get(candidate.candidate_id) ?? new Map(),
    );
    identityDocuments += reconciled.identityCount;
    semanticDocuments += reconciled.semanticCount;
    relationDocuments += reconciled.relationCount;
    return reconciled.result;
  });
  return knowledgeReconciliationSchema.parse({
    schema_version: 'knowledge-reconciliation/1.0',
    session_id: sessionId,
    run_id: runId,
    candidate_snapshot_hash: knowledgeCandidateSnapshotHash(delta, frontmatter, runId),
    corpus_fingerprint: corpusFingerprint(documents),
    matcher_revision: 'semantic-delta/1.0',
    generated_at: new Date().toISOString(),
    retrieval: {
      mode: options.retrievalMode ?? 'lexical-kg',
      embedding_used: options.embeddingUsed ?? false,
      candidate_limit: DISCOVERY_LIMIT + MATCH_LIMIT,
      identity_documents: identityDocuments,
      semantic_documents: semanticDocuments,
      relation_documents: relationDocuments,
    },
    counts: countReceipt(results),
    candidates: results,
  });
}

function daemonDocument(
  entry: { id: string; type: string; title: string; body: string; ext?: Record<string, unknown>; source?: { path?: string } },
  documents: KnowledgeDocument[],
): KnowledgeDocument | null {
  const sid = typeof entry.ext?.sid === 'string' ? entry.ext.sid : null;
  if (sid) {
    const direct = documents.find(document => matchesAlias(document, sid));
    if (direct) return direct;
  }
  const byId = documents.find(document => matchesAlias(document, entry.id));
  if (byId) return byId;
  return documents.find(document =>
    document.target === entry.type
    && normalized(document.title) === normalized(entry.title)
    && (
      !entry.source?.path
      || document.sourcePath === entry.source.path
      || contentHash(document.content) === contentHash(entry.body)
    )
  ) ?? null;
}

export async function reconcileRunKnowledge(
  projectRoot: string,
  sessionId: string,
  runId: string,
  options: { timeoutMs?: number } = {},
): Promise<KnowledgeReconciliation> {
  const store = new SessionStore(projectRoot);
  const frontmatter = readReportFrontmatter(store.runDir(sessionId, runId));
  const delta = readRunKnowledgeDelta(store, sessionId, runId, true);
  const documents = loadCorpus(projectRoot);
  const candidates = candidateViews(delta, frontmatter, runId);
  const embeddingScores = new Map<string, Map<string, number>>();
  let embeddingUsed = false;
  for (const candidate of candidates) {
    const response = await tryDaemonSearch(
      join(projectRoot, '.workflow'),
      `${candidate.title}\n${candidate.content}`,
      DISCOVERY_LIMIT * 2,
      false,
      { timeoutMs: options.timeoutMs ?? 1500 },
    );
    if (!response?.ok || !response.results) break;
    embeddingUsed ||= response.embeddingUsed === true;
    const max = Math.max(...response.results.map(item => item.score), Number.EPSILON);
    const scores = new Map<string, number>();
    for (const item of response.results) {
      if (item.entry.type !== 'spec' && item.entry.type !== 'knowhow') continue;
      if (item.entry.source.workspace) continue;
      const document = daemonDocument(item.entry, documents);
      if (!document) continue;
      scores.set(document.id, Math.max(scores.get(document.id) ?? 0, Math.min(1, item.score / max)));
    }
    embeddingScores.set(candidate.candidate_id, scores);
  }
  return reconcileRunKnowledgeSync(projectRoot, sessionId, runId, frontmatter, {
    embeddingScores,
    embeddingUsed,
    retrievalMode: embeddingUsed ? 'hybrid' : 'lexical-kg',
  });
}

export function isKnowledgeReconciliationFresh(
  projectRoot: string,
  sessionId: string,
  runId: string,
  receipt: KnowledgeReconciliation,
  frontmatter: ReportFrontmatter,
): boolean {
  const store = new SessionStore(projectRoot);
  const delta = readRunKnowledgeDelta(store, sessionId, runId, true);
  return receipt.session_id === sessionId
    && receipt.run_id === runId
    && receipt.candidate_snapshot_hash === knowledgeCandidateSnapshotHash(delta, frontmatter, runId)
    && receipt.corpus_fingerprint === corpusFingerprint(loadCorpus(projectRoot));
}

export function ensureKnowledgeReconciliation(
  projectRoot: string,
  sessionId: string,
  runId: string,
  frontmatter: ReportFrontmatter,
): KnowledgeReconciliation {
  const store = new SessionStore(projectRoot);
  const existing = readKnowledgeReconciliation(store, sessionId, runId, true);
  if (existing && isKnowledgeReconciliationFresh(
    projectRoot,
    sessionId,
    runId,
    existing,
    frontmatter,
  )) return existing;
  return reconcileRunKnowledgeSync(projectRoot, sessionId, runId, frontmatter);
}

export function writeKnowledgeReconciliation(
  store: SessionStore,
  tx: StoreTransaction,
  receipt: KnowledgeReconciliation,
): void {
  tx.writeJson(
    reconciliationPath(store, receipt.session_id, receipt.run_id),
    receipt,
    knowledgeReconciliationSchema,
  );
}

export function persistActiveKnowledgeReconciliation(
  projectRoot: string,
  receipt: KnowledgeReconciliation,
): void {
  const store = new SessionStore(projectRoot);
  store.writeActiveRunSidecar(
    receipt.session_id,
    receipt.run_id,
    reconciliationPath(store, receipt.session_id, receipt.run_id),
    receipt,
    knowledgeReconciliationSchema,
  );
}

export function persistKnowledgeReconciliation(
  projectRoot: string,
  receipt: KnowledgeReconciliation,
): void {
  const store = new SessionStore(projectRoot);
  store.readRun(receipt.session_id, receipt.run_id);
  store.updateKnowledgeLifecycle(receipt.session_id, (_lifecycle, tx) => {
    writeKnowledgeReconciliation(store, tx, receipt);
  });
}

/**
 * Refresh every source receipt before invoking the lower-level promotion
 * transaction. A corpus change invalidates prior human resolution and forces
 * review again instead of silently promoting against stale evidence.
 */
export function promoteReconciledSessionKnowledge(
  projectRoot: string,
  sessionId: string,
  options: PromoteSessionKnowledgeOptions,
): KnowledgePromotionResult {
  const store = new SessionStore(projectRoot);
  const summary = summarizeSessionKnowledge(projectRoot, sessionId, {
    readOnly: true,
    strict: true,
  });
  const requested = new Set(options.candidateIds ?? []);
  const recovering = summary.candidates.filter(candidate =>
    candidate.status === 'promoting'
    && candidate.promoted_id
    && (
      requested.has(candidate.candidate_id)
      || (
        options.all
        && (options.includeObserved || candidate.stage === 'corroborated')
      )
    )
  );
  if (recovering.length > 0) {
    const recovered = promoteSessionKnowledge(projectRoot, sessionId, {
      candidateIds: recovering.map(candidate => candidate.candidate_id),
    });
    const remaining = promoteReconciledSessionKnowledge(projectRoot, sessionId, options);
    const recoveredIds = new Set(recovered.promoted.map(item => item.candidate_id));
    return {
      ...remaining,
      promoted: [...recovered.promoted, ...remaining.promoted],
      already_promoted: remaining.already_promoted
        .filter(item => !recoveredIds.has(item.candidate_id)),
    };
  }
  const runIds = [...new Set(summary.candidates.flatMap(candidate => candidate.run_ids))].sort();
  for (const runId of runIds) {
    const frontmatter = readReportFrontmatter(store.runDir(sessionId, runId));
    const receipt = ensureKnowledgeReconciliation(
      projectRoot,
      sessionId,
      runId,
      frontmatter,
    );
    persistKnowledgeReconciliation(projectRoot, receipt);
  }
  return promoteSessionKnowledge(projectRoot, sessionId, options);
}

export type KnowledgeResolutionChoice = 'duplicate' | 'related' | 'conflict' | 'supersede' | 'unique';

export interface ResolveKnowledgeCandidateResult {
  schema_version: 'knowledge-resolution-result/1.0';
  session_id: string;
  candidate_id: string;
  disposition: KnowledgeDisposition;
  promotion_eligibility: KnowledgePromotionEligibility;
  canonical_id: string | null;
  affected_runs: string[];
  conflict_marked: boolean;
}

function resolutionState(
  choice: KnowledgeResolutionChoice,
): {
  disposition: KnowledgeDisposition;
  promotionEligibility: KnowledgePromotionEligibility;
  rejectCandidate: boolean;
} {
  switch (choice) {
    case 'duplicate':
      return { disposition: 'semantic_duplicate', promotionEligibility: 'suppressed', rejectCandidate: true };
    case 'related':
      return { disposition: 'related', promotionEligibility: 'eligible', rejectCandidate: false };
    case 'conflict':
      return { disposition: 'potential_conflict', promotionEligibility: 'suppressed', rejectCandidate: true };
    case 'supersede':
      return { disposition: 'supersede_candidate', promotionEligibility: 'eligible', rejectCandidate: false };
    case 'unique':
      return { disposition: 'unique', promotionEligibility: 'eligible', rejectCandidate: false };
  }
}

export function resolveKnowledgeCandidate(
  projectRoot: string,
  sessionId: string,
  candidateId: string,
  choice: KnowledgeResolutionChoice,
  options: { targetId?: string; reason: string },
): ResolveKnowledgeCandidateResult {
  const reason = options.reason.trim();
  if (!reason) throw new Error('Knowledge resolution requires a non-empty reason');
  const summary = summarizeSessionKnowledge(projectRoot, sessionId, { readOnly: true, strict: true });
  const candidate = summary.candidates.find(item => item.candidate_id === candidateId);
  if (!candidate) throw new Error(`Unknown candidate ID: ${candidateId}`);
  const store = new SessionStore(projectRoot);
  const receipts = candidate.run_ids.map(runId => ({
    runId,
    receipt: readKnowledgeReconciliation(store, sessionId, runId, true),
  }));
  if (receipts.some(item => !item.receipt)) {
    throw new Error(`Candidate ${candidateId} has a source Run without reconciliation`);
  }
  const staleRuns = receipts
    .filter(item => !isKnowledgeReconciliationFresh(
      projectRoot,
      sessionId,
      item.runId,
      item.receipt!,
      readReportFrontmatter(store.runDir(sessionId, item.runId)),
    ))
    .map(item => item.runId);
  if (staleRuns.length > 0) {
    throw new Error(
      `Candidate ${candidateId} has stale reconciliation on Run(s): ${staleRuns.join(', ')}; `
      + 'run maestro knowledge reconcile for each Run before resolving',
    );
  }
  const existingCandidates = receipts.map(item => ({
    runId: item.runId,
    receipt: item.receipt!,
    candidate: item.receipt!.candidates.find(entry => entry.candidate_id === candidateId),
  }));
  if (existingCandidates.some(item => !item.candidate)) {
    throw new Error(`Candidate ${candidateId} is missing from a reconciliation receipt`);
  }
  if (choice === 'unique' && options.targetId?.trim()) {
    throw new Error('--target is not valid for unique resolution');
  }
  const targetRequired = choice !== 'unique';
  const targetId = choice === 'unique'
    ? null
    : options.targetId?.trim()
      || existingCandidates.map(item => item.candidate!.canonical_id).find(Boolean)
      || null;
  if (targetRequired && !targetId) throw new Error(`--target is required for ${choice} resolution`);
  const targetMatch = targetId
    ? existingCandidates
      .flatMap(item => item.candidate!.matches)
      .find(match => match.knowledge_id === targetId)
    : null;
  if (targetId && !targetMatch) {
    throw new Error(`Resolution target ${targetId} is not an evidence-backed match for ${candidateId}`);
  }
  if (choice === 'supersede' && targetMatch?.target !== candidate.target) {
    throw new Error('Supersession requires candidate and target to use the same knowledge store');
  }

  let conflictMarked = false;
  if (choice === 'conflict' && targetMatch?.target === 'spec' && targetMatch.source_line !== null) {
    const file = basename(targetMatch.source_path);
    const marked = markConflict(projectRoot, file, targetMatch.source_line, {
      note: `Knowledge candidate ${candidateId}: ${reason}`,
      confidence: 'contested',
    });
    if (!marked.success) throw new Error(marked.error ?? `Failed to mark conflict on ${targetId}`);
    conflictMarked = true;
  }

  const state = resolutionState(choice);
  const resolvedAt = new Date().toISOString();
  const nextCorpusFingerprint = corpusFingerprint(loadCorpus(projectRoot));
  store.updateKnowledgeLifecycle(sessionId, (_lifecycle, tx) => {
    for (const item of existingCandidates) {
      const receipt = structuredClone(item.receipt);
      const entry = receipt.candidates.find(value => value.candidate_id === candidateId)!;
      entry.disposition = state.disposition;
      entry.promotion_eligibility = state.promotionEligibility;
      entry.canonical_id = targetId;
      entry.resolution = {
        status: 'confirmed',
        reason,
        resolved_at: resolvedAt,
      };
      receipt.corpus_fingerprint = nextCorpusFingerprint;
      receipt.counts = countReceipt(receipt.candidates);
      writeKnowledgeReconciliation(store, tx, receipt);

      const delta = readRunKnowledgeDelta(store, sessionId, item.runId);
      const ledgerCandidate = delta.candidates.find(value => value.candidate_id === candidateId);
      if (ledgerCandidate) {
        if (state.rejectCandidate && ledgerCandidate.status === 'pending') {
          ledgerCandidate.status = 'rejected';
        } else if (!state.rejectCandidate && ledgerCandidate.status === 'rejected') {
          ledgerCandidate.status = 'pending';
        }
        delta.revision++;
        delta.updated_at = resolvedAt;
        tx.writeJson(
          runKnowledgeDeltaPath(store, sessionId, item.runId),
          delta,
          runKnowledgeDeltaSchema,
        );
      }
    }
  });

  return {
    schema_version: 'knowledge-resolution-result/1.0',
    session_id: sessionId,
    candidate_id: candidateId,
    disposition: state.disposition,
    promotion_eligibility: state.promotionEligibility,
    canonical_id: targetId,
    affected_runs: candidate.run_ids,
    conflict_marked: conflictMarked,
  };
}

export function reconciliationForCandidate(
  projectRoot: string,
  sessionId: string,
  runIds: string[],
  candidateId: string,
): KnowledgeCandidateReconciliation[] {
  const store = new SessionStore(projectRoot);
  return runIds.flatMap(runId => {
    const receipt = readKnowledgeReconciliation(store, sessionId, runId, true);
    const candidate = receipt?.candidates.find(item => item.candidate_id === candidateId);
    return candidate ? [candidate] : [];
  });
}

export function applyAutomaticKnowledgeSuppression(
  delta: RunKnowledgeDelta | null,
  receipt: KnowledgeReconciliation,
): void {
  if (!delta) return;
  const suppressed = new Set(receipt.candidates
    .filter(candidate =>
      candidate.disposition === 'exact_duplicate'
      && candidate.promotion_eligibility === 'suppressed'
    )
    .map(candidate => candidate.candidate_id));
  for (const candidate of delta.candidates) {
    if (suppressed.has(candidate.candidate_id) && candidate.status === 'pending') {
      candidate.status = 'rejected';
    }
  }
}

export function reconciliationSummary(receipt: KnowledgeReconciliation): {
  schema_version: 'knowledge-reconciliation-receipt/1.0';
  candidate_snapshot_hash: string;
  corpus_fingerprint: string;
  retrieval_mode: 'lexical-kg' | 'hybrid';
  candidates: number;
  duplicates: number;
  conflicts: number;
  review_required: number;
  suppressed: number;
  review_command: string;
} {
  return {
    schema_version: 'knowledge-reconciliation-receipt/1.0',
    candidate_snapshot_hash: receipt.candidate_snapshot_hash,
    corpus_fingerprint: receipt.corpus_fingerprint,
    retrieval_mode: receipt.retrieval.mode,
    candidates: receipt.counts.candidates,
    duplicates: receipt.counts.duplicates,
    conflicts: receipt.counts.conflicts,
    review_required: receipt.counts.review_required,
    suppressed: receipt.counts.suppressed,
    review_command: `maestro knowledge session ${receipt.session_id}`,
  };
}

export function projectedCandidateId(target: 'spec' | 'knowhow', content: string): string {
  return knowledgeCandidateId(target, content);
}
