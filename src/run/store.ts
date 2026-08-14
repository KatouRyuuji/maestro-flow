import {
  copyFileSync,
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  lstatSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  appendFileSync,
  chmodSync,
} from 'node:fs';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { safeRename } from '../utils/state-schema.js';
import { hashDirectory } from './artifacts.js';
import {
  assertExecutionLease,
  hashExecutionLeaseId,
  isExecutionLeaseStale,
  type ExecutionLeaseClaim,
} from './lease.js';
import { loadWorkspaceConfig, resolveWorkspaceLinks } from '../config/index.js';
import {
  artifactRegistrySchema,
  commandRunReadSchema,
  commandRunV13Schema,
  commandRunV14Schema,
  runReadSchema,
  runV30ReadSchema,
  runV30Schema,
  evidenceStoreSchema,
  executionLeaseSchema,
  executionStateSchema,
  gateRegistrySchema,
  normalizeCommandRun,
  normalizeSessionState,
  projectSessionSchemaConfigSchema,
  sessionSchemaSelectionSchema,
  sessionStateReadSchema,
  sessionStateSchema,
  sessionStateV13Schema,
  sessionStateV20Schema,
  sessionStateV30ReadSchema,
  sessionStateV30Schema,
  targetPlatformSchema,
  type ArtifactRegistry,
  type CommandRun,
  type CommandRunInput,
  type CommandRunV14,
  type RunRead,
  type RunV30,
  type EvidenceStore,
  type ExecutionState,
  type GateRegistry,
  type SessionSchemaSelection,
  type SessionState,
  type SessionStateRead,
  type SessionStateV30,
  type SessionIdentityV20,
} from './schemas.js';
import {
  DEFAULT_SESSION_SCHEMA_SELECTION,
  createArtifactRegistry,
  createEvidenceStore,
  createGateRegistry,
  createSessionIdentityV20,
  createSessionState,
} from './defaults.js';
import { assertSafePathSegment } from './ids.js';
import { canonicalWorkspaceId, createIntentIdentity, sameIntentIdentity } from './intent-identity.js';
import {
  artifactRepublishReceiptSchema,
  executionSealReceiptReadSchema,
  executionSealReceiptSchema,
  executionSealReceiptV11Schema,
  recallConfirmationFinalTargetSchema,
  recallConfirmationRecordReadSchema,
  recallConfirmationRegistryReadSchema as recallConfirmationRegistrySchema,
  recallConfirmationRegistryV11Schema,
  recallReservationMarkerSchema,
  recallReservationObservationSchema,
  recallReservationReconciliationSchema,
  persistedTransitionRecordV11Schema,
  sessionArchiveReceiptSchema,
  requestReceiptV20Schema,
  transitionReceiptV20Schema,
  transitionFenceSchema,
  validatedRecallSourceReadSchema,
  type ArtifactRepublishReceipt,
  type ExecutionSealReceipt,
  type ExecutionSealReceiptV10,
  type ExecutionSealReceiptV11,
  type IntentIdentity,
  type RecallConfirmationFinalTarget,
  type RecallConfirmationOutcome,
  type RecallConfirmationRecord,
  type RecallConfirmationRegistry,
  type RecallConfirmationTargetIdentity,
  type RecallReservationMarker,
  type RecallReservationObservation,
  type RecallReservationReconciliation,
  type PersistedTransitionRecord,
  type PersistedTransitionRecordV11,
  type SessionArchiveReceipt,
  type RequestReceiptV20,
  type TransitionReceiptV20,
  type SessionProvenance,
  type SourceFenceRead,
  type SourceFenceV11,
  type StaleRecallReservation,
  type TransitionFence,
  type TransitionOutcome,
  type TransitionRequest,
  type ValidatedRecallSource,
} from './protocol-schemas.js';
import {
  assertRecallConfirmationConsumable,
  cancelRecallConfirmationRecord,
  createRecallReservationMarker,
  createStaleRecallReservation,
  createRecallConfirmationRegistry,
  finalizeRecallConfirmationRecord,
  hashRecallConfirmationToken,
  issueRecallConfirmationRecord,
  reserveRecallConfirmationRecord,
  RECALL_CONFIRMATION_RECONCILIATION_TTL_MS,
  RecallConfirmationError,
  type FinalizeRecallConfirmationInput,
  type IssueRecallConfirmationInput,
  type ReserveRecallConfirmationInput,
  type ReserveRecallConfirmationResult,
} from './recall-confirmation-store.js';
import {
  replayOrApplyTransition,
  stableJsonUtf8,
  validatePersistedTransitionRecordV11,
} from './transition-receipts.js';

const LOCK_WAIT_MS = 5_000;
const LOCK_POLL_MS = 15;
const MAX_BACKUPS = 10;
const CACHE_MAX_ENTRIES = 64;
const TRANSACTION_INTENT_FILE = '.session-store-transaction.json';

const lockRecordSchema = z.object({
  schema_version: z.literal('session-store-lock/1.0').optional(),
  pid: z.number().int().positive(),
  token: z.string().min(16).optional(),
  acquired_at: z.number().int().nonnegative(),
}).strict();

interface LockFileIdentity {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  birthtimeMs: number;
}

interface LockSnapshot {
  raw: string;
  owner: z.infer<typeof lockRecordSchema>;
  identity: LockFileIdentity;
}

function lockFileIdentity(stats: ReturnType<typeof fstatSync>): LockFileIdentity {
  return {
    dev: Number(stats.dev),
    ino: Number(stats.ino),
    size: Number(stats.size),
    mtimeMs: Number(stats.mtimeMs),
    birthtimeMs: Number(stats.birthtimeMs),
  };
}

function sameLockIdentity(left: LockFileIdentity, right: LockFileIdentity): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.birthtimeMs === right.birthtimeMs;
}

function sameLockSnapshot(left: LockSnapshot, right: LockSnapshot): boolean {
  return left.raw === right.raw
    && left.owner.pid === right.owner.pid
    && left.owner.token === right.owner.token
    && left.owner.acquired_at === right.owner.acquired_at
    && sameLockIdentity(left.identity, right.identity);
}

/**
 * Read one immutable lock-file generation through an fd. A missing, partial or
 * replaced path is normal contention and returns null so the caller can retry.
 */
function readStableLockSnapshot(path: string): LockSnapshot | null {
  let fd: number | null = null;
  try {
    fd = openSync(path, 'r');
    const before = lockFileIdentity(fstatSync(fd));
    const raw = readFileSync(fd, 'utf8');
    const after = lockFileIdentity(fstatSync(fd));
    if (!sameLockIdentity(before, after)) return null;
    const pathIdentity = lockFileIdentity(statSync(path));
    if (!sameLockIdentity(after, pathIdentity)) return null;
    const owner = lockRecordSchema.safeParse(JSON.parse(raw));
    if (!owner.success) return null;
    return { raw, owner: owner.data, identity: after };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'EACCES' || code === 'EPERM' || code === 'EBUSY') return null;
    if (error instanceof SyntaxError) return null;
    throw error;
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* fd already closed */ }
    }
  }
}

const transactionIntentSchema = z.object({
  schema_version: z.literal('session-store-intent/1.0'),
  transaction_id: z.string().min(1),
  created_at: z.string().min(1),
  writes: z.array(z.object({
    path: z.string().min(1),
    tmp_path: z.string().min(1),
    original_base64: z.string().nullable(),
    original_sha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
    next_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict()).min(1),
}).strict();

type TransactionIntent = z.infer<typeof transactionIntentSchema>;

interface CacheEntry {
  mtime: number;
  size: number;
  data: unknown;
}

export interface SessionBundle {
  session: SessionState;
  gates: GateRegistry;
  artifacts: ArtifactRegistry;
  evidence: EvidenceStore;
}

export interface SessionListFilters {
  statuses?: SessionState['status'][];
  engines?: SessionState['orchestration']['engine'][];
  intentIdentity?: IntentIdentity;
}

export interface SessionListCandidate {
  sessionId: string;
  session: SessionState;
  identity: IntentIdentity | null;
}

export interface SessionListExclusion {
  sessionId: string;
  code: 'CORRUPT' | 'STATUS_FILTERED' | 'ENGINE_FILTERED' | 'IDENTITY_MISMATCH' | 'IDENTITY_UNAVAILABLE';
  detail: string;
}

export interface SessionListResult {
  candidates: SessionListCandidate[];
  exclusions: SessionListExclusion[];
}

export type SessionStoreReserveRecallResult = ReserveRecallConfirmationResult & {
  validated_source: ValidatedRecallSource | null;
};

interface JsonWrite {
  path: string;
  value?: unknown;
  raw?: string;
  schema?: z.ZodType;
  mode?: number;
}

export interface SessionStoreLockTiming {
  now: () => number;
  wait: (milliseconds: number) => void;
}

export interface SessionStoreOptions {
  lockTiming?: Partial<SessionStoreLockTiming>;
}

export interface ExecutionAtomicOptions {
  replayRequestId?: string;
  expectedActivityRevision?: number;
}

export class SessionSchemaUnsupportedError extends Error {
  readonly code = 'SESSION_SCHEMA_UNSUPPORTED' as const;

  constructor(readonly sessionId: string) {
    super(`Session ${sessionId} uses session/3.0; legacy Session/Execution mutations are unsupported`);
    this.name = 'SessionSchemaUnsupportedError';
  }
}

export interface ExecutionRunSidecarAuthority {
  executionId: string;
  generation: number;
  requestId: string;
  expectedExecutionRevision: number;
  lease: ExecutionLeaseClaim;
}

const executionRunSidecarReceiptSchema = z.object({
  schema_version: z.literal('execution-run-sidecar-transition/1.0'),
  request_id: z.string().min(1),
  operation: z.enum(['knowledge-stage', 'knowledge-record']),
  session_id: z.string().min(1),
  execution_id: z.string().min(1),
  generation: z.number().int().positive(),
  run_id: z.string().min(1),
  sidecar_path: z.string().min(1),
  expected_execution_revision: z.number().int().nonnegative(),
  lease: z.object({
    owner_id: z.string().min(1),
    owner_kind: executionLeaseSchema.shape.owner_kind,
    epoch: z.number().int().positive(),
    lease_id_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  }).strict(),
  request_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  sidecar_revision_before: z.number().int().nonnegative(),
  sidecar_revision_after: z.number().int().positive(),
  applied_at: z.string().min(1),
  result: z.union([
    z.object({
      session_id: z.string().min(1),
      run_id: z.string().min(1),
      candidate_id: z.string().min(1),
      reused: z.boolean(),
    }).strict(),
    z.object({
      session_id: z.string().min(1),
      run_id: z.string().min(1),
      recorded: z.number().int().nonnegative(),
    }).strict(),
  ]),
}).strict();

export type ExecutionRunSidecarReceipt = z.infer<typeof executionRunSidecarReceiptSchema>;

const RETRYABLE_WINDOWS_LOCK_ERRORS = new Set(['EPERM', 'EACCES', 'EBUSY']);

export class SessionStoreLock {
  private readonly path: string;
  private readonly now: () => number;
  private readonly wait: (milliseconds: number) => void;
  private held = false;
  private token: string | null = null;

  constructor(path: string, timing: Partial<SessionStoreLockTiming> = {}) {
    this.path = path;
    this.now = timing.now ?? Date.now;
    this.wait = timing.wait ?? waitSync;
  }

  get isHeld(): boolean { return this.held; }

  acquire(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const deadline = this.now() + LOCK_WAIT_MS;
    const token = randomBytes(24).toString('base64url');
    while (true) {
      try {
        writeFileSync(this.path, JSON.stringify({
          schema_version: 'session-store-lock/1.0',
          pid: process.pid,
          token,
          acquired_at: this.now(),
        }), { flag: 'wx' });
        this.token = token;
        this.held = true;
        return;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'EEXIST') {
          if (code && RETRYABLE_WINDOWS_LOCK_ERRORS.has(code)) {
            this.waitForRetry(
              deadline,
              `Cannot create SessionStore lock after retrying ${code}: ${this.path}`,
            );
            continue;
          }
          throw error;
        }
      }

      const snapshot = readStableLockSnapshot(this.path);
      if (!snapshot) {
        this.waitForRetry(deadline);
        continue;
      }
      const liveness = processLiveness(snapshot.owner.pid);
      const verified = readStableLockSnapshot(this.path);
      if (!verified || !sameLockSnapshot(snapshot, verified)) {
        this.waitForRetry(deadline);
        continue;
      }
      if (liveness === 'dead') {
        try {
          unlinkSync(this.path);
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === 'ENOENT') continue;
          if (code && RETRYABLE_WINDOWS_LOCK_ERRORS.has(code)) {
            this.waitForRetry(deadline);
            continue;
          }
          throw error;
        }
        continue;
      }
      if (verified.owner.pid === process.pid || liveness === 'unknown' || this.now() >= deadline) {
        throw new Error(`SessionStore locked by PID ${verified.owner.pid}: ${this.path}`);
      }
      this.wait(LOCK_POLL_MS);
    }
  }

  private waitForRetry(
    deadline: number,
    exhaustedMessage = `Cannot safely inspect SessionStore lock: ${this.path}`,
  ): void {
    if (this.now() >= deadline) throw new Error(exhaustedMessage);
    this.wait(LOCK_POLL_MS);
  }

  release(): void {
    if (!this.held) return;
    try {
      const snapshot = readStableLockSnapshot(this.path);
      if (snapshot?.owner.pid === process.pid && snapshot.owner.token === this.token) {
        const verified = readStableLockSnapshot(this.path);
        if (verified && sameLockSnapshot(snapshot, verified)) unlinkSync(this.path);
      }
    } catch { /* already removed */ }
    this.held = false;
    this.token = null;
  }
}

function waitSync(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function processLiveness(pid: number): 'alive' | 'dead' | 'unknown' {
  try {
    process.kill(pid, 0);
    return 'alive';
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return 'dead';
    if (code === 'EPERM') return 'unknown';
    return 'unknown';
  }
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.\-TZ]/g, '').slice(0, 14);
}

function sha256Hex(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function sha256Prefixed(value: string | Buffer): string {
  return `sha256:${sha256Hex(value)}`;
}

export type ExecutionSealReceiptInput = Omit<
  ExecutionSealReceiptV10,
  'schema_version' | 'overall_hash'
>;

export type ExecutionSealReceiptV11Input = Omit<
  ExecutionSealReceiptV11,
  'schema_version' | 'overall_hash'
>;

export function executionSealReceiptHash(
  receipt: ExecutionSealReceipt | ExecutionSealReceiptInput | ExecutionSealReceiptV11Input,
): string {
  const { overall_hash: _overallHash, ...content } = receipt as ExecutionSealReceipt;
  return sha256Prefixed(stableJsonUtf8(content));
}

export function createExecutionSealReceipt(input: ExecutionSealReceiptInput): ExecutionSealReceiptV10 {
  const receipt = {
    schema_version: 'execution-seal-receipt/1.0' as const,
    ...input,
    overall_hash: '',
  };
  receipt.overall_hash = executionSealReceiptHash(receipt);
  return executionSealReceiptSchema.parse(receipt);
}

export function createExecutionSealReceiptV11(input: ExecutionSealReceiptV11Input): ExecutionSealReceiptV11 {
  const receipt = {
    schema_version: 'execution-seal-receipt/1.1' as const,
    ...input,
    overall_hash: '',
  };
  receipt.overall_hash = executionSealReceiptHash(receipt);
  return executionSealReceiptV11Schema.parse(receipt);
}

export function executionSealReceiptScopeSnapshots(
  runs: readonly CommandRunV14[],
  bundle: Pick<SessionBundle, 'gates' | 'artifacts' | 'evidence'>,
): Pick<ExecutionSealReceiptV11, 'gates' | 'artifacts' | 'evidence'> {
  const runIds = new Set(runs.map(run => run.run_id));
  const gateIds = new Set(runs.flatMap(run => run.gate_ids));
  for (const [gateId, gate] of Object.entries(bundle.gates.gates)) {
    if (gate.run_id && runIds.has(gate.run_id)) gateIds.add(gateId);
  }
  const gateSnapshots = [...gateIds]
    .sort()
    .map(gateId => {
      const gate = bundle.gates.gates[gateId];
      if (!gate) throw new Error(`Execution seal receipt references missing Gate: ${gateId}`);
      return { gate_id: gateId, record: clone(gate) };
    });
  const blockingGateIds = gateSnapshots
    .filter(({ record }) => record.blocking
      && ['pending', 'running', 'failed', 'blocked'].includes(String(record.status)))
    .map(({ gate_id: gateId }) => gateId);

  const artifactSnapshots = Object.entries(bundle.artifacts.artifacts)
    .filter(([, artifact]) => runIds.has(artifact.producer_run_id) && artifact.status === 'sealed')
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([artifactId, artifact]) => ({
      artifact_id: artifactId,
      ...clone(artifact),
      content_hash: `sha256:${artifact.content_hash}`,
      status: 'sealed' as const,
    }));
  const contentHashes = Object.fromEntries(
    artifactSnapshots.map(snapshot => [snapshot.artifact_id, snapshot.content_hash]),
  );

  const evidenceIds = new Set<string>();
  for (const { record } of gateSnapshots) {
    if (Array.isArray(record.evidence_refs)) {
      for (const evidenceId of record.evidence_refs) evidenceIds.add(String(evidenceId));
    }
  }
  for (const [recordId, record] of Object.entries(bundle.evidence.records)) {
    if (runIds.has(record.run_id)) evidenceIds.add(recordId);
  }
  const evidenceSnapshots = [...evidenceIds]
    .sort()
    .map(recordId => {
      const record = bundle.evidence.records[recordId];
      if (!record) throw new Error(`Execution seal receipt references missing Evidence: ${recordId}`);
      return { record_id: recordId, record: clone(record) };
    });

  return {
    gates: {
      clean: blockingGateIds.length === 0,
      blocking_gate_ids: blockingGateIds,
      registry_revision: bundle.gates.revision,
      registry_hash: sha256Prefixed(`${JSON.stringify(bundle.gates, null, 2)}\n`),
      snapshots: gateSnapshots,
      snapshot_hash: sha256Prefixed(stableJsonUtf8(gateSnapshots)),
    },
    artifacts: {
      registry_revision: bundle.artifacts.revision,
      registry_hash: sha256Prefixed(`${JSON.stringify(bundle.artifacts, null, 2)}\n`),
      content_hashes: contentHashes,
      snapshots: artifactSnapshots,
      snapshot_hash: sha256Prefixed(stableJsonUtf8(artifactSnapshots)),
    },
    evidence: {
      store_revision: bundle.evidence.revision,
      store_hash: sha256Prefixed(`${JSON.stringify(bundle.evidence, null, 2)}\n`),
      record_refs: evidenceSnapshots.map(snapshot => snapshot.record_id),
      snapshots: evidenceSnapshots,
      snapshot_hash: sha256Prefixed(stableJsonUtf8(evidenceSnapshots)),
    },
  };
}

export type SessionArchiveReceiptInput = Omit<
  SessionArchiveReceipt,
  'schema_version' | 'receipt_hash'
>;

export function sessionArchiveReceiptHash(
  receipt: SessionArchiveReceipt | SessionArchiveReceiptInput,
): string {
  const { receipt_hash: _receiptHash, ...content } = receipt as SessionArchiveReceipt;
  return sha256Prefixed(stableJsonUtf8(content));
}

export function createSessionArchiveReceipt(input: SessionArchiveReceiptInput): SessionArchiveReceipt {
  const receipt = {
    schema_version: 'session-archive-receipt/1.0' as const,
    ...input,
    receipt_hash: '',
  };
  receipt.receipt_hash = sessionArchiveReceiptHash(receipt);
  return sessionArchiveReceiptSchema.parse(receipt);
}

function assertExecutionLifecycleInvariants(execution: ExecutionState): void {
  if (execution.lease
    && (execution.lease.session_id !== execution.session_id
      || execution.lease.execution_id !== execution.execution_id)) {
    throw new Error(`Execution ${execution.execution_id} lease identity mismatch`);
  }
  if (execution.status !== 'active' && execution.lease) {
    throw new Error(`${execution.status} Execution ${execution.execution_id} must not retain a lease`);
  }
  if (execution.status === 'paused' && execution.active_run_id) {
    throw new Error(`paused Execution ${execution.execution_id} must not retain an active Run`);
  }
  if (execution.status === 'sealed') {
    if (execution.active_run_id) throw new Error(`sealed Execution ${execution.execution_id} must not retain an active Run`);
    if (!execution.sealed_at || execution.seal_summary === null || execution.final_outcome === null) {
      throw new Error(`sealed Execution ${execution.execution_id} has incomplete lifecycle metadata`);
    }
    return;
  }
  if (execution.sealed_at !== null || execution.seal_summary !== null || execution.final_outcome !== null) {
    throw new Error(`open Execution ${execution.execution_id} must not contain seal metadata`);
  }
}

function assertExecutionSessionInvariants(session: SessionState, execution: ExecutionState): void {
  assertExecutionLifecycleInvariants(execution);
  if (execution.status === 'sealed') return;
  if (execution.active_run_id !== session.active_run_id) {
    throw new Error(`Execution ${execution.execution_id} active Run projection diverged from Session`);
  }
  if (stableJsonUtf8(execution.chain) !== stableJsonUtf8(session.orchestration.chain)
    || stableJsonUtf8(execution.decision_points) !== stableJsonUtf8(session.orchestration.decision_points)) {
    throw new Error(`Execution ${execution.execution_id} orchestration projection diverged from Session`);
  }
  if (execution.status === 'active' && session.status !== 'running') {
    throw new Error(`active Execution ${execution.execution_id} requires a running Session`);
  }
  if (execution.status === 'paused' && session.status !== 'paused') {
    throw new Error(`paused Execution ${execution.execution_id} requires a paused Session`);
  }
}

