import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

import { chainStepId } from './chain-admin.js';
import { createExecutionState } from './defaults.js';
import {
  assertExecutionLease,
  describeExecutionLease,
  hashExecutionLeaseId,
  isExecutionLeaseStale,
  mintExecutionLeaseId,
  type ExecutionLeaseClaim,
  type ExecutionLeaseStatus,
} from './lease.js';
import {
  type ExecutionSealReceipt,
  type PersistedTransitionRecordV11,
  transitionOperationV11Schema,
  type TransitionFenceV11,
} from './protocol-schemas.js';
import {
  sessionStateV20Schema,
  type CommandRunV14,
  type ExecutionLease,
  type ExecutionState,
  type OrchestrationStep,
  type SessionIdentityV20,
  type SessionState,
} from './schemas.js';
import {
  createExecutionSealReceiptV11,
  executionSealReceiptScopeSnapshots,
  SessionStore,
  type SessionBundle,
  type StoreTransaction,
} from './store.js';
import {
  createTransitionOutcomeV11,
  createTransitionRequestV11,
  replayOrApplyTransitionV11,
  stableJsonUtf8,
  TransitionReceiptError,
  validatePersistedTransitionRecordV11,
} from './transition-receipts.js';

const handoffClaimSchema = z.object({
  schema_version: z.literal('execution-handoff-claim/1.0'),
  session_id: z.string().min(1),
  execution_id: z.string().min(1),
  from_owner_id: z.string().min(1),
  to_owner_id: z.string().min(1),
  token_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  prepared_at: z.string().min(1),
}).strict();

const acquisitionReceiptLeaseSchema = z.object({
  owner_id: z.string().min(1),
  owner_kind: z.enum(['pi', 'claude', 'codex', 'agy', 'manual']),
  epoch: z.number().int().positive(),
  lease_id_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  acquired_at: z.string().min(1),
  heartbeat_at: z.string().min(1),
  handoff_to: z.string().min(1).nullable(),
}).strict();

type OwnerKind = ExecutionLease['owner_kind'];
type TransitionOperationV11 = z.infer<typeof transitionOperationV11Schema>;

const auditMetadataSchema = z.object({
  actor: z.string().trim().min(1),
  reason: z.string().trim().min(1),
  evidence: z.array(z.string().trim().min(1)).min(1),
}).strict();

export interface AuditMetadata {
  actor: string;
  reason: string;
  evidence: readonly string[];
}

export interface ExecutionLocatorInput {
  sessionId: string;
  executionId: string;
}

export interface ExecutionMutationOptions extends ExecutionLocatorInput {
  requestId: string;
  expectedExecutionRevision: number;
  lease: ExecutionLeaseClaim;
  now?: Date;
}

export interface AuditedExecutionMutationOptions extends ExecutionMutationOptions, Partial<AuditMetadata> {}

export interface UnleasedExecutionMutationOptions extends ExecutionLocatorInput {
  requestId: string;
  expectedExecutionRevision: number;
  now?: Date;
}

export interface AuditedUnleasedExecutionMutationOptions extends UnleasedExecutionMutationOptions, Partial<AuditMetadata> {}

export interface ExecutionLeaseAcquisition {
  owner_id: string;
  owner_kind: OwnerKind;
  epoch: number;
  lease_id: string;
}

export type PublicExecutionState = Omit<ExecutionState, 'lease'> & {
  lease: Omit<ExecutionLease, 'lease_id'> | null;
};

export interface ExecutionResult {
  execution: PublicExecutionState;
  replayed: boolean;
  transition_id: string;
}

export interface BootstrapExecutionChainOptions extends ExecutionLocatorInput, AuditMetadata {
  requestId: string;
  generation: number;
  expectedIdentityRevision: number;
  expectedActivityRevision: number;
  expectedExecutionRevision: number;
  lease: ExecutionLeaseClaim;
  now?: Date;
}

export interface StartExecutionOptions extends Partial<AuditMetadata> {
  executionId?: string;
  requestId: string;
  ownerId: string;
  ownerKind: OwnerKind;
  expectedIdentityRevision?: number;
  expectedActivityRevision?: number;
  expectedLeaseEpoch?: number;
  now?: Date;
}

export interface StartExecutionResult extends ExecutionResult {
  lease_claim: ExecutionLeaseAcquisition;
}

export interface UnavailableExecutionAcquisitionResult extends ExecutionResult {
  lease_claim: null;
  credential_status: 'superseded' | 'released' | 'different_current_claim';
  recovery_instruction: string;
}

export type ReplayableExecutionAcquisitionResult =
  | StartExecutionResult
  | UnavailableExecutionAcquisitionResult;

export interface AttachExecutionOptions extends ExecutionLocatorInput {
  requestId: string;
  expectedExecutionRevision: number;
  ownerId: string;
  ownerKind: OwnerKind;
  now?: Date;
}

export interface ExecutionStatusResult {
  session_status: SessionState['status'];
  execution: Omit<ExecutionState, 'lease'> & { lease: ExecutionLeaseStatus['lease'] };
  lease: ExecutionLeaseStatus;
}

export type ExecutionResolutionTarget =
  | { kind: 'decision'; id: string; disposition: 'proceed' | 'retry' }
  | { kind: 'step'; id: string; disposition: 'retry' | 'skip' };

export interface ResolveExecutionOptions extends AuditedUnleasedExecutionMutationOptions {
  target: ExecutionResolutionTarget;
}

export interface ResumeExecutionOptions extends AuditedUnleasedExecutionMutationOptions {
  ownerId: string;
  ownerKind: OwnerKind;
  expectedActivityRevision?: number;
  expectedLeaseEpoch?: number;
}

export interface SealExecutionOptions extends AuditedExecutionMutationOptions {
  summary: string;
  outcome: 'done' | 'done_with_concerns' | 'failed';
  expectedActivityRevision?: number;
  staleAfterMs?: number;
}

export interface RecoverExecutionLeaseOptions extends ExecutionLocatorInput, Partial<AuditMetadata> {
  requestId: string;
  expectedExecutionRevision: number;
  ownerId: string;
  ownerKind: OwnerKind;
  expectedLeaseEpoch?: number;
  staleAfterMs?: number;
  now?: Date;
}

export interface PrepareExecutionHandoffOptions extends AuditedExecutionMutationOptions {
  toOwnerId: string;
}

export interface PrepareExecutionHandoffResult extends ExecutionResult {
  handoff_token: string | null;
  credential_status: 'issued' | 'already_applied';
  recovery: 'none' | 'cancel_and_prepare_new';
}

export interface AcceptExecutionHandoffOptions extends ExecutionLocatorInput, Partial<AuditMetadata> {
  requestId: string;
  expectedExecutionRevision: number;
  ownerId: string;
  ownerKind: OwnerKind;
  handoffToken: string;
  expectedLeaseEpoch?: number;
  now?: Date;
}

export class ExecutionLeaseReleaseBlockedError extends Error {
  readonly code = 'LEASE_RELEASE_BLOCKED' as const;

  constructor(readonly blockers: readonly string[]) {
    super(`Execution lease release blocked: ${blockers.join('; ')}`);
    this.name = 'ExecutionLeaseReleaseBlockedError';
  }
}

