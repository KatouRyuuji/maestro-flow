import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { z } from 'zod';

import { artifactRegistrySchema, type ArtifactRegistry, type CommandRun, type ReportFrontmatter, type SessionStateV30 } from './schemas.js';
import {
  SessionStore,
  type ExecutionRunSidecarAuthority,
  type StoreTransaction,
} from './store.js';
import { formatNewEntry, parseSpecEntries } from '../tools/spec-entry-parser.js';
import { appendSpecEntry } from '../tools/spec-writer.js';
import { CATEGORY_MAP, resolveSpecDir, type SpecCategory } from '../tools/spec-loader.js';
import { executeAdd } from '../tools/store-knowhow.js';
import { supersedeEntry } from '../tools/spec-conflict-marker.js';
import { supersedeKnowhowEntry } from '../tools/knowhow-lifecycle.js';
import { findSeedByFilename, renderSeedContent } from '../tools/spec-seeds.js';
import {
  escapeYamlValue,
  generateKnowhowFilename,
  normalizeKnowhowBody,
  parseFrontmatter,
} from '../utils/frontmatter.js';
import { hashDirectory, readVerifiedContainedFile } from './artifacts.js';
import {
  parseTranscriptUri,
  quoteSha256,
  transcriptEvidenceSnapshotSchema,
} from './transcript-evidence.js';
import {
  knowledgeReconciliationSchema,
  type KnowledgeCandidateReconciliation,
  type KnowledgeReconciliation,
} from '../knowledge/reconciliation-schema.js';

const nonEmptyString = z.string().min(1);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export const sessionKnowledgeEvidenceRootSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('file'),
    ref: nonEmptyString,
    path: nonEmptyString,
    anchor: nonEmptyString.nullable(),
    content_hash: sha256Schema,
    size: z.number().int().nonnegative(),
  }).strict(),
  z.object({
    kind: z.literal('run'),
    ref: nonEmptyString,
    run_id: nonEmptyString,
    path: nonEmptyString,
    content_hash: sha256Schema,
    size: z.number().int().nonnegative(),
  }).strict(),
  z.object({
    kind: z.literal('artifact'),
    ref: nonEmptyString,
    artifact_id: nonEmptyString,
    path: nonEmptyString,
    content_hash: sha256Schema,
    size: z.number().int().nonnegative(),
  }).strict(),
  z.object({
    kind: z.literal('inline'),
    ref: nonEmptyString,
    encoding: z.literal('utf8'),
    content: nonEmptyString,
    content_hash: sha256Schema,
    size: z.number().int().nonnegative(),
  }).strict(),
  z.object({
    kind: z.literal('transcript'),
    ref: nonEmptyString,
    path: nonEmptyString,
    content_hash: sha256Schema,
    size: z.number().int().nonnegative(),
  }).strict(),
]);

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
  /** Optional evidence anchors (artifact/output/test refs) for high-value signals. */
  evidence: z.array(nonEmptyString).optional(),
}).strict();

export const sessionKnowledgeCandidateSourceSchema = z.object({
  schema_version: z.literal('session-knowledge-candidate-source/1.0'),
  candidate_version: z.literal(1),
  session_id: nonEmptyString,
  observed_activity_revision: z.number().int().nonnegative(),
  content_hash: sha256Schema,
  evidence_roots: z.array(nonEmptyString).min(1),
  evidence_root_hash: sha256Schema,
  /** Additive typed content addresses; absent only on legacy snapshots. */
  evidence_root_descriptors: z.array(sessionKnowledgeEvidenceRootSchema).min(1).optional(),
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
  /** Immutable source binding for newly staged origin=session candidates. */
  source_snapshot: sessionKnowledgeCandidateSourceSchema.optional(),
}).strict();

export type KnowledgeInputSource = z.infer<typeof knowledgeInputSchema>['source'];
export type KnowledgeInput = z.infer<typeof knowledgeInputSchema>;

/**
 * Minimal ledger surface shared by run and session knowledge deltas, so
 * input/candidate append logic stays single-sourced (session delta reuse).
 */
export interface KnowledgeLedgerDraft {
  inputs: KnowledgeInput[];
  candidates: KnowledgeCandidate[];
}

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

/**
 * Session-level knowledge ledger (origin=session). Separate schema family on
 * purpose: run-knowledge-delta/1.0 is strict() and frozen byte-for-byte for
 * backward compatibility with deployed CLIs (see knowledge-session-decoupling-mvp.md S1).
 */
export const sessionKnowledgeDeltaSchema = z.object({
  schema_version: z.literal('session-knowledge-delta/1.0'),
  session_id: nonEmptyString,
  revision: z.number().int().nonnegative(),
  created_at: nonEmptyString,
  updated_at: nonEmptyString,
  inputs: z.array(knowledgeInputSchema),
  candidates: z.array(knowledgeCandidateSchema),
}).strict();

export type RunKnowledgeDelta = z.infer<typeof runKnowledgeDeltaSchema>;
export type SessionKnowledgeDelta = z.infer<typeof sessionKnowledgeDeltaSchema>;
export type KnowledgeCandidate = z.infer<typeof knowledgeCandidateSchema>;
export type SessionKnowledgeCandidateSource = z.infer<typeof sessionKnowledgeCandidateSourceSchema>;
export type SessionKnowledgeEvidenceRoot = z.infer<typeof sessionKnowledgeEvidenceRootSchema>;
export type KnowledgeInputSignal = z.infer<typeof knowledgeInputSignalSchema>;

export interface SessionKnowledgeSummary {
  schema_version: 'session-knowledge-summary/1.0';
  session_id: string;
  run_count: number;
  ledger_count: number;
  input_totals: Record<KnowledgeInputSignal, number>;
  /** Signal totals broken down by attribution source (load/search/injection/manual). */
  input_totals_by_source: Record<KnowledgeInputSource, Record<KnowledgeInputSignal, number>>;
  /** Knowledge-id-level attribution detail, in ledger order. */
  inputs: Array<{
    run_id: string;
    /** Origin of the attribution ledger ('session' for session-level deltas). */
    origin?: 'run' | 'session';
    knowledge_id: string;
    signal: KnowledgeInputSignal;
    source: KnowledgeInputSource;
    count: number;
    evidence?: string[];
  }>;
  unique_inputs: number;
  candidates: Array<KnowledgeCandidate & {
    run_ids: string[];
    /** Origin of the candidate ledger ('session' for session-level deltas). */
    origin?: 'run' | 'session';
    stage: 'observed' | 'corroborated';
  }>;
}