export class SessionStore {
  readonly projectRoot: string;
  readonly workflowRoot: string;
  readonly sessionsRoot: string;
  private readonly lock: SessionStoreLock;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(projectRoot: string, options: SessionStoreOptions = {}) {
    this.projectRoot = projectRoot;
    this.workflowRoot = join(projectRoot, '.workflow');
    this.sessionsRoot = join(this.workflowRoot, 'sessions');
    this.lock = new SessionStoreLock(join(this.sessionsRoot, '.session-store.lock'), options.lockTiming);
  }

  sessionDir(sessionId: string): string {
    assertSafePathSegment(sessionId, 'session ID');
    return join(this.sessionsRoot, sessionId);
  }

  executionDir(sessionId: string, executionId: string): string {
    assertSafePathSegment(executionId, 'execution ID');
    return join(this.sessionDir(sessionId), 'executions', executionId);
  }

  executionPath(sessionId: string, executionId: string): string {
    return join(this.executionDir(sessionId, executionId), 'execution.json');
  }

  executionTransitionPath(sessionId: string, executionId: string, requestId: string): string {
    assertSafePathSegment(requestId, 'request ID');
    return join(this.executionDir(sessionId, executionId), 'transitions', `${requestId}.json`);
  }

  executionRunSidecarReceiptPath(sessionId: string, executionId: string, requestId: string): string {
    assertSafePathSegment(requestId, 'request ID');
    return join(this.executionDir(sessionId, executionId), 'sidecar-transitions', `${requestId}.json`);
  }

  executionSealReceiptPath(sessionId: string, executionId: string): string {
    return join(this.executionDir(sessionId, executionId), 'seal-receipt.json');
  }

  sessionCompatibilityPath(sessionId: string): string {
    return join(this.sessionDir(sessionId), '.compat', 'session-1.3.json');
  }

  sessionArchiveReceiptPath(sessionId: string, activityRevision: number): string {
    if (!Number.isSafeInteger(activityRevision) || activityRevision < 0) {
      throw new Error(`invalid archive receipt activity revision: ${activityRevision}`);
    }
    return join(
      this.sessionDir(sessionId),
      'archive-receipts',
      `${String(activityRevision).padStart(12, '0')}.json`,
    );
  }