function executionStableIdleBlockers(
  session: SessionState,
  execution: ExecutionState,
  tx: StoreTransaction,
  options: { includeHandoff?: boolean } = {},
): string[] {
  const blockers: string[] = [];
  const activeRunIds = [...new Set([execution.active_run_id, session.active_run_id].filter(Boolean))].sort();
  if (activeRunIds.length > 0) blockers.push(`active_run_id=${activeRunIds.join(',')}`);
  const claimedRequestIds = session.requests
    .filter(request => request.status === 'claimed')
    .map(request => request.request_id)
    .sort();
  if (claimedRequestIds.length > 0) blockers.push(`claimed requests=${claimedRequestIds.join(',')}`);
  if (options.includeHandoff && execution.lease?.handoff_to) {
    blockers.push(`in-flight handoff=${execution.lease.handoff_to}`);
  }
  const nonIdleRuns = tx.listBoundExecutionRuns(execution.execution_id, execution.generation)
    .filter(run => run.status !== 'sealed')
    .map(run => `${run.run_id}:${run.status}`)
    .sort();
  if (nonIdleRuns.length > 0) blockers.push(`non-stable-idle Runs=${nonIdleRuns.join(',')}`);
  const runningSteps = session.orchestration.chain
    .filter(step => step.status === 'running')
    .map(step => step.step_id)
    .sort();
  if (runningSteps.length > 0) blockers.push(`in-flight chain transitions=${runningSteps.join(',')}`);
  return blockers;
}

function assertExecutionStableIdle(
  session: SessionState,
  execution: ExecutionState,
  tx: StoreTransaction,
  operation: 'release' | 'handoff prepare' | 'handoff accept',
): void {
  const blockers = executionStableIdleBlockers(session, execution, tx, {
    includeHandoff: operation === 'release',
  });
  if (blockers.length === 0) return;
  if (operation === 'release') throw new ExecutionLeaseReleaseBlockedError(blockers);
  throw new Error(`Execution ${operation} blocked before stable idle: ${blockers.join('; ')}`);
}

function required(value: string | null | undefined, label: string): string {
  const normalized = value?.trim() ?? '';
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

function receiptAudit(metadata: Partial<AuditMetadata>): {
  actor: string;
  reason: string;
  evidence_refs: string[];
} | null {
  if (metadata.actor === undefined && metadata.reason === undefined && metadata.evidence === undefined) return null;
  const audit = auditMetadataSchema.parse({
    actor: metadata.actor,
    reason: metadata.reason,
    evidence: metadata.evidence,
  });
  return { actor: audit.actor, reason: audit.reason, evidence_refs: audit.evidence };
}

function assertExpectedRevision(value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error('expected execution revision must be a non-negative integer');
  }
}

function executionIdFor(generation: number): string {
  return `execution-${String(generation).padStart(3, '0')}`;
}

function claimResult(lease: ExecutionLease): ExecutionLeaseAcquisition {
  return {
    owner_id: lease.owner_id,
    owner_kind: lease.owner_kind,
    epoch: lease.epoch,
    lease_id: lease.lease_id,
  };
}

type ReplayAcquisitionCredential =
  | { status: 'current'; lease: ExecutionLease }
  | { status: 'superseded' | 'released' | 'different_current_claim' };

function replayAcquisitionCredential(
  execution: ExecutionState,
  receipt: PersistedTransitionRecordV11,
  operation: 'execution-attach' | 'execution-resume' | 'execution-handoff-accept' | 'execution-lease-recover',
): ReplayAcquisitionCredential {
  if (receipt.payload.operation !== operation || receipt.outcome.operation !== operation) {
    throw new Error(`request_id ${receipt.request_id} is not an ${operation} acquisition receipt`);
  }
  const parsedLease = acquisitionReceiptLeaseSchema.safeParse(receipt.outcome.result.lease);
  if (!parsedLease.success) {
    throw new Error(`${operation} ${receipt.request_id} has an invalid acquisition lease result`);
  }
  const receiptLease = parsedLease.data;
  const requestedOwnerId = operation === 'execution-handoff-accept'
    ? receipt.payload.payload.to_owner_id
    : receipt.payload.payload.owner_id;
  if (receipt.outcome.postconditions.lease_epoch !== receiptLease.epoch
    || requestedOwnerId !== receiptLease.owner_id
    || receipt.payload.payload.owner_kind !== receiptLease.owner_kind) {
    throw new Error(`${operation} ${receipt.request_id} has a divergent acquisition lease binding`);
  }

  const current = execution.lease;
  if (!current) return { status: 'released' };
  if (current.epoch === receiptLease.epoch
    && hashExecutionLeaseId(current.lease_id) === receiptLease.lease_id_hash
    && current.owner_id === receiptLease.owner_id
    && current.owner_kind === receiptLease.owner_kind) {
    return { status: 'current', lease: structuredClone(current) };
  }
  if (current.epoch < receiptLease.epoch) {
    throw new Error(`${operation} ${receipt.request_id} cannot replay because current lease epoch regressed`);
  }
  return { status: current.epoch > receiptLease.epoch ? 'superseded' : 'different_current_claim' };
}

function replayableAcquisitionResult(
  result: ExecutionResult,
  acquired: ExecutionLease | null,
  replayCredential: ReplayAcquisitionCredential | null,
  requestId: string,
): ReplayableExecutionAcquisitionResult {
  const currentAcquisition = acquired
    ?? (replayCredential?.status === 'current' ? replayCredential.lease : null);
  if (currentAcquisition) return { ...result, lease_claim: claimResult(currentAcquisition) };
  if (!result.replayed || !replayCredential) {
    throw new Error(`execution acquisition ${requestId} completed without a recoverable lease claim`);
  }
  if (replayCredential.status === 'current') {
    throw new Error(`execution acquisition ${requestId} lost its exact current lease claim`);
  }
  const credentialStatus = replayCredential.status;
  return {
    ...result,
    lease_claim: null,
    credential_status: credentialStatus,
    recovery_instruction: credentialStatus === 'released'
      ? 'This acquisition claim has been released. Perform a new authorized acquisition; historical replay cannot restore released credentials.'
      : 'This acquisition claim is no longer current. Use the separately retained current claim or perform a new authorized acquisition; historical replay never returns a different claim.',
  };
}

function publicLease(lease: ExecutionLease): Record<string, unknown> {
  return {
    owner_id: lease.owner_id,
    owner_kind: lease.owner_kind,
    epoch: lease.epoch,
    lease_id_hash: hashExecutionLeaseId(lease.lease_id),
    acquired_at: lease.acquired_at,
    heartbeat_at: lease.heartbeat_at,
    handoff_to: lease.handoff_to,
  };
}

function leaseFor(
  sessionId: string,
  executionId: string,
  ownerId: string,
  ownerKind: OwnerKind,
  epoch: number,
  now: Date,
): ExecutionLease {
  const timestamp = now.toISOString();
  return {
    schema_version: 'execution-lease/1.0',
    session_id: sessionId,
    execution_id: executionId,
    owner_id: required(ownerId, 'owner id'),
    owner_kind: ownerKind,
    epoch,
    lease_id: mintExecutionLeaseId(),
    acquired_at: timestamp,
    heartbeat_at: timestamp,
    handoff_to: null,
  };
}

function fence(
  session: SessionState,
  execution: ExecutionState,
  artifactRevision: number,
): TransitionFenceV11 {
  return {
    session_identity_revision: session.identity_revision,
    session_activity_revision: session.activity_revision,
    execution_id: execution.execution_id,
    execution_generation: execution.generation,
    execution_revision: execution.revision,
    execution_status: execution.status,
    lease_epoch: execution.lease?.epoch ?? null,
    active_run_id: execution.active_run_id,
    run_hash: null,
    artifact_registry_revision: artifactRevision,
  };
}