export interface PromoteSessionKnowledgeOptions {
  candidateIds?: string[];
  all?: boolean;
  /** Internal deterministic interleaving hook used by focused CAS tests. */
  _beforeFinalSessionValidation?: () => void;
  /** Wrapper-supplied corpus/receipt validator, executed under the final store lock. */
  _finalSessionValidation?: (store: SessionStore) => void;
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
    record: 'explicit_attribution';
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

export function createSessionDelta(sessionId: string, now: string = nowIso()): SessionKnowledgeDelta {
  return {
    schema_version: 'session-knowledge-delta/1.0',
    session_id: sessionId,
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

export function sessionKnowledgeDeltaPath(store: SessionStore, sessionId: string): string {
  return join(store.sessionDir(sessionId), 'knowledge-delta.json');
}

export function readSessionKnowledgeDelta(
  store: SessionStore,
  sessionId: string,
  readOnly = false,
): SessionKnowledgeDelta {
  const path = sessionKnowledgeDeltaPath(store, sessionId);
  const fallback = createSessionDelta(sessionId);
  return readOnly
    ? store.readJsonFileReadOnly(path, sessionKnowledgeDeltaSchema, fallback)
    : store.readJsonFile(path, sessionKnowledgeDeltaSchema, fallback);
}

// ---------------------------------------------------------------------------
// Session-level reconciliation receipt (origin=session governance gate).
// Reuses knowledge-reconciliation/1.0 with the run_id sentinel 'session';
// the receipt lives at the Session directory, never inside a run directory,
// so run-scoped readers never encounter it (byte-compat with deployed CLIs).
// ---------------------------------------------------------------------------

export const SESSION_RECONCILIATION_RUN_ID = 'session';

export function sessionReconciliationPath(store: SessionStore, sessionId: string): string {
  return join(store.sessionDir(sessionId), 'knowledge-reconciliation.json');
}

export function readSessionKnowledgeReconciliation(
  store: SessionStore,
  sessionId: string,
  readOnly = false,
): KnowledgeReconciliation | null {
  const path = sessionReconciliationPath(store, sessionId);
  if (!existsSync(path)) return null;
  return readOnly
    ? store.readJsonFileReadOnly(path, knowledgeReconciliationSchema, null)
    : store.readJsonFile(path, knowledgeReconciliationSchema, null);
}

/**
 * Snapshot hash over pending session-ledger candidates; the session receipt's
 * freshness anchor (mirrors knowledgeCandidateSnapshotHash for run deltas).
 */
export function sessionKnowledgeSnapshotHash(delta: SessionKnowledgeDelta): string {
  const views = delta.candidates
    .filter(candidate => candidate.status !== 'promoted')
    .map(candidate => ({
      candidate_id: candidate.candidate_id,
      target: candidate.target,
      action: candidate.action,
      title: normalizedText(candidate.title),
      content: normalizedText(candidate.content),
      category: candidate.category,
      source_kind: candidate.source_kind,
      evidence_roots: normalizeKnowledgeEvidenceRoots(candidate.evidence_refs),
      source_snapshot: candidate.source_snapshot ?? null,
    }))
    .sort((left, right) => left.candidate_id.localeCompare(right.candidate_id));
  return createHash('sha256').update(JSON.stringify(views)).digest('hex');
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

export function knowledgeCandidateContentHash(value: string): string {
  return contentHash(value);
}

export function normalizeKnowledgeEvidenceRoots(refs: readonly string[]): string[] {
  return [...new Set(refs
    .map(ref => ref.normalize('NFKC').trim().replaceAll('\\', '/').replace(/\s+/g, ' '))
    .filter(Boolean))]
    .sort();
}

export function knowledgeEvidenceRootHash(refs: readonly string[]): string {
  return createHash('sha256')
    .update(JSON.stringify(normalizeKnowledgeEvidenceRoots(refs)))
    .digest('hex');
}

function evidenceDescriptorHash(descriptors: readonly SessionKnowledgeEvidenceRoot[]): string {
  return createHash('sha256').update(JSON.stringify(descriptors)).digest('hex');
}

function rawHash(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function projectRelativePath(projectRoot: string, absolutePath: string): string {
  const path = relative(resolve(projectRoot), absolutePath).replaceAll('\\', '/');
  if (!path || path === '.' || path.startsWith('../') || isAbsolute(path)) {
    throw new Error(`Evidence path escapes the project root: ${absolutePath}`);
  }
  return path;
}

function splitFileEvidenceRef(
  projectRoot: string,
  ref: string,
): { path: string; anchor: string | null } {
  const exact = resolve(projectRoot, ref);
  if (existsSync(exact)) return { path: ref, anchor: null };
  const hashAnchor = ref.match(/^(.*?)(#.+)$/);
  if (hashAnchor) return { path: hashAnchor[1], anchor: hashAnchor[2] };
  const lineAnchor = ref.match(/^(.*?)(:\d+(?::\d+)?)$/);
  if (lineAnchor) return { path: lineAnchor[1], anchor: lineAnchor[2] };
  return { path: ref, anchor: null };
}

function resolveTranscriptEvidenceRoot(
  projectRoot: string,
  store: SessionStore,
  sessionId: string,
  ref: string,
): SessionKnowledgeEvidenceRoot | null {
  const parsed = parseTranscriptUri(ref);
  if (!parsed) return null;
  const dir = join(store.sessionDir(sessionId), 'transcript-evidence');
  if (!existsSync(dir)) throw new Error(`Unresolved transcript evidence: ${ref}`);
  const matches = readdirSync(dir)
    .filter(name => name.endsWith('.json'))
    .map(name => {
      const path = join(dir, name);
      const snapshot = store.readJsonFileReadOnly(path, transcriptEvidenceSnapshotSchema);
      return { path, snapshot };
    })
    .filter(({ snapshot }) => snapshot.host_kind === parsed.hostKind
      && snapshot.host_session_id === parsed.hostSessionId
      && snapshot.entry_id === parsed.entryId
      && snapshot.sha256.startsWith(parsed.sha256Prefix));
  if (matches.length !== 1) {
    throw new Error(`Transcript evidence must resolve to exactly one immutable snapshot: ${ref}`);
  }
  const { path, snapshot } = matches[0];
  if (quoteSha256(snapshot.quote) !== snapshot.normalized_sha256) {
    throw new Error(`Transcript evidence snapshot bytes changed: ${ref}`);
  }
  return {
    kind: 'transcript',
    ref,
    path: projectRelativePath(projectRoot, path),
    content_hash: snapshot.normalized_sha256,
    size: Buffer.byteLength(snapshot.quote, 'utf8'),
  };
}

export function resolveSessionKnowledgeEvidenceRoots(
  projectRoot: string,
  store: SessionStore,
  sessionId: string,
  refs: readonly string[],
): SessionKnowledgeEvidenceRoot[] {
  const normalizedRefs = normalizeKnowledgeEvidenceRoots(refs)
    .filter(ref => ref !== `session:${sessionId}`);
  if (normalizedRefs.length === 0) {
    throw new Error('Session-source candidate evidence must contain a resolvable immutable root');
  }
  // v3 Sessions keep the artifact registry at session.artifacts_ref instead of
  // the v2 bundle; readBundle rejects session/3.0 (SESSION_SCHEMA_UNSUPPORTED).
  const sessionRecord = store.readSessionRecordReadOnly(sessionId);
  const artifacts: ArtifactRegistry = sessionRecord.schema_version === 'session/3.0'
    ? store.readJsonFileReadOnly(
        join(store.sessionDir(sessionId), (sessionRecord as SessionStateV30).artifacts_ref),
        artifactRegistrySchema,
      )
    : store.readBundle(sessionId).artifacts;
  const descriptors = normalizedRefs.map((ref): SessionKnowledgeEvidenceRoot => {
    if (ref.startsWith('inline:')) {
      const content = ref.slice('inline:'.length);
      if (!content) throw new Error('Inline evidence must explicitly include immutable content');
      return {
        kind: 'inline',
        ref,
        encoding: 'utf8',
        content,
        content_hash: rawHash(content),
        size: Buffer.byteLength(content, 'utf8'),
      };
    }
    if (ref.startsWith('transcript:')) {
      const transcript = resolveTranscriptEvidenceRoot(projectRoot, store, sessionId, ref);
      if (!transcript) throw new Error(`Unresolved transcript evidence: ${ref}`);
      return transcript;
    }
    if (ref.startsWith('run:')) {
      const runId = ref.slice('run:'.length).trim();
      if (!runId) throw new Error(`Invalid Run evidence reference: ${ref}`);
      const runPath = join(store.runDir(sessionId, runId), 'run.json');
      const verified = readVerifiedContainedFile(projectRoot, runPath);
      store.readRunReadOnly(sessionId, runId);
      return {
        kind: 'run',
        ref,
        run_id: runId,
        path: projectRelativePath(projectRoot, verified.canonicalPath),
        content_hash: verified.contentHash,
        size: verified.size,
      };
    }
    if (ref.startsWith('artifact:')) {
      const artifactId = ref.slice('artifact:'.length).trim();
      const artifact = artifacts.artifacts[artifactId];
      if (!artifact || artifact.status !== 'sealed') {
        throw new Error(`Artifact evidence is missing or not sealed: ${artifactId || ref}`);
      }
      const artifactPath = join(store.sessionDir(sessionId), artifact.relative_path);
      const stat = lstatSync(artifactPath);
      if (stat.isSymbolicLink()) throw new Error(`Artifact evidence cannot be a symbolic link: ${artifactId}`);
      const observed = stat.isDirectory()
        ? hashDirectory(artifactPath)
        : (() => {
            const verified = readVerifiedContainedFile(projectRoot, artifactPath);
            return { hash: verified.contentHash, size: verified.size };
          })();
      if (observed.hash !== artifact.content_hash) {
        throw new Error(`Sealed artifact evidence bytes changed: ${artifactId}`);
      }
      return {
        kind: 'artifact',
        ref,
        artifact_id: artifactId,
        path: projectRelativePath(projectRoot, resolve(artifactPath)),
        content_hash: observed.hash,
        size: observed.size,
      };
    }
    const parsed = splitFileEvidenceRef(projectRoot, ref);
    try {
      const verified = readVerifiedContainedFile(projectRoot, parsed.path);
      return {
        kind: 'file',
        ref,
        path: projectRelativePath(projectRoot, verified.canonicalPath),
        anchor: parsed.anchor,
        content_hash: verified.contentHash,
        size: verified.size,
      };
    } catch (error) {
      throw new Error(`Unresolved or mutable session evidence "${ref}": ${(error as Error).message}`);
    }
  });
  return descriptors.sort((left, right) => left.ref.localeCompare(right.ref)
    || left.kind.localeCompare(right.kind));
}

export function createSessionKnowledgeCandidateSource(
  projectRoot: string,
  store: SessionStore,
  sessionId: string,
  observedActivityRevision: number,
  content: string,
  evidenceRefs: readonly string[],
): SessionKnowledgeCandidateSource {
  const evidenceRoots = normalizeKnowledgeEvidenceRoots(evidenceRefs);
  if (evidenceRoots.length === 0) {
    throw new Error('Session-source candidate evidence must remain non-empty');
  }
  const descriptors = resolveSessionKnowledgeEvidenceRoots(projectRoot, store, sessionId, evidenceRoots);
  return sessionKnowledgeCandidateSourceSchema.parse({
    schema_version: 'session-knowledge-candidate-source/1.0',
    candidate_version: 1,
    session_id: sessionId,
    observed_activity_revision: observedActivityRevision,
    content_hash: knowledgeCandidateContentHash(content),
    evidence_roots: evidenceRoots,
    evidence_root_hash: evidenceDescriptorHash(descriptors),
    evidence_root_descriptors: descriptors,
  });
}

export function assertSessionKnowledgeCandidateSource(
  candidate: KnowledgeCandidate,
  sessionId: string,
): SessionKnowledgeCandidateSource {
  const source = candidate.source_snapshot;
  if (!source) {
    throw new Error(`Session-source candidate ${candidate.candidate_id} has no immutable source snapshot`);
  }
  const evidenceRoots = normalizeKnowledgeEvidenceRoots(candidate.evidence_refs);
  if (evidenceRoots.length === 0) {
    throw new Error(`Session-source candidate ${candidate.candidate_id} has empty evidence`);
  }
  const expectedRootHash = source.evidence_root_descriptors
    ? evidenceDescriptorHash(source.evidence_root_descriptors)
    : knowledgeEvidenceRootHash(evidenceRoots);
  if (source.session_id !== sessionId
    || source.content_hash !== knowledgeCandidateContentHash(candidate.content)
    || source.evidence_root_hash !== expectedRootHash
    || JSON.stringify(source.evidence_roots) !== JSON.stringify(evidenceRoots)) {
    throw new Error(`Session-source candidate ${candidate.candidate_id} source snapshot is stale or mismatched`);
  }
  return source;
}

export function revalidateSessionKnowledgeCandidateSource(
  projectRoot: string,
  store: SessionStore,
  candidate: KnowledgeCandidate,
  sessionId: string,
): SessionKnowledgeCandidateSource {
  const source = assertSessionKnowledgeCandidateSource(candidate, sessionId);
  if (!source.evidence_root_descriptors) {
    throw new Error(`Session-source candidate ${candidate.candidate_id} has legacy unfenced evidence roots`);
  }
  const current = resolveSessionKnowledgeEvidenceRoots(
    projectRoot,
    store,
    sessionId,
    candidate.evidence_refs,
  );
  if (JSON.stringify(current) !== JSON.stringify(source.evidence_root_descriptors)
    || evidenceDescriptorHash(current) !== source.evidence_root_hash) {
    throw new Error(`Session-source candidate ${candidate.candidate_id} evidence bytes changed`);
  }
  return source;
}

export function addInput(
  draft: KnowledgeLedgerDraft,
  knowledgeId: string,
  signal: KnowledgeInputSignal,
  source: z.infer<typeof knowledgeInputSchema>['source'],
  now: string,
  evidence: readonly string[] = [],
): void {
  const existing = draft.inputs.find(item =>
    item.knowledge_id === knowledgeId && item.signal === signal && item.source === source
  );
  if (existing) {
    existing.count++;
    existing.last_recorded_at = now;
    if (evidence.length > 0) {
      existing.evidence = [...new Set([...(existing.evidence ?? []), ...evidence])];
    }
  } else {
    draft.inputs.push({
      knowledge_id: knowledgeId,
      signal,
      source,
      count: 1,
      first_recorded_at: now,
      last_recorded_at: now,
      ...(evidence.length > 0 ? { evidence: [...new Set(evidence)] } : {}),
    });
  }
}

export function addCandidate(
  draft: KnowledgeLedgerDraft,
  input: Pick<KnowledgeCandidate, 'target' | 'action' | 'title' | 'content' | 'category' | 'source_kind'>
    & { evidence_refs: string[]; source_snapshot?: SessionKnowledgeCandidateSource },
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
    if (existing.source_snapshot || input.source_snapshot) {
      if (!existing.source_snapshot || !input.source_snapshot) {
        throw new Error(`Candidate ${id} cannot change its immutable source snapshot`);
      }
      assertSessionKnowledgeCandidateSource(existing, existing.source_snapshot.session_id);
      if (JSON.stringify(existing.source_snapshot) !== JSON.stringify(input.source_snapshot)
        || knowledgeEvidenceRootHash(existing.evidence_refs) !== knowledgeEvidenceRootHash(input.evidence_refs)) {
        throw new Error(`Candidate ${id} cannot change its immutable content or evidence binding`);
      }
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

export type KnowledgeExecutionAuthority = ExecutionRunSidecarAuthority;

function executionKnowledgeAuthorityRequired(runId: string): Error {
  return new Error(
    `Run ${runId} is bound to an active Execution; exact sidecar authority is required. `
    + 'Pass --execution, --generation, --request-id, --expected-execution-revision, '
    + '--owner-id, --owner-kind, --lease-epoch, and --lease-id, or provide a private '
    + 'authority JSON file with --execution-authority / MAESTRO_EXECUTION_AUTHORITY_FILE.',
  );
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
  evidence: readonly string[] = [],
  executionAuthority?: KnowledgeExecutionAuthority,
): { session_id: string; run_id: string; recorded: number } {
  const ids = [...new Set(knowledgeIds.map(id => id.trim()).filter(Boolean))];
  if (ids.length === 0) throw new Error('At least one knowledge ID is required');
  const store = new SessionStore(projectRoot);
  const located = store.findRun(runId, sessionId);
  const now = nowIso();
  const path = runKnowledgeDeltaPath(store, located.sessionId, runId);
  const mutate = (draft: RunKnowledgeDelta) => {
    for (const id of ids) addInput(draft, id, signal, source, now, evidence);
    draft.revision++;
    draft.updated_at = now;
    return { session_id: located.sessionId, run_id: runId, recorded: ids.length };
  };
  if (store.readOpenExecution(located.sessionId)) {
    if (!executionAuthority) throw executionKnowledgeAuthorityRequired(runId);
    return store.updateActiveExecutionRunSidecar({
      sessionId: located.sessionId,
      runId,
      path,
      schema: runKnowledgeDeltaSchema,
      initial: createDelta(located.sessionId, runId, now),
      authority: executionAuthority,
      operation: 'knowledge-record',
      requestPayload: {
        knowledge_ids: ids,
        signal,
        source,
        evidence: [...evidence],
      },
      revisionOf: draft => draft.revision,
      mutator: mutate,
    }).result;
  }
  if (executionAuthority) {
    throw new Error(`Run ${runId} uses ${located.run.schema_version}; Execution sidecar authority is not applicable`);
  }
  return store.updateActiveRunSidecar(
    located.sessionId,
    runId,
    path,
    runKnowledgeDeltaSchema,
    createDelta(located.sessionId, runId, now),
    mutate,
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
  executionAuthority?: KnowledgeExecutionAuthority,
): { session_id: string; run_id: string; candidate_id: string; reused: boolean } {
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
  const reused = Boolean(prior);
  const now = nowIso();
  const path = runKnowledgeDeltaPath(store, located.sessionId, runId);
  const mutate = (draft: RunKnowledgeDelta) => {
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
    return { session_id: located.sessionId, run_id: runId, candidate_id: candidateId, reused };
  };
  if (store.readOpenExecution(located.sessionId)) {
    if (!executionAuthority) throw executionKnowledgeAuthorityRequired(runId);
    return store.updateActiveExecutionRunSidecar({
      sessionId: located.sessionId,
      runId,
      path,
      schema: runKnowledgeDeltaSchema,
      initial: createDelta(located.sessionId, runId, now),
      authority: executionAuthority,
      operation: 'knowledge-stage',
      requestPayload: {
        target: input.target,
        action: input.action ?? 'propose',
        title,
        content,
        category: input.category?.trim() || null,
        evidence_refs: [...new Set((input.evidenceRefs ?? []).map(ref => ref.trim()).filter(Boolean))],
      },
      revisionOf: draft => draft.revision,
      mutator: mutate,
    }).result;
  }
  if (executionAuthority) {
    throw new Error(`Run ${runId} uses ${located.run.schema_version}; Execution sidecar authority is not applicable`);
  }
  return store.updateActiveRunSidecar(
    located.sessionId,
    runId,
    path,
    runKnowledgeDeltaSchema,
    createDelta(located.sessionId, runId, now),
    mutate,
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
      evidence_refs: [...evidence, `report.md#decision:${decision.id ?? '?'}`],
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
      evidence_refs: [...evidence, `report.md#constraint:${constraint.id ?? '?'}`],
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
        // Schema-agnostic authority check: v2 readRun* rejects run/3.0
        // (SessionSchemaUnsupportedError), which would make knowledge
        // review/promote crash on v3 workspaces. The raw record carries
        // run_id for both generations.
        const record = options.readOnly
          ? store.readRunRecordReadOnly(sessionId, runId)
          : store.readRunRecord(sessionId, runId);
        if (record.run_id !== runId) {
          throw new Error(`Run authority mismatch: directory ${runId} contains ${record.run_id}`);
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

  // Session-level ledger (origin=session) is aggregated alongside run ledgers.
  // Candidate/input bookkeeping stays separated per origin: cross-origin same
  // candidate IDs are accounted separately and never merge gates (K7).
  const sessionLedgerPath = sessionKnowledgeDeltaPath(store, sessionId);
  const sessionLedger = existsSync(sessionLedgerPath)
    ? readSessionKnowledgeDelta(store, sessionId, options.readOnly)
    : null;
  type LedgerView = {
    origin: 'run' | 'session';
    run_id: string;
    inputs: KnowledgeInput[];
    candidates: KnowledgeCandidate[];
  };
  const ledgerViews: LedgerView[] = [
    ...ledgers.map(ledger => ({
      origin: 'run' as const,
      run_id: ledger.run_id,
      inputs: ledger.inputs,
      candidates: ledger.candidates,
    })),
    ...(sessionLedger && (sessionLedger.inputs.length > 0 || sessionLedger.candidates.length > 0)
      ? [{
          origin: 'session' as const,
          run_id: '',
          inputs: sessionLedger.inputs,
          candidates: sessionLedger.candidates,
        }]
      : []),
  ];

  const inputTotals: Record<KnowledgeInputSignal, number> = {
    consumed: 0,
    cited: 0,
    validated: 0,
    contradicted: 0,
  };
  const inputTotalsBySource: Record<KnowledgeInputSource, Record<KnowledgeInputSignal, number>> = {
    load: { consumed: 0, cited: 0, validated: 0, contradicted: 0 },
    search: { consumed: 0, cited: 0, validated: 0, contradicted: 0 },
    injection: { consumed: 0, cited: 0, validated: 0, contradicted: 0 },
    manual: { consumed: 0, cited: 0, validated: 0, contradicted: 0 },
  };
  const inputs: SessionKnowledgeSummary['inputs'] = [];
  const uniqueInputs = new Set<string>();
  const candidates = new Map<string, KnowledgeCandidate & { run_ids: string[]; origin: 'run' | 'session' }>();
  for (const view of ledgerViews) {
    for (const input of view.inputs) {
      inputTotals[input.signal] += input.count;
      inputTotalsBySource[input.source][input.signal] += input.count;
      uniqueInputs.add(input.knowledge_id);
      inputs.push({
        run_id: view.run_id,
        ...(view.origin === 'session' ? { origin: 'session' as const } : {}),
        knowledge_id: input.knowledge_id,
        signal: input.signal,
        source: input.source,
        count: input.count,
        ...(input.evidence?.length ? { evidence: input.evidence } : {}),
      });
    }
    for (const candidate of view.candidates) {
      const key = `${view.origin}\u0000${candidate.candidate_id}`;
      const existing = candidates.get(key);
      if (existing) {
        existing.occurrences += candidate.occurrences;
        if (view.origin === 'run') existing.run_ids.push(view.run_id);
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
        candidates.set(key, {
          ...structuredClone(candidate),
          run_ids: view.origin === 'run' ? [view.run_id] : [],
          origin: view.origin,
        });
      }
    }
  }

  return {
    schema_version: 'session-knowledge-summary/1.0',
    session_id: sessionId,
    run_count: runIds.length,
    ledger_count: ledgers.length,
    input_totals: inputTotals,
    input_totals_by_source: inputTotalsBySource,
    inputs,
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
      record: 'explicit_attribution',
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

function atomicSpecFilename(category: SpecCategory): string {
  const filename = Object.entries(CATEGORY_MAP).find(([, value]) => value === category)?.[0];
  if (!filename) throw new Error(`No project spec file is registered for category ${category}`);
  return filename;
}

function stageAtomicSessionCorpusPromotion(
  projectRoot: string,
  sessionId: string,
  tx: StoreTransaction,
  candidate: KnowledgeCandidate,
  promotedId: string,
  promotedAt: string,
): { promoted_id: string; outcome: 'created' | 'reaffirmed' } {
  if (candidate.target === 'spec') {
    const content = safeSpecContent(candidate.content);
    const plannedExisting = findSpecById(projectRoot, promotedId);
    if (plannedExisting) {
      if (normalizedText(plannedExisting.content) !== normalizedText(content)) {
        throw new Error(`Persisted promotion ID ${promotedId} has different content for ${candidate.candidate_id}`);
      }
      return { promoted_id: promotedId, outcome: 'reaffirmed' };
    }
    const existing = findExistingSpec(projectRoot, candidate.title);
    if (existing) {
      if (normalizedText(existing.content) !== normalizedText(content)) {
        throw new Error(`Candidate ${candidate.candidate_id} conflicts with existing spec title "${candidate.title}"`);
      }
      return { promoted_id: existing.id, outcome: 'reaffirmed' };
    }
    const validCategories: SpecCategory[] = ['coding', 'arch', 'debug', 'test', 'review', 'learning', 'ui'];
    const category = validCategories.includes(candidate.category as SpecCategory)
      ? candidate.category as SpecCategory
      : 'learning';
    const filename = atomicSpecFilename(category);
    const path = join(resolveSpecDir(projectRoot, 'project'), filename);
    const seed = findSeedByFilename(filename);
    const current = tx.pendingText(path) ?? (existsSync(path)
      ? readFileSync(path, 'utf8')
      : seed ? renderSeedContent(seed) : '');
    const entry = formatNewEntry(
      category,
      ['session-knowledge', candidate.source_kind],
      promotedAt.slice(0, 10),
      candidate.title,
      content,
      `session:${sessionId}:${candidate.candidate_id}`,
      undefined,
      `Promoted from ${candidate.evidence_refs.join(', ')}`,
      undefined,
      undefined,
      undefined,
      { sid: promotedId },
    );
    tx.writeText(path, `${current.replace(/\s*$/, '')}\n\n${entry}\n`);
    return { promoted_id: promotedId, outcome: 'created' };
  }

  const generated = generateKnowhowFilename('tip', candidate.title, promotedId);
  const path = join(projectRoot, '.workflow', 'knowhow', generated.filename);
  if (existsSync(path)) {
    const parsed = parseFrontmatter(readFileSync(path, 'utf8'));
    const existingBody = normalizeKnowhowBody(parsed.body);
    if (parsed.data.title !== candidate.title
      || parsed.data.type !== 'tip'
      || parsed.data.explicitId !== promotedId
      || existingBody !== normalizeKnowhowBody(candidate.content)) {
      throw new Error(`Persisted promotion ID ${promotedId} has different content for ${candidate.candidate_id}`);
    }
    return { promoted_id: generated.id, outcome: 'reaffirmed' };
  }
  const body = normalizeKnowhowBody(candidate.content);
  if (!body) throw new Error(`Knowledge candidate ${candidate.candidate_id} has empty content`);
  const description = `Promoted from ${candidate.evidence_refs.join(', ')}`;
  const document = [
    '---',
    `title: ${escapeYamlValue(candidate.title)}`,
    `description: ${escapeYamlValue(description)}`,
    'type: tip',
    `explicitId: ${promotedId}`,
    `created: ${promotedAt}`,
    'keywords:',
    '  - session-knowledge',
    `  - ${candidate.source_kind}`,
    'tags:',
    '  - promoted',
    '---',
    '',
    body,
  ].join('\n');
  tx.writeText(path, document);
  return { promoted_id: generated.id, outcome: 'created' };
}

function candidateReconciliationPolicies(
  store: SessionStore,
  sessionId: string,
  candidate: SessionKnowledgeSummary['candidates'][number],
): KnowledgeCandidateReconciliation[] {
  if ((candidate.origin ?? 'run') === 'session') {
    const receipt = readSessionKnowledgeReconciliation(store, sessionId, true);
    const policy = receipt?.candidates.find(item => item.candidate_id === candidate.candidate_id);
    return policy ? [policy] : [];
  }
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

/**
 * K17 trust-gate predicate (shared with reconcile.ts): a candidate is
 * transcript-only when its evidence set is non-empty and, after dropping the
 * automatic origin markers (session:<sid> / run:<runId>), every remaining ref
 * is a transcript: anchor. Only-assistant/tool/transcript-supported candidates
 * default to review_required and are excluded from promote --all until a human
 * --reason resolution or an independent verifier upgrades them
 * (docs/knowledge-window-evidence-plan.md §4.4).
 */
const ORIGIN_EVIDENCE_PREFIX = /^(session|run):/;

export function isTranscriptOnlyEvidenceRefs(refs: readonly string[]): boolean {
  const meaningful = refs
    .map(ref => ref.trim())
    .filter(ref => ref.length > 0 && !ORIGIN_EVIDENCE_PREFIX.test(ref));
  return meaningful.length > 0 && meaningful.every(ref => ref.startsWith('transcript:'));
}

/**
 * A confirmed human resolution (--reason) upgrades a candidate past the gate.
 * Defensive hardening (GPT final review): the resolution is only trusted when
 * it is structurally complete (schema already requires reason/resolved_at); a
 * partial or stale resolution never counts. Note: this defends against
 * accidental/partial state, not against a local attacker with write access to
 * the receipt file — that actor can rewrite the corpus directly (same trust
 * boundary, documented in knowledge-window-evidence-plan.md §10.4).
 */
function hasConfirmedHumanResolution(policies: KnowledgeCandidateReconciliation[]): boolean {
  return policies.some(policy => {
    const r = policy.resolution;
    return r?.status === 'confirmed'
      && typeof r.reason === 'string'
      && r.reason.trim().length > 0
      && typeof r.resolved_at === 'string'
      && r.resolved_at.length > 0;
  });
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
 * Promote selected pending candidates. `--all` promotes every eligible pending
 * candidate whose source Runs are sealed; observed-only candidates are promoted
 * with a warning rather than being skipped.
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
  if (unknown.length > 0) {
    throw new Error(`Unknown candidate IDs: ${unknown.join(', ')}; list candidates with: maestro knowledge review <session-id>`);
  }

  const policyByCandidate = new Map(summary.candidates.map(candidate => [
    candidate.candidate_id,
    candidateReconciliationPolicies(store, sessionId, candidate),
  ]));
  if (!options.all) {
    const blocked = summary.candidates
      .filter(candidate => requested.has(candidate.candidate_id))
      .map(candidate => ({
        candidate,
        policies: policyByCandidate.get(candidate.candidate_id) ?? [],
      }))
      .find(item =>
        blockingCandidatePolicy(item.policies)
        || (
          // K17 — transcript-only candidates need a human --reason resolution
          // (or an independent verifier upgrade) before explicit promotion.
          isTranscriptOnlyEvidenceRefs(item.candidate.evidence_refs)
          && !hasConfirmedHumanResolution(item.policies)
        )
      );
    const blocking = blocked && blockingCandidatePolicy(blocked.policies);
    if (blocked) {
      throw new Error(
        blocking
          ? `Candidate ${blocked.candidate.candidate_id} promotion is ${blocking.promotion_eligibility} `
            + `(${blocking.disposition}); resolve it with 'maestro knowledge promote <session-id> --resolve <candidate-id> --as <choice> [--target <knowledge-id>] --reason "<reason>"' (or the deprecated review --resolve) first`
          : `Candidate ${blocked.candidate.candidate_id} is backed only by transcript evidence; `
            + `resolve it with 'maestro knowledge promote <session-id> --resolve <candidate-id> --as unique --reason "<reason>"' `
            + 'before promotion (untrusted quotes require human review)',
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
    ? pending
    : pending.filter(candidate => requested.has(candidate.candidate_id));
  const skippedReviewRequired = options.all
    ? eligiblePending
      .filter(candidate => {
        const policies = policyByCandidate.get(candidate.candidate_id) ?? [];
        return blockingCandidatePolicy(policies)?.promotion_eligibility === 'review_required'
          || (
            // K17 — transcript-only candidates are excluded from --all
            // auto-promotion until a human --reason resolution upgrades them.
            isTranscriptOnlyEvidenceRefs(candidate.evidence_refs)
            && !hasConfirmedHumanResolution(policies)
          );
      })
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
  const eligibleSelected = eligiblePending.filter(candidate => !blockedForAll.has(candidate.candidate_id));
  // Cross-origin same-ID candidates carry identical content but divergent
  // evidence metadata; the corpus write happens once (run-origin copy as the
  // representative) and write-back below dispatches to each origin ledger.
  const selectedById = new Map<string, typeof eligibleSelected[number]>();
  for (const candidate of eligibleSelected) {
    const existing = selectedById.get(candidate.candidate_id);
    if (!existing) {
      selectedById.set(candidate.candidate_id, candidate);
      continue;
    }
    if ((candidate.origin ?? 'run') === 'run' && (existing.origin ?? 'run') !== 'run') {
      selectedById.set(candidate.candidate_id, candidate);
    }
  }
  const selected = [...selectedById.values()];
  const skippedObserved = options.all
    ? eligibleSelected.filter(candidate => candidate.stage === 'observed').map(candidate => candidate.candidate_id)
    : [];
  const unsealedSources = selected.flatMap(candidate =>
    candidate.run_ids
      .filter(runId => store.readRun(sessionId, runId).status !== 'sealed')
      .map(runId => `${candidate.candidate_id}:${runId}`)
  );
  if (unsealedSources.length > 0) {
    throw new Error(
      `Knowledge candidates require sealed source Runs before promotion: ${unsealedSources.join(', ')}; `
      + 'complete and seal each source Run first: maestro run check <run-id> && maestro session done',
    );
  }
  // Session-origin candidates are fenced by their immutable staged source and
  // an existing review receipt, not by permanent Session sealing. The wrapper
  // revalidates the receipt's corpus fingerprint immediately before entering
  // this lower-level promotion path.
  const sessionSourceSelected = selected.filter(candidate => (candidate.origin ?? 'run') === 'session');
  if (sessionSourceSelected.length > 0) {
    const sessionDelta = readSessionKnowledgeDelta(store, sessionId, true);
    const sessionReceipt = readSessionKnowledgeReconciliation(store, sessionId, true);
    if (!sessionReceipt) {
      throw new Error(
        `Session ${sessionId} has no session knowledge reconciliation receipt; `
        + `run "maestro knowledge review ${sessionId} --refresh" first`,
      );
    }
    if (!sessionReceipt.session_source
      || sessionReceipt.candidate_snapshot_hash !== sessionKnowledgeSnapshotHash(sessionDelta)) {
      throw new Error(
        `Session ${sessionId} has a stale or mismatched session knowledge reconciliation receipt; `
        + `run "maestro knowledge review ${sessionId} --refresh" before promotion`,
      );
    }
    for (const candidate of sessionSourceSelected) {
      const source = revalidateSessionKnowledgeCandidateSource(
        projectRoot,
        store,
        candidate,
        sessionId,
      );
      const bound = sessionReceipt.session_source.candidates.find(item =>
        item.candidate_id === candidate.candidate_id
      );
      if (!bound
        || bound.candidate_version !== source.candidate_version
        || bound.observed_activity_revision !== source.observed_activity_revision
        || bound.content_hash !== source.content_hash
        || bound.evidence_root_hash !== source.evidence_root_hash) {
        throw new Error(
          `Session-source candidate ${candidate.candidate_id} has stale or mismatched receipt evidence`,
        );
      }
    }
  }
  if (selected.length === 0 && alreadyPromoted.length === 0) {
    if (options.all) {
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
    throw new Error('No pending candidates selected');
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

  const atomicSessionPlan = plan.length > 0
    && plan.every(item => (item.candidate.origin ?? 'run') === 'session' && !item.supersessionTarget);
  if (atomicSessionPlan) {
    if (!options._finalSessionValidation) {
      throw new Error(
        'Session-source promotion requires the reconciled wrapper final corpus validation',
      );
    }
    const promotedAt = nowIso();
    const promoted = store.updateKnowledgeTransaction(sessionId, tx => {
      options._beforeFinalSessionValidation?.();
      const lockedDelta = readSessionKnowledgeDelta(store, sessionId, true);
      const lockedReceipt = readSessionKnowledgeReconciliation(store, sessionId, true);
      if (!lockedReceipt?.session_source
        || lockedReceipt.candidate_snapshot_hash !== sessionKnowledgeSnapshotHash(lockedDelta)) {
        throw new Error(`Session ${sessionId} has a stale session knowledge reconciliation receipt`);
      }
      options._finalSessionValidation?.(store);

      for (const item of plan) {
        const lockedCandidate = lockedDelta.candidates.find(candidate =>
          candidate.candidate_id === item.candidate.candidate_id
        );
        if (!lockedCandidate
          || lockedCandidate.status === 'promoted'
          || lockedCandidate.target !== item.candidate.target
          || lockedCandidate.action !== item.candidate.action
          || lockedCandidate.title !== item.candidate.title
          || lockedCandidate.content !== item.candidate.content
          || lockedCandidate.category !== item.candidate.category
          || lockedCandidate.source_kind !== item.candidate.source_kind
          || JSON.stringify(lockedCandidate.evidence_refs) !== JSON.stringify(item.candidate.evidence_refs)
          || JSON.stringify(lockedCandidate.source_snapshot) !== JSON.stringify(item.candidate.source_snapshot)) {
          throw new Error(`Session-source candidate ${item.candidate.candidate_id} changed before final commit`);
        }
        const source = revalidateSessionKnowledgeCandidateSource(
          projectRoot,
          store,
          lockedCandidate,
          sessionId,
        );
        const bound = lockedReceipt.session_source.candidates.find(candidate =>
          candidate.candidate_id === lockedCandidate.candidate_id
        );
        if (!bound
          || bound.candidate_version !== source.candidate_version
          || bound.content_hash !== source.content_hash
          || bound.evidence_root_hash !== source.evidence_root_hash
          || JSON.stringify(bound.evidence_root_descriptors)
            !== JSON.stringify(source.evidence_root_descriptors)) {
          throw new Error(
            `Session-source candidate ${lockedCandidate.candidate_id} has stale receipt evidence`,
          );
        }
      }

      const results = plan.map(item => {
        const result = stageAtomicSessionCorpusPromotion(
          projectRoot,
          sessionId,
          tx,
          item.candidate,
          item.promotedId,
          promotedAt,
        );
        return {
          candidate_id: item.candidate.candidate_id,
          target: item.candidate.target,
          promoted_id: result.promoted_id,
          outcome: result.outcome,
        };
      });
      for (const candidate of lockedDelta.candidates) {
        const result = results.find(item => item.candidate_id === candidate.candidate_id);
        if (!result) continue;
        candidate.status = 'promoted';
        candidate.promoted_id = result.promoted_id;
        candidate.promotion_receipt = {
          outcome: result.outcome,
          promoted_at: promotedAt,
          content_hash: contentHash(candidate.content),
        };
      }
      lockedDelta.revision++;
      lockedDelta.updated_at = promotedAt;
      tx.writeJson(
        sessionKnowledgeDeltaPath(store, sessionId),
        lockedDelta,
        sessionKnowledgeDeltaSchema,
      );
      if (store.readSessionRecordReadOnly(sessionId).schema_version !== 'session/2.0') {
        const bundle = structuredClone(store.readBundle(sessionId));
        for (const item of results) {
          const target = item.target === 'spec'
            ? bundle.session.lifecycle.promoted_spec_ids
            : bundle.session.lifecycle.promoted_knowhow_ids;
          if (!target.includes(item.promoted_id)) target.push(item.promoted_id);
        }
        tx.addBundle(bundle);
      }
      return results;
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

  // Phase 1: persist deterministic promotion intents before any project write.
  // A crash after this point is resumable because `promoting` candidates remain selectable.
  const intentAt = nowIso();
  const canonicalSessionV20 = store.readSessionRecordReadOnly(sessionId).schema_version === 'session/2.0';
  const sessionOnlyPlan = plan.every(item => (item.candidate.origin ?? 'run') === 'session');
  if (canonicalSessionV20 && sessionOnlyPlan) {
    store.updateJsonFile(
      sessionKnowledgeDeltaPath(store, sessionId),
      sessionKnowledgeDeltaSchema,
      createSessionDelta(sessionId, intentAt),
      sessionDelta => {
        let changed = false;
        for (const candidate of sessionDelta.candidates) {
          const item = plan.find(entry => entry.candidate.candidate_id === candidate.candidate_id);
          if (!item || candidate.status === 'promoted') continue;
          candidate.status = 'promoting';
          candidate.promoted_id = item.promotedId;
          changed = true;
        }
        if (changed) {
          sessionDelta.revision++;
          sessionDelta.updated_at = intentAt;
        }
      },
    );
  } else {
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
      // K7 origin dispatch: session-source intents land in the session delta.
      if (plan.some(item => (item.candidate.origin ?? 'run') === 'session')) {
        const sessionDelta = readSessionKnowledgeDelta(store, sessionId);
        let changed = false;
        for (const candidate of sessionDelta.candidates) {
          const item = plan.find(entry => entry.candidate.candidate_id === candidate.candidate_id);
          if (!item || candidate.status === 'promoted') continue;
          candidate.status = 'promoting';
          candidate.promoted_id = item.promotedId;
          changed = true;
        }
        if (changed) {
          sessionDelta.revision++;
          sessionDelta.updated_at = intentAt;
          tx.writeJson(sessionKnowledgeDeltaPath(store, sessionId), sessionDelta, sessionKnowledgeDeltaSchema);
        }
      }
    });
  }

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
  if (canonicalSessionV20 && sessionOnlyPlan) {
    store.updateJsonFile(
      sessionKnowledgeDeltaPath(store, sessionId),
      sessionKnowledgeDeltaSchema,
      createSessionDelta(sessionId, promotedAt),
      sessionDelta => {
        let changed = false;
        for (const candidate of sessionDelta.candidates) {
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
          sessionDelta.revision++;
          sessionDelta.updated_at = promotedAt;
        }
      },
    );
  } else {
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
      // K7 origin dispatch: session-source completion lands in the session delta.
      if (summary.candidates.some(candidate => (candidate.origin ?? 'run') === 'session')) {
        const sessionDelta = readSessionKnowledgeDelta(store, sessionId);
        let changed = false;
        for (const candidate of sessionDelta.candidates) {
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
          sessionDelta.revision++;
          sessionDelta.updated_at = promotedAt;
          tx.writeJson(sessionKnowledgeDeltaPath(store, sessionId), sessionDelta, sessionKnowledgeDeltaSchema);
        }
      }
    });
  }

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