  sessionSchemaSelection(): SessionSchemaSelection {
    const path = join(this.workflowRoot, 'config.json');
    if (!existsSync(path)) return clone(DEFAULT_SESSION_SCHEMA_SELECTION);
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, 'utf8'));
    } catch (error) {
      throw new Error(`Invalid project Session schema config at ${path}: ${(error as Error).message}`);
    }
    const config = projectSessionSchemaConfigSchema.parse(raw);
    return config.session_schema
      ? sessionSchemaSelectionSchema.parse(config.session_schema)
      : clone(DEFAULT_SESSION_SCHEMA_SELECTION);
  }

  runDir(sessionId: string, runId: string): string {
    assertSafePathSegment(runId, 'run ID');
    return join(this.sessionDir(sessionId), 'runs', runId);
  }

  receiptsDir(sessionId: string): string {
    return join(this.sessionDir(sessionId), 'receipts');
  }

  requestReceiptsDir(sessionId: string): string {
    return join(this.receiptsDir(sessionId), 'requests');
  }

  transitionReceiptsDir(sessionId: string): string {
    return join(this.receiptsDir(sessionId), 'transitions');
  }

  requestReceiptV20Path(sessionId: string, requestId: string): string {
    assertSafePathSegment(requestId, 'request ID');
    return join(this.requestReceiptsDir(sessionId), `${requestId}.json`);
  }

  transitionReceiptV20Path(
    sessionId: string,
    activityRevision: number,
    transitionId: string,
  ): string {
    if (!Number.isSafeInteger(activityRevision) || activityRevision <= 0) {
      throw new Error(`invalid transition receipt activity revision: ${activityRevision}`);
    }
    assertSafePathSegment(transitionId, 'transition ID');
    return join(
      this.transitionReceiptsDir(sessionId),
      `${String(activityRevision).padStart(12, '0')}-${transitionId}.json`,
    );
  }

  withLock<T>(fn: () => T): T {
    this.lock.acquire();
    try {
      this.reconcileTransactionIntentUnlocked();
      return fn();
    } finally { this.lock.release(); }
  }

  sessionExists(sessionId: string): boolean {
    return existsSync(join(this.sessionDir(sessionId), 'session.json'));
  }

  createSession(
    sessionId: string,
    intent: string,
    options: {
      ifExists?: 'reuse' | 'error';
      command?: string;
      intentIdentity?: IntentIdentity;
      provenance?: SessionProvenance;
    } = {},
  ): SessionBundle {
    return this.withLock(() => {
      if (this.sessionExists(sessionId)) {
        if (options.ifExists === 'error') throw new Error(`Session already exists: ${sessionId}`);
        const existing = this.readBundleUnlocked(sessionId);
        this.ensureSessionProjections(sessionId, existing.session.intent);
        return clone(existing);
      }
      this.assertRecoverableSessionShell(sessionId, intent);
      const intentIdentity = options.intentIdentity
        ?? createIntentIdentity(this.projectRoot, options.command ?? 'session', intent);
      const bundle: SessionBundle = {
        session: createSessionState(sessionId, intent, {
          intentIdentity,
          ...(options.provenance ? { provenance: options.provenance } : {}),
        }),
        gates: createGateRegistry(),
        artifacts: createArtifactRegistry(),
        evidence: createEvidenceStore(),
      };
      this.writeFreshBundleUnlocked(sessionId, bundle, this.sessionSchemaSelection());
      this.ensureSessionProjections(sessionId, intent);
      return clone(bundle);
    });
  }

  private assertRecoverableSessionShell(sessionId: string, intent: string): void {
    const dir = this.sessionDir(sessionId);
    if (!existsSync(dir)) return;
    const dirStat = lstatSync(dir);
    if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
      throw new Error(`SessionStore recovery required: invalid Session shell at ${dir}`);
    }
    const allowedDirectories = new Set([
      'runs', 'specs', 'knowhow', 'executions', 'archive-receipts', 'receipts', '.compat',
    ]);
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const stats = lstatSync(path);
      if (stats.isSymbolicLink()) {
        throw new Error(`SessionStore recovery required: symbolic link in Session shell: ${path}`);
      }
      if (name === '.recall-import-staging') {
        if (!stats.isDirectory()) {
          throw new Error(`SessionStore recovery required: invalid recall import staging directory: ${path}`);
        }
        continue;
      }
      if (allowedDirectories.has(name)) {
        if (!stats.isDirectory() || readdirSync(path).length > 0) {
          throw new Error(`SessionStore recovery required: non-empty or invalid projection directory: ${path}`);
        }
        continue;
      }
      if (name === '.recall-reservation.json') {
        if (!stats.isFile()) {
          throw new Error(`SessionStore recovery required: invalid recall reservation marker: ${path}`);
        }
        this.readValidated(path, recallReservationMarkerSchema);
        continue;
      }
      if (name === 'events.ndjson') {
        if (!stats.isFile() || stats.size !== 0) {
          throw new Error(`SessionStore recovery required: conflicting events projection: ${path}`);
        }
        continue;
      }
      if (name === 'context.md') {
        if (!stats.isFile() || readFileSync(path, 'utf8') !== `# ${intent}\n`) {
          throw new Error(`SessionStore recovery required: conflicting context projection: ${path}`);
        }
        continue;
      }
      throw new Error(`SessionStore recovery required: unknown Session shell entry: ${path}`);
    }
  }

  private ensureSessionProjections(sessionId: string, intent: string): void {
    const dir = this.sessionDir(sessionId);
    const dirStat = lstatSync(dir);
    if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
      throw new Error(`SessionStore recovery required: invalid canonical Session directory: ${dir}`);
    }
    for (const name of ['runs', 'specs', 'knowhow', 'executions']) {
      const path = join(dir, name);
      if (!existsSync(path)) {
        mkdirSync(path);
        continue;
      }
      const stats = lstatSync(path);
      if (stats.isSymbolicLink() || !stats.isDirectory()) {
        throw new Error(`SessionStore recovery required: invalid projection directory: ${path}`);
      }
    }
    const eventsPath = join(dir, 'events.ndjson');
    if (!existsSync(eventsPath)) writeFileSync(eventsPath, '', { flag: 'wx' });
    else {
      const stats = lstatSync(eventsPath);
      if (stats.isSymbolicLink() || !stats.isFile()) {
        throw new Error(`SessionStore recovery required: invalid events projection: ${eventsPath}`);
      }
    }
    const contextPath = join(dir, 'context.md');
    if (!existsSync(contextPath)) writeFileSync(contextPath, `# ${intent}\n`, { flag: 'wx' });
    else {
      const stats = lstatSync(contextPath);
      if (stats.isSymbolicLink() || !stats.isFile() || readFileSync(contextPath, 'utf8') !== `# ${intent}\n`) {
        throw new Error(`SessionStore recovery required: conflicting context projection: ${contextPath}`);
      }
    }
  }

  readBundle(sessionId: string): SessionBundle {
    if (!this.lock.isHeld) return this.withLock(() => this.readBundleUnlocked(sessionId));
    return this.readBundleUnlocked(sessionId);
  }

  readSessionRecord(sessionId: string): SessionStateRead {
    if (!this.lock.isHeld) return this.withLock(() => this.readSessionRecordUnlocked(sessionId));
    return this.readSessionRecordUnlocked(sessionId);
  }

  /** Strict read of canonical session.json with no cross-version normalization. */
  readSessionRecordReadOnly(sessionId: string): SessionStateRead {
    return this.readSessionRecordUnlocked(sessionId);
  }

  readSessionV30(sessionId: string): SessionStateV30 {
    const session = this.readSessionRecord(sessionId);
    if (session.schema_version !== 'session/3.0') {
      throw new Error(`Session ${sessionId} uses ${session.schema_version}; session/3.0 is required`);
    }
    const parsed = sessionStateV30ReadSchema.parse(session);
    // Retired status: pre-simplification session/3.0 documents may still say
    // `paused`; the engine no longer has that status, so reads map it to open.
    return parsed.status === 'paused' ? { ...parsed, status: 'open' } : parsed as SessionStateV30;
  }

  writeSessionV30(sessionInput: SessionStateV30): SessionStateV30 {
    return this.withLock(() => {
      const session = sessionStateV30Schema.parse(sessionInput);
      if (this.sessionSchemaSelection().writer !== 'session/3.0') {
        throw new Error('session/3.0 writes require the explicit session/3.0 writer selection');
      }
      const path = join(this.sessionDir(session.session_id), 'session.json');
      if (existsSync(path)) {
        const current = this.readSessionRecordUnlocked(session.session_id);
        if (current.schema_version !== 'session/3.0') {
          throw new Error(
            `Session ${session.session_id} uses ${current.schema_version}; v2-to-v3 replacement requires the migration engine`,
          );
        }
      }
      this.writeBatchUnlocked([{
        path,
        value: session,
        schema: sessionStateV30Schema,
      }]);
      return clone(session);
    });
  }

  /** Typed atomic storage batch for W2/W5. It deliberately performs no CAS or state-machine work. */
  withV30Transaction<T>(
    sessionId: string,
    builder: (tx: SessionV30StoreTransaction) => T,
  ): T {
    return this.withLock(() => {
      if (this.sessionSchemaSelection().writer !== 'session/3.0') {
        throw new Error('v3 storage transactions require the explicit session/3.0 writer selection');
      }
      const tx = new SessionV30StoreTransaction(this, sessionId);
      const result = builder(tx);
      const writes = tx.pendingWrites();
      if (writes.length > 0) this.writeBatchUnlocked(writes);
      return result;
    });
  }

  private readSessionRecordUnlocked(sessionId: string): SessionStateRead {
    const session = this.readValidated(
      join(this.sessionDir(sessionId), 'session.json'),
      sessionStateReadSchema,
    );
    if (session.session_id !== sessionId) {
      throw new Error(`Session identity does not match its canonical path: ${sessionId}`);
    }
    return session;
  }

  private readBundleUnlocked(sessionId: string): SessionBundle {
    const dir = this.sessionDir(sessionId);
    const record = this.readSessionRecordUnlocked(sessionId);
    if (record.schema_version === 'session/3.0') {
      throw new SessionSchemaUnsupportedError(sessionId);
    }
    const session = record.schema_version === 'session/2.0'
      ? this.readValidated(this.sessionCompatibilityPath(sessionId), sessionStateV13Schema)
      : normalizeSessionState(record);
    if (session.session_id !== sessionId) {
      throw new Error(`Session compatibility identity does not match its canonical path: ${sessionId}`);
    }
    return {
      session,
      gates: this.readValidated(join(dir, 'gates.json'), gateRegistrySchema),
      artifacts: this.readValidated(join(dir, 'artifacts.json'), artifactRegistrySchema),
      evidence: this.readValidated(join(dir, 'evidence.json'), evidenceStoreSchema),
    };
  }

  readExecution(sessionId: string, executionId: string): ExecutionState {
    if (!this.lock.isHeld) return this.withLock(() => this.readExecutionUnlocked(sessionId, executionId));
    return this.readExecutionUnlocked(sessionId, executionId);
  }

  /** Validate an Execution without lock acquisition or recovery writes. */
  readExecutionReadOnly(sessionId: string, executionId: string): ExecutionState {
    return this.readExecutionUnlocked(sessionId, executionId);
  }

  private readExecutionUnlocked(sessionId: string, executionId: string): ExecutionState {
    const execution = this.readValidated(this.executionPath(sessionId, executionId), executionStateSchema);
    if (execution.session_id !== sessionId || execution.execution_id !== executionId) {
      throw new Error(`Execution identity does not match its canonical path: ${sessionId}/${executionId}`);
    }
    assertExecutionLifecycleInvariants(execution);
    return execution;
  }

  readExecutionSealReceipt(sessionId: string, executionId: string): ExecutionSealReceipt | null {
    if (!this.lock.isHeld) {
      return this.withLock(() => this.readExecutionSealReceiptUnlocked(sessionId, executionId));
    }
    return this.readExecutionSealReceiptUnlocked(sessionId, executionId);
  }

  private readExecutionSealReceiptUnlocked(
    sessionId: string,
    executionId: string,
  ): ExecutionSealReceipt | null {
    const path = this.executionSealReceiptPath(sessionId, executionId);
    if (!existsSync(path)) return null;
    const receipt = this.readValidated(path, executionSealReceiptReadSchema);
    if (receipt.session_id !== sessionId || receipt.execution_id !== executionId) {
      throw new Error(`Execution seal receipt identity does not match its canonical path: ${sessionId}/${executionId}`);
    }
    this.assertPersistedExecutionSealReceiptUnlocked(receipt);
    return receipt;
  }

  writeExecutionSealReceipt(receiptInput: ExecutionSealReceipt): ExecutionSealReceipt {
    return this.withLock(() => {
      const receipt = executionSealReceiptReadSchema.parse(receiptInput);
      this.assertSessionV30MutationUnsupported(receipt.session_id);
      const existing = this.readExecutionSealReceiptUnlocked(receipt.session_id, receipt.execution_id);
      if (existing) {
        if (stableJsonUtf8(existing) !== stableJsonUtf8(receipt)) {
          throw new Error(`Execution seal receipt is immutable: ${receipt.execution_id}`);
        }
        return clone(existing);
      }
      this.assertExecutionSealReceiptSnapshotUnlocked(receipt);
      this.writeBatchUnlocked([{
        path: this.executionSealReceiptPath(receipt.session_id, receipt.execution_id),
        value: receipt,
        schema: executionSealReceiptReadSchema,
        mode: 0o600,
      }]);
      return clone(receipt);
    });
  }

  private assertExecutionSealReceiptSnapshotUnlocked(receipt: ExecutionSealReceipt): void {
    this.assertPersistedExecutionSealReceiptUnlocked(receipt);
    const session = this.readSessionRecordUnlocked(receipt.session_id);
    if (session.schema_version === 'session/3.0'
      || (session.schema_version !== 'session/2.0' && !session.schema_version.startsWith('session/1.'))) {
      throw new Error(`Unsupported Session version for Execution seal receipt: ${session.schema_version}`);
    }
    // The known/unknown read union is not TS-discriminable; the guard above
    // already rejected v3 and unknown versions, leaving legacy 1.x/2.0 only.
    const legacySession = session as SessionState;
    if (legacySession.identity_revision !== receipt.session_identity_revision
      || legacySession.activity_revision !== receipt.session_activity_revision) {
      throw new Error('Execution seal receipt Session revisions changed');
    }
    const bundle = this.readBundleUnlocked(receipt.session_id);
    if (receipt.schema_version === 'execution-seal-receipt/1.1') {
      const runs = this.listBoundExecutionRunsUnlocked(
        receipt.session_id,
        receipt.execution_id,
        receipt.generation,
      );
      const expected = executionSealReceiptScopeSnapshots(runs, bundle);
      if (stableJsonUtf8(receipt.gates) !== stableJsonUtf8(expected.gates)) {
        throw new Error('Execution seal receipt gate snapshot changed');
      }
      if (stableJsonUtf8(receipt.artifacts) !== stableJsonUtf8(expected.artifacts)) {
        throw new Error('Execution seal receipt Artifact snapshot changed');
      }
      if (stableJsonUtf8(receipt.evidence) !== stableJsonUtf8(expected.evidence)) {
        throw new Error('Execution seal receipt Evidence snapshot changed');
      }
      return;
    }
    const dir = this.sessionDir(receipt.session_id);
    const gatesPath = join(dir, 'gates.json');
    const artifactsPath = join(dir, 'artifacts.json');
    const evidencePath = join(dir, 'evidence.json');
    const blockingGateIds = Object.entries(bundle.gates.gates)
      .filter(([, gate]) => gate.blocking && ['pending', 'running', 'failed', 'blocked'].includes(gate.status))
      .map(([gateId]) => gateId)
      .sort();
    const artifactHashes = Object.fromEntries(
      Object.entries(bundle.artifacts.artifacts)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([artifactId, artifact]) => [artifactId, `sha256:${artifact.content_hash}`]),
    );
    if (receipt.gates.registry_revision !== bundle.gates.revision
      || receipt.gates.registry_hash !== sha256Prefixed(readFileSync(gatesPath))
      || receipt.gates.clean !== (blockingGateIds.length === 0)
      || stableJsonUtf8(receipt.gates.blocking_gate_ids) !== stableJsonUtf8(blockingGateIds)) {
      throw new Error('Execution seal receipt gate snapshot changed');
    }
    if (receipt.artifacts.registry_revision !== bundle.artifacts.revision
      || receipt.artifacts.registry_hash !== sha256Prefixed(readFileSync(artifactsPath))
      || stableJsonUtf8(receipt.artifacts.content_hashes) !== stableJsonUtf8(artifactHashes)) {
      throw new Error('Execution seal receipt Artifact snapshot changed');
    }
    if (receipt.evidence.store_revision !== bundle.evidence.revision
      || receipt.evidence.store_hash !== sha256Prefixed(readFileSync(evidencePath))
      || stableJsonUtf8(receipt.evidence.record_refs) !== stableJsonUtf8(Object.keys(bundle.evidence.records).sort())) {
      throw new Error('Execution seal receipt Evidence snapshot changed');
    }
  }

  private assertPersistedExecutionSealReceiptUnlocked(receipt: ExecutionSealReceipt): void {
    if (executionSealReceiptHash(receipt) !== receipt.overall_hash) {
      throw new Error('Execution seal receipt overall hash mismatch');
    }
    if (sha256Prefixed(stableJsonUtf8(receipt.chain_snapshot)) !== receipt.chain_hash) {
      throw new Error('Execution seal receipt chain hash mismatch');
    }
    const executionPath = this.executionPath(receipt.session_id, receipt.execution_id);
    const execution = this.readExecutionUnlocked(receipt.session_id, receipt.execution_id);
    if (execution.status !== 'sealed'
      || execution.generation !== receipt.generation
      || execution.revision !== receipt.execution_revision
      || execution.sealed_at !== receipt.sealed_at) {
      throw new Error('Execution seal receipt does not match sealed Execution authority');
    }
    if (stableJsonUtf8(execution.chain) !== stableJsonUtf8(receipt.chain_snapshot)) {
      throw new Error('Execution seal receipt chain snapshot changed');
    }
    if (receipt.schema_version === 'execution-seal-receipt/1.1'
      && sha256Prefixed(readFileSync(executionPath)) !== receipt.execution_hash) {
      throw new Error('Execution seal receipt Execution bytes changed');
    }

    const runIds = new Set<string>();
    for (const runSnapshot of receipt.runs) {
      if (runIds.has(runSnapshot.run_id)) throw new Error(`Duplicate Execution seal receipt Run: ${runSnapshot.run_id}`);
      runIds.add(runSnapshot.run_id);
      const path = join(this.runDir(receipt.session_id, runSnapshot.run_id), 'run.json');
      const run = this.readValidated(path, commandRunReadSchema);
      if (run.schema_version !== runSnapshot.schema_version || run.status !== 'sealed'
        || sha256Prefixed(readFileSync(path)) !== runSnapshot.content_hash) {
        throw new Error(`Execution seal receipt Run snapshot changed: ${runSnapshot.run_id}`);
      }
      if (run.schema_version === 'command-run/1.4'
        && (run.execution_id !== receipt.execution_id || run.generation !== receipt.generation)) {
        throw new Error(`Execution seal receipt Run ownership changed: ${runSnapshot.run_id}`);
      }
    }
    if (receipt.schema_version === 'execution-seal-receipt/1.1') {
      const ownedRunIds = this.listBoundExecutionRunsUnlocked(
        receipt.session_id,
        receipt.execution_id,
        receipt.generation,
      ).map(run => run.run_id).sort();
      if (stableJsonUtf8([...runIds].sort()) !== stableJsonUtf8(ownedRunIds)) {
        throw new Error('Execution seal receipt Run ownership changed');
      }
      this.assertExecutionSealReceiptV11CommitmentsUnlocked(receipt, runIds);
      return;
    }
    const artifacts = this.readBundleUnlocked(receipt.session_id).artifacts.artifacts;
    for (const [artifactId, contentHash] of Object.entries(receipt.artifacts.content_hashes)) {
      const artifact = artifacts[artifactId];
      if (!artifact || `sha256:${artifact.content_hash}` !== contentHash
        || this.observedArtifactHashUnlocked(receipt.session_id, artifact.relative_path) !== contentHash) {
        throw new Error(`Execution seal receipt Artifact snapshot changed: ${artifactId}`);
      }
    }
  }

  private assertExecutionSealReceiptV11CommitmentsUnlocked(
    receipt: ExecutionSealReceiptV11,
    runIds: ReadonlySet<string>,
  ): void {
    if (sha256Prefixed(stableJsonUtf8(receipt.gates.snapshots)) !== receipt.gates.snapshot_hash) {
      throw new Error('Execution seal receipt Gate commitment changed');
    }
    if (sha256Prefixed(stableJsonUtf8(receipt.artifacts.snapshots)) !== receipt.artifacts.snapshot_hash) {
      throw new Error('Execution seal receipt Artifact commitment changed');
    }
    if (sha256Prefixed(stableJsonUtf8(receipt.evidence.snapshots)) !== receipt.evidence.snapshot_hash) {
      throw new Error('Execution seal receipt Evidence commitment changed');
    }
    const artifactIds = receipt.artifacts.snapshots.map(snapshot => snapshot.artifact_id);
    const artifactHashes = Object.fromEntries(
      receipt.artifacts.snapshots.map(snapshot => [snapshot.artifact_id, snapshot.content_hash]),
    );
    if (stableJsonUtf8(artifactIds) !== stableJsonUtf8([...new Set(artifactIds)].sort())
      || stableJsonUtf8(artifactHashes) !== stableJsonUtf8(receipt.artifacts.content_hashes)) {
      throw new Error('Execution seal receipt Artifact index commitment changed');
    }
    const artifacts = this.readBundleUnlocked(receipt.session_id).artifacts.artifacts;
    for (const snapshot of receipt.artifacts.snapshots) {
      if (!runIds.has(snapshot.producer_run_id)) {
        throw new Error(`Execution seal receipt Artifact producer changed: ${snapshot.artifact_id}`);
      }
      const current = artifacts[snapshot.artifact_id];
      if (!current
        || current.kind !== snapshot.kind
        || current.role !== snapshot.role
        || current.producer_run_id !== snapshot.producer_run_id
        || current.relative_path !== snapshot.relative_path
        || current.media_type !== snapshot.media_type
        || current.schema_version !== snapshot.schema_version
        || `sha256:${current.content_hash}` !== snapshot.content_hash
        || current.size !== snapshot.size
        || stableJsonUtf8(current.derived_from) !== stableJsonUtf8(snapshot.derived_from)
        || current.replaces !== snapshot.replaces) {
        throw new Error(`Execution seal receipt Artifact metadata changed: ${snapshot.artifact_id}`);
      }
      if (this.observedArtifactHashUnlocked(receipt.session_id, snapshot.relative_path) !== snapshot.content_hash) {
        throw new Error(`Execution seal receipt Artifact bytes changed: ${snapshot.artifact_id}`);
      }
    }
    const gateIds = receipt.gates.snapshots.map(snapshot => snapshot.gate_id);
    if (stableJsonUtf8(gateIds) !== stableJsonUtf8([...new Set(gateIds)].sort())) {
      throw new Error('Execution seal receipt Gate index commitment changed');
    }
    const blockingGateIds = receipt.gates.snapshots
      .filter(({ record }) => record.blocking
        && ['pending', 'running', 'failed', 'blocked'].includes(String(record.status)))
      .map(snapshot => snapshot.gate_id);
    if (receipt.gates.clean !== (blockingGateIds.length === 0)
      || stableJsonUtf8(receipt.gates.blocking_gate_ids) !== stableJsonUtf8(blockingGateIds)) {
      throw new Error('Execution seal receipt Gate outcome commitment changed');
    }
    const evidenceIds = receipt.evidence.snapshots.map(snapshot => snapshot.record_id);
    if (stableJsonUtf8(evidenceIds) !== stableJsonUtf8([...new Set(evidenceIds)].sort())
      || stableJsonUtf8(evidenceIds) !== stableJsonUtf8(receipt.evidence.record_refs)) {
      throw new Error('Execution seal receipt Evidence index commitment changed');
    }
  }

  private observedArtifactHashUnlocked(sessionId: string, relativePath: string): string {
    const path = this.assertWorkflowPath(join(this.sessionDir(sessionId), relativePath));
    if (!existsSync(path)) throw new Error(`Execution seal receipt Artifact is missing: ${relativePath}`);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error(`Execution seal receipt Artifact cannot be a symbolic link: ${relativePath}`);
    return stat.isDirectory()
      ? `sha256:${hashDirectory(path).hash}`
      : sha256Prefixed(readFileSync(path));
  }

  listExecutions(sessionId: string): ExecutionState[] {
    return this.withLock(() => this.listExecutionsUnlocked(sessionId));
  }

  private listExecutionsUnlocked(sessionId: string): ExecutionState[] {
    const root = join(this.sessionDir(sessionId), 'executions');
    if (!existsSync(root)) return [];
    const executions: ExecutionState[] = [];
    for (const executionId of readdirSync(root).sort()) {
      const path = join(root, executionId);
      const stats = lstatSync(path);
      if (stats.isSymbolicLink() || !stats.isDirectory()) {
        throw new Error(`Corrupt Execution storage entry: ${path}`);
      }
      if (!existsSync(join(path, 'execution.json'))) {
        throw new Error(`Corrupt Execution storage entry: missing execution.json at ${path}`);
      }
      executions.push(this.readExecutionUnlocked(sessionId, executionId));
    }
    return executions.sort((left, right) => left.generation - right.generation
      || left.execution_id.localeCompare(right.execution_id));
  }

  readOpenExecution(sessionId: string): ExecutionState | null {
    if (!this.lock.isHeld) return this.withLock(() => this.readOpenExecutionUnlocked(sessionId));
    return this.readOpenExecutionUnlocked(sessionId);
  }

  private readOpenExecutionUnlocked(sessionId: string): ExecutionState | null {
    const open = this.listExecutionsUnlocked(sessionId).filter(execution => execution.status !== 'sealed');
    if (open.length > 1) throw new Error(`Corrupt Execution storage: Session ${sessionId} has multiple open Executions`);
    return open[0] ?? null;
  }

  createExecution(execution: ExecutionState): ExecutionState {
    return this.withLock(() => {
      this.assertSessionV30MutationUnsupported(execution.session_id);
      const sessionRecord = this.readSessionRecordUnlocked(execution.session_id);
      if (sessionRecord.schema_version === 'session/2.0'
        && sessionStateV20Schema.parse(sessionRecord).archived_at !== null) {
        throw new Error(`Session ${execution.session_id} is archived; unarchive it before creating an Execution`);
      }
      const bundle = this.readBundleUnlocked(execution.session_id);
      const executions = this.listExecutionsUnlocked(execution.session_id);
      if (executions.some(item => item.execution_id === execution.execution_id)) {
        throw new Error(`Execution already exists: ${execution.execution_id}`);
      }
      if (executions.some(item => item.generation === execution.generation)) {
        throw new Error(`Execution generation already exists: ${execution.generation}`);
      }
      if (execution.status !== 'sealed' && executions.some(item => item.status !== 'sealed')) {
        throw new Error(`Session ${execution.session_id} already has an open Execution`);
      }
      executionStateSchema.parse(execution);
      assertExecutionSessionInvariants(bundle.session, execution);
      this.writeBatchUnlocked([{
        path: this.executionPath(execution.session_id, execution.execution_id),
        value: execution,
        schema: executionStateSchema,
        mode: 0o600,
      }]);
      return clone(execution);
    });
  }

  updateExecution<T>(
    sessionId: string,
    executionId: string,
    expectedRevision: number | undefined,
    mutator: (draft: ExecutionState, tx: ExecutionStoreTransaction) => T,
  ): T {
    return this.withLock(() => {
      this.assertSessionV30MutationUnsupported(sessionId);
      const current = this.readExecutionUnlocked(sessionId, executionId);
      if (expectedRevision !== undefined && current.revision !== expectedRevision) {
        throw new Error(`execution revision conflict: expected ${expectedRevision}, current ${current.revision}`);
      }
      const draft = clone(current);
      const tx = new ExecutionStoreTransaction(this, sessionId, executionId);
      const result = mutator(draft, tx);
      if (current.status === 'sealed' && stableJsonUtf8(draft) !== stableJsonUtf8(current)) {
        throw new Error(`Execution ${executionId} is sealed and immutable`);
      }
      if (draft.session_id !== sessionId || draft.execution_id !== executionId
        || draft.generation !== current.generation) {
        throw new Error('Execution identity and generation are immutable');
      }
      if (draft.status !== 'sealed') {
        const sibling = this.listExecutionsUnlocked(sessionId)
          .find(item => item.execution_id !== executionId && item.status !== 'sealed');
        if (sibling) throw new Error(`Session ${sessionId} already has open Execution ${sibling.execution_id}`);
      }
      executionStateSchema.parse(draft);
      assertExecutionSessionInvariants(this.readBundleUnlocked(sessionId).session, draft);
      tx.writeExecution(draft);
      this.writeBatchUnlocked(tx.writes);
      return result;
    });
  }

  listExecutionTransitions(sessionId: string, executionId: string): PersistedTransitionRecordV11[] {
    if (!this.lock.isHeld) return this.withLock(() => this.listExecutionTransitionsUnlocked(sessionId, executionId));
    return this.listExecutionTransitionsUnlocked(sessionId, executionId);
  }

  private listExecutionTransitionsUnlocked(sessionId: string, executionId: string): PersistedTransitionRecordV11[] {
    const root = join(this.executionDir(sessionId, executionId), 'transitions');
    if (!existsSync(root)) return [];
    return readdirSync(root)
      .filter(name => name.endsWith('.json'))
      .sort()
      .map(name => validatePersistedTransitionRecordV11(
        this.readValidated(join(root, name), persistedTransitionRecordV11Schema),
      ));
  }

  readExecutionTransition(
    sessionId: string,
    executionId: string,
    requestId: string,
  ): PersistedTransitionRecordV11 | null {
    if (!this.lock.isHeld) {
      return this.withLock(() => this.readExecutionTransitionUnlocked(sessionId, executionId, requestId));
    }
    return this.readExecutionTransitionUnlocked(sessionId, executionId, requestId);
  }

  readExecutionTransitionReadOnly(
    sessionId: string,
    executionId: string,
    requestId: string,
  ): PersistedTransitionRecordV11 | null {
    return this.readExecutionTransitionUnlocked(sessionId, executionId, requestId);
  }

  private readExecutionTransitionUnlocked(
    sessionId: string,
    executionId: string,
    requestId: string,
  ): PersistedTransitionRecordV11 | null {
    const path = this.executionTransitionPath(sessionId, executionId, requestId);
    if (!existsSync(path)) return null;
    return validatePersistedTransitionRecordV11(this.readValidated(path, persistedTransitionRecordV11Schema));
  }

  readExecutionRun(sessionId: string, runId: string): CommandRunV14 {
    if (!this.lock.isHeld) return this.withLock(() => this.readExecutionRunUnlocked(sessionId, runId));
    return this.readExecutionRunUnlocked(sessionId, runId);
  }

  private readExecutionRunUnlocked(sessionId: string, runId: string): CommandRunV14 {
    const raw = this.readValidated(join(this.runDir(sessionId, runId), 'run.json'), commandRunReadSchema);
    if (raw.schema_version !== 'command-run/1.4') {
      throw new Error(`Run ${runId} is not bound to an Execution`);
    }
    return commandRunV14Schema.parse(raw);
  }

  listBoundExecutionRuns(sessionId: string, executionId: string, generation: number): CommandRunV14[] {
    if (!this.lock.isHeld) {
      return this.withLock(() => this.listBoundExecutionRunsUnlocked(sessionId, executionId, generation));
    }
    return this.listBoundExecutionRunsUnlocked(sessionId, executionId, generation);
  }

  private listBoundExecutionRunsUnlocked(
    sessionId: string,
    executionId: string,
    generation: number,
  ): CommandRunV14[] {
    const root = join(this.sessionDir(sessionId), 'runs');
    if (!existsSync(root)) return [];
    const runs: CommandRunV14[] = [];
    for (const runId of readdirSync(root).sort()) {
      const path = join(root, runId, 'run.json');
      if (!existsSync(path)) continue;
      const raw = this.readValidated(path, commandRunReadSchema);
      if (raw.schema_version !== 'command-run/1.4') continue;
      const run = commandRunV14Schema.parse(raw);
      if (run.execution_id === executionId && run.generation === generation) runs.push(run);
    }
    return runs;
  }

  readRunRecord(sessionId: string, runId: string): RunRead {
    if (!this.lock.isHeld) return this.withLock(() => this.readRunRecordUnlocked(sessionId, runId));
    return this.readRunRecordUnlocked(sessionId, runId);
  }

  /** Validate a canonical Run document without normalization or recovery writes. */
  readRunRecordReadOnly(sessionId: string, runId: string): RunRead {
    return this.readRunRecordUnlocked(sessionId, runId);
  }

  private readRunRecordUnlocked(sessionId: string, runId: string): RunRead {
    const run = this.readValidated(join(this.runDir(sessionId, runId), 'run.json'), runReadSchema);
    if ('session_id' in run && run.session_id !== sessionId) {
      throw new Error(`Run Session identity does not match its canonical path: ${sessionId}/${runId}`);
    }
    if ('run_id' in run && run.run_id !== runId) {
      throw new Error(`Run identity does not match its canonical path: ${sessionId}/${runId}`);
    }
    return run;
  }

  readRunV30(sessionId: string, runId: string): RunV30 {
    const run = this.readRunRecord(sessionId, runId);
    if (run.schema_version !== 'run/3.0') {
      throw new Error(`Run ${runId} uses ${run.schema_version}; run/3.0 is required`);
    }
    return runV30ReadSchema.parse(run);
  }

  writeRunV30(runInput: RunV30): RunV30 {
    return this.withLock(() => {
      const run = runV30Schema.parse(runInput);
      if (this.sessionSchemaSelection().writer !== 'session/3.0') {
        throw new Error('run/3.0 writes require the explicit session/3.0 writer selection');
      }
      const session = this.readSessionRecordUnlocked(run.session_id);
      if (session.schema_version !== 'session/3.0') {
        throw new Error(`Session ${run.session_id} uses ${session.schema_version}; session/3.0 is required`);
      }
      const path = join(this.runDir(run.session_id, run.run_id), 'run.json');
      if (existsSync(path)) {
        const current = this.readRunRecordUnlocked(run.session_id, run.run_id);
        if (current.schema_version !== 'run/3.0') {
          throw new Error(
            `Run ${run.run_id} uses ${current.schema_version}; legacy-to-v3 replacement requires the migration engine`,
          );
        }
      }
      this.writeBatchUnlocked([{
        path,
        value: run,
        schema: runV30Schema,
      }]);
      return clone(run);
    });
  }

  readRequestReceiptV20(sessionId: string, requestId: string): RequestReceiptV20 | null {
    if (!this.lock.isHeld) {
      return this.withLock(() => this.readRequestReceiptV20Unlocked(sessionId, requestId));
    }
    return this.readRequestReceiptV20Unlocked(sessionId, requestId);
  }

  private readRequestReceiptV20Unlocked(sessionId: string, requestId: string): RequestReceiptV20 | null {
    const path = this.requestReceiptV20Path(sessionId, requestId);
    if (!existsSync(path)) return null;
    const receipt = this.readValidated(path, requestReceiptV20Schema);
    if (receipt.request_id !== requestId) {
      throw new Error(`Request receipt identity does not match its canonical path: ${requestId}`);
    }
    return receipt;
  }

  readTransitionReceiptV20(
    sessionId: string,
    activityRevision: number,
    transitionId: string,
  ): TransitionReceiptV20 | null {
    const read = (): TransitionReceiptV20 | null => {
      const path = this.transitionReceiptV20Path(sessionId, activityRevision, transitionId);
      if (!existsSync(path)) return null;
      const receipt = this.readValidated(path, transitionReceiptV20Schema);
      if (receipt.session_id !== sessionId
        || receipt.activity_revision !== activityRevision
        || receipt.transition_id !== transitionId) {
        throw new Error(`Transition receipt identity does not match its canonical path: ${transitionId}`);
      }
      return receipt;
    };
    return this.lock.isHeld ? read() : this.withLock(read);
  }

  listTransitionReceiptsV20(sessionId: string): TransitionReceiptV20[] {
    const read = (): TransitionReceiptV20[] => {
      const root = this.transitionReceiptsDir(sessionId);
      if (!existsSync(root)) return [];
      const rootStat = lstatSync(root);
      if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
        throw new Error(`Invalid transition receipt directory: ${root}`);
      }
      const receipts: TransitionReceiptV20[] = [];
      for (const name of readdirSync(root).sort()) {
        if (name === '.backups') {
          const backupPath = join(root, name);
          const backupStats = lstatSync(backupPath);
          if (backupStats.isSymbolicLink() || !backupStats.isDirectory()) {
            throw new Error(`Invalid transition receipt backup directory: ${backupPath}`);
          }
          continue;
        }
        const match = /^(\d{12})-(.+)\.json$/.exec(name);
        if (!match) throw new Error(`Invalid transition receipt entry: ${join(root, name)}`);
        const path = join(root, name);
        const stats = lstatSync(path);
        if (stats.isSymbolicLink() || !stats.isFile()) {
          throw new Error(`Invalid transition receipt entry: ${path}`);
        }
        const receipt = this.readTransitionReceiptV20(sessionId, Number(match[1]), match[2]);
        if (!receipt) throw new Error(`Missing transition receipt: ${path}`);
        receipts.push(receipt);
      }
      return receipts.sort((left, right) => left.activity_revision - right.activity_revision
        || left.transition_id.localeCompare(right.transition_id));
    };
    return this.lock.isHeld ? read() : this.withLock(read);
  }

  readRun(sessionId: string, runId: string): CommandRun {
    if (!this.lock.isHeld) return this.withLock(() => this.readRunUnlocked(sessionId, runId));
    return this.readRunUnlocked(sessionId, runId);
  }

  /** Validate a Run without lock acquisition, recovery, or filesystem writes. */
  readRunReadOnly(sessionId: string, runId: string): CommandRun {
    return this.readRunUnlocked(sessionId, runId);
  }

  private readRunUnlocked(sessionId: string, runId: string): CommandRun {
    const raw = this.readRunRecordUnlocked(sessionId, runId);
    if (raw.schema_version === 'run/3.0') {
      throw new SessionSchemaUnsupportedError(sessionId);
    }
    const legacyRaw = commandRunReadSchema.parse(raw);
    const session = this.readBundleUnlocked(sessionId).session;
    const executorPlatform = targetPlatformSchema.safeParse(session.orchestration.executor?.platform);
    const fallbackPlatform = executorPlatform.success ? executorPlatform.data : 'claude';
    const run = legacyRaw.schema_version === 'command-run/1.3'
      ? legacyRaw as CommandRun
      : normalizeCommandRun(legacyRaw, fallbackPlatform);
    if (run.retry_fence && run.retry_fence.consumed_at === null) {
      const replacement = this.findRetryReplacementUnlocked(sessionId, run, fallbackPlatform);
      if (replacement) run.retry_fence.consumed_at = replacement.started_at;
    }
    return run;
  }

  private findRetryReplacementUnlocked(
    sessionId: string,
    parent: CommandRun,
    fallbackPlatform: z.infer<typeof targetPlatformSchema>,
  ): CommandRun | null {
    const root = join(this.sessionDir(sessionId), 'runs');
    if (!existsSync(root)) return null;
    for (const candidateId of readdirSync(root).sort()) {
      if (candidateId === parent.run_id) continue;
      const path = join(root, candidateId, 'run.json');
      if (!existsSync(path)) continue;
      const raw = this.readValidated(path, commandRunReadSchema);
      const candidate = raw.schema_version === 'command-run/1.3'
        ? raw as CommandRun
        : normalizeCommandRun(raw, fallbackPlatform);
      if (candidate.parent_run_id === parent.run_id
        && candidate.chain_step_id === parent.retry_fence?.chain_step_id
        && candidate.command.name === parent.command.name
        && candidate.creation_decision?.mode === 'retry'
        && candidate.creation_provenance.source_run_id === parent.run_id
        && candidate.sequence > parent.sequence) {
        return candidate;
      }
    }
    return null;
  }

  createExecutionAtomic<T>(
    sessionId: string,
    builder: (
      draft: SessionBundle,
      existing: readonly ExecutionState[],
      tx: StoreTransaction,
    ) => { execution: ExecutionState | null; result: T },
    options: Pick<ExecutionAtomicOptions, 'expectedActivityRevision'> = {},
  ): T {
    return this.withLock(() => {
      this.assertSessionV30MutationUnsupported(sessionId);
      const currentRecord = this.readSessionRecordUnlocked(sessionId);
      if (currentRecord.schema_version === 'session/2.0'
        && sessionStateV20Schema.parse(currentRecord).archived_at !== null) {
        throw new Error(`Session ${sessionId} is archived; unarchive it before starting an Execution`);
      }
      const draft = clone(this.readBundleUnlocked(sessionId));
      this.prepareExecutionCompatibilityDraft(currentRecord, draft);
      this.assertExpectedActivityRevision(currentRecord, options.expectedActivityRevision);
      const existing = this.listExecutionsUnlocked(sessionId);
      const tx = new StoreTransaction(this, sessionId);
      const built = builder(draft, existing, tx);
      if (!built.execution) return built.result;
      const execution = executionStateSchema.parse(built.execution);
      if (execution.session_id !== sessionId) throw new Error('Execution Session identity mismatch');
      if (existing.some(item => item.execution_id === execution.execution_id)) {
        throw new Error(`Execution already exists: ${execution.execution_id}`);
      }
      if (existing.some(item => item.generation === execution.generation)) {
        throw new Error(`Execution generation already exists: ${execution.generation}`);
      }
      if (execution.status !== 'sealed' && existing.some(item => item.status !== 'sealed')) {
        throw new Error(`Session ${sessionId} already has an open Execution`);
      }
      assertExecutionSessionInvariants(draft.session, execution);
      draft.session.schema_version = 'session/1.3';
      sessionStateV13Schema.parse(draft.session);
      const nextRecord = this.addExecutionAtomicBundleWrites(currentRecord, draft, execution, tx);
      tx.writeExecution(execution);
      this.assertPendingExecutionSealReceiptUnlocked(tx, execution, nextRecord, draft);
      this.writeBatchUnlocked(tx.writes);
      return built.result;
    });
  }

  updateExecutionAtomic<T>(
    sessionId: string,
    executionId: string,
    expectedRevision: number | undefined,
    mutator: (draft: SessionBundle, execution: ExecutionState, tx: StoreTransaction) => T,
    options: ExecutionAtomicOptions = {},
  ): T {
    return this.withLock(() => {
      this.assertSessionV30MutationUnsupported(sessionId);
      const currentRecord = this.readSessionRecordUnlocked(sessionId);
      const draft = clone(this.readBundleUnlocked(sessionId));
      this.prepareExecutionCompatibilityDraft(currentRecord, draft);
      const current = this.readExecutionUnlocked(sessionId, executionId);
      assertExecutionSessionInvariants(draft.session, current);
      const replayReceipt = options.replayRequestId
        ? this.readExecutionTransitionUnlocked(sessionId, executionId, options.replayRequestId)
        : null;
      if (!replayReceipt && expectedRevision !== undefined && current.revision !== expectedRevision) {
        throw new Error(`execution revision conflict: expected ${expectedRevision}, current ${current.revision}`);
      }
      if (!replayReceipt) {
        this.assertExpectedActivityRevision(currentRecord, options.expectedActivityRevision);
      }
      const execution = clone(current);
      const tx = new StoreTransaction(this, sessionId);
      const result = mutator(draft, execution, tx);
      if (current.status === 'sealed' && stableJsonUtf8(execution) !== stableJsonUtf8(current)) {
        throw new Error(`Execution ${executionId} is sealed and immutable`);
      }
      if (execution.session_id !== sessionId || execution.execution_id !== executionId
        || execution.generation !== current.generation) {
        throw new Error('Execution identity and generation are immutable');
      }
      if (execution.status !== 'sealed') {
        const sibling = this.listExecutionsUnlocked(sessionId)
          .find(item => item.execution_id !== executionId && item.status !== 'sealed');
        if (sibling) throw new Error(`Session ${sessionId} already has open Execution ${sibling.execution_id}`);
      }
      executionStateSchema.parse(execution);
      assertExecutionSessionInvariants(draft.session, execution);
      draft.session.schema_version = 'session/1.3';
      sessionStateV13Schema.parse(draft.session);
      const nextRecord = this.addExecutionAtomicBundleWrites(currentRecord, draft, execution, tx);
      tx.writeExecution(execution);
      this.assertPendingExecutionSealReceiptUnlocked(tx, execution, nextRecord, draft);
      this.writeBatchUnlocked(tx.writes);
      return result;
    });
  }

  update<T>(
    sessionId: string,
    mutator: (draft: SessionBundle, tx: StoreTransaction) => T,
    options: { allowOpenExecution?: boolean } = {},
  ): T {
    return this.withLock(() => {
      this.assertLegacySessionMutationAllowed(sessionId);
      const current = this.readBundle(sessionId);
      const openExecution = this.readOpenExecutionUnlocked(sessionId);
      if (openExecution && !options.allowOpenExecution) {
        throw new Error(
          `Session ${sessionId} has open Execution ${openExecution.execution_id}; execution binding and lease are required`,
        );
      }
      if (current.session.status === 'sealed' || current.session.status === 'archived') {
        throw new Error(`Session ${sessionId} is ${current.session.status} and immutable`);
      }
      const draft = clone(current);
      const tx = new StoreTransaction(this, sessionId);
      const result = mutator(draft, tx);
      // Compatible reads normalize legacy sessions in memory; every mutation
      // persists the coordinated canonical generation.
      draft.session.schema_version = 'session/1.3';
      sessionStateV13Schema.parse(draft.session);
      gateRegistrySchema.parse(draft.gates);
      artifactRegistrySchema.parse(draft.artifacts);
      evidenceStoreSchema.parse(draft.evidence);
      tx.addBundle(draft);
      this.writeBatchUnlocked(tx.writes);
      return result;
    });
  }

  /**
   * Record post-Run knowledge lifecycle metadata without reopening immutable
   * Session execution state. Only the lifecycle object and sidecar transaction
   * are exposed to the caller.
   */
  updateKnowledgeLifecycle<T>(
    sessionId: string,
    mutator: (lifecycle: SessionState['lifecycle'], tx: StoreTransaction) => T,
  ): T {
    return this.withLock(() => {
      this.assertLegacySessionMutationAllowed(sessionId);
      const draft = clone(this.readBundleUnlocked(sessionId));
      const tx = new StoreTransaction(this, sessionId);
      const result = mutator(draft.session.lifecycle, tx);
      sessionStateV13Schema.parse(draft.session);
      tx.addBundle(draft);
      this.writeBatchUnlocked(tx.writes);
      return result;
    });
  }

  /**
   * Commit knowledge sidecars and corpus files under one SessionStore lock and
   * one recoverable transaction intent. The caller performs its final CAS
   * reads inside the callback before queueing writes.
   */
  updateKnowledgeTransaction<T>(
    sessionId: string,
    mutator: (tx: StoreTransaction) => T,
  ): T {
    return this.withLock(() => {
      this.assertSessionV30MutationUnsupported(sessionId);
      this.readSessionRecordUnlocked(sessionId);
      const tx = new StoreTransaction(this, sessionId);
      const result = mutator(tx);
      if (tx.writes.length > 0) this.writeBatchUnlocked(tx.writes);
      return result;
    });
  }

  /**
   * Mutate one Run-owned sidecar only while that Run remains the canonical
   * active Run. This avoids rewriting the coordinated Session bundle for
   * high-frequency knowledge relation/candidate updates.
   */
  updateActiveRunSidecar<T, R>(
    sessionId: string,
    runId: string,
    path: string,
    schema: z.ZodType<T>,
    initial: T,
    mutator: (draft: T) => R,
  ): R {
    const safePath = this.assertWorkflowPath(path);
    return this.withLock(() => {
      const bundle = this.readBundleUnlocked(sessionId);
      const openExecution = this.readOpenExecutionUnlocked(sessionId);
      if (openExecution) {
        throw new Error(
          `Session ${sessionId} has open Execution ${openExecution.execution_id}; explicit Execution sidecar authority is required`,
        );
      }
      if (bundle.session.status !== 'running' || bundle.session.active_run_id !== runId) {
        throw new Error(
          `Run ${runId} is not the active Run for Session ${sessionId} `
          + '(completed/sealed runs are immutable; stage/record must happen before the Run completes)',
        );
      }
      const run = this.readRunUnlocked(sessionId, runId);
      if (run.status === 'sealed' || run.status === 'completed') {
        throw new Error(`Run ${runId} is ${run.status} and cannot mutate Run sidecars`);
      }
      const current = existsSync(safePath)
        ? this.readValidated(safePath, schema)
        : schema.parse(initial);
      const draft = clone(current);
      const result = mutator(draft);
      schema.parse(draft);
      this.writeBatchUnlocked([{ path: safePath, value: draft, schema }]);
      return result;
    });
  }

  /**
   * Mutate one Run-owned sidecar under exact active Execution authority. The
   * sidecar and its idempotency receipt are committed in the same recoverable
   * store transaction; the private lease token is represented only by a hash.
   */
  updateActiveExecutionRunSidecar<T, R extends Record<string, unknown>>(input: {
    sessionId: string;
    runId: string;
    path: string;
    schema: z.ZodType<T>;
    initial: T;
    authority: ExecutionRunSidecarAuthority;
    operation: 'knowledge-stage' | 'knowledge-record';
    requestPayload: unknown;
    revisionOf: (value: T) => number;
    mutator: (draft: T) => R;
    now?: Date;
    staleAfterMs?: number;
  }): { result: R; replayed: boolean } {
    const safePath = this.assertWorkflowPath(input.path);
    const runRoot = resolve(this.runDir(input.sessionId, input.runId));
    const sidecarRelative = relative(runRoot, safePath);
    if (!sidecarRelative || sidecarRelative.startsWith('..') || isAbsolute(sidecarRelative)) {
      throw new Error(`Execution sidecar path is not owned by Run ${input.runId}`);
    }
    const normalizedSidecarPath = sidecarRelative.replaceAll('\\', '/');
    const receiptPath = this.executionRunSidecarReceiptPath(
      input.sessionId,
      input.authority.executionId,
      input.authority.requestId,
    );
    const requestHash = sha256Prefixed(stableJsonUtf8({
      operation: input.operation,
      session_id: input.sessionId,
      execution_id: input.authority.executionId,
      generation: input.authority.generation,
      run_id: input.runId,
      sidecar_path: normalizedSidecarPath,
      expected_execution_revision: input.authority.expectedExecutionRevision,
      lease: {
        owner_id: input.authority.lease.ownerId,
        owner_kind: input.authority.lease.ownerKind,
        epoch: input.authority.lease.epoch,
        lease_id_hash: hashExecutionLeaseId(input.authority.lease.leaseId),
      },
      payload: input.requestPayload,
    }));

    return this.withLock(() => {
      const bundle = this.readBundleUnlocked(input.sessionId);
      const execution = this.readExecutionUnlocked(input.sessionId, input.authority.executionId);
      const openExecution = this.readOpenExecutionUnlocked(input.sessionId);
      if (execution.generation !== input.authority.generation) {
        throw new Error(
          `Execution generation conflict: expected ${input.authority.generation}, current ${execution.generation}`,
        );
      }
      if (execution.status !== 'active') {
        throw new Error(`Execution ${execution.execution_id} is ${execution.status}; active authority is required`);
      }
      if (!openExecution || openExecution.execution_id !== execution.execution_id) {
        throw new Error(`Execution ${execution.execution_id} is not the active Execution for Session ${input.sessionId}`);
      }
      if (execution.revision !== input.authority.expectedExecutionRevision) {
        throw new Error(
          `execution revision conflict: expected ${input.authority.expectedExecutionRevision}, current ${execution.revision}`,
        );
      }
      if (bundle.session.status !== 'running'
        || bundle.session.active_run_id !== input.runId
        || execution.active_run_id !== input.runId) {
        throw new Error(
          `Run ${input.runId} is not the active Run for Execution ${execution.execution_id} `
          + `and Session ${input.sessionId}`,
        );
      }
      const lease = assertExecutionLease(execution.lease, input.authority.lease);
      if (isExecutionLeaseStale(lease, input.now ?? new Date(), input.staleAfterMs)) {
        throw new Error('Execution lease is stale; heartbeat or recover it before mutating Run knowledge');
      }
      const run = this.readExecutionRunUnlocked(input.sessionId, input.runId);
      if (run.execution_id !== execution.execution_id || run.generation !== execution.generation) {
        throw new Error(`Run ${input.runId} belongs to a different Execution generation`);
      }
      if (run.status === 'sealed' || run.status === 'completed') {
        throw new Error(`Run ${input.runId} is ${run.status} and cannot mutate Run sidecars`);
      }

      const current = existsSync(safePath)
        ? this.readValidated(safePath, input.schema)
        : input.schema.parse(input.initial);
      const currentRevision = input.revisionOf(current);
      if (!Number.isInteger(currentRevision) || currentRevision < 0) {
        throw new Error(`Run ${input.runId} sidecar has an invalid revision`);
      }
      if (existsSync(receiptPath)) {
        const receipt = this.readValidated(receiptPath, executionRunSidecarReceiptSchema);
        if (receipt.operation !== input.operation
          || receipt.session_id !== input.sessionId
          || receipt.execution_id !== execution.execution_id
          || receipt.generation !== execution.generation
          || receipt.run_id !== input.runId
          || receipt.sidecar_path !== normalizedSidecarPath
          || receipt.expected_execution_revision !== input.authority.expectedExecutionRevision
          || receipt.lease.owner_id !== lease.owner_id
          || receipt.lease.owner_kind !== lease.owner_kind
          || receipt.lease.epoch !== lease.epoch
          || receipt.lease.lease_id_hash !== hashExecutionLeaseId(lease.lease_id)
          || receipt.request_hash !== requestHash) {
          throw new Error(`request_id ${input.authority.requestId} was already used with different sidecar inputs`);
        }
        if (currentRevision < receipt.sidecar_revision_after) {
          throw new Error(`request_id ${input.authority.requestId} receipt diverged from the Run sidecar`);
        }
        return { result: clone(receipt.result) as unknown as R, replayed: true };
      }

      const draft = clone(current);
      const result = input.mutator(draft);
      input.schema.parse(draft);
      const nextRevision = input.revisionOf(draft);
      if (nextRevision !== currentRevision + 1) {
        throw new Error(
          `Execution Run sidecar revision must advance exactly once: ${currentRevision} -> ${nextRevision}`,
        );
      }
      const receipt = executionRunSidecarReceiptSchema.parse({
        schema_version: 'execution-run-sidecar-transition/1.0',
        request_id: input.authority.requestId,
        operation: input.operation,
        session_id: input.sessionId,
        execution_id: execution.execution_id,
        generation: execution.generation,
        run_id: input.runId,
        sidecar_path: normalizedSidecarPath,
        expected_execution_revision: input.authority.expectedExecutionRevision,
        lease: {
          owner_id: lease.owner_id,
          owner_kind: lease.owner_kind,
          epoch: lease.epoch,
          lease_id_hash: hashExecutionLeaseId(lease.lease_id),
        },
        request_hash: requestHash,
        sidecar_revision_before: currentRevision,
        sidecar_revision_after: nextRevision,
        applied_at: (input.now ?? new Date()).toISOString(),
        result,
      });
      this.writeBatchUnlocked([
        { path: safePath, value: draft, schema: input.schema },
        { path: receiptPath, value: receipt, schema: executionRunSidecarReceiptSchema, mode: 0o600 },
      ]);
      return { result, replayed: false };
    });
  }

  /** Replace one active Run sidecar atomically after validating Run authority. */
  writeActiveRunSidecar<T>(
    sessionId: string,
    runId: string,
    path: string,
    value: T,
    schema: z.ZodType<T>,
  ): void {
    const safePath = this.assertWorkflowPath(path);
    this.withLock(() => {
      const bundle = this.readBundleUnlocked(sessionId);
      const openExecution = this.readOpenExecutionUnlocked(sessionId);
      if (openExecution) {
        throw new Error(
          `Session ${sessionId} has open Execution ${openExecution.execution_id}; explicit Execution sidecar authority is required`,
        );
      }
      if (bundle.session.status !== 'running' || bundle.session.active_run_id !== runId) {
        throw new Error(
          `Run ${runId} is not the active Run for Session ${sessionId} `
          + '(completed/sealed runs are immutable; stage/record must happen before the Run completes)',
        );
      }
      const run = this.readRunUnlocked(sessionId, runId);
      if (run.status === 'sealed' || run.status === 'completed') {
        throw new Error(`Run ${runId} is ${run.status} and cannot mutate Run sidecars`);
      }
      schema.parse(value);
      this.writeBatchUnlocked([{ path: safePath, value, schema }]);
    });
  }

  findRun(runId: string, sessionId?: string): { sessionId: string; run: CommandRun } {
    if (sessionId) {
      if (!this.sessionExists(sessionId)) {
        throw new Error(
          `Session not found: ${sessionId} (looking for Run ${runId}); `
          + 'list sessions with: maestro session list',
        );
      }
      if (!existsSync(join(this.runDir(sessionId, runId), 'run.json'))) {
        throw new Error(
          `Run not found: ${runId} in Session ${sessionId}; `
          + `check the run id with: maestro run list --session ${sessionId}`,
        );
      }
      return { sessionId, run: this.readRun(sessionId, runId) };
    }
    if (!existsSync(this.sessionsRoot)) throw new Error(`Run not found: ${runId}`);
    const matches: string[] = [];
    for (const candidate of readdirSync(this.sessionsRoot)) {
      if (existsSync(join(this.runDir(candidate, runId), 'run.json'))) matches.push(candidate);
    }
    if (matches.length === 0) throw new Error(`Run not found: ${runId}`);
    if (matches.length > 1) throw new Error(`Run ID is ambiguous; pass --session: ${runId}`);
    return { sessionId: matches[0], run: this.readRun(matches[0], runId) };
  }

  /** Enumerate canonical Session files only; state.json is never consulted. */
  listSessions(filters: SessionListFilters = {}): SessionListResult {
    return this.withLock(() => this.listSessionsUnlocked(filters));
  }

  /** Enumerate Sessions without lock acquisition, recovery, or projection writes. */
  listSessionsReadOnly(filters: SessionListFilters = {}): SessionListResult {
    return this.listSessionsUnlocked(filters);
  }

  private listSessionsUnlocked(filters: SessionListFilters): SessionListResult {
    const candidates: SessionListCandidate[] = [];
    const exclusions: SessionListExclusion[] = [];
    if (!existsSync(this.sessionsRoot)) return { candidates, exclusions };
    for (const sessionId of readdirSync(this.sessionsRoot).sort()) {
      const path = join(this.sessionsRoot, sessionId);
      try {
        if (!statSync(path).isDirectory() || !existsSync(join(path, 'session.json'))) continue;
        const session = this.readBundleUnlocked(sessionId).session;
        if (filters.statuses && !filters.statuses.includes(session.status)) {
          exclusions.push({ sessionId, code: 'STATUS_FILTERED', detail: session.status });
          continue;
        }
        if (filters.engines && !filters.engines.includes(session.orchestration.engine)) {
          exclusions.push({ sessionId, code: 'ENGINE_FILTERED', detail: session.orchestration.engine });
          continue;
        }
        let identity = session.intent_identity;
        if (!identity && filters.intentIdentity) {
          identity = createIntentIdentity(
            this.projectRoot,
            filters.intentIdentity.command,
            session.intent,
            { source: 'derived_legacy', backfillStatus: 'derived' },
          );
        }
        if (filters.intentIdentity) {
          if (!identity) {
            exclusions.push({ sessionId, code: 'IDENTITY_UNAVAILABLE', detail: 'no native or derivable identity' });
            continue;
          }
          if (!sameIntentIdentity(identity, filters.intentIdentity)) {
            exclusions.push({ sessionId, code: 'IDENTITY_MISMATCH', detail: identity.normalized_hash });
            continue;
          }
        }
        candidates.push({ sessionId, session: clone(session), identity: identity ? clone(identity) : null });
      } catch (error) {
        exclusions.push({
          sessionId,
          code: 'CORRUPT',
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { candidates, exclusions };
  }

  /**
   * Resolve the unique active Run from canonical session.json files only.
   * This avoids parsing every coordinated Session bundle on each knowledge load.
   */
  findUniqueActiveRun(): { sessionId: string; runId: string } | null {
    if (!existsSync(this.sessionsRoot)) return null;
    let active: { sessionId: string; runId: string } | null = null;
    for (const sessionId of readdirSync(this.sessionsRoot).sort()) {
      const sessionPath = join(this.sessionsRoot, sessionId, 'session.json');
      if (!existsSync(sessionPath)) continue;
      try {
        const session = this.readValidated(sessionPath, sessionStateSchema);
        if (session.status !== 'running' || !session.active_run_id) continue;
        if (active) return null;
        active = { sessionId, runId: session.active_run_id };
      } catch {
        // Corrupt sessions cannot be authoritative active-run candidates.
      }
    }
    return active;
  }

  /**
   * Enumerate Sessions currently in `running` status with their active Run
   * (if any). Used by the knowledge write-authority resolver to implement the
   * narrowed single-session scan and fail-closed ambiguity reporting.
   */
  listRunningSessions(): Array<{ sessionId: string; activeRunId: string | null }> {
    if (!existsSync(this.sessionsRoot)) return [];
    const running: Array<{ sessionId: string; activeRunId: string | null }> = [];
    for (const sessionId of readdirSync(this.sessionsRoot).sort()) {
      const sessionPath = join(this.sessionsRoot, sessionId, 'session.json');
      if (!existsSync(sessionPath)) continue;
      try {
        const session = this.readValidated(sessionPath, sessionStateSchema);
        if (session.status !== 'running') continue;
        running.push({ sessionId, activeRunId: session.active_run_id ?? null });
      } catch {
        // Corrupt sessions cannot participate in authority resolution.
      }
    }
    return running;
  }

  issueRecallConfirmation(input: IssueRecallConfirmationInput): { token: string; record: RecallConfirmationRecord } {
    return this.withLock(() => {
      let registry = this.readRecallRegistryUnlocked();
      const issued = issueRecallConfirmationRecord(input);
      if (issued.record.schema_version === 'recall-confirmation/1.1'
        && registry.schema_version === 'recall-confirmations/1.0') {
        registry = recallConfirmationRegistryV11Schema.parse({
          ...registry,
          schema_version: 'recall-confirmations/1.1',
        });
      }
      if (registry.records[issued.record.token_hash]) throw new Error('recall confirmation token hash collision');
      registry.records[issued.record.token_hash] = issued.record;
      registry.revision++;
      this.writeBatchUnlocked([{
        path: this.recallRegistryPath(),
        value: registry,
        schema: recallConfirmationRegistrySchema,
      }]);
      return { token: issued.token, record: clone(issued.record) };
    });
  }

  readRecallConfirmation(token: string): RecallConfirmationRecord | null {
    return this.withLock(() => {
      const record = this.readRecallRegistryUnlocked().records[hashRecallConfirmationToken(token)];
      return record ? clone(record) : null;
    });
  }

  reserveRecallConfirmation(
    token: string,
    input: ReserveRecallConfirmationInput,
  ): SessionStoreReserveRecallResult {
    return this.withLock(() => {
      const registry = this.readRecallRegistryUnlocked();
      const tokenHash = hashRecallConfirmationToken(token);
      const current = registry.records[tokenHash];
      if (!current) throw new RecallConfirmationError('TOKEN_INVALID', 'confirmation token not found');
      const result = reserveRecallConfirmationRecord(current, input);
      if (result.status !== 'reserved') return clone({ ...result, validated_source: null });
      const validatedSource = this.validateRecallSourceFenceUnlocked(input.action, input.source_fence);
      this.assertRecallTargetFenceUnlocked(input.target_fence);
      if (this.findRecallReservationUnlocked(registry, result.reservation_id)) {
        throw new Error('recall confirmation reservation ID collision');
      }
      registry.records[tokenHash] = result.record;
      registry.revision++;
      this.writeBatchUnlocked([{
        path: this.recallRegistryPath(),
        value: registry,
        schema: recallConfirmationRegistrySchema,
      }]);
      return clone({ ...result, validated_source: validatedSource });
    });
  }

  validateRecallConfirmationSource(
    action: RecallConfirmationRecord['action'],
    sourceFence: RecallConfirmationRecord['source_fence'],
  ): ValidatedRecallSource | null {
    return this.withLock(() => this.validateRecallSourceFenceUnlocked(action, sourceFence));
  }

  claimRecallConfirmationTarget(
    reservationId: string,
    now = new Date(),
  ): { reservation_id: string; marker: RecallReservationMarker; marker_path: string } {
    return this.withLock(() => {
      const registry = this.readRecallRegistryUnlocked();
      const located = this.findRecallReservationUnlocked(registry, reservationId);
      if (!located?.record.reservation) {
        throw new RecallConfirmationError('RESERVATION_INVALID', 'confirmation reservation not found');
      }
      const reservation = located.record.reservation;
      if (!['reserved', 'target-claimed'].includes(reservation.phase) || Date.parse(reservation.expires_at) <= now.getTime()) {
        throw new RecallConfirmationError('RESERVATION_INVALID', 'confirmation reservation cannot claim a target');
      }
      if (reservation.phase === 'target-claimed') {
        const marker = this.assertRecallReservationMarkerUnlocked(reservation);
        return {
          reservation_id: reservationId,
          marker: clone(marker),
          marker_path: this.recallReservationMarkerPath(reservation.proposed_target.session_id),
        };
      }
      this.assertRecallTargetFenceUnlocked(reservation.target_fence);
      const marker = createRecallReservationMarker(reservation);
      const markerPath = this.recallReservationMarkerPath(reservation.proposed_target.session_id);
      if (existsSync(markerPath)) {
        const existing = this.readValidated(markerPath, recallReservationMarkerSchema);
        if (stableJsonUtf8(existing) !== stableJsonUtf8(marker)) {
          throw new RecallConfirmationError('FENCE_CONFLICT', 'target reservation marker belongs to another reservation');
        }
      } else {
        const targetDir = this.sessionDir(reservation.proposed_target.session_id);
        if (existsSync(targetDir) && readdirSync(targetDir).length > 0) {
          throw new RecallConfirmationError('FENCE_CONFLICT', 'target directory exists without the reservation marker');
        }
        mkdirSync(targetDir, { recursive: true });
      }
      const claimed = recallConfirmationRecordReadSchema.parse({
        ...located.record,
        reservation: { ...reservation, phase: 'target-claimed' },
      });
      registry.records[located.tokenHash] = claimed;
      registry.revision++;
      this.writeBatchUnlocked([
        { path: markerPath, value: marker, schema: recallReservationMarkerSchema },
        { path: this.recallRegistryPath(), value: registry, schema: recallConfirmationRegistrySchema },
      ]);
      return { reservation_id: reservationId, marker: clone(marker), marker_path: markerPath };
    });
  }

  readRecallTargetHash(target: RecallConfirmationFinalTarget): string {
    return this.withLock(() => this.recallTargetHashUnlocked(target));
  }

  finalizeRecallConfirmation(
    reservationId: string,
    input: FinalizeRecallConfirmationInput,
  ): { outcome: RecallConfirmationOutcome; replayed: boolean } {
    return this.withLock(() => {
      const registry = this.readRecallRegistryUnlocked();
      const located = this.findRecallReservationUnlocked(registry, reservationId, true);
      if (!located) throw new RecallConfirmationError('RESERVATION_INVALID', 'confirmation reservation not found');
      if (!located.record.outcome) {
        this.validateRecallSourceFenceUnlocked(located.record.action, located.record.source_fence);
        if (located.record.reservation && ['target-claimed', 'resume-finalize'].includes(located.record.reservation.phase)) {
          this.assertRecallReservationMarkerUnlocked(located.record.reservation);
        }
        const actualTargetHash = this.recallTargetHashUnlocked(input.target);
        if (actualTargetHash !== input.target_hash) {
          throw new RecallConfirmationError('FENCE_CONFLICT', 'final target authority hash changed');
        }
      }
      const finalized = finalizeRecallConfirmationRecord(located.record, reservationId, input);
      if (finalized.replayed) return { outcome: clone(finalized.outcome), replayed: true };
      registry.records[located.tokenHash] = finalized.record;
      registry.revision++;
      this.writeBatchUnlocked([{
        path: this.recallRegistryPath(),
        value: registry,
        schema: recallConfirmationRegistrySchema,
      }]);
      const markerPath = this.recallReservationMarkerPath(finalized.outcome.target.session_id);
      if (existsSync(markerPath)) {
        try {
          const marker = JSON.parse(readFileSync(markerPath, 'utf8')) as { reservation_id?: unknown };
          if (marker.reservation_id === reservationId) rmSync(markerPath, { force: true });
        } catch { /* finalized authority is durable; an unrelated marker is left untouched */ }
      }
      return { outcome: clone(finalized.outcome), replayed: false };
    });
  }

  cancelRecallConfirmation(
    reservationId: string,
    now = new Date(),
  ): { reservation_id: string; rollback_target: RecallConfirmationTargetIdentity; released: boolean } {
    return this.withLock(() => {
      const registry = this.readRecallRegistryUnlocked();
      const located = this.findRecallReservationUnlocked(registry, reservationId);
      if (!located) throw new RecallConfirmationError('RESERVATION_INVALID', 'confirmation reservation not found');
      if (located.record.reservation?.phase === 'target-claimed') {
        this.assertRecallReservationMarkerUnlocked(located.record.reservation);
      }
      const cancelled = cancelRecallConfirmationRecord(located.record, reservationId, now);
      registry.records[located.tokenHash] = cancelled.record;
      registry.revision++;
      this.writeBatchUnlocked([{
        path: this.recallRegistryPath(),
        value: registry,
        schema: recallConfirmationRegistrySchema,
      }]);
      return {
        reservation_id: reservationId,
        rollback_target: clone(cancelled.rollback_target),
        released: cancelled.released,
      };
    });
  }

  observeRecallConfirmationReservation(
    reservationId: string,
    observedAt = new Date(),
  ): RecallReservationObservation {
    return this.withLock(() => {
      const registry = this.readRecallRegistryUnlocked();
      const located = this.findRecallReservationUnlocked(registry, reservationId);
      if (!located?.record.reservation) {
        throw new RecallConfirmationError('RESERVATION_INVALID', 'confirmation reservation not found');
      }
      return this.observeRecallReservationUnlocked(located.record.reservation, observedAt);
    });
  }

  reconcileExpiredRecallConfirmation(
    reservationId: string,
    reportedInput: RecallReservationObservation,
    now = new Date(),
  ): RecallReservationReconciliation {
    return this.withLock(() => {
      const registry = this.readRecallRegistryUnlocked();
      const located = this.findRecallReservationUnlocked(registry, reservationId);
      if (!located?.record.reservation) {
        throw new RecallConfirmationError('RESERVATION_INVALID', 'confirmation reservation not found');
      }
      const reservation = located.record.reservation;
      if (Date.parse(reservation.expires_at) > now.getTime() && reservation.phase !== 'rollback-partial') {
        throw new RecallConfirmationError('RESERVATION_INVALID', 'confirmation reservation is not expired');
      }
      const reported = recallReservationObservationSchema.parse(reportedInput);
      if (reported.reservation_id !== reservationId) {
        throw new RecallConfirmationError('REQUEST_CONFLICT', 'reconciliation observation reservation mismatch');
      }
      const actual = this.observeRecallReservationUnlocked(reservation, new Date(reported.observed_at));
      const stale = createStaleRecallReservation(reservation);
      let decision: RecallReservationReconciliation['decision'] = 'conflict';
      let reason = 'reported marker or target authority does not match canonical observation';
      let reconcileExpiresAt: string | null = null;
      if (stableJsonUtf8(reported) === stableJsonUtf8(actual)) {
        const identityMatches = actual.target.intent_identity !== null
          && sameIntentIdentity(actual.target.intent_identity, reservation.proposed_target.intent_identity);
        if (actual.marker.state === 'matching' && actual.target.state === 'complete' && identityMatches) {
          try {
            this.validateRecallSourceFenceUnlocked(reservation.action, reservation.source_fence);
            decision = 'resume_finalize';
            reason = 'matching reservation marker and complete target authority can resume finalize';
            reconcileExpiresAt = new Date(now.getTime() + RECALL_CONFIRMATION_RECONCILIATION_TTL_MS).toISOString();
          } catch {
            decision = 'conflict';
            reason = 'source authority fence changed during reconciliation';
          }
        } else if (
          (actual.marker.state === 'matching' && actual.target.state === 'partial')
          || (actual.marker.state === 'missing' && actual.target.state === 'absent')
        ) {
          decision = 'rollback_partial';
          reason = actual.target.state === 'absent'
            ? 'no target authority exists; stale reservation may be released after confirmation'
            : 'matching reservation marker bounds rollback to the stale partial target';
        } else if (actual.target.state === 'complete' && !identityMatches) {
          reason = 'complete target belongs to a different intent identity';
        } else if (actual.marker.state === 'mismatched') {
          reason = 'target marker belongs to a different reservation';
        } else {
          reason = 'target authority is not safely attributable to the stale reservation';
        }
      }
      const phase = decision === 'resume_finalize'
        ? 'resume-finalize'
        : decision === 'rollback_partial' ? 'rollback-partial' : 'conflict';
      const updated = recallConfirmationRecordReadSchema.parse({
        ...located.record,
        reservation: { ...reservation, phase, reconcile_expires_at: reconcileExpiresAt },
      });
      registry.records[located.tokenHash] = updated;
      registry.revision++;
      this.writeBatchUnlocked([{
        path: this.recallRegistryPath(), value: registry, schema: recallConfirmationRegistrySchema,
      }]);
      return recallReservationReconciliationSchema.parse({
        schema_version: 'recall-reservation-reconciliation/1.0',
        reservation_id: reservationId,
        decision,
        reason,
        stale,
        observed: actual,
        reconcile_expires_at: reconcileExpiresAt,
      });
    });
  }

  completeRecallConfirmationRollback(
    reservationId: string,
    reportedInput: RecallReservationObservation,
  ): { reservation_id: string; rollback_target: RecallConfirmationTargetIdentity; released: true } {
    return this.withLock(() => {
      const registry = this.readRecallRegistryUnlocked();
      const located = this.findRecallReservationUnlocked(registry, reservationId);
      if (!located?.record.reservation || located.record.reservation.phase !== 'rollback-partial') {
        throw new RecallConfirmationError('RESERVATION_INVALID', 'rollback reconciliation is not authorized');
      }
      const reservation = located.record.reservation;
      const reported = recallReservationObservationSchema.parse(reportedInput);
      const actual = this.observeRecallReservationUnlocked(reservation, new Date(reported.observed_at));
      if (stableJsonUtf8(reported) !== stableJsonUtf8(actual)) {
        throw new RecallConfirmationError('FENCE_CONFLICT', 'rollback observation does not match canonical target authority');
      }
      if (actual.marker.state !== 'missing' || actual.target.state !== 'absent') {
        throw new RecallConfirmationError('FENCE_CONFLICT', 'rollback target or reservation marker still exists');
      }
      registry.records[located.tokenHash] = recallConfirmationRecordReadSchema.parse({
        ...located.record,
        reservation: null,
      });
      registry.revision++;
      this.writeBatchUnlocked([{
        path: this.recallRegistryPath(), value: registry, schema: recallConfirmationRegistrySchema,
      }]);
      return {
        reservation_id: reservationId,
        rollback_target: clone(reservation.proposed_target),
        released: true,
      };
    });
  }

  consumeRecallConfirmation(
    token: string,
    expected: { action: RecallConfirmationRecord['action']; request_hash: string; now?: Date },
    result: { session_id: string; run_id?: string | null },
  ): RecallConfirmationRecord {
    return this.withLock(() => {
      const registry = this.readRecallRegistryUnlocked();
      const tokenHash = hashRecallConfirmationToken(token);
      const current = registry.records[tokenHash];
      if (!current) throw new RecallConfirmationError('TOKEN_INVALID', 'confirmation token not found');
      const record = assertRecallConfirmationConsumable(current, expected);
      const consumed = {
        ...record,
        consumed_at: (expected.now ?? new Date()).toISOString(),
        result_session_id: result.session_id,
        result_run_id: result.run_id ?? null,
        reservation: null,
      };
      registry.records[tokenHash] = consumed;
      registry.revision++;
      this.writeBatchUnlocked([{
        path: this.recallRegistryPath(),
        value: registry,
        schema: recallConfirmationRegistrySchema,
      }]);
      return clone(consumed);
    });
  }

  readSessionFence(sessionId: string, runId?: string | null): TransitionFence {
    return this.withLock(() => this.sessionFenceUnlocked(sessionId, runId));
  }

  validateSourceTargetFences(input: {
    source: { session_id: string; run_id?: string | null; fence: TransitionFence };
    target?: { session_id: string; run_id?: string | null; fence: TransitionFence };
  }): { source: TransitionFence; target: TransitionFence | null } {
    return this.withLock(() => {
      const source = this.sessionFenceUnlocked(input.source.session_id, input.source.run_id);
      if (JSON.stringify(source) !== JSON.stringify(transitionFenceSchema.parse(input.source.fence))) {
        throw new Error('source authority fence changed');
      }
      const target = input.target
        ? this.sessionFenceUnlocked(input.target.session_id, input.target.run_id)
        : null;
      if (target && input.target && JSON.stringify(target) !== JSON.stringify(transitionFenceSchema.parse(input.target.fence))) {
        throw new Error('target authority fence changed');
      }
      return { source, target };
    });
  }

  replayOrApplyArtifactRepublishTransition(
    sessionId: string,
    request: TransitionRequest,
    apply: (draft: SessionBundle, tx: StoreTransaction) => TransitionOutcome,
  ): { outcome: TransitionOutcome; replayed: boolean } {
    return this.withLock(() => {
      this.assertSessionV30MutationUnsupported(sessionId);
      const currentRecord = this.readSessionRecordUnlocked(sessionId);
      const current = this.readBundleUnlocked(sessionId);
      const openExecution = this.readOpenExecutionUnlocked(sessionId);
      if (openExecution) {
        throw new Error(
          `Session ${sessionId} has open Execution ${openExecution.execution_id}; Artifact republish requires no open Execution`,
        );
      }
      if (currentRecord.schema_version === 'session/2.0' && currentRecord.archived_at !== null) {
        throw new Error(`Session ${sessionId} is archived and immutable`);
      }
      const currentFence = this.sessionFenceForBundle(current, request.subject.run_id);
      const records = current.session.requests
        .filter(item => item.type === 'transition' && 'outcome' in item)
        .map(item => item as Extract<SessionState['requests'][number], { type: 'transition' }>);
      const draft = clone(current);
      this.prepareExecutionCompatibilityDraft(currentRecord, draft);
      const tx = new StoreTransaction(this, sessionId);
      const evaluated = replayOrApplyTransition(
        records,
        request,
        currentFence,
        () => apply(draft, tx),
      );
      if (evaluated.replayed) return { outcome: clone(evaluated.outcome), replayed: true };
      const actualPost = this.sessionFenceForBundle(draft, request.subject.run_id, tx);
      if (JSON.stringify(actualPost) !== JSON.stringify(evaluated.outcome.postconditions)) {
        throw new Error(`transition ${evaluated.outcome.transition_id} postcondition fence does not match the draft`);
      }
      draft.session.requests.push(evaluated.record);
      draft.session.schema_version = 'session/1.3';
      sessionStateV13Schema.parse(draft.session);
      gateRegistrySchema.parse(draft.gates);
      artifactRegistrySchema.parse(draft.artifacts);
      evidenceStoreSchema.parse(draft.evidence);
      if (currentRecord.schema_version === 'session/2.0') {
        const nextIdentity = sessionStateV20Schema.parse({
          ...currentRecord,
          activity_revision: draft.session.activity_revision,
          latest_completed_run_id: draft.session.latest_completed_run_id,
        });
        tx.addStatuslessBundle(draft, nextIdentity);
      } else {
        tx.addBundle(draft);
      }
      this.writeBatchUnlocked(tx.writes);
      return { outcome: clone(evaluated.outcome), replayed: false };
    });
  }

  replayOrApplyTransition(
    sessionId: string,
    request: TransitionRequest,
    apply: (draft: SessionBundle, tx: StoreTransaction) => TransitionOutcome,
    validateReplay?: (record: PersistedTransitionRecord) => void,
    options: { allowOpenExecution?: boolean } = {},
  ): { outcome: TransitionOutcome; replayed: boolean } {
    return this.withLock(() => {
      this.assertLegacySessionMutationAllowed(sessionId);
      const current = this.readBundleUnlocked(sessionId);
      const openExecution = this.readOpenExecutionUnlocked(sessionId);
      if (openExecution && !options.allowOpenExecution) {
        throw new Error(
          `Session ${sessionId} has open Execution ${openExecution.execution_id}; execution binding and lease are required`,
        );
      }
      const currentFence = this.sessionFenceForBundle(current, request.subject.run_id);
      const records = current.session.requests
        .filter(item => item.type === 'transition' && 'outcome' in item)
        .map(item => item as Extract<SessionState['requests'][number], { type: 'transition' }>);
      const draft = clone(current);
      const tx = new StoreTransaction(this, sessionId);
      const evaluated = replayOrApplyTransition(
        records,
        request,
        currentFence,
        () => apply(draft, tx),
        validateReplay,
      );
      if (evaluated.replayed) return { outcome: clone(evaluated.outcome), replayed: true };
      const actualPost = this.sessionFenceForBundle(draft, request.subject.run_id, tx);
      if (JSON.stringify(actualPost) !== JSON.stringify(evaluated.outcome.postconditions)) {
        throw new Error(`transition ${evaluated.outcome.transition_id} postcondition fence does not match the draft`);
      }
      draft.session.requests.push(evaluated.record);
      draft.session.schema_version = 'session/1.3';
      sessionStateV13Schema.parse(draft.session);
      tx.addBundle(draft);
      this.writeBatchUnlocked(tx.writes);
      return { outcome: clone(evaluated.outcome), replayed: false };
    });
  }

  listSessionArchiveReceipts(sessionId: string): SessionArchiveReceipt[] {
    if (!this.lock.isHeld) return this.withLock(() => this.listSessionArchiveReceiptsUnlocked(sessionId));
    return this.listSessionArchiveReceiptsUnlocked(sessionId);
  }

  private listSessionArchiveReceiptsUnlocked(sessionId: string): SessionArchiveReceipt[] {
    const root = join(this.sessionDir(sessionId), 'archive-receipts');
    if (!existsSync(root)) return [];
    return readdirSync(root)
      .filter(name => name.endsWith('.json'))
      .sort()
      .map(name => this.readValidated(join(root, name), sessionArchiveReceiptSchema));
  }

  applySessionArchiveReceipt(receiptInput: SessionArchiveReceipt): SessionIdentityV20 {
    return this.withLock<SessionIdentityV20>(() => {
      const receipt = sessionArchiveReceiptSchema.parse(receiptInput);
      this.assertSessionV30MutationUnsupported(receipt.session_id);
      if (this.sessionSchemaSelection().writer !== 'session/2.0') {
        throw new Error('session/2.0 archive writes require the explicit project Session schema feature');
      }
      if (sessionArchiveReceiptHash(receipt) !== receipt.receipt_hash) {
        throw new Error('Session archive receipt hash mismatch');
      }
      const currentRecord = this.readSessionRecordUnlocked(receipt.session_id);
      if (currentRecord.schema_version !== 'session/2.0') {
        throw new Error(`Session ${receipt.session_id} is not session/2.0`);
      }
      const current = sessionStateV20Schema.parse(currentRecord);
      const isArchive = receipt.operation === 'archive';
      if (isArchive) {
        const openExecutions = this.listExecutionsUnlocked(receipt.session_id)
          .filter(execution => execution.status === 'active' || execution.status === 'paused');
        if (current.current_execution_id !== null || openExecutions.length > 0) {
          const openIds = openExecutions.map(execution => execution.execution_id).sort();
          throw new Error(
            `Session ${receipt.session_id} cannot be archived while an Execution is current or open`
            + (openIds.length > 0 ? `: ${openIds.join(', ')}` : ''),
          );
        }
      }
      const receiptPath = this.sessionArchiveReceiptPath(receipt.session_id, receipt.after.activity_revision);
      if (existsSync(receiptPath)) {
        const existing = this.readValidated(receiptPath, sessionArchiveReceiptSchema);
        if (stableJsonUtf8(existing) !== stableJsonUtf8(receipt)) {
          throw new Error(`Session archive receipt is immutable: ${receipt.receipt_id}`);
        }
        const currentState = {
          identity_revision: current.identity_revision,
          activity_revision: current.activity_revision,
          archived_at: current.archived_at,
          archived_by: current.archived_by,
        };
        if (stableJsonUtf8(currentState) !== stableJsonUtf8(receipt.after)) {
          throw new Error('Session archive receipt replay diverged from canonical state');
        }
        return clone(current);
      }
      const before = {
        identity_revision: current.identity_revision,
        activity_revision: current.activity_revision,
        archived_at: current.archived_at,
        archived_by: current.archived_by,
      };
      if (stableJsonUtf8(before) !== stableJsonUtf8(receipt.before)) {
        throw new Error('Session archive receipt CAS conflict');
      }
      if (receipt.after.identity_revision !== receipt.before.identity_revision
        || receipt.after.activity_revision !== receipt.before.activity_revision + 1) {
        throw new Error('Session archive receipt revisions are not a deterministic CAS successor');
      }
      const existingReceipts = this.listSessionArchiveReceiptsUnlocked(receipt.session_id);
      const previousHash = existingReceipts.at(-1)?.receipt_hash ?? null;
      if (receipt.previous_receipt_hash !== previousHash) {
        throw new Error('Session archive receipt history hash conflict');
      }
      if (isArchive
        ? receipt.after.archived_at !== receipt.recorded_at || receipt.after.archived_by !== receipt.actor
        : receipt.after.archived_at !== null || receipt.after.archived_by !== null) {
        throw new Error('Session archive receipt operation does not match its post-state');
      }
      const next = sessionStateV20Schema.parse({
        ...current,
        identity_revision: receipt.after.identity_revision,
        activity_revision: receipt.after.activity_revision,
        archived_at: receipt.after.archived_at,
        archived_by: receipt.after.archived_by,
      });
      this.writeBatchUnlocked([
        {
          path: join(this.sessionDir(receipt.session_id), 'session.json'),
          value: next,
          schema: sessionStateV20Schema,
        },
        { path: receiptPath, value: receipt, schema: sessionArchiveReceiptSchema },
      ]);
      return clone(next);
    });
  }

  migrateLegacySessionToV20(input: {
    identity: SessionIdentityV20;
    compatibility: SessionState;
    legacyExecution?: ExecutionState;
    archiveReceipt?: SessionArchiveReceipt;
    sourceIdentityRevision: number;
    sourceActivityRevision: number;
  }): void {
    this.withLock(() => {
      this.assertSessionV30MutationUnsupported(input.identity.session_id);
      if (this.sessionSchemaSelection().writer !== 'session/2.0') {
        throw new Error('session/2.0 migration requires the explicit project Session schema feature');
      }
      const current = this.readSessionRecordUnlocked(input.identity.session_id);
      if (current.schema_version === 'session/2.0') return;
      if (!current.schema_version.startsWith('session/1.')) {
        throw new Error(`Cannot migrate unsupported Session version: ${current.schema_version}`);
      }
      const identity = sessionStateV20Schema.parse(input.identity);
      const compatibility = sessionStateV13Schema.parse(input.compatibility);
      const lockedCompatibility = this.readBundleUnlocked(identity.session_id).session;
      if (lockedCompatibility.identity_revision !== input.sourceIdentityRevision
        || lockedCompatibility.activity_revision !== input.sourceActivityRevision) {
        throw new Error(
          `session/2.0 migration source revision conflict: expected `
          + `${input.sourceIdentityRevision}/${input.sourceActivityRevision}, current `
          + `${lockedCompatibility.identity_revision}/${lockedCompatibility.activity_revision}`,
        );
      }
      if (identity.session_id !== compatibility.session_id) {
        throw new Error('session/2.0 migration Session identity mismatch');
      }

      const persistedExecutions = this.listExecutionsUnlocked(identity.session_id);
      let executions = persistedExecutions;
      let legacyExecution: ExecutionState | null = null;
      if (executions.length === 0) {
        if (!input.legacyExecution) {
          throw new Error('session/2.0 migration requires a legacy generation-1 Execution fallback');
        }
        legacyExecution = executionStateSchema.parse(input.legacyExecution);
        if (legacyExecution.session_id !== identity.session_id || legacyExecution.generation !== 1) {
          throw new Error('session/2.0 migration legacy Execution identity or generation mismatch');
        }
        executions = [legacyExecution];
      } else if (input.legacyExecution) {
        throw new Error('session/2.0 migration must not synthesize over existing Execution projections');
      }

      const executionIds = new Set<string>();
      const generations = new Set<number>();
      for (const execution of executions) {
        if (execution.session_id !== identity.session_id) {
          throw new Error(`Execution ${execution.execution_id} belongs to Session ${execution.session_id}`);
        }
        if (executionIds.has(execution.execution_id)) {
          throw new Error(`Duplicate Execution identity during migration: ${execution.execution_id}`);
        }
        if (generations.has(execution.generation)) {
          throw new Error(`Duplicate Execution generation during migration: ${execution.generation}`);
        }
        executionIds.add(execution.execution_id);
        generations.add(execution.generation);
      }
      const openExecutions = executions.filter(execution => execution.status !== 'sealed');
      if (openExecutions.length > 1) {
        throw new Error(
          `Session ${identity.session_id} has multiple nonsealed Executions: `
          + openExecutions.map(execution => execution.execution_id).sort().join(', '),
        );
      }
      if (identity.archived_at !== null && openExecutions.length > 0) {
        throw new Error(`Archived Session ${identity.session_id} cannot retain a nonsealed Execution`);
      }
      const latestExecution = executions.reduce((latest, execution) => (
        execution.generation > latest.generation ? execution : latest
      ));
      const currentExecutionId = openExecutions[0]?.execution_id ?? null;
      if (persistedExecutions.length > 0 && openExecutions[0]) {
        assertExecutionSessionInvariants(compatibility, openExecutions[0]);
      }
      if (identity.current_execution_id !== currentExecutionId
        || identity.latest_execution_id !== latestExecution.execution_id) {
        throw new Error('session/2.0 migration Execution pointers do not match reconciled generations');
      }

      const runRoot = join(this.sessionDir(identity.session_id), 'runs');
      const runRecords: Array<{ path: string; run: CommandRunInput }> = [];
      if (existsSync(runRoot)) {
        for (const runId of readdirSync(runRoot).sort()) {
          const path = join(runRoot, runId, 'run.json');
          if (!existsSync(path)) continue;
          const run = this.readValidated(path, commandRunReadSchema);
          if (!('run_id' in run) || run.run_id !== runId) {
            throw new Error(`Run identity does not match its canonical path during migration: ${runId}`);
          }
          if (run.schema_version === 'command-run/1.4') {
            const owner = executions.find(execution => execution.execution_id === run.execution_id);
            if (!owner || owner.generation !== run.generation) {
              throw new Error(
                `Run ${runId} references unknown Execution generation ${run.execution_id}/${run.generation}`,
              );
            }
          }
          runRecords.push({ path, run });
        }
      }
      if (['sealed', 'archived'].includes(compatibility.status)) {
        const unsealedRunIds = runRecords
          .filter(({ run }) => !('status' in run) || run.status !== 'sealed')
          .map(({ run }) => 'run_id' in run ? String(run.run_id) : '<unknown>');
        if (unsealedRunIds.length > 0) {
          throw new Error(
            `Cannot migrate sealed Session ${identity.session_id}; unsealed Runs: ${unsealedRunIds.join(', ')}`,
          );
        }
      }

      const writes: JsonWrite[] = [];
      if (legacyExecution) {
        writes.push({
          path: this.executionPath(identity.session_id, legacyExecution.execution_id),
          value: legacyExecution,
          schema: executionStateSchema,
          mode: 0o600,
        });
      }
      for (const execution of executions.filter(item => item.status === 'sealed')) {
        const existingReceipt = this.readExecutionSealReceiptUnlocked(identity.session_id, execution.execution_id);
        const executionRuns = runRecords.filter(({ run }) => run.schema_version === 'command-run/1.4'
          && run.execution_id === execution.execution_id
          && run.generation === execution.generation);
        if (existingReceipt) {
          if (existingReceipt.generation !== execution.generation
            || existingReceipt.execution_revision !== execution.revision
            || existingReceipt.sealed_at !== execution.sealed_at
            || existingReceipt.chain_hash !== sha256Prefixed(stableJsonUtf8(execution.chain))
            || stableJsonUtf8(existingReceipt.chain_snapshot) !== stableJsonUtf8(execution.chain)) {
            throw new Error(`Existing seal receipt does not match Execution ${execution.execution_id}`);
          }
          const expectedRunIds = executionRuns.map(({ run }) => String(run.run_id)).sort();
          const receiptRunIds = existingReceipt.runs.map(run => run.run_id).sort();
          if (stableJsonUtf8(expectedRunIds) !== stableJsonUtf8(receiptRunIds)) {
            throw new Error(`Existing seal receipt Run ownership changed: ${execution.execution_id}`);
          }
          for (const snapshot of existingReceipt.runs) {
            const record = executionRuns.find(({ run }) => run.run_id === snapshot.run_id);
            if (!record || !('status' in record.run) || record.run.status !== 'sealed'
              || record.run.schema_version !== snapshot.schema_version
              || sha256Prefixed(readFileSync(record.path)) !== snapshot.content_hash) {
              throw new Error(`Existing seal receipt Run snapshot changed: ${snapshot.run_id}`);
            }
          }
          continue;
        }
        // A receipt is historical authority only if it was written at seal time. Migration
        // may establish authority for the synthesized legacy Execution, but must not infer a
        // missing receipt for an already-persisted Execution from later Session state.
        if (!legacyExecution) continue;
        const boundRuns = runRecords;
        const unsealedRuns = boundRuns
          .filter(({ run }) => !('status' in run) || run.status !== 'sealed')
          .map(({ run }) => 'run_id' in run ? String(run.run_id) : '<unknown>');
        if (unsealedRuns.length > 0) {
          throw new Error(
            `Cannot migrate sealed Execution ${execution.execution_id}; unsealed Runs: ${unsealedRuns.join(', ')}`,
          );
        }
        const receipt = this.createHistoricalExecutionSealReceiptUnlocked(identity, execution, boundRuns);
        writes.push({
          path: this.executionSealReceiptPath(identity.session_id, execution.execution_id),
          value: receipt,
          schema: executionSealReceiptSchema,
          mode: 0o600,
        });
      }

      writes.push(
        {
          path: join(this.sessionDir(identity.session_id), 'session.json'),
          value: identity,
          schema: sessionStateV20Schema,
        },
        {
          path: this.sessionCompatibilityPath(identity.session_id),
          value: compatibility,
          schema: sessionStateV13Schema,
          mode: 0o600,
        },
      );
      if (input.archiveReceipt) {
        const receipt = sessionArchiveReceiptSchema.parse(input.archiveReceipt);
        if (receipt.session_id !== identity.session_id
          || receipt.after.activity_revision !== identity.activity_revision
          || receipt.after.archived_at !== identity.archived_at
          || receipt.after.archived_by !== identity.archived_by
          || receipt.previous_receipt_hash !== null
          || sessionArchiveReceiptHash(receipt) !== receipt.receipt_hash) {
          throw new Error('historical Session archive receipt does not match migrated identity');
        }
        writes.push({
          path: this.sessionArchiveReceiptPath(identity.session_id, receipt.after.activity_revision),
          value: receipt,
          schema: sessionArchiveReceiptSchema,
        });
      }
      this.writeBatchUnlocked(writes);
    });
  }

  private createHistoricalExecutionSealReceiptUnlocked(
    identity: SessionIdentityV20,
    execution: ExecutionState,
    runs: Array<{ path: string; run: CommandRunInput }>,
  ): ExecutionSealReceipt {
    if (!execution.sealed_at) {
      throw new Error(`Cannot migrate sealed Execution ${execution.execution_id}; sealed_at is missing`);
    }
    const dir = this.sessionDir(identity.session_id);
    const gatesPath = join(dir, 'gates.json');
    const artifactsPath = join(dir, 'artifacts.json');
    const evidencePath = join(dir, 'evidence.json');
    const gates = this.readValidated(gatesPath, gateRegistrySchema);
    const artifacts = this.readValidated(artifactsPath, artifactRegistrySchema);
    const evidence = this.readValidated(evidencePath, evidenceStoreSchema);
    const blockingGateIds = Object.entries(gates.gates)
      .filter(([, gate]) => gate.blocking && ['pending', 'running', 'failed', 'blocked'].includes(gate.status))
      .map(([gateId]) => gateId)
      .sort();
    const artifactHashes = Object.fromEntries(
      Object.entries(artifacts.artifacts)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([artifactId, artifact]) => [artifactId, `sha256:${artifact.content_hash}`]),
    );
    const corpusRefs = new Map<string, ExecutionSealReceipt['corpus_refs'][number]>();
    for (const { run } of runs) {
      if (run.schema_version !== 'command-run/1.3' && run.schema_version !== 'command-run/1.4') continue;
      const receiptRun = run.schema_version === 'command-run/1.4'
        ? commandRunV14Schema.parse(run)
        : commandRunV13Schema.parse(run);
      const snapshot = receiptRun.guidance_snapshot;
      if (!snapshot) continue;
      const source = snapshot.source_path || 'inline';
      const prefix = `${receiptRun.run_id}:${source}`;
      const candidates = [
        ['command-guidance', prefix, snapshot.content_hash],
        ['resolved-prompt', prefix, snapshot.resolved_prompt_hash],
        ['prepare-guidance', `${prefix}#prepare`, snapshot.prepare_hash],
        ['workflow-guidance', `${prefix}#workflow`, snapshot.workflow_hash],
        ['run-mode-guidance', `${prefix}#run-mode`, snapshot.run_mode_hash],
      ] as const;
      for (const [kind, id, contentHash] of candidates) {
        if (!contentHash) continue;
        corpusRefs.set(`${kind}\0${id}\0${contentHash}`, { kind, id, content_hash: contentHash });
      }
    }
    const chainSnapshot = clone(execution.chain);
    return createExecutionSealReceipt({
      session_id: identity.session_id,
      execution_id: execution.execution_id,
      generation: execution.generation,
      sealed_at: execution.sealed_at,
      execution_revision: execution.revision,
      session_identity_revision: identity.identity_revision,
      session_activity_revision: identity.activity_revision,
      runs: runs.map(({ path, run }) => {
        if (!('run_id' in run) || ![
          'command-run/1.0',
          'command-run/1.1',
          'command-run/1.2',
          'command-run/1.3',
          'command-run/1.4',
        ].includes(run.schema_version)) {
          throw new Error(`Cannot seal unsupported Run snapshot during migration: ${run.schema_version}`);
        }
        return {
          run_id: String(run.run_id),
          schema_version: run.schema_version as 'command-run/1.0' | 'command-run/1.1' | 'command-run/1.2' | 'command-run/1.3' | 'command-run/1.4',
          content_hash: sha256Prefixed(readFileSync(path)),
        };
      }),
      chain_snapshot: chainSnapshot,
      chain_hash: sha256Prefixed(stableJsonUtf8(chainSnapshot)),
      gates: {
        clean: blockingGateIds.length === 0,
        blocking_gate_ids: blockingGateIds,
        registry_revision: gates.revision,
        registry_hash: sha256Prefixed(readFileSync(gatesPath)),
      },
      artifacts: {
        registry_revision: artifacts.revision,
        registry_hash: sha256Prefixed(readFileSync(artifactsPath)),
        content_hashes: artifactHashes,
      },
      evidence: {
        store_revision: evidence.revision,
        store_hash: sha256Prefixed(readFileSync(evidencePath)),
        record_refs: Object.keys(evidence.records).sort(),
      },
      corpus_refs: [...corpusRefs.values()].sort((left, right) => (
        left.kind.localeCompare(right.kind)
        || left.id.localeCompare(right.id)
        || left.content_hash.localeCompare(right.content_hash)
      )),
    });
  }

  private assertSessionV30MutationUnsupported(sessionId: string): void {
    const current = this.readSessionRecordUnlocked(sessionId);
    if (current.schema_version === 'session/3.0') {
      throw new SessionSchemaUnsupportedError(sessionId);
    }
  }

  assertLegacySessionMutationAllowed(sessionId: string): void {
    const current = this.readSessionRecordUnlocked(sessionId);
    if (current.schema_version === 'session/3.0') {
      throw new SessionSchemaUnsupportedError(sessionId);
    }
    if (current.schema_version === 'session/2.0') {
      throw new Error(
        `Session ${sessionId} uses session/2.0; use the statusless Session/Execution store primitives`,
      );
    }
  }

  clearCache(): void {
    this.cache.clear();
  }

  readJsonFile<T>(path: string, schema: z.ZodType<T>, fallback?: T): T {
    if (!this.lock.isHeld) return this.withLock(() => this.readJsonFileUnlocked(path, schema, fallback));
    return this.readJsonFileUnlocked(path, schema, fallback);
  }

  /** Read and validate a sidecar without lock acquisition or recovery writes. */
  readJsonFileReadOnly<T>(path: string, schema: z.ZodType<T>, fallback?: T): T {
    return this.readJsonFileUnlocked(path, schema, fallback);
  }

  private readJsonFileUnlocked<T>(path: string, schema: z.ZodType<T>, fallback?: T): T {
    const safePath = this.assertWorkflowPath(path);
    if (!existsSync(safePath)) {
      if (fallback === undefined) throw new Error(`Missing authoritative file: ${safePath}`);
      return clone(schema.parse(fallback));
    }
    return this.readValidated(safePath, schema);
  }

  updateJsonFile<T>(
    path: string,
    schema: z.ZodType<T>,
    initial: T,
    mutator: (draft: T) => void,
  ): T {
    const safePath = this.assertWorkflowPath(path);
    return this.withLock(() => {
      const current = existsSync(safePath) ? this.readValidated(safePath, schema) : schema.parse(initial);
      const draft = clone(current);
      mutator(draft);
      schema.parse(draft);
      this.writeBatchUnlocked([{ path: safePath, value: draft, schema }]);
      return clone(draft);
    });
  }

  appendLine(path: string, line: string): void {
    const safePath = this.assertWorkflowPath(path);
    this.withLock(() => {
      mkdirSync(dirname(safePath), { recursive: true });
      appendFileSync(safePath, line.endsWith('\n') ? line : `${line}\n`, 'utf8');
    });
  }

  private recallRegistryPath(): string {
    return join(this.sessionsRoot, 'recall-confirmations.json');
  }

  private readRecallRegistryUnlocked(): RecallConfirmationRegistry {
    const path = this.recallRegistryPath();
    return existsSync(path)
      ? this.readValidated(path, recallConfirmationRegistrySchema)
      : createRecallConfirmationRegistry();
  }

  private findRecallReservationUnlocked(
    registry: RecallConfirmationRegistry,
    reservationId: string,
    includeFinalized = false,
  ): { tokenHash: string; record: RecallConfirmationRecord } | null {
    let match: { tokenHash: string; record: RecallConfirmationRecord } | null = null;
    for (const [tokenHash, record] of Object.entries(registry.records)) {
      const matchesActive = record.reservation?.reservation_id === reservationId;
      const matchesFinalized = includeFinalized && record.outcome?.reservation_id === reservationId;
      if (!matchesActive && !matchesFinalized) continue;
      if (match) throw new Error(`duplicate recall confirmation reservation ID: ${reservationId}`);
      match = { tokenHash, record };
    }
    return match;
  }

  private recallReservationMarkerPath(sessionId: string): string {
    return join(this.sessionDir(sessionId), '.recall-reservation.json');
  }

  private assertRecallReservationMarkerUnlocked(
    reservation: NonNullable<RecallConfirmationRecord['reservation']>,
  ): RecallReservationMarker {
    const path = this.recallReservationMarkerPath(reservation.proposed_target.session_id);
    if (!existsSync(path)) {
      throw new RecallConfirmationError('FENCE_CONFLICT', 'target reservation marker is missing');
    }
    const actual = this.readValidated(path, recallReservationMarkerSchema);
    const expected = createRecallReservationMarker(reservation);
    if (stableJsonUtf8(actual) !== stableJsonUtf8(expected)) {
      throw new RecallConfirmationError('FENCE_CONFLICT', 'target reservation marker changed');
    }
    return actual;
  }

  private observeRecallReservationUnlocked(
    reservation: NonNullable<RecallConfirmationRecord['reservation']>,
    observedAt: Date,
  ): RecallReservationObservation {
    const targetDir = this.sessionDir(reservation.proposed_target.session_id);
    const markerPath = this.recallReservationMarkerPath(reservation.proposed_target.session_id);
    let marker: RecallReservationObservation['marker'] = { state: 'missing', reservation_id: null };
    if (existsSync(markerPath)) {
      try {
        const parsed = this.readValidated(markerPath, recallReservationMarkerSchema);
        const expected = createRecallReservationMarker(reservation);
        marker = stableJsonUtf8(parsed) === stableJsonUtf8(expected)
          ? { state: 'matching', reservation_id: parsed.reservation_id }
          : { state: 'mismatched', reservation_id: parsed.reservation_id };
      } catch {
        marker = { state: 'mismatched', reservation_id: null };
      }
    }
    let target: RecallReservationObservation['target'];
    if (!existsSync(targetDir)) {
      target = { state: 'absent', authority_hash: null, intent_identity: null, run_id: null };
    } else if (!existsSync(join(targetDir, 'session.json'))) {
      try {
        target = {
          state: 'partial',
          authority_hash: this.hashRecallTargetDirectoryUnlocked(targetDir),
          intent_identity: null,
          run_id: null,
        };
      } catch {
        target = { state: 'corrupt', authority_hash: null, intent_identity: null, run_id: null };
      }
    } else {
      try {
        const bundle = this.readBundleUnlocked(reservation.proposed_target.session_id);
        const runId = bundle.session.active_run_id;
        target = {
          state: 'complete',
          authority_hash: this.recallTargetAuthorityHashUnlocked(reservation.proposed_target.session_id, runId),
          intent_identity: bundle.session.intent_identity,
          run_id: runId,
        };
      } catch {
        target = { state: 'corrupt', authority_hash: null, intent_identity: null, run_id: null };
      }
    }
    return recallReservationObservationSchema.parse({
      schema_version: 'recall-reservation-observation/1.0',
      reservation_id: reservation.reservation_id,
      observed_at: observedAt.toISOString(),
      marker,
      target,
    });
  }

  private hashRecallTargetDirectoryUnlocked(targetDir: string): string {
    const entries: Array<{ path: string; size: number; hash: string | null; type: 'file' | 'directory' }> = [];
    let totalBytes = 0;
    const walk = (directory: string, prefix: string): void => {
      for (const name of readdirSync(directory).sort()) {
        if (entries.length >= 256) throw new Error('partial target snapshot exceeds 256 entries');
        const absolute = this.assertWorkflowPath(join(directory, name));
        const relativePath = prefix ? `${prefix}/${name}` : name;
        const stat = lstatSync(absolute);
        if (stat.isSymbolicLink()) throw new Error('partial target contains a symbolic link');
        if (stat.isDirectory()) {
          entries.push({ path: relativePath, size: 0, hash: null, type: 'directory' });
          walk(absolute, relativePath);
        } else if (stat.isFile()) {
          totalBytes += stat.size;
          if (totalBytes > 8 * 1024 * 1024) throw new Error('partial target snapshot exceeds 8 MiB');
          entries.push({ path: relativePath, size: stat.size, hash: sha256Prefixed(readFileSync(absolute)), type: 'file' });
        } else {
          throw new Error('partial target contains an unsupported entry');
        }
      }
    };
    walk(targetDir, '');
    return sha256Prefixed(stableJsonUtf8(entries));
  }

  private validateRecallSourceFenceUnlocked(
    action: RecallConfirmationRecord['action'],
    source: RecallConfirmationRecord['source_fence'],
  ): ValidatedRecallSource | null {
    if (!source) {
      if (action === 'fork' || action === 'import') {
        throw new RecallConfirmationError('FENCE_CONFLICT', `${action} requires a validated source fence`);
      }
      return null;
    }
    let scope: ValidatedRecallSource['scope'] = 'local';
    let sourceProjectRoot = this.projectRoot;
    if (source.workspace_link_name) {
      if (action !== 'import') {
        throw new RecallConfirmationError('FENCE_CONFLICT', 'linked workspace sources are import-only');
      }
      const matches = resolveWorkspaceLinks(this.projectRoot, loadWorkspaceConfig(this.projectRoot))
        .filter(link => link.valid
          && link.name === source.workspace_link_name
          && (link.share as string[]).includes('session'));
      if (matches.length !== 1) {
        throw new RecallConfirmationError('FENCE_CONFLICT', 'linked workspace source is unavailable or not uniquely shared');
      }
      sourceProjectRoot = matches[0].resolvedPath;
      scope = 'linked';
    }
    if (canonicalWorkspaceId(sourceProjectRoot) !== source.workspace_id) {
      throw new RecallConfirmationError('FENCE_CONFLICT', 'source workspace identity changed');
    }
    const sourceStore = resolve(sourceProjectRoot) === resolve(this.projectRoot)
      ? this
      : new SessionStore(sourceProjectRoot);
    const validate = () => sourceStore.validateSourceFenceAtRootUnlocked(source);
    const validated = sourceStore === this ? validate() : sourceStore.withLock(validate);
    return validatedRecallSourceReadSchema.parse({
      schema_version: 'schema_version' in validated.fence
        ? 'validated-recall-source/1.1'
        : 'validated-recall-source/1.0',
      scope,
      workspace_link_name: source.workspace_link_name,
      source_project_root: resolve(sourceProjectRoot),
      source_workflow_root: join(resolve(sourceProjectRoot), '.workflow'),
      workspace_id: source.workspace_id,
      session_id: source.session_id,
      run_id: source.run_id,
      session_status: validated.session_status,
      run_status: 'sealed',
      session_intent_identity: validated.session_intent_identity,
      fence: validated.fence,
    });
  }

  private validateSourceFenceAtRootUnlocked(
    source: SourceFenceRead,
  ): {
    fence: SourceFenceRead;
    session_status: 'sealed' | 'archived' | null;
    session_intent_identity: IntentIdentity | null;
  } {
    if ('schema_version' in source) return this.validateReceiptSourceFenceAtRootUnlocked(source);
    const sessionPath = join(this.sessionDir(source.session_id), 'session.json');
    const runPath = join(this.runDir(source.session_id, source.run_id), 'run.json');
    if (!existsSync(sessionPath) || !existsSync(runPath)) {
      throw new RecallConfirmationError('FENCE_CONFLICT', 'source authority fence changed');
    }
    const sessionRaw = readFileSync(sessionPath);
    const runRaw = readFileSync(runPath);
    const bundle = this.readBundleUnlocked(source.session_id);
    const run = this.readRunUnlocked(source.session_id, source.run_id);
    if (!['sealed', 'archived'].includes(bundle.session.status) || run.status !== 'sealed') {
      throw new RecallConfirmationError('FENCE_CONFLICT', 'source Session and Run must remain sealed and immutable');
    }
    const selectedArtifacts = source.selected_artifacts.map(expected => {
      const registered = Object.values(bundle.artifacts.artifacts).find(item => (
        item.kind === expected.kind
        && item.relative_path === expected.relative_path
        && `sha256:${item.content_hash}` === expected.content_hash
        && item.status === 'sealed'
      ));
      if (!registered) throw new RecallConfirmationError('FENCE_CONFLICT', 'source artifact fence changed');
      const artifactPath = this.assertWorkflowPath(join(this.sessionDir(source.session_id), expected.relative_path));
      if (!existsSync(artifactPath)) throw new RecallConfirmationError('FENCE_CONFLICT', 'source artifact is missing');
      if (statSync(artifactPath).isFile() && sha256Prefixed(readFileSync(artifactPath)) !== expected.content_hash) {
        throw new RecallConfirmationError('FENCE_CONFLICT', 'source artifact content hash changed');
      }
      return expected;
    });
    const current = {
      workspace_id: canonicalWorkspaceId(this.projectRoot),
      workspace_link_name: source.workspace_link_name,
      session_id: source.session_id,
      session_schema_version: bundle.session.schema_version,
      session_identity_revision: bundle.session.identity_revision,
      session_activity_revision: bundle.session.activity_revision,
      session_hash: sha256Prefixed(sessionRaw),
      run_id: source.run_id,
      run_schema_version: run.schema_version,
      run_hash: sha256Prefixed(runRaw),
      artifact_registry_revision: bundle.artifacts.revision,
      selected_artifacts: selectedArtifacts,
    } as const;
    if (stableJsonUtf8(current) !== stableJsonUtf8(source)) {
      throw new RecallConfirmationError('FENCE_CONFLICT', 'source authority fence changed');
    }
    return {
      fence: source,
      session_status: bundle.session.status as 'sealed' | 'archived',
      session_intent_identity: bundle.session.intent_identity,
    };
  }

  private validateReceiptSourceFenceAtRootUnlocked(source: SourceFenceV11): {
    fence: SourceFenceV11;
    session_status: null;
    session_intent_identity: IntentIdentity | null;
  } {
    const sessionPath = join(this.sessionDir(source.session_id), 'session.json');
    const runPath = join(this.runDir(source.session_id, source.run_id), 'run.json');
    if (!existsSync(sessionPath) || !existsSync(runPath)) {
      throw new RecallConfirmationError('FENCE_CONFLICT', 'receipt-backed source authority is missing');
    }
    const session = this.readSessionRecordUnlocked(source.session_id);
    if (session.schema_version !== source.session_schema_version) {
      throw new RecallConfirmationError('FENCE_CONFLICT', 'source Session schema identity changed');
    }
    const locator = source.execution_seal_receipt;
    const expectedReceiptPath = `executions/${locator.execution_id}/seal-receipt.json`;
    if (locator.relative_path.replaceAll('\\', '/') !== expectedReceiptPath) {
      throw new RecallConfirmationError('FENCE_CONFLICT', 'Execution seal receipt path changed');
    }
    let receipt: ExecutionSealReceipt | null;
    let execution: ExecutionState;
    try {
      receipt = this.readExecutionSealReceiptUnlocked(source.session_id, locator.execution_id);
      execution = this.readExecutionUnlocked(source.session_id, locator.execution_id);
    } catch (error) {
      throw new RecallConfirmationError(
        'FENCE_CONFLICT',
        `Execution seal receipt is corrupt: ${(error as Error).message}`,
      );
    }
    if (!receipt) throw new RecallConfirmationError('FENCE_CONFLICT', 'Execution seal receipt is missing');
    if (receipt.overall_hash !== locator.overall_hash
      || receipt.session_id !== source.session_id
      || receipt.execution_id !== locator.execution_id
      || receipt.generation !== locator.generation
      || receipt.sealed_at !== locator.sealed_at
      || execution.status !== 'sealed'
      || execution.session_id !== source.session_id
      || execution.execution_id !== locator.execution_id
      || execution.generation !== locator.generation
      || execution.revision !== receipt.execution_revision
      || execution.sealed_at !== locator.sealed_at) {
      throw new RecallConfirmationError('FENCE_CONFLICT', 'sealed Execution source anchor changed');
    }
    const runRaw = readFileSync(runPath);
    const runHash = sha256Prefixed(runRaw);
    const run = this.readValidated(runPath, commandRunReadSchema);
    const runSnapshot = receipt.runs.find(item => item.run_id === source.run_id);
    if (!runSnapshot
      || run.status !== 'sealed'
      || run.schema_version !== source.run_schema_version
      || runSnapshot.schema_version !== source.run_schema_version
      || runSnapshot.content_hash !== source.run_hash
      || runHash !== source.run_hash) {
      throw new RecallConfirmationError('FENCE_CONFLICT', 'sealed Run content or receipt binding changed');
    }
    if (run.schema_version === 'command-run/1.4'
      && (run.execution_id !== locator.execution_id || run.generation !== locator.generation)) {
      throw new RecallConfirmationError('FENCE_CONFLICT', 'Run belongs to a different Execution generation');
    }
    const bundle = this.readBundleUnlocked(source.session_id);
    for (const expected of source.selected_artifacts) {
      if (receipt.schema_version === 'execution-seal-receipt/1.1') {
        const matches = receipt.artifacts.snapshots.filter(artifact => (
          artifact.producer_run_id === source.run_id
          && artifact.kind === expected.kind
          && artifact.relative_path === expected.relative_path
          && artifact.status === 'sealed'
          && artifact.content_hash === expected.content_hash
        ));
        if (matches.length !== 1) {
          throw new RecallConfirmationError('FENCE_CONFLICT', 'sealed source artifact receipt binding changed');
        }
      } else {
        const matches = Object.entries(bundle.artifacts.artifacts).filter(([, artifact]) => (
          artifact.producer_run_id === source.run_id
          && artifact.kind === expected.kind
          && artifact.relative_path === expected.relative_path
          && artifact.status === 'sealed'
          && `sha256:${artifact.content_hash}` === expected.content_hash
        ));
        if (matches.length !== 1) {
          throw new RecallConfirmationError('FENCE_CONFLICT', 'sealed source artifact registry binding changed');
        }
        const [artifactId] = matches[0];
        if (receipt.artifacts.content_hashes[artifactId] !== expected.content_hash) {
          throw new RecallConfirmationError('FENCE_CONFLICT', 'source artifact is not sealed by the Execution receipt');
        }
      }
      const artifactPath = this.assertWorkflowPath(join(this.sessionDir(source.session_id), expected.relative_path));
      if (!existsSync(artifactPath)) {
        throw new RecallConfirmationError('FENCE_CONFLICT', 'sealed source artifact is missing');
      }
      const stat = lstatSync(artifactPath);
      if (stat.isSymbolicLink()) {
        throw new RecallConfirmationError('FENCE_CONFLICT', 'sealed source artifact cannot be a symbolic link');
      }
      const observedHash = stat.isDirectory()
        ? `sha256:${hashDirectory(artifactPath).hash}`
        : sha256Prefixed(readFileSync(artifactPath));
      if (observedHash !== expected.content_hash) {
        throw new RecallConfirmationError('FENCE_CONFLICT', 'sealed source artifact content hash changed');
      }
    }
    return {
      fence: source,
      session_status: null,
      session_intent_identity: bundle.session.intent_identity,
    };
  }

  private assertRecallTargetFenceUnlocked(target: RecallConfirmationRecord['target_fence']): void {
    if (target.workspace_id !== canonicalWorkspaceId(this.projectRoot)) {
      throw new RecallConfirmationError('FENCE_CONFLICT', 'target workspace fence changed');
    }
    const exists = this.sessionExists(target.session_id);
    if (target.must_not_exist) {
      if (exists) throw new RecallConfirmationError('FENCE_CONFLICT', 'target Session already exists');
      return;
    }
    if (!exists) throw new RecallConfirmationError('FENCE_CONFLICT', 'target Session no longer exists');
    const bundle = this.readBundleUnlocked(target.session_id);
    const actual = {
      workspace_id: target.workspace_id,
      session_id: target.session_id,
      must_not_exist: false,
      status: bundle.session.status,
      identity_revision: bundle.session.identity_revision,
      activity_revision: bundle.session.activity_revision,
      active_run_id: bundle.session.active_run_id,
      artifact_registry_revision: bundle.artifacts.revision,
    };
    if (stableJsonUtf8(actual) !== stableJsonUtf8(target)) {
      throw new RecallConfirmationError('FENCE_CONFLICT', 'target authority fence changed');
    }
  }

  private recallTargetHashUnlocked(targetInput: RecallConfirmationFinalTarget): string {
    const target = recallConfirmationFinalTargetSchema.parse(targetInput);
    if (target.workspace_id !== canonicalWorkspaceId(this.projectRoot)) {
      throw new RecallConfirmationError('FENCE_CONFLICT', 'final target workspace does not match');
    }
    const bundle = this.readBundleUnlocked(target.session_id);
    if (!bundle.session.intent_identity || !sameIntentIdentity(bundle.session.intent_identity, target.intent_identity)) {
      throw new RecallConfirmationError('FENCE_CONFLICT', 'final target intent identity does not match');
    }
    return this.recallTargetAuthorityHashUnlocked(target.session_id, target.run_id);
  }

  private recallTargetAuthorityHashUnlocked(sessionId: string, runId: string | null): string {
    const bundle = this.readBundleUnlocked(sessionId);
    const run = runId ? this.readRunUnlocked(sessionId, runId) : null;
    return sha256Prefixed(stableJsonUtf8({
      session: bundle.session,
      run,
      gates: bundle.gates,
      artifacts: bundle.artifacts,
      evidence: bundle.evidence,
    }));
  }

  private sessionFenceUnlocked(sessionId: string, runId?: string | null): TransitionFence {
    return this.sessionFenceForBundle(this.readBundleUnlocked(sessionId), runId);
  }

  private sessionFenceForBundle(
    bundle: SessionBundle,
    runId?: string | null,
    tx?: StoreTransaction,
  ): TransitionFence {
    let runHash: string | null = null;
    if (runId) {
      const pending = tx?.writes.find(write => write.path === join(this.runDir(bundle.session.session_id, runId), 'run.json'));
      if (pending) runHash = sha256Prefixed(`${JSON.stringify(pending.value, null, 2)}\n`);
      else {
        const path = join(this.runDir(bundle.session.session_id, runId), 'run.json');
        if (existsSync(path)) runHash = sha256Prefixed(readFileSync(path));
      }
    }
    return transitionFenceSchema.parse({
      session_identity_revision: bundle.session.identity_revision,
      session_activity_revision: bundle.session.activity_revision,
      active_run_id: bundle.session.active_run_id,
      run_hash: runHash,
      artifact_registry_revision: bundle.artifacts.revision,
    });
  }

  private transactionIntentPath(): string {
    return join(this.sessionsRoot, TRANSACTION_INTENT_FILE);
  }

  private reconcileTransactionIntentUnlocked(): void {
    const intentPath = this.transactionIntentPath();
    if (!existsSync(intentPath)) return;
    let intent: TransactionIntent;
    try {
      intent = transactionIntentSchema.parse(JSON.parse(readFileSync(intentPath, 'utf8')));
    } catch (error) {
      throw new Error(`SessionStore recovery required: invalid transaction intent at ${intentPath}: ${(error as Error).message}`);
    }
    try {
      for (const entry of intent.writes) {
        const path = this.assertWorkflowPath(join(this.workflowRoot, entry.path));
        const tmpPath = this.assertWorkflowPath(join(this.workflowRoot, entry.tmp_path));
        const current = existsSync(path) ? readFileSync(path) : null;
        const currentHash = current ? sha256Hex(current) : null;
        if (currentHash !== entry.original_sha256) {
          if (entry.original_base64 === null) {
            rmSync(path, { force: true });
          } else {
            const recoveryTmp = `${path}.recovery-${intent.transaction_id}`;
            writeFileSync(recoveryTmp, Buffer.from(entry.original_base64, 'base64'));
            safeRename(recoveryTmp, path);
          }
        }
        rmSync(tmpPath, { force: true });
      }
      rmSync(intentPath, { force: true });
      this.clearCache();
    } catch (error) {
      throw new Error(`SessionStore recovery required for ${intent.transaction_id}: ${(error as Error).message}`);
    }
  }

  private assertWorkflowPath(path: string): string {
    const root = resolve(this.workflowRoot);
    const target = resolve(path);
    const rel = relative(root, target);
    if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`Path escapes .workflow: ${path}`);
    return target;
  }

  private assertSafeWriteTarget(path: string): string {
    const target = this.assertWorkflowPath(path);
    const root = resolve(this.workflowRoot);
    const relativeParent = relative(root, dirname(target));
    let cursor = root;
    for (const segment of relativeParent.split(/[\\/]+/).filter(Boolean)) {
      cursor = join(cursor, segment);
      if (!existsSync(cursor)) continue;
      const details = lstatSync(cursor);
      if (details.isSymbolicLink() || !details.isDirectory()) {
        throw new Error(`Unsafe transaction write parent: ${cursor}`);
      }
    }
    if (existsSync(target) && lstatSync(target).isSymbolicLink()) {
      throw new Error(`Unsafe transaction write target: ${target}`);
    }
    return target;
  }

  private readValidated<T>(path: string, schema: z.ZodType<T>): T {
    if (!existsSync(path)) throw new Error(`Missing authoritative file: ${path}`);
    const stat = statSync(path);
    const cached = this.cache.get(path);
    if (cached && cached.mtime === stat.mtimeMs && cached.size === stat.size) return clone(cached.data as T);
    let parsed: unknown;
    try { parsed = JSON.parse(readFileSync(path, 'utf8')); } catch (error) {
      throw new Error(`Invalid JSON at ${path}: ${(error as Error).message}`);
    }
    const data = schema.parse(parsed);
    if (this.cache.size >= CACHE_MAX_ENTRIES) {
      const oldest = this.cache.keys().next().value;
      if (oldest) this.cache.delete(oldest);
    }
    this.cache.set(path, { mtime: stat.mtimeMs, size: stat.size, data: clone(data) });
    return data;
  }

  private writeFreshBundleUnlocked(
    sessionId: string,
    bundle: SessionBundle,
    selection: SessionSchemaSelection,
  ): void {
    const dir = this.sessionDir(sessionId);
    if (selection.writer === 'session/3.0') {
      throw new Error('session/3.0 creation is reserved for the v3 Session mutation engine');
    }
    if (selection.writer === 'session/2.0') {
      const identity = createSessionIdentityV20(sessionId, bundle.session.intent, {
        topicIdentity: bundle.session.topic_identity,
        identityRevision: bundle.session.identity_revision,
        activityRevision: bundle.session.activity_revision,
        latestCompletedRunId: bundle.session.latest_completed_run_id,
      });
      this.writeBatchUnlocked([
        { path: join(dir, 'session.json'), value: identity, schema: sessionStateV20Schema },
        {
          path: this.sessionCompatibilityPath(sessionId),
          value: bundle.session,
          schema: sessionStateV13Schema,
          mode: 0o600,
        },
        { path: join(dir, 'gates.json'), value: bundle.gates, schema: gateRegistrySchema },
        { path: join(dir, 'artifacts.json'), value: bundle.artifacts, schema: artifactRegistrySchema },
        { path: join(dir, 'evidence.json'), value: bundle.evidence, schema: evidenceStoreSchema },
      ]);
      return;
    }
    this.writeBatchUnlocked([
      { path: join(dir, 'session.json'), value: bundle.session, schema: sessionStateV13Schema },
      { path: join(dir, 'gates.json'), value: bundle.gates, schema: gateRegistrySchema },
      { path: join(dir, 'artifacts.json'), value: bundle.artifacts, schema: artifactRegistrySchema },
      { path: join(dir, 'evidence.json'), value: bundle.evidence, schema: evidenceStoreSchema },
    ]);
  }

  private prepareExecutionCompatibilityDraft(current: SessionStateRead, draft: SessionBundle): void {
    if (current.schema_version !== 'session/2.0') return;
    const identity = sessionStateV20Schema.parse(current);
    draft.session.session_id = identity.session_id;
    draft.session.intent = identity.intent;
    draft.session.topic_identity = clone(identity.topic_identity);
    draft.session.identity_revision = identity.identity_revision;
    draft.session.activity_revision = identity.activity_revision;
    draft.session.latest_completed_run_id = identity.latest_completed_run_id;
  }

  private assertExpectedActivityRevision(
    current: SessionStateRead,
    expectedActivityRevision: number | undefined,
  ): void {
    if (current.schema_version !== 'session/2.0' || expectedActivityRevision === undefined) return;
    const identity = sessionStateV20Schema.parse(current);
    if (identity.activity_revision !== expectedActivityRevision) {
      throw new Error(
        `session activity revision conflict: expected ${expectedActivityRevision}, current ${identity.activity_revision}`,
      );
    }
  }

  private addExecutionAtomicBundleWrites(
    current: SessionStateRead,
    draft: SessionBundle,
    execution: ExecutionState,
    tx: StoreTransaction,
  ): { identity_revision: number; activity_revision: number } {
    if (current.schema_version !== 'session/2.0') {
      tx.addBundle(draft);
      return draft.session;
    }
    const identity = sessionStateV20Schema.parse(current);
    if (draft.session.activity_revision < identity.activity_revision) {
      throw new Error('session activity revision must not move backwards');
    }
    const next = sessionStateV20Schema.parse({
      ...identity,
      activity_revision: draft.session.activity_revision,
      current_execution_id: execution.status === 'sealed' ? null : execution.execution_id,
      latest_execution_id: execution.execution_id,
      latest_completed_run_id: draft.session.latest_completed_run_id,
    });
    tx.addStatuslessBundle(draft, next);
    return next;
  }

  private assertPendingExecutionSealReceiptUnlocked(
    tx: StoreTransaction,
    execution: ExecutionState,
    session: { identity_revision: number; activity_revision: number },
    bundle: SessionBundle,
  ): void {
    const receipt = tx.pendingExecutionSealReceipt(execution.execution_id);
    if (!receipt) return;
    if (receipt.session_id !== execution.session_id
      || receipt.execution_id !== execution.execution_id
      || receipt.generation !== execution.generation
      || execution.status !== 'sealed'
      || receipt.execution_revision !== execution.revision
      || receipt.sealed_at !== execution.sealed_at) {
      throw new Error('Execution seal receipt does not match atomic sealed Execution authority');
    }
    if (receipt.session_identity_revision !== session.identity_revision
      || receipt.session_activity_revision !== session.activity_revision) {
      throw new Error('Execution seal receipt does not match atomic Session revisions');
    }
    if (sha256Prefixed(stableJsonUtf8(receipt.chain_snapshot)) !== receipt.chain_hash
      || stableJsonUtf8(receipt.chain_snapshot) !== stableJsonUtf8(execution.chain)) {
      throw new Error('Execution seal receipt chain snapshot changed');
    }
    if (receipt.schema_version === 'execution-seal-receipt/1.1'
      && receipt.execution_hash !== sha256Prefixed(`${JSON.stringify(execution, null, 2)}\n`)) {
      throw new Error('Execution seal receipt Execution bytes changed');
    }
    for (const runSnapshot of receipt.runs) {
      const path = join(this.runDir(receipt.session_id, runSnapshot.run_id), 'run.json');
      const run = this.readValidated(path, commandRunReadSchema);
      if (run.schema_version !== runSnapshot.schema_version || run.status !== 'sealed'
        || sha256Prefixed(readFileSync(path)) !== runSnapshot.content_hash) {
        throw new Error(`Execution seal receipt Run snapshot changed: ${runSnapshot.run_id}`);
      }
    }
    if (receipt.schema_version === 'execution-seal-receipt/1.1') {
      const runs = tx.listBoundExecutionRuns(execution.execution_id, execution.generation)
        .sort((left, right) => left.run_id.localeCompare(right.run_id));
      if (stableJsonUtf8(receipt.runs.map(run => run.run_id))
        !== stableJsonUtf8(runs.map(run => run.run_id))) {
        throw new Error('Execution seal receipt Run ownership changed');
      }
      const expected = executionSealReceiptScopeSnapshots(runs, bundle);
      if (stableJsonUtf8(receipt.gates) !== stableJsonUtf8(expected.gates)) {
        throw new Error('Execution seal receipt gate snapshot changed');
      }
      if (stableJsonUtf8(receipt.artifacts) !== stableJsonUtf8(expected.artifacts)) {
        throw new Error('Execution seal receipt Artifact snapshot changed');
      }
      if (stableJsonUtf8(receipt.evidence) !== stableJsonUtf8(expected.evidence)) {
        throw new Error('Execution seal receipt Evidence snapshot changed');
      }
      return;
    }
    const blockingGateIds = Object.entries(bundle.gates.gates)
      .filter(([, gate]) => gate.blocking && ['pending', 'running', 'failed', 'blocked'].includes(gate.status))
      .map(([gateId]) => gateId)
      .sort();
    const registryBytes = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
    if (receipt.gates.registry_revision !== bundle.gates.revision
      || receipt.gates.registry_hash !== sha256Prefixed(registryBytes(bundle.gates))
      || receipt.gates.clean !== (blockingGateIds.length === 0)
      || stableJsonUtf8(receipt.gates.blocking_gate_ids) !== stableJsonUtf8(blockingGateIds)) {
      throw new Error('Execution seal receipt gate snapshot changed');
    }
    const artifactHashes = Object.fromEntries(
      Object.entries(bundle.artifacts.artifacts)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([artifactId, artifact]) => [artifactId, `sha256:${artifact.content_hash}`]),
    );
    if (receipt.artifacts.registry_revision !== bundle.artifacts.revision
      || receipt.artifacts.registry_hash !== sha256Prefixed(registryBytes(bundle.artifacts))
      || stableJsonUtf8(receipt.artifacts.content_hashes) !== stableJsonUtf8(artifactHashes)) {
      throw new Error('Execution seal receipt Artifact snapshot changed');
    }
    const evidenceRefs = Object.keys(bundle.evidence.records).sort();
    if (receipt.evidence.store_revision !== bundle.evidence.revision
      || receipt.evidence.store_hash !== sha256Prefixed(registryBytes(bundle.evidence))
      || stableJsonUtf8(receipt.evidence.record_refs) !== stableJsonUtf8(evidenceRefs)) {
      throw new Error('Execution seal receipt Evidence snapshot changed');
    }
  }

  private writeBatchUnlocked(writes: JsonWrite[]): void {
    const unique = new Map(writes.map(write => [write.path, write]));
    const entries = [...unique.values()];
    for (const entry of entries) {
      entry.path = this.assertSafeWriteTarget(entry.path);
      if (entry.raw !== undefined && entry.value !== undefined) {
        throw new Error(`Transaction write cannot contain both JSON and raw content: ${entry.path}`);
      }
      if (entry.raw === undefined && entry.value === undefined) {
        throw new Error(`Transaction write has no content: ${entry.path}`);
      }
      entry.schema?.parse(entry.value);
    }

    const originals = new Map<string, Buffer | null>();
    const staged: Array<{ tmp: string; path: string; content: string }> = [];
    let intentWritten = false;
    try {
      for (const entry of entries) {
        mkdirSync(dirname(entry.path), { recursive: true });
        originals.set(entry.path, existsSync(entry.path) ? readFileSync(entry.path) : null);
        const tmp = `${entry.path}.tmp-${process.pid}-${Date.now()}-${staged.length}`;
        staged.push({
          tmp,
          path: entry.path,
          content: entry.raw ?? `${JSON.stringify(entry.value, null, 2)}\n`,
        });
      }
      const transactionId = `tx_${randomUUID()}`;
      const intent = transactionIntentSchema.parse({
        schema_version: 'session-store-intent/1.0',
        transaction_id: transactionId,
        created_at: new Date().toISOString(),
        writes: staged.map(item => {
          const original = originals.get(item.path) ?? null;
          return {
            path: relative(this.workflowRoot, item.path).replaceAll('\\', '/'),
            tmp_path: relative(this.workflowRoot, item.tmp).replaceAll('\\', '/'),
            original_base64: original?.toString('base64') ?? null,
            original_sha256: original ? sha256Hex(original) : null,
            next_sha256: sha256Hex(item.content),
          };
        }),
      });
      mkdirSync(this.sessionsRoot, { recursive: true });
      writeFileSync(this.transactionIntentPath(), `${JSON.stringify(intent, null, 2)}\n`, 'utf8');
      intentWritten = true;
      for (const item of staged) {
        if (existsSync(item.path)) this.backup(item.path);
        const entry = entries.find(candidate => candidate.path === item.path);
        writeFileSync(item.tmp, item.content, 'utf8');
        if (entry?.mode !== undefined) chmodSync(item.tmp, entry.mode);
      }
      for (const item of staged) safeRename(item.tmp, item.path);
      rmSync(this.transactionIntentPath(), { force: true });
      this.clearCache();
    } catch (error) {
      if (intentWritten) {
        try {
          this.reconcileTransactionIntentUnlocked();
        } catch (recoveryError) {
          this.clearCache();
          throw new Error(
            `SessionStore transaction failed and recovery is required: ${(error as Error).message}; `
            + `${(recoveryError as Error).message}`,
          );
        }
      } else {
        for (const item of staged) {
          try { rmSync(item.tmp, { force: true }); } catch { /* ignore */ }
        }
      }
      this.clearCache();
      throw error;
    }
  }

  private backup(path: string): void {
    const backupDir = join(dirname(path), '.backups');
    if (existsSync(backupDir)) {
      const details = lstatSync(backupDir);
      if (details.isSymbolicLink() || !details.isDirectory()) {
        throw new Error(`Unsafe backup directory: ${backupDir}`);
      }
    }
    mkdirSync(backupDir, { recursive: true });
    const base = basename(path).replace(/\.json$/i, '');
    const backupPath = join(backupDir, `${base}-${timestamp()}-${process.pid}-${Date.now()}.json`);
    copyFileSync(path, backupPath);
    const backups = readdirSync(backupDir)
      .filter(name => name.startsWith(`${base}-`))
      .sort()
      .reverse();
    for (const old of backups.slice(MAX_BACKUPS)) {
      try { unlinkSync(join(backupDir, old)); } catch { /* ignore */ }
    }
  }
}