function syncProjection(session: SessionState, execution: ExecutionState): void {
  execution.active_run_id = session.active_run_id;
  execution.chain = structuredClone(session.orchestration.chain);
  execution.decision_points = structuredClone(session.orchestration.decision_points);
}

function canonicalPlanExecutionChain(): OrchestrationStep[] {
  return ['execute', 'verify'].map((command, index) => ({
    step_id: chainStepId(index, command),
    command,
    status: 'pending',
    run_id: null,
    inserted_by: 'plan-publish',
    decision_ref: null,
    retry: { count: 0, max: 2 },
  }));
}

function bootstrapResult(): Record<string, unknown> {
  const chain = canonicalPlanExecutionChain();
  return {
    engine: 'manual',
    chain_step_ids: chain.map(step => step.step_id),
    chain_hash: sha256(stableJsonUtf8(chain)),
  };
}

function bootstrapFenceConflict(message: string): never {
  throw new TransitionReceiptError('FENCE_CONFLICT', message);
}

function bootstrapRequestConflict(message: string): never {
  throw new TransitionReceiptError('REQUEST_CONFLICT', message);
}

function assertBootstrapRevision(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
}

function assertBootstrapCanonicalState(session: SessionState, execution: ExecutionState): void {
  const chain = canonicalPlanExecutionChain();
  if (session.orchestration.engine !== 'manual'
    || stableJsonUtf8(session.orchestration.chain) !== stableJsonUtf8(chain)
    || stableJsonUtf8(execution.chain) !== stableJsonUtf8(chain)
    || session.orchestration.decision_points.length !== 0
    || execution.decision_points.length !== 0
    || session.active_run_id !== null
    || execution.active_run_id !== null) {
    bootstrapFenceConflict(
      `Execution ${execution.execution_id} chain bootstrap outcome no longer matches canonical authority`,
    );
  }
}

function maximumLeaseEpoch(values: readonly unknown[]): number {
  let maximum = 0;
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if ((key === 'epoch' || key === 'released_epoch' || key === 'recovered_from_epoch')
        && typeof child === 'number' && Number.isInteger(child)) {
        maximum = Math.max(maximum, child);
      }
      visit(child);
    }
  };
  values.forEach(visit);
  return maximum;
}

function handoffPath(store: SessionStore, sessionId: string, executionId: string): string {
  return join(store.executionDir(sessionId, executionId), '.handoff-claim.json');
}

function publicExecution(execution: ExecutionState): ExecutionResult['execution'] {
  const { lease, ...rest } = execution;
  if (!lease) return { ...structuredClone(rest), lease: null };
  const { lease_id: _privateToken, ...sanitizedLease } = lease;
  return { ...structuredClone(rest), lease: structuredClone(sanitizedLease) };
}

function assertActiveExecution(execution: ExecutionState): void {
  if (execution.status !== 'active') {
    throw new Error(`Execution ${execution.execution_id} is ${execution.status}; active authority is required`);
  }
}

function replayStartResult(
  session: SessionState,
  artifactRevision: number,
  execution: ExecutionState,
  rawReceipt: unknown,
  input: {
    sessionId: string;
    executionId?: string;
    requestId: string;
    ownerId: string;
    ownerKind: OwnerKind;
    statusless: boolean;
    audit: Partial<AuditMetadata>;
    expectedIdentityRevision?: number;
    expectedActivityRevision?: number;
    expectedLeaseEpoch?: number;
  },
): StartExecutionResult {
  const receipt = validatePersistedTransitionRecordV11(rawReceipt);
  const requestedExecutionId = input.executionId?.trim();
  const payloadKeys = Object.keys(receipt.payload.payload).sort();
  const audit = receiptAudit(input.audit);
  const expectedPayloadKeys = audit
    ? 'actor,evidence_refs,lease_id_hash,owner_id,owner_kind,reason'
    : 'lease_id_hash,owner_id,owner_kind';
  if (receipt.payload.operation !== 'execution-start'
    || receipt.status !== 'applied'
    || receipt.payload.subject.session_id !== input.sessionId
    || receipt.payload.subject.execution_id !== execution.execution_id
    || receipt.payload.subject.generation !== execution.generation
    || receipt.payload.subject.run_id !== null
    || (requestedExecutionId && requestedExecutionId !== execution.execution_id)
    || payloadKeys.join(',') !== expectedPayloadKeys
    || receipt.payload.payload.owner_id !== input.ownerId
    || receipt.payload.payload.owner_kind !== input.ownerKind
    || (audit !== null && (
      receipt.payload.payload.actor !== audit.actor
      || receipt.payload.payload.reason !== audit.reason
      || JSON.stringify(receipt.payload.payload.evidence_refs) !== JSON.stringify(audit.evidence_refs)
    ))) {
    throw new Error(`request_id ${input.requestId} was already used with different execution-start inputs`);
  }
  const preconditions = receipt.payload.preconditions;
  const resultKeys = Object.keys(receipt.outcome.result).sort();
  if ((!input.statusless && session.status !== 'running')
    || execution.status !== 'active'
    || execution.active_run_id !== session.active_run_id
    || JSON.stringify(execution.chain) !== JSON.stringify(session.orchestration.chain)
    || JSON.stringify(execution.decision_points) !== JSON.stringify(session.orchestration.decision_points)
    || preconditions.execution_id !== null
    || preconditions.execution_generation !== null
    || preconditions.execution_revision !== null
    || preconditions.execution_status !== null
    || preconditions.lease_epoch !== null
    || preconditions.active_run_id !== null
    || preconditions.run_hash !== null
    || (input.expectedIdentityRevision !== undefined
      && preconditions.session_identity_revision !== input.expectedIdentityRevision)
    || (input.expectedActivityRevision !== undefined
      && preconditions.session_activity_revision !== input.expectedActivityRevision)
    || (input.expectedLeaseEpoch !== undefined && input.expectedLeaseEpoch !== 0)
    || resultKeys.length !== 3
    || resultKeys.join(',') !== 'execution_id,generation,lease'
    || !execution.lease
    || receipt.payload.payload.lease_id_hash !== hashExecutionLeaseId(execution.lease.lease_id)
    || receipt.outcome.result.execution_id !== execution.execution_id
    || receipt.outcome.result.generation !== execution.generation
    || JSON.stringify(receipt.outcome.result.lease) !== JSON.stringify(publicLease(execution.lease))
    || JSON.stringify(receipt.outcome.postconditions) !== JSON.stringify(fence(session, execution, artifactRevision))) {
    throw new Error(`execution-start ${input.requestId} cannot replay because persisted authority diverged`);
  }
  return {
    execution: publicExecution(execution),
    lease_claim: claimResult(execution.lease),
    replayed: true,
    transition_id: receipt.outcome.transition_id,
  };
}

function receiptPayload(lease: ExecutionLeaseClaim | undefined, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...extra,
    ...(lease ? {
      lease: {
        owner_id: lease.ownerId,
        owner_kind: lease.ownerKind,
        epoch: lease.epoch,
        lease_id_hash: hashExecutionLeaseId(lease.leaseId),
      },
    } : {}),
  };
}