export class SessionV30StoreTransaction {
  private readonly writes: JsonWrite[] = [];

  constructor(private readonly store: SessionStore, private readonly sessionId: string) {}

  pendingWrites(): JsonWrite[] {
    return [...this.writes];
  }

  private assertNotReceiptPath(path: string): void {
    const receiptRoot = resolve(this.store.receiptsDir(this.sessionId));
    const target = resolve(path);
    if (target === receiptRoot || target.startsWith(`${receiptRoot}${sep}`)) {
      throw new Error('generic v3 transaction writes cannot target immutable receipt paths');
    }
  }

  sessionExists(): boolean {
    return this.store.sessionExists(this.sessionId);
  }

  runExists(runId: string): boolean {
    return existsSync(join(this.store.runDir(this.sessionId, runId), 'run.json'));
  }

  readSession(): SessionStateV30 {
    return this.store.readSessionV30(this.sessionId);
  }

  readRun(runId: string): RunV30 {
    return this.store.readRunV30(this.sessionId, runId);
  }

  readArtifactRepublishReceipt(receiptId: string): ArtifactRepublishReceipt | null {
    assertSafePathSegment(receiptId, 'Artifact republish receipt ID');
    const path = join(this.store.receiptsDir(this.sessionId), 'artifact-republish', `${receiptId}.json`);
    return existsSync(path)
      ? this.store.readJsonFileReadOnly(path, artifactRepublishReceiptSchema)
      : null;
  }

  readRequestReceipt(requestId: string): RequestReceiptV20 | null {
    return this.store.readRequestReceiptV20(this.sessionId, requestId);
  }

  readTransitionReceipt(activityRevision: number, transitionId: string): TransitionReceiptV20 | null {
    return this.store.readTransitionReceiptV20(this.sessionId, activityRevision, transitionId);
  }

  listTransitionReceipts(): TransitionReceiptV20[] {
    return this.store.listTransitionReceiptsV20(this.sessionId);
  }

  readJson<T>(path: string, schema: z.ZodType<T>): T {
    return this.store.readJsonFileReadOnly(path, schema);
  }

  writeSession(sessionInput: SessionStateV30): void {
    const session = sessionStateV30Schema.parse(sessionInput);
    if (session.session_id !== this.sessionId) throw new Error('v3 Session transaction identity mismatch');
    this.writes.push({
      path: join(this.store.sessionDir(this.sessionId), 'session.json'),
      value: session,
      schema: sessionStateV30Schema,
    });
  }

  writeRun(runInput: RunV30): void {
    const run = runV30Schema.parse(runInput);
    if (run.session_id !== this.sessionId) throw new Error('v3 Run transaction Session identity mismatch');
    this.writes.push({
      path: join(this.store.runDir(this.sessionId, run.run_id), 'run.json'),
      value: run,
      schema: runV30Schema,
    });
  }