function sha256(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function storedJsonHash(value: unknown): string {
  return sha256(`${JSON.stringify(value, null, 2)}\n`);
}

function executionCorpusRefs(runs: readonly CommandRunV14[]): ExecutionSealReceipt['corpus_refs'] {
  const refs = new Map<string, ExecutionSealReceipt['corpus_refs'][number]>();
  const add = (kind: string, id: string, contentHash: string | null): void => {
    if (!contentHash) return;
    const key = `${kind}\0${id}\0${contentHash}`;
    refs.set(key, { kind, id, content_hash: contentHash });
  };
  for (const run of runs) {
    const snapshot = run.guidance_snapshot;
    if (!snapshot) continue;
    const source = snapshot.source_path || 'inline';
    const prefix = `${run.run_id}:${source}`;
    add('command-guidance', prefix, snapshot.content_hash);
    add('resolved-prompt', prefix, snapshot.resolved_prompt_hash);
    add('prepare-guidance', `${prefix}#prepare`, snapshot.prepare_hash);
    add('workflow-guidance', `${prefix}#workflow`, snapshot.workflow_hash);
    add('run-mode-guidance', `${prefix}#run-mode`, snapshot.run_mode_hash);
  }
  return [...refs.values()].sort((left, right) => {
    const kindOrder = left.kind.localeCompare(right.kind);
    return kindOrder || left.id.localeCompare(right.id) || left.content_hash.localeCompare(right.content_hash);
  });
}

function buildExecutionSealReceipt(
  store: SessionStore,
  bundle: SessionBundle,
  execution: ExecutionState,
  tx: StoreTransaction,
): ExecutionSealReceipt {
  if (!execution.sealed_at) throw new Error('sealed Execution timestamp is required for receipt');
  const runs = tx.listBoundExecutionRuns(execution.execution_id, execution.generation)
    .sort((left, right) => left.run_id.localeCompare(right.run_id));
  const scopeSnapshots = executionSealReceiptScopeSnapshots(runs, bundle);
  const chainSnapshot = structuredClone(execution.chain);
  return createExecutionSealReceiptV11({
    session_id: execution.session_id,
    execution_id: execution.execution_id,
    generation: execution.generation,
    sealed_at: execution.sealed_at,
    execution_revision: execution.revision,
    execution_hash: storedJsonHash(execution),
    session_identity_revision: bundle.session.identity_revision,
    session_activity_revision: bundle.session.activity_revision,
    runs: runs.map(run => ({
      run_id: run.run_id,
      schema_version: run.schema_version,
      content_hash: sha256(readFileSync(join(store.runDir(execution.session_id, run.run_id), 'run.json'), 'utf8')),
    })),
    chain_snapshot: chainSnapshot,
    chain_hash: sha256(stableJsonUtf8(chainSnapshot)),
    ...scopeSnapshots,
    corpus_refs: executionCorpusRefs(runs),
  });
}

interface ExecutionMutationControls {
  requireLease?: boolean;
  advanceRevision?: boolean;
  audited?: boolean;
  expectedActivityRevision?: number;
  afterAdvance?: (
    bundle: SessionBundle,
    execution: ExecutionState,
    tx: StoreTransaction,
    now: Date,
    result: Record<string, unknown>,
  ) => void;
  afterEvaluate?: (
    execution: ExecutionState,
    receipt: PersistedTransitionRecordV11,
    replayed: boolean,
  ) => void;
}

function mutateExecution(
  projectRoot: string,
  operation: TransitionOperationV11,
  options: UnleasedExecutionMutationOptions & Partial<AuditMetadata> & { lease?: ExecutionLeaseClaim },
  payload: Record<string, unknown>,
  apply: (
    session: SessionState,
    execution: ExecutionState,
    tx: StoreTransaction,
    now: Date,
  ) => Record<string, unknown>,
  controls: ExecutionMutationControls = {},
): ExecutionResult {
  const requireLease = controls.requireLease ?? true;
  const advanceRevision = controls.advanceRevision ?? true;
  assertExpectedRevision(options.expectedExecutionRevision);
  const store = new SessionStore(projectRoot);
  const now = options.now ?? new Date();
  return store.updateExecutionAtomic(
    options.sessionId,
    options.executionId,
    options.expectedExecutionRevision,
    (draft, execution, tx) => {
      const before = fence(draft.session, execution, draft.artifacts.revision);
      const records = tx.listExecutionTransitions(options.executionId);
      const existing = records.find(record => record.request_id === options.requestId) ?? null;
      const request = createTransitionRequestV11({
        request_id: required(options.requestId, 'request id'),
        operation,
        subject: {
          session_id: options.sessionId,
          execution_id: options.executionId,
          generation: execution.generation,
          run_id: execution.active_run_id,
          chain_step_id: null,
        },
        requested_at: existing?.payload.requested_at ?? now.toISOString(),
        preconditions: existing?.payload.preconditions ?? before,
        payload: receiptPayload(options.lease, controls.audited
          ? { ...payload, ...(receiptAudit(options) ?? {}) }
          : payload),
      });
      const evaluated = replayOrApplyTransitionV11(
        records,
        request,
        before,
        () => {
          if (requireLease) {
            if (!options.lease) throw new Error('execution lease claim is required');
            assertExecutionLease(
              execution.lease,
              options.lease,
              {
                allowHandoff: operation === 'execution-handoff-cancel'
                  || operation === 'execution-handoff-accept'
                  || operation === 'execution-lease-release',
              },
            );
          }
          const result = apply(draft.session, execution, tx, now);
          syncProjection(draft.session, execution);
          if (advanceRevision) {
            execution.revision++;
            draft.session.activity_revision++;
          }
          controls.afterAdvance?.(draft, execution, tx, now, result);
          return createTransitionOutcomeV11({
            request_id: request.request_id,
            request_hash: request.normalized_request_hash,
            operation,
            status: 'applied',
            applied_at: now.toISOString(),
            subject: request.subject,
            postconditions: fence(draft.session, execution, draft.artifacts.revision),
            exit_code: 0,
            error_code: null,
            result,
          });
        },
      );
      controls.afterEvaluate?.(execution, evaluated.record, evaluated.replayed);
      if (!evaluated.replayed) tx.writeExecutionTransition(options.executionId, evaluated.record);
      return {
        execution: publicExecution(execution),
        replayed: evaluated.replayed,
        transition_id: evaluated.outcome.transition_id,
      };
    },
    {
      replayRequestId: options.requestId,
      expectedActivityRevision: controls.expectedActivityRevision,
    },
  );
}

export function startExecution(
  projectRoot: string,
  sessionId: string,
  options: StartExecutionOptions,
): StartExecutionResult {
  const store = new SessionStore(projectRoot);
  const now = options.now ?? new Date();
  const requestId = required(options.requestId, 'request id');
  const ownerId = required(options.ownerId, 'owner id');
  return store.createExecutionAtomic(sessionId, (draft, existing, tx) => {
    const sessionRecord = store.readSessionRecord(sessionId);
    const statusless = sessionRecord.schema_version === 'session/2.0';
    const identity: SessionIdentityV20 | null = statusless
      ? sessionStateV20Schema.parse(sessionRecord)
      : null;
    if (identity) {
      const canonicalCurrent = identity.current_execution_id
        ? existing.find(execution => execution.execution_id === identity.current_execution_id)
        : null;
      draft.session.status = canonicalCurrent?.status === 'paused' ? 'paused' : 'running';
    }
    for (const execution of existing) {
      const receipt = tx.readExecutionTransition(execution.execution_id, requestId);
      if (!receipt) continue;
      return {
        execution: null,
        result: replayStartResult(draft.session, draft.artifacts.revision, execution, receipt, {
          sessionId,
          executionId: options.executionId,
          requestId,
          ownerId,
          ownerKind: options.ownerKind,
          statusless,
          audit: options,
          expectedIdentityRevision: options.expectedIdentityRevision,
          expectedActivityRevision: options.expectedActivityRevision,
          expectedLeaseEpoch: options.expectedLeaseEpoch,
        }),
      };
    }
    if (!statusless && draft.session.status !== 'running') {
      throw new Error(`Session ${sessionId} is ${draft.session.status}; execution start requires running status`);
    }
    if (identity?.current_execution_id) {
      const current = existing.find(execution => execution.execution_id === identity.current_execution_id);
      if (!current || current.status === 'sealed') {
        throw new Error(
          `Session ${sessionId} current Execution pointer is inconsistent: ${identity.current_execution_id}`,
        );
      }
    }
    if (draft.session.active_run_id) {
      throw new Error(
        `Session ${sessionId} has legacy active Run ${draft.session.active_run_id}; explicit migration is required`,
      );
    }
    const generation = existing.reduce((maximum, item) => Math.max(maximum, item.generation), 0) + 1;
    const executionId = options.executionId?.trim() || executionIdFor(generation);
    const execution = createExecutionState(draft.session, {
      executionId,
      generation,
      startedAt: now.toISOString(),
    });
    execution.lease = leaseFor(sessionId, executionId, ownerId, options.ownerKind, 1, now);
    execution.revision = 1;
    const before: TransitionFenceV11 = {
      session_identity_revision: draft.session.identity_revision,
      session_activity_revision: draft.session.activity_revision,
      execution_id: null,
      execution_generation: null,
      execution_revision: null,
      execution_status: null,
      lease_epoch: null,
      active_run_id: null,
      run_hash: null,
      artifact_registry_revision: draft.artifacts.revision,
    };
    if (options.expectedIdentityRevision !== undefined
      && options.expectedIdentityRevision !== before.session_identity_revision) {
      throw new Error(
        `session identity revision conflict: expected ${options.expectedIdentityRevision}, `
        + `current ${before.session_identity_revision}`,
      );
    }
    if (options.expectedActivityRevision !== undefined
      && options.expectedActivityRevision !== before.session_activity_revision) {
      throw new Error(
        `session activity revision conflict: expected ${options.expectedActivityRevision}, `
        + `current ${before.session_activity_revision}`,
      );
    }
    if (options.expectedLeaseEpoch !== undefined && options.expectedLeaseEpoch !== 0) {
      throw new Error(`lease epoch conflict: expected ${options.expectedLeaseEpoch}, current 0`);
    }
    const audit = receiptAudit(options);
    draft.session.activity_revision++;
    const request = createTransitionRequestV11({
      request_id: requestId,
      operation: 'execution-start',
      subject: { session_id: sessionId, execution_id: executionId, generation, run_id: null, chain_step_id: null },
      requested_at: now.toISOString(),
      preconditions: before,
      payload: {
        owner_id: ownerId,
        owner_kind: options.ownerKind,
        lease_id_hash: hashExecutionLeaseId(execution.lease.lease_id),
        ...(audit ?? {}),
      },
    });
    const outcome = createTransitionOutcomeV11({
      request_id: request.request_id,
      request_hash: request.normalized_request_hash,
      operation: request.operation,
      status: 'applied',
      applied_at: now.toISOString(),
      subject: request.subject,
      postconditions: fence(draft.session, execution, draft.artifacts.revision),
      exit_code: 0,
      error_code: null,
      result: { execution_id: executionId, generation, lease: publicLease(execution.lease) },
    });
    const record = validatePersistedTransitionRecordV11({
      request_id: request.request_id,
      type: 'transition',
      status: 'applied',
      payload: request,
      claimed_by_run_id: null,
      outcome,
    });
    tx.writeExecutionTransition(executionId, record);
    return {
      execution,
      result: {
        execution: publicExecution(execution),
        lease_claim: claimResult(execution.lease),
        replayed: false,
        transition_id: outcome.transition_id,
      },
    };
  });
}

export function bootstrapExecutionChain(
  projectRoot: string,
  options: BootstrapExecutionChainOptions,
): ExecutionResult {
  const requestId = required(options.requestId, 'request id');
  const audit = receiptAudit(options);
  if (!audit) throw new Error('actor, reason, and evidence are required');
  if (!Number.isSafeInteger(options.generation) || options.generation < 1) {
    throw new Error('generation must be a positive integer');
  }
  assertBootstrapRevision(options.expectedIdentityRevision, 'expected identity revision');
  assertBootstrapRevision(options.expectedActivityRevision, 'expected activity revision');
  assertBootstrapRevision(options.expectedExecutionRevision, 'expected execution revision');

  const store = new SessionStore(projectRoot);
  const now = options.now ?? new Date();
  return store.updateExecutionAtomic(
    options.sessionId,
    options.executionId,
    undefined,
    (draft, execution, tx) => {
      const record = store.readSessionRecord(options.sessionId);
      if (record.schema_version !== 'session/2.0') {
        bootstrapFenceConflict(
          `Execution chain bootstrap requires session/2.0 authority; found ${record.schema_version}`,
        );
      }
      const identity = sessionStateV20Schema.parse(record);
      if (identity.current_execution_id !== options.executionId) {
        bootstrapFenceConflict(
          `Session ${options.sessionId} current Execution is ${identity.current_execution_id ?? '<none>'}; `
          + `expected ${options.executionId}`,
        );
      }

      const before = fence(draft.session, execution, draft.artifacts.revision);
      const records = tx.listExecutionTransitions(options.executionId);
      const existing = records.find(record => record.request_id === requestId) ?? null;
      if (existing) {
        const original = existing.payload.preconditions;
        if (original.session_identity_revision !== options.expectedIdentityRevision
          || original.session_activity_revision !== options.expectedActivityRevision
          || original.execution_id !== options.executionId
          || original.execution_generation !== options.generation
          || original.execution_revision !== options.expectedExecutionRevision
          || original.execution_status !== 'active'
          || original.lease_epoch !== options.lease.epoch
          || original.active_run_id !== null
          || original.run_hash !== null) {
          bootstrapFenceConflict(
            `request_id ${requestId} does not match the original Execution chain bootstrap fence`,
          );
        }
      }

      const request = createTransitionRequestV11({
        request_id: requestId,
        operation: 'execution-chain-bootstrap',
        subject: {
          session_id: options.sessionId,
          execution_id: options.executionId,
          generation: options.generation,
          run_id: null,
          chain_step_id: null,
        },
        requested_at: existing?.payload.requested_at ?? now.toISOString(),
        preconditions: existing?.payload.preconditions ?? before,
        payload: {
          actor: audit.actor,
          reason: audit.reason,
          evidence_refs: audit.evidence_refs,
          lease: {
            owner_id: options.lease.ownerId,
            owner_kind: options.lease.ownerKind,
            epoch: options.lease.epoch,
            lease_id_hash: hashExecutionLeaseId(options.lease.leaseId),
          },
        },
      });

      let evaluated: ReturnType<typeof replayOrApplyTransitionV11>;
      try {
        evaluated = replayOrApplyTransitionV11(
          records,
          request,
          before,
          () => {
            if (before.session_identity_revision !== options.expectedIdentityRevision
              || before.session_activity_revision !== options.expectedActivityRevision
              || before.execution_id !== options.executionId
              || before.execution_generation !== options.generation
              || before.execution_revision !== options.expectedExecutionRevision
              || before.execution_status !== 'active'
              || before.lease_epoch !== options.lease.epoch
              || before.active_run_id !== null
              || before.run_hash !== null) {
              bootstrapFenceConflict(
                `Execution chain bootstrap CAS changed for ${options.sessionId}/${options.executionId}`,
              );
            }
            try {
              assertExecutionLease(execution.lease, options.lease);
            } catch (error) {
              bootstrapFenceConflict((error as Error).message);
            }
            if (draft.session.orchestration.chain.length !== 0
              || execution.chain.length !== 0
              || draft.session.orchestration.decision_points.length !== 0
              || execution.decision_points.length !== 0) {
              bootstrapRequestConflict(
                `Execution ${execution.execution_id} chain is non-empty; empty-only bootstrap refused`,
              );
            }
            draft.session.orchestration.engine = 'manual';
            draft.session.orchestration.chain = canonicalPlanExecutionChain();
            draft.session.orchestration.decision_points = [];
            syncProjection(draft.session, execution);
            execution.revision++;
            draft.session.activity_revision++;
            return createTransitionOutcomeV11({
              request_id: request.request_id,
              request_hash: request.normalized_request_hash,
              operation: request.operation,
              status: 'applied',
              applied_at: now.toISOString(),
              subject: request.subject,
              postconditions: fence(draft.session, execution, draft.artifacts.revision),
              exit_code: 0,
              error_code: null,
              result: bootstrapResult(),
            });
          },
        );
      } catch (error) {
        if (error instanceof TransitionReceiptError && error.code === 'REPLAY_STATE_DIVERGED') {
          bootstrapFenceConflict(
            `request_id ${requestId} bootstrap outcome no longer matches current authority revisions`,
          );
        }
        throw error;
      }

      if (stableJsonUtf8(evaluated.outcome.result) !== stableJsonUtf8(bootstrapResult())) {
        bootstrapFenceConflict(`request_id ${requestId} has a divergent Execution chain bootstrap outcome`);
      }
      assertBootstrapCanonicalState(draft.session, execution);
      try {
        assertExecutionLease(execution.lease, options.lease);
      } catch (error) {
        bootstrapFenceConflict((error as Error).message);
      }
      if (!evaluated.replayed) tx.writeExecutionTransition(options.executionId, evaluated.record);
      return {
        execution: publicExecution(execution),
        replayed: evaluated.replayed,
        transition_id: evaluated.outcome.transition_id,
      };
    },
    { replayRequestId: requestId },
  );
}

export function executionStatus(
  projectRoot: string,
  sessionId: string,
  executionId?: string,
  options: { now?: Date; staleAfterMs?: number } = {},
): ExecutionStatusResult {
  const store = new SessionStore(projectRoot);
  const execution = executionId
    ? store.readExecution(sessionId, executionId)
    : store.readOpenExecution(sessionId);
  if (!execution) throw new Error(`Execution not found for Session ${sessionId}`);
  const status = describeExecutionLease(execution.lease, options.now, options.staleAfterMs);
  const { lease: _privateLease, ...publicExecution } = execution;
  return {
    session_status: store.readBundle(sessionId).session.status,
    execution: { ...publicExecution, lease: status.lease },
    lease: status,
  };
}

export function attachExecution(
  projectRoot: string,
  options: AttachExecutionOptions,
): ReplayableExecutionAcquisitionResult {
  const provisional: ExecutionLeaseClaim = {
    ownerId: options.ownerId,
    ownerKind: options.ownerKind,
    epoch: 0,
    leaseId: 'attach-provisional',
  };
  let acquired: ExecutionLease | null = null;
  let replayCredential: ReplayAcquisitionCredential | null = null;
  const result = mutateExecution(
    projectRoot,
    'execution-attach',
    { ...options, lease: provisional },
    { owner_id: options.ownerId, owner_kind: options.ownerKind },
    (session, execution, tx, now) => {
      assertActiveExecution(execution);
      if (session.status !== 'running') {
        throw new Error(`Execution ${execution.execution_id} cannot attach while Session is ${session.status}`);
      }
      if (execution.lease) throw new Error(`execution lease busy: owned by ${execution.lease.owner_id}`);
      const nextEpoch = maximumLeaseEpoch(tx.listExecutionTransitions(options.executionId)) + 1;
      acquired = leaseFor(
        options.sessionId,
        options.executionId,
        options.ownerId,
        options.ownerKind,
        nextEpoch,
        now,
      );
      execution.lease = acquired;
      return { lease: publicLease(acquired) };
    },
    {
      requireLease: false,
      afterEvaluate: (execution, receipt, replayed) => {
        if (replayed) replayCredential = replayAcquisitionCredential(execution, receipt, 'execution-attach');
      },
    },
  );
  return replayableAcquisitionResult(result, acquired, replayCredential, options.requestId);
}

export function pauseExecution(projectRoot: string, options: AuditedExecutionMutationOptions): ExecutionResult {
  return mutateExecution(projectRoot, 'execution-pause', options, {}, (session, execution) => {
    if (execution.status !== 'active') throw new Error(`Execution ${execution.execution_id} is ${execution.status}`);
    if (execution.active_run_id) throw new Error(`Execution has active Run ${execution.active_run_id}`);
    const releasedEpoch = execution.lease?.epoch ?? options.lease.epoch;
    execution.status = 'paused';
    execution.lease = null;
    session.status = 'paused';
    return { status: 'paused', released_epoch: releasedEpoch };
  }, { audited: true });
}

export function resolveExecution(projectRoot: string, options: ResolveExecutionOptions): ExecutionResult {
  return mutateExecution(projectRoot, 'execution-resolve', options, { target: options.target }, (session, execution) => {
    if (execution.status !== 'paused' || session.status !== 'paused') {
      throw new Error(`Execution ${execution.execution_id} is not paused`);
    }
    const target = options.target;
    if (target.kind === 'decision') {
      const point = session.orchestration.decision_points.find(item => item.point_id === target.id);
      if (!point || point.status !== 'escalated') throw new Error(`decision ${target.id} is not escalated`);
      point.status = target.disposition === 'proceed' ? 'passed' : 'pending';
      const step = session.orchestration.chain.find(item => item.decision_ref === target.id);
      if (step) step.status = target.disposition === 'proceed' ? 'sealed' : 'pending';
    } else {
      const step = session.orchestration.chain.find(item => item.step_id === target.id);
      if (!step || step.status !== 'failed') throw new Error(`chain step ${target.id} is not failed`);
      step.status = target.disposition === 'skip' ? 'skipped' : 'pending';
      if (target.disposition === 'retry') step.run_id = null;
    }
    return { target };
  }, { requireLease: false, audited: true });
}

export function resumeExecution(
  projectRoot: string,
  options: ResumeExecutionOptions,
): ReplayableExecutionAcquisitionResult {
  let acquired: ExecutionLease | null = null;
  let replayCredential: ReplayAcquisitionCredential | null = null;
  const result = mutateExecution(projectRoot, 'execution-resume', options, {
    owner_id: options.ownerId,
    owner_kind: options.ownerKind,
  }, (session, execution, tx, now) => {
    if (execution.status !== 'paused' || session.status !== 'paused') {
      throw new Error(`Execution ${execution.execution_id} is not paused`);
    }
    if (execution.lease) throw new Error('paused Execution must not retain a lease');
    if (session.orchestration.decision_points.some(item => item.status === 'escalated')) {
      throw new Error('unresolved escalated decision');
    }
    if (session.orchestration.chain.some(item => item.status === 'failed')) {
      throw new Error('unresolved failed chain step');
    }
    const nextEpoch = maximumLeaseEpoch(tx.listExecutionTransitions(options.executionId)) + 1;
    acquired = leaseFor(
      options.sessionId,
      options.executionId,
      options.ownerId,
      options.ownerKind,
      nextEpoch,
      now,
    );
    execution.lease = acquired;
    execution.status = 'active';
    session.status = 'running';
    return { status: 'active', lease: publicLease(acquired) };
  }, {
    requireLease: false,
    audited: true,
    expectedActivityRevision: options.expectedActivityRevision,
    afterEvaluate: (execution, receipt, replayed) => {
      if (replayed) replayCredential = replayAcquisitionCredential(execution, receipt, 'execution-resume');
    },
  });
  return replayableAcquisitionResult(result, acquired, replayCredential, options.requestId);
}

function replaySealExecution(
  store: SessionStore,
  options: SealExecutionOptions,
): ExecutionResult | null {
  return store.withLock(() => {
    const raw = store.readExecutionTransition(options.sessionId, options.executionId, options.requestId);
    if (!raw) return null;
    const record = validatePersistedTransitionRecordV11(raw);
    const execution = store.readExecution(options.sessionId, options.executionId);
    const request = createTransitionRequestV11({
      request_id: required(options.requestId, 'request id'),
      operation: 'execution-seal',
      subject: {
        session_id: options.sessionId,
        execution_id: options.executionId,
        generation: execution.generation,
        run_id: null,
        chain_step_id: null,
      },
      requested_at: record.payload.requested_at,
      preconditions: record.payload.preconditions,
      payload: receiptPayload(options.lease, {
        summary: options.summary,
        outcome: options.outcome,
        ...(receiptAudit(options) ?? {}),
      }),
    });
    if (request.normalized_request_hash !== record.payload.normalized_request_hash
      || record.payload.operation !== 'execution-seal'
      || record.status !== 'applied') {
      throw new Error(`request_id ${options.requestId} was already used with different execution-seal inputs`);
    }
    if (record.payload.preconditions.execution_revision !== options.expectedExecutionRevision
      || (options.expectedActivityRevision !== undefined
        && record.payload.preconditions.session_activity_revision !== options.expectedActivityRevision)) {
      throw new Error(`request_id ${options.requestId} does not match the original execution-seal revision fence`);
    }
    const receipt = store.readExecutionSealReceipt(options.sessionId, options.executionId);
    if (!receipt) throw new Error(`Execution seal receipt is missing: ${options.executionId}`);
    const resultKeys = Object.keys(record.outcome.result).sort();
    if (execution.status !== 'sealed'
      || execution.generation !== receipt.generation
      || execution.revision !== receipt.execution_revision
      || execution.sealed_at !== receipt.sealed_at
      || stableJsonUtf8(execution.chain) !== stableJsonUtf8(receipt.chain_snapshot)
      || record.outcome.postconditions.execution_id !== execution.execution_id
      || record.outcome.postconditions.execution_generation !== execution.generation
      || record.outcome.postconditions.execution_revision !== execution.revision
      || record.outcome.postconditions.execution_status !== 'sealed'
      || record.outcome.postconditions.lease_epoch !== null
      || record.outcome.postconditions.active_run_id !== null
      || resultKeys.join(',') !== 'final_outcome,seal_receipt_hash,status'
      || record.outcome.result.status !== 'sealed'
      || record.outcome.result.final_outcome !== options.outcome
      || record.outcome.result.seal_receipt_hash !== receipt.overall_hash) {
      throw new Error(`execution-seal ${options.requestId} cannot replay because persisted authority diverged`);
    }
    return {
      execution: publicExecution(execution),
      replayed: true,
      transition_id: record.outcome.transition_id,
    };
  });
}

export function sealExecution(projectRoot: string, options: SealExecutionOptions): ExecutionResult {
  assertExpectedRevision(options.expectedExecutionRevision);
  const store = new SessionStore(projectRoot);
  const replay = replaySealExecution(store, options);
  if (replay) return replay;

  const sessionRecord = store.readSessionRecord(options.sessionId);
  let expectedActivityRevision = options.expectedActivityRevision;
  if (sessionRecord.schema_version === 'session/2.0') {
    const identity = sessionStateV20Schema.parse(sessionRecord);
    if (identity.current_execution_id !== options.executionId) {
      throw new Error(
        `Session ${options.sessionId} current Execution pointer mismatch: expected ${options.executionId}, `
        + `current ${identity.current_execution_id ?? 'null'}`,
      );
    }
    expectedActivityRevision ??= identity.activity_revision;
  }

  return mutateExecution(
    projectRoot,
    'execution-seal',
    options,
    { summary: options.summary, outcome: options.outcome },
    (session, execution, tx, now) => {
      if (execution.status === 'sealed') throw new Error(`Execution ${execution.execution_id} is sealed`);
      assertActiveExecution(execution);
      if (execution.active_run_id || session.active_run_id) throw new Error('Execution has an active Run');
      if (execution.lease?.handoff_to) throw new Error('Execution has an in-flight lease handoff');
      if (!execution.lease || isExecutionLeaseStale(execution.lease, now, options.staleAfterMs)) {
        throw new Error('Execution lease is stale; recovery is required before sealing');
      }
      const boundRuns = tx.listBoundExecutionRuns(execution.execution_id, execution.generation);
      const unsealedRuns = boundRuns.filter(run => run.status !== 'sealed').map(run => run.run_id).sort();
      if (unsealedRuns.length > 0) throw new Error(`Execution has unsealed Runs: ${unsealedRuns.join(', ')}`);
      if (session.orchestration.chain.some(step => !['completed', 'sealed', 'skipped'].includes(step.status))) {
        throw new Error('Execution chain is not terminal');
      }
      const unresolvedDecisions = session.orchestration.decision_points
        .filter(point => point.status !== 'passed')
        .map(point => point.point_id)
        .sort();
      if (unresolvedDecisions.length > 0) {
        throw new Error(`Execution has unresolved decisions: ${unresolvedDecisions.join(', ')}`);
      }
      const blockingGates = Object.entries(tx.gates().gates)
        .filter(([, gate]) => gate.blocking && ['pending', 'running', 'failed', 'blocked'].includes(gate.status))
        .map(([gateId]) => gateId)
        .sort();
      if (blockingGates.length > 0) throw new Error(`Execution gates are not complete: ${blockingGates.join(', ')}`);
      const claimedRequests = session.requests
        .filter(request => request.status === 'claimed')
        .map(request => request.request_id)
        .sort();
      if (claimedRequests.length > 0) {
        throw new Error(`Session has claimed requests: ${claimedRequests.join(', ')}`);
      }
      execution.status = 'sealed';
      execution.sealed_at = now.toISOString();
      execution.seal_summary = options.summary;
      execution.final_outcome = options.outcome;
      execution.lease = null;
      return { status: 'sealed', final_outcome: options.outcome };
    },
    {
      audited: true,
      expectedActivityRevision,
      afterAdvance: (bundle, execution, tx, _now, result) => {
        const receipt = buildExecutionSealReceipt(store, bundle, execution, tx);
        tx.writeExecutionSealReceipt(execution.execution_id, receipt);
        result.seal_receipt_hash = receipt.overall_hash;
      },
    },
  );
}

export function heartbeatExecutionLease(projectRoot: string, options: ExecutionMutationOptions): ExecutionResult {
  return mutateExecution(projectRoot, 'execution-lease-heartbeat', options, {}, (_session, execution, _tx, now) => {
    assertActiveExecution(execution);
    const lease = assertExecutionLease(execution.lease, options.lease);
    lease.heartbeat_at = now.toISOString();
    return { lease: publicLease(lease) };
  }, { advanceRevision: false });
}

export function releaseExecutionLease(projectRoot: string, options: ExecutionMutationOptions): ExecutionResult {
  return mutateExecution(projectRoot, 'execution-lease-release', options, {}, (session, execution, tx) => {
    assertActiveExecution(execution);
    assertExecutionLease(execution.lease, options.lease, { allowHandoff: true });
    assertExecutionStableIdle(session, execution, tx, 'release');
    execution.lease = null;
    return { released: true };
  });
}

export function recoverExecutionLease(
  projectRoot: string,
  options: RecoverExecutionLeaseOptions,
): ReplayableExecutionAcquisitionResult {
  let acquired: ExecutionLease | null = null;
  let replayCredential: ReplayAcquisitionCredential | null = null;
  let recoveredFromEpoch: number | null = null;
  const result = mutateExecution(
    projectRoot,
    'execution-lease-recover',
    options,
    {
      owner_id: options.ownerId,
      owner_kind: options.ownerKind,
    },
    (_session, execution, _tx, now) => {
      assertActiveExecution(execution);
      if (!execution.lease || !isExecutionLeaseStale(execution.lease, now, options.staleAfterMs)) {
        throw new Error('execution lease is not stale; recovery refused');
      }
      recoveredFromEpoch = execution.lease.epoch;
      acquired = leaseFor(
        options.sessionId,
        options.executionId,
        options.ownerId,
        options.ownerKind,
        execution.lease.epoch + 1,
        now,
      );
      execution.lease = acquired;
      return { lease: publicLease(acquired), recovered_from_epoch: recoveredFromEpoch };
    },
    {
      requireLease: false,
      audited: true,
      afterEvaluate: (execution, receipt, replayed) => {
        if (replayed) {
          replayCredential = replayAcquisitionCredential(execution, receipt, 'execution-lease-recover');
        }
      },
    },
  );
  return replayableAcquisitionResult(result, acquired, replayCredential, options.requestId);
}

export function prepareExecutionHandoff(
  projectRoot: string,
  options: PrepareExecutionHandoffOptions,
): PrepareExecutionHandoffResult {
  const store = new SessionStore(projectRoot);
  const token = randomBytes(32).toString('base64url');
  const toOwnerId = required(options.toOwnerId, 'handoff owner id');
  const result = mutateExecution(
    projectRoot,
    'execution-handoff-prepare',
    options,
    { to_owner_id: toOwnerId },
    (session, execution, tx, now) => {
      assertActiveExecution(execution);
      const lease = assertExecutionLease(execution.lease, options.lease);
      if (lease.handoff_to) throw new Error(`execution lease handoff in progress to ${lease.handoff_to}`);
      assertExecutionStableIdle(session, execution, tx, 'handoff prepare');
      lease.handoff_to = toOwnerId;
      tx.writeJson(handoffPath(store, options.sessionId, options.executionId), {
        schema_version: 'execution-handoff-claim/1.0',
        session_id: options.sessionId,
        execution_id: options.executionId,
        from_owner_id: lease.owner_id,
        to_owner_id: toOwnerId,
        token_hash: hashExecutionLeaseId(token),
        prepared_at: now.toISOString(),
      }, handoffClaimSchema, 0o600);
      return { to_owner_id: toOwnerId, handoff_token_hash: hashExecutionLeaseId(token) };
    },
    { audited: true },
  );
  return result.replayed
    ? { ...result, handoff_token: null, credential_status: 'already_applied', recovery: 'cancel_and_prepare_new' }
    : { ...result, handoff_token: token, credential_status: 'issued', recovery: 'none' };
}

export function acceptExecutionHandoff(
  projectRoot: string,
  options: AcceptExecutionHandoffOptions,
): ReplayableExecutionAcquisitionResult {
  const store = new SessionStore(projectRoot);
  const claimPath = handoffPath(store, options.sessionId, options.executionId);
  let acquired: ExecutionLease | null = null;
  let replayCredential: ReplayAcquisitionCredential | null = null;
  const result = mutateExecution(
    projectRoot,
    'execution-handoff-accept',
    options,
    {
      to_owner_id: options.ownerId,
      owner_kind: options.ownerKind,
      handoff_token_hash: hashExecutionLeaseId(options.handoffToken),
    },
    (session, execution, tx, now) => {
      assertActiveExecution(execution);
      const lease = execution.lease;
      if (!lease || !lease.handoff_to) throw new Error('execution handoff is not in progress');
      if (lease.handoff_to !== options.ownerId) throw new Error('execution handoff target changed');
      if (!existsSync(claimPath)) throw new Error('execution handoff token is missing');
      const persisted = tx.readJson(claimPath, handoffClaimSchema);
      if (persisted.to_owner_id !== options.ownerId
        || persisted.token_hash !== hashExecutionLeaseId(options.handoffToken)) {
        throw new Error('execution handoff token is invalid');
      }
      assertExecutionStableIdle(session, execution, tx, 'handoff accept');
      acquired = leaseFor(
        options.sessionId,
        options.executionId,
        options.ownerId,
        options.ownerKind,
        lease.epoch + 1,
        now,
      );
      execution.lease = acquired;
      tx.writeJson(claimPath, { ...persisted, token_hash: hashExecutionLeaseId(randomUUID()) }, handoffClaimSchema, 0o600);
      return { lease: publicLease(acquired), accepted_from: lease.owner_id };
    },
    {
      requireLease: false,
      audited: true,
      afterEvaluate: (execution, receipt, replayed) => {
        if (replayed) {
          replayCredential = replayAcquisitionCredential(execution, receipt, 'execution-handoff-accept');
        }
      },
    },
  );
  return replayableAcquisitionResult(result, acquired, replayCredential, options.requestId);
}

export function cancelExecutionHandoff(
  projectRoot: string,
  options: AuditedExecutionMutationOptions,
): ExecutionResult {
  const store = new SessionStore(projectRoot);
  return mutateExecution(
    projectRoot,
    'execution-handoff-cancel',
    options,
    {},
    (_session, execution, tx) => {
      assertActiveExecution(execution);
      const lease = assertExecutionLease(execution.lease, options.lease, { allowHandoff: true });
      if (!lease.handoff_to) throw new Error('execution handoff is not in progress');
      const cancelled = lease.handoff_to;
      lease.handoff_to = null;
      tx.writeJson(handoffPath(store, options.sessionId, options.executionId), {
        schema_version: 'execution-handoff-claim/1.0',
        session_id: options.sessionId,
        execution_id: options.executionId,
        from_owner_id: lease.owner_id,
        to_owner_id: cancelled,
        token_hash: hashExecutionLeaseId(randomUUID()),
        prepared_at: new Date(0).toISOString(),
      }, handoffClaimSchema, 0o600);
      return { cancelled_to_owner_id: cancelled };
    },
    { audited: true },
  );
}