  writeRequestReceipt(receiptInput: RequestReceiptV20): void {
    const receipt = requestReceiptV20Schema.parse(receiptInput);
    const path = this.store.requestReceiptV20Path(this.sessionId, receipt.request_id);
    const pending = [...this.writes].reverse().find(write => write.path === path)?.value;
    if (pending !== undefined) {
      const existing = requestReceiptV20Schema.parse(pending);
      if (stableJsonUtf8(existing) !== stableJsonUtf8(receipt)) {
        throw new Error(`v3 request receipt is immutable: ${receipt.request_id}`);
      }
      return;
    }
    const existing = this.store.readRequestReceiptV20(this.sessionId, receipt.request_id);
    if (existing) {
      if (stableJsonUtf8(existing) !== stableJsonUtf8(receipt)) {
        throw new Error(`v3 request receipt is immutable: ${receipt.request_id}`);
      }
      return;
    }
    this.writes.push({
      path,
      value: receipt,
      schema: requestReceiptV20Schema,
    });
  }

  writeTransitionReceipt(receiptInput: TransitionReceiptV20): void {
    const receipt = transitionReceiptV20Schema.parse(receiptInput);
    if (receipt.session_id !== this.sessionId) {
      throw new Error('v3 transition receipt Session identity mismatch');
    }
    const path = this.store.transitionReceiptV20Path(
      this.sessionId,
      receipt.activity_revision,
      receipt.transition_id,
    );
    const pending = [...this.writes].reverse().find(write => write.path === path)?.value;
    if (pending !== undefined) {
      const existing = transitionReceiptV20Schema.parse(pending);
      if (stableJsonUtf8(existing) !== stableJsonUtf8(receipt)) {
        throw new Error(`v3 transition receipt is immutable: ${receipt.transition_id}`);
      }
      return;
    }
    const existing = this.store.readTransitionReceiptV20(
      this.sessionId,
      receipt.activity_revision,
      receipt.transition_id,
    );
    if (existing) {
      if (stableJsonUtf8(existing) !== stableJsonUtf8(receipt)) {
        throw new Error(`v3 transition receipt is immutable: ${receipt.transition_id}`);
      }
      return;
    }
    this.writes.push({
      path,
      value: receipt,
      schema: transitionReceiptV20Schema,
    });
  }

  writeArtifactRepublishReceipt(receiptInput: ArtifactRepublishReceipt): void {
    const receipt = artifactRepublishReceiptSchema.parse(receiptInput);
    if (receipt.session_id !== this.sessionId) {
      throw new Error('Artifact republish receipt Session identity mismatch');
    }
    assertSafePathSegment(receipt.receipt_id, 'Artifact republish receipt ID');
    const path = join(this.store.receiptsDir(this.sessionId), 'artifact-republish', `${receipt.receipt_id}.json`);
    const pending = [...this.writes].reverse().find(write => write.path === path)?.value;
    if (pending !== undefined) {
      const existing = artifactRepublishReceiptSchema.parse(pending);
      if (stableJsonUtf8(existing) !== stableJsonUtf8(receipt)) {
        throw new Error(`Artifact republish receipt is immutable: ${receipt.receipt_id}`);
      }
      return;
    }
    const existing = existsSync(path)
      ? this.store.readJsonFileReadOnly(path, artifactRepublishReceiptSchema)
      : null;
    if (existing) {
      if (stableJsonUtf8(existing) !== stableJsonUtf8(receipt)) {
        throw new Error(`Artifact republish receipt is immutable: ${receipt.receipt_id}`);
      }
      return;
    }
    this.writes.push({ path, value: receipt, schema: artifactRepublishReceiptSchema, mode: 0o600 });
  }

  writeJson(path: string, value: unknown, schema: z.ZodType, mode?: number): void {
    this.assertNotReceiptPath(path);
    this.writes.push({ path, value, schema, mode });
  }

  writeRaw(path: string, raw: string, mode?: number): void {
    this.assertNotReceiptPath(path);
    this.writes.push({ path, raw, mode });
  }
}

export class ExecutionStoreTransaction {
  readonly writes: JsonWrite[] = [];

  constructor(
    private readonly store: SessionStore,
    private readonly sessionId: string,
    private readonly executionId: string,
  ) {}

  writeExecution(execution: ExecutionState): void {
    this.writes.push({
      path: this.store.executionPath(this.sessionId, this.executionId),
      value: execution,
      schema: executionStateSchema,
      mode: 0o600,
    });
  }

  writeTransition(record: PersistedTransitionRecordV11, schema: z.ZodType<PersistedTransitionRecordV11>): void {
    this.writes.push({
      path: this.store.executionTransitionPath(this.sessionId, this.executionId, record.request_id),
      value: record,
      schema,
    });
  }

  writeSealReceipt(receipt: ExecutionSealReceipt): void {
    if (executionSealReceiptHash(receipt) !== receipt.overall_hash) {
      throw new Error('Execution seal receipt overall hash mismatch');
    }
    const existing = this.store.readExecutionSealReceipt(this.sessionId, this.executionId);
    if (existing) {
      if (stableJsonUtf8(existing) !== stableJsonUtf8(receipt)) {
        throw new Error(`Execution seal receipt is immutable: ${this.executionId}`);
      }
      return;
    }
    this.writes.push({
      path: this.store.executionSealReceiptPath(this.sessionId, this.executionId),
      value: receipt,
      schema: executionSealReceiptReadSchema,
      mode: 0o600,
    });
  }

  writeJson(path: string, value: unknown, schema?: z.ZodType): void {
    this.writes.push({ path, value, schema });
  }
}

export class StoreTransaction {
  readonly writes: JsonWrite[] = [];

  constructor(private readonly store: SessionStore, private readonly sessionId: string) {}

  readExecution(executionId: string): ExecutionState {
    return this.store.readExecutionReadOnly(this.sessionId, executionId);
  }

  readRun(runId: string): CommandRun {
    return this.store.readRun(this.sessionId, runId);
  }

  readExecutionRun(runId: string): CommandRunV14 {
    return this.store.readExecutionRun(this.sessionId, runId);
  }

  readJson<T>(path: string, schema: z.ZodType<T>, fallback?: T): T {
    return this.store.readJsonFileReadOnly(path, schema, fallback);
  }

  listExecutionTransitions(executionId: string): PersistedTransitionRecordV11[] {
    return this.store.listExecutionTransitions(this.sessionId, executionId);
  }

  readExecutionTransition(executionId: string, requestId: string): PersistedTransitionRecordV11 | null {
    return this.store.readExecutionTransitionReadOnly(this.sessionId, executionId, requestId);
  }

  listBoundExecutionRuns(executionId: string, generation: number): CommandRunV14[] {
    return this.store.listBoundExecutionRuns(this.sessionId, executionId, generation);
  }

  gates(): GateRegistry {
    return this.store.readBundle(this.sessionId).gates;
  }

  writeRun(run: CommandRun | CommandRunV14): void {
    const schema = run.schema_version === 'command-run/1.4' ? commandRunV14Schema : commandRunV13Schema;
    schema.parse(run);
    this.writes.push({
      path: join(this.store.runDir(this.sessionId, run.run_id), 'run.json'),
      value: run,
      schema,
    });
  }

  writeExecution(execution: ExecutionState): void {
    this.writes.push({
      path: this.store.executionPath(this.sessionId, execution.execution_id),
      value: execution,
      schema: executionStateSchema,
      mode: 0o600,
    });
  }

  writeExecutionTransition(executionId: string, record: PersistedTransitionRecordV11): void {
    this.writes.push({
      path: this.store.executionTransitionPath(this.sessionId, executionId, record.request_id),
      value: record,
      schema: persistedTransitionRecordV11Schema,
    });
  }

  writeExecutionSealReceipt(executionId: string, receipt: ExecutionSealReceipt): void {
    if (receipt.session_id !== this.sessionId || receipt.execution_id !== executionId) {
      throw new Error('Execution seal receipt transaction identity mismatch');
    }
    if (executionSealReceiptHash(receipt) !== receipt.overall_hash) {
      throw new Error('Execution seal receipt overall hash mismatch');
    }
    const existing = this.store.readExecutionSealReceipt(this.sessionId, executionId);
    if (existing) {
      if (stableJsonUtf8(existing) !== stableJsonUtf8(receipt)) {
        throw new Error(`Execution seal receipt is immutable: ${executionId}`);
      }
      return;
    }
    this.writes.push({
      path: this.store.executionSealReceiptPath(this.sessionId, executionId),
      value: receipt,
      schema: executionSealReceiptReadSchema,
      mode: 0o600,
    });
  }

  writeJson(path: string, value: unknown, schema?: z.ZodType, mode?: number): void {
    this.writes.push({ path, value, schema, mode });
  }

  writeText(path: string, content: string, mode?: number): void {
    this.writes.push({ path, raw: content, mode });
  }

  pendingText(path: string): string | null {
    const pending = [...this.writes].reverse().find(write => write.path === path && write.raw !== undefined);
    return pending?.raw ?? null;
  }

  pendingExecutionSealReceipt(executionId: string): ExecutionSealReceipt | null {
    const path = this.store.executionSealReceiptPath(this.sessionId, executionId);
    const pending = this.writes.find(write => write.path === path);
    return pending ? executionSealReceiptReadSchema.parse(pending.value) : null;
  }

  addStatuslessBundle(bundle: SessionBundle, identity: SessionIdentityV20): void {
    const dir = this.store.sessionDir(this.sessionId);
    this.writes.push(
      { path: join(dir, 'session.json'), value: identity, schema: sessionStateV20Schema },
      {
        path: this.store.sessionCompatibilityPath(this.sessionId),
        value: bundle.session,
        schema: sessionStateV13Schema,
        mode: 0o600,
      },
      { path: join(dir, 'gates.json'), value: bundle.gates, schema: gateRegistrySchema },
      { path: join(dir, 'artifacts.json'), value: bundle.artifacts, schema: artifactRegistrySchema },
      { path: join(dir, 'evidence.json'), value: bundle.evidence, schema: evidenceStoreSchema },
    );
  }

  addBundle(bundle: SessionBundle): void {
    this.store.assertLegacySessionMutationAllowed(this.sessionId);
    const dir = this.store.sessionDir(this.sessionId);
    this.writes.push(
      { path: join(dir, 'session.json'), value: bundle.session, schema: sessionStateV13Schema },
      { path: join(dir, 'gates.json'), value: bundle.gates, schema: gateRegistrySchema },
      { path: join(dir, 'artifacts.json'), value: bundle.artifacts, schema: artifactRegistrySchema },
      { path: join(dir, 'evidence.json'), value: bundle.evidence, schema: evidenceStoreSchema },
    );
  }
}
