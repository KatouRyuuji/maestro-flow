import { createHash, randomUUID } from 'node:crypto';

import {
  persistedTransitionRecordSchema,
  persistedTransitionRecordV11Schema,
  transitionOutcomeSchema,
  transitionOutcomeV11Schema,
  transitionRequestSchema,
  transitionRequestV11Schema,
  type PersistedTransitionRecord,
  type PersistedTransitionRecordV11,
  type TransitionFence,
  type TransitionFenceV11,
  type TransitionOutcome,
  type TransitionOutcomeV11,
  type TransitionRequest,
  type TransitionRequestV11,
} from './protocol-schemas.js';
import type { LeaseClaim } from './lease.js';
import type { SessionState } from './schemas.js';

export interface TransitionMutationOptions {
  requestId: string;
  expectedIdentityRevision: number;
  expectedActivityRevision: number;
  leaseClaim?: LeaseClaim;
}

export interface TransitionMutationReceipt {
  request_id: string;
  transition_id: string;
  status: 'applied' | 'replayed';
}

export type TransitionMutationResult<T> = T & { transition: TransitionMutationReceipt };

export interface PreparedTransitionMutation {
  request: TransitionRequest;
  options: TransitionMutationOptions;
}

export function stableJsonUtf8(value: unknown): string {
  const normalize = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(normalize);
    if (item && typeof item === 'object') {
      return Object.fromEntries(
        Object.entries(item as Record<string, unknown>)
          .filter(([, child]) => child !== undefined)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, child]) => [key, normalize(child)]),
      );
    }
    return item;
  };
  return JSON.stringify(normalize(value));
}

export function sha256Digest(value: string | Buffer): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

export function normalizedTransitionRequestHash(
  request: Omit<TransitionRequest, 'normalized_request_hash'>,
): string {
  return sha256Digest(stableJsonUtf8(request));
}

export function createTransitionRequest(
  input: Omit<TransitionRequest, 'schema_version' | 'normalized_request_hash'>,
): TransitionRequest {
  const unhashed = {
    schema_version: 'transition-request/1.0' as const,
    ...input,
  };
  return transitionRequestSchema.parse({
    ...unhashed,
    normalized_request_hash: normalizedTransitionRequestHash(unhashed),
  });
}

export class TransitionReceiptError extends Error {
  constructor(
    readonly code: 'REQUEST_CONFLICT' | 'REPLAY_STATE_DIVERGED' | 'INVALID_TRANSITION_RECEIPT' | 'FENCE_CONFLICT' | 'ALREADY_ACCEPTED',
    message: string,
  ) {
    super(message);
    this.name = 'TransitionReceiptError';
  }
}

function transitionRecord(
  session: SessionState,
  requestId: string,
): PersistedTransitionRecord | undefined {
  return session.requests.find(item => (
    item.type === 'transition' && item.request_id === requestId && 'outcome' in item
  )) as PersistedTransitionRecord | undefined;
}

function numberFromPayload(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function leaseFromPayload(value: unknown): LeaseClaim | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  return {
    ...(typeof raw.executionOwner === 'string' ? { executionOwner: raw.executionOwner } : {}),
    ...(typeof raw.ownerEpoch === 'number' ? { ownerEpoch: raw.ownerEpoch } : {}),
    ...(typeof raw.leaseId === 'string' ? { leaseId: raw.leaseId } : {}),
  };
}

/**
 * Prepare one normalized retryable mutation request. Existing receipts supply
 * their original timestamp, precondition fence and omitted guard values so a
 * caller may retry with only the same request ID without changing its hash.
 */
export function prepareTransitionMutation(input: {
  session: SessionState;
  currentFence: TransitionFence;
  operation: TransitionRequest['operation'];
  subject: TransitionRequest['subject'];
  payload: Record<string, unknown>;
  options?: Partial<TransitionMutationOptions>;
}): PreparedTransitionMutation {
  const requestId = input.options?.requestId?.trim() || `req_${randomUUID()}`;
  const existing = transitionRecord(input.session, requestId);
  const existingPayload = existing?.payload.payload ?? {};
  // v0.5.61–v0.5.63 persisted `require_running_session` inside the complete
  // payload hash (since removed). Rebuild it for legacy receipts so a retry of
  // that request_id reproduces the stored hash and replays instead of hitting
  // REQUEST_CONFLICT.
  const legacyCompleteFields = 'require_running_session' in existingPayload
    ? { require_running_session: existingPayload.require_running_session }
    : {};
  const expectedIdentityRevision = input.options?.expectedIdentityRevision
    ?? numberFromPayload(existingPayload.expected_identity_revision)
    ?? input.currentFence.session_identity_revision;
  const expectedActivityRevision = input.options?.expectedActivityRevision
    ?? numberFromPayload(existingPayload.expected_activity_revision)
    ?? input.currentFence.session_activity_revision;
  const leaseClaim = input.options?.leaseClaim ?? leaseFromPayload(existingPayload.lease);
  const options: TransitionMutationOptions = {
    requestId,
    expectedIdentityRevision,
    expectedActivityRevision,
    ...(leaseClaim ? { leaseClaim } : {}),
  };
  const payload = {
    ...input.payload,
    ...legacyCompleteFields,
    expected_identity_revision: expectedIdentityRevision,
    expected_activity_revision: expectedActivityRevision,
    lease: leaseClaim ?? {},
  };
  const subject = existing
    && existing.payload.subject.session_id === input.subject.session_id
    && existing.payload.subject.run_id === input.subject.run_id
    ? existing.payload.subject
    : input.subject;
  return {
    options,
    request: createTransitionRequest({
      request_id: requestId,
      operation: input.operation,
      subject,
      requested_at: existing?.payload.requested_at ?? new Date().toISOString(),
      preconditions: existing?.payload.preconditions ?? input.currentFence,
      payload,
    }),
  };
}

export function assertTransitionMutationRevisions(
  session: SessionState,
  options: TransitionMutationOptions,
): void {
  if (session.identity_revision !== options.expectedIdentityRevision) {
    throw new TransitionReceiptError(
      'FENCE_CONFLICT',
      `stale identity revision: expected ${options.expectedIdentityRevision}, current ${session.identity_revision}`,
    );
  }
  if (session.activity_revision !== options.expectedActivityRevision) {
    throw new TransitionReceiptError(
      'FENCE_CONFLICT',
      `stale activity revision: expected ${options.expectedActivityRevision}, current ${session.activity_revision}`,
    );
  }
}

export function transitionMutationReceipt(
  request: TransitionRequest,
  outcome: TransitionOutcome,
  replayed: boolean,
): TransitionMutationReceipt {
  return {
    request_id: request.request_id,
    transition_id: outcome.transition_id,
    status: replayed ? 'replayed' : 'applied',
  };
}

function sameFence(left: unknown, right: unknown): boolean {
  return stableJsonUtf8(left) === stableJsonUtf8(right);
}

function sameFenceWithoutRunHash(left: TransitionFenceV11, right: TransitionFenceV11): boolean {
  const { run_hash: _leftRunHash, ...leftAuthority } = left;
  const { run_hash: _rightRunHash, ...rightAuthority } = right;
  return sameFence(leftAuthority, rightAuthority);
}

function replayStateDiverged(requestId: string, detail = 'outcome no longer matches current authority revisions'): never {
  throw new TransitionReceiptError(
    'REPLAY_STATE_DIVERGED',
    `request_id ${requestId} ${detail}`,
  );
}

function assertAppliedExecutionFenceShape(record: PersistedTransitionRecordV11): void {
  if (record.status !== 'applied') return;
  const before = record.payload.preconditions;
  const after = record.outcome.postconditions;
  if (before.execution_revision === null || after.execution_revision === null) return;
  const expectedExecutionAdvance = record.payload.operation === 'execution-lease-heartbeat' ? 0 : 1;
  const activityAdvance = after.session_activity_revision - before.session_activity_revision;
  const validActivityAdvance = record.payload.operation === 'next'
    ? activityAdvance === 1 || activityAdvance === 2
    : activityAdvance === expectedExecutionAdvance;
  const identityAdvance = after.session_identity_revision - before.session_identity_revision;
  const validIdentityAdvance = record.payload.operation === 'create' || record.payload.operation === 'next'
    ? identityAdvance === 0 || identityAdvance === 1
    : identityAdvance === 0;
  const runOperation = record.payload.operation === 'create'
    || record.payload.operation === 'next'
    || record.payload.operation === 'complete';
  if (before.execution_id !== record.payload.subject.execution_id
    || before.execution_generation !== record.payload.subject.generation
    || after.execution_id !== before.execution_id
    || after.execution_generation !== before.execution_generation
    || after.execution_revision !== before.execution_revision + expectedExecutionAdvance
    || !validActivityAdvance
    || !validIdentityAdvance
    || (!runOperation && (before.run_hash !== null || after.run_hash !== null))) {
    replayStateDiverged(record.request_id, 'has an illegal applied postcondition rewrite');
  }
}

function resultObject(record: PersistedTransitionRecordV11): Record<string, unknown> {
  return record.outcome.result;
}

function nestedObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function resultLeaseEpoch(record: PersistedTransitionRecordV11): number | null {
  const lease = nestedObject(resultObject(record).lease);
  return typeof lease?.epoch === 'number' ? lease.epoch : null;
}

function assertOperationReplayPostconditions(record: PersistedTransitionRecordV11): void {
  if (record.status !== 'applied') return;
  const before = record.payload.preconditions;
  const after = record.outcome.postconditions;
  const result = resultObject(record);
  const activeWithoutRun = before.execution_status === 'active'
    && after.execution_status === 'active'
    && before.active_run_id === null
    && after.active_run_id === null;
  switch (record.payload.operation) {
    case 'execution-pause':
      if (before.execution_status !== 'active' || before.lease_epoch === null
        || after.execution_status !== 'paused' || after.lease_epoch !== null
        || after.active_run_id !== null || result.status !== 'paused'
        || result.released_epoch !== before.lease_epoch) {
        replayStateDiverged(record.request_id, 'has an illegal execution-pause postcondition');
      }
      break;
    case 'execution-resolve':
      if (before.execution_status !== 'paused' || before.lease_epoch !== null
        || after.execution_status !== 'paused' || after.lease_epoch !== null
        || after.active_run_id !== null) {
        replayStateDiverged(record.request_id, 'has an illegal execution-resolve postcondition');
      }
      break;
    case 'execution-resume':
      if (before.execution_status !== 'paused' || before.lease_epoch !== null
        || before.active_run_id !== null || after.execution_status !== 'active'
        || after.lease_epoch === null || after.active_run_id !== null
        || resultLeaseEpoch(record) !== after.lease_epoch) {
        replayStateDiverged(record.request_id, 'has an illegal execution-resume postcondition');
      }
      break;
    case 'execution-attach':
      if (before.lease_epoch !== null || !activeWithoutRun || after.lease_epoch === null
        || resultLeaseEpoch(record) !== after.lease_epoch) {
        replayStateDiverged(record.request_id, 'has an illegal execution-attach postcondition');
      }
      break;
    case 'execution-handoff-accept':
    case 'execution-lease-recover':
      if (!activeWithoutRun || before.lease_epoch === null
        || after.lease_epoch !== before.lease_epoch + 1
        || resultLeaseEpoch(record) !== after.lease_epoch) {
        replayStateDiverged(record.request_id, `has an illegal ${record.payload.operation} postcondition`);
      }
      break;
    case 'execution-lease-release':
      if (!activeWithoutRun || before.lease_epoch === null || after.lease_epoch !== null
        || result.released !== true) {
        replayStateDiverged(record.request_id, 'has an illegal execution-lease-release postcondition');
      }
      break;
    case 'execution-lease-heartbeat':
      if (!sameFence(before, after) || resultLeaseEpoch(record) !== after.lease_epoch) {
        replayStateDiverged(record.request_id, 'has an illegal execution-lease-heartbeat postcondition');
      }
      break;
    case 'execution-handoff-prepare':
    case 'execution-handoff-cancel':
      if (!activeWithoutRun || before.lease_epoch === null || after.lease_epoch !== before.lease_epoch) {
        replayStateDiverged(record.request_id, `has an illegal ${record.payload.operation} postcondition`);
      }
      break;
    case 'execution-chain-bootstrap':
      if (!activeWithoutRun || before.lease_epoch === null || after.lease_epoch !== before.lease_epoch) {
        replayStateDiverged(record.request_id, 'has an illegal execution-chain-bootstrap postcondition');
      }
      break;
    case 'execution-seal':
      if (before.execution_status !== 'active' || before.lease_epoch === null
        || after.execution_status !== 'sealed' || after.lease_epoch !== null
        || after.active_run_id !== null || result.status !== 'sealed') {
        replayStateDiverged(record.request_id, 'has an illegal execution-seal postcondition');
      }
      break;
  }
}

function assertEvidenceBackedReplaySuccessor(
  existing: PersistedTransitionRecordV11,
  records: readonly PersistedTransitionRecordV11[],
  currentFence: TransitionFenceV11,
): void {
  assertAppliedExecutionFenceShape(existing);
  assertOperationReplayPostconditions(existing);
  if (sameFence(existing.outcome.postconditions, currentFence)) return;
  if (existing.status !== 'applied') replayStateDiverged(existing.request_id);

  let cursor = existing.outcome.postconditions;
  const startRevision = cursor.execution_revision;
  const targetRevision = currentFence.execution_revision;
  if (startRevision === null || targetRevision === null
    || cursor.execution_id !== currentFence.execution_id
    || cursor.execution_generation !== currentFence.execution_generation
    || targetRevision < startRevision) {
    replayStateDiverged(existing.request_id);
  }
  let cursorRevision = startRevision;

  while (cursorRevision < targetRevision) {
    const successors = records.filter(record => {
      if (record.request_id === existing.request_id || record.status !== 'applied') return false;
      const before = record.payload.preconditions;
      const after = record.outcome.postconditions;
      return before.execution_revision === cursorRevision
        && after.execution_revision === cursorRevision + 1
        && sameFenceWithoutRunHash(cursor, before);
    });
    if (successors.length !== 1) {
      replayStateDiverged(existing.request_id, 'has no unique evidence-backed successor receipt');
    }
    const successor = successors[0];
    assertAppliedExecutionFenceShape(successor);
    assertOperationReplayPostconditions(successor);
    cursor = successor.outcome.postconditions;
    cursorRevision = cursor.execution_revision!;
  }

  if (!sameFenceWithoutRunHash(cursor, currentFence)) {
    replayStateDiverged(existing.request_id);
  }
}

function invalidReceipt(message: string): never {
  throw new TransitionReceiptError('INVALID_TRANSITION_RECEIPT', message);
}

function assertRequestHash(request: TransitionRequest): void {
  const { normalized_request_hash: _storedHash, ...unhashed } = request;
  if (normalizedTransitionRequestHash(unhashed) !== request.normalized_request_hash) {
    invalidReceipt(`transition request ${request.request_id} normalized request hash is invalid`);
  }
}

export function validatePersistedTransitionRecord(recordInput: unknown): PersistedTransitionRecord {
  const parsed = persistedTransitionRecordSchema.safeParse(recordInput);
  if (!parsed.success) invalidReceipt('persisted transition record does not satisfy its schema');
  const record = parsed.data;
  assertRequestHash(record.payload);
  if (sha256Digest(stableJsonUtf8(record.outcome.result)) !== record.outcome.result_hash) {
    invalidReceipt(`transition ${record.outcome.transition_id} result hash is invalid`);
  }
  if (record.request_id !== record.payload.request_id
    || record.request_id !== record.outcome.request_id
    || record.status !== record.outcome.status
    || record.payload.operation !== record.outcome.operation
    || !sameFence(record.payload.subject, record.outcome.subject)
    || record.outcome.request_hash !== record.payload.normalized_request_hash
    || record.claimed_by_run_id !== record.payload.subject.run_id
    || record.claimed_by_run_id !== record.outcome.subject.run_id) {
    invalidReceipt(`transition record ${record.request_id} is not cross-bound to its request and outcome`);
  }
  return record;
}

export interface ReplayOrApplyTransitionResult {
  outcome: TransitionOutcome;
  record: PersistedTransitionRecord;
  replayed: boolean;
}

/**
 * Pure replay gate. The caller owns the lock and persists `record` only when
 * `replayed` is false. Similarity/recall data is intentionally absent here.
 */
export function replayOrApplyTransition(
  records: readonly PersistedTransitionRecord[],
  requestInput: TransitionRequest,
  currentFence: TransitionFence,
  apply: () => TransitionOutcome,
  validateReplay?: (record: PersistedTransitionRecord) => void,
): ReplayOrApplyTransitionResult {
  const request = transitionRequestSchema.parse(requestInput);
  assertRequestHash(request);
  const parsedRecords = records.map(validatePersistedTransitionRecord);
  const existing = parsedRecords.find(record => record.request_id === request.request_id);
  if (existing) {
    const parsed = existing;
    if (parsed.payload.normalized_request_hash !== request.normalized_request_hash) {
      throw new TransitionReceiptError(
        'REQUEST_CONFLICT',
        `request_id ${request.request_id} was already used with a different normalized request hash`,
      );
    }
    validateReplay?.(parsed);
    if (!sameFence(parsed.outcome.postconditions, currentFence)) {
      throw new TransitionReceiptError(
        'REPLAY_STATE_DIVERGED',
        `request_id ${request.request_id} outcome no longer matches current authority revisions`,
      );
    }
    return { outcome: parsed.outcome, record: parsed, replayed: true };
  }

  const outcome = transitionOutcomeSchema.parse(apply());
  if (outcome.request_id !== request.request_id
    || outcome.request_hash !== request.normalized_request_hash
    || outcome.operation !== request.operation
    || !sameFence(outcome.subject, request.subject)
    || sha256Digest(stableJsonUtf8(outcome.result)) !== outcome.result_hash) {
    throw new TransitionReceiptError(
      'INVALID_TRANSITION_RECEIPT',
      `transition outcome does not bind request ${request.request_id}`,
    );
  }
  const record = persistedTransitionRecordSchema.parse({
    request_id: request.request_id,
    type: 'transition',
    status: outcome.status,
    payload: request,
    claimed_by_run_id: outcome.subject.run_id,
    outcome,
  });
  validatePersistedTransitionRecord(record);
  return { outcome, record, replayed: false };
}

export function createTransitionOutcome(
  input: Omit<TransitionOutcome, 'schema_version' | 'transition_id' | 'result_hash'> & {
    transition_id?: string;
  },
): TransitionOutcome {
  return transitionOutcomeSchema.parse({
    ...input,
    schema_version: 'transition-outcome/1.0',
    transition_id: input.transition_id ?? `tr_${randomUUID()}`,
    result_hash: sha256Digest(stableJsonUtf8(input.result)),
  });
}

export function createTransitionRequestV11(
  input: Omit<TransitionRequestV11, 'schema_version' | 'normalized_request_hash'>,
): TransitionRequestV11 {
  const unhashed = { schema_version: 'transition-request/1.1' as const, ...input };
  return transitionRequestV11Schema.parse({
    ...unhashed,
    normalized_request_hash: normalizedTransitionRequestHash(unhashed as never),
  });
}

export function createTransitionOutcomeV11(
  input: Omit<TransitionOutcomeV11, 'schema_version' | 'transition_id' | 'result_hash'> & {
    transition_id?: string;
  },
): TransitionOutcomeV11 {
  return transitionOutcomeV11Schema.parse({
    ...input,
    schema_version: 'transition-outcome/1.1',
    transition_id: input.transition_id ?? `tr_${randomUUID()}`,
    result_hash: sha256Digest(stableJsonUtf8(input.result)),
  });
}

export function validatePersistedTransitionRecordV11(value: unknown): PersistedTransitionRecordV11 {
  const parsed = persistedTransitionRecordV11Schema.safeParse(value);
  if (!parsed.success) invalidReceipt('persisted transition record does not satisfy transition/1.1 schema');
  const record = parsed.data;
  const { normalized_request_hash: _stored, ...unhashed } = record.payload;
  if (normalizedTransitionRequestHash(unhashed as never) !== record.payload.normalized_request_hash
    || sha256Digest(stableJsonUtf8(record.outcome.result)) !== record.outcome.result_hash
    || record.request_id !== record.payload.request_id
    || record.request_id !== record.outcome.request_id
    || record.status !== record.outcome.status
    || record.payload.operation !== record.outcome.operation
    || !sameFence(record.payload.subject, record.outcome.subject)
    || record.outcome.request_hash !== record.payload.normalized_request_hash
    || record.claimed_by_run_id !== record.payload.subject.run_id) {
    invalidReceipt(`transition record ${record.request_id} is not a valid transition/1.1 receipt`);
  }
  return record;
}

export function replayOrApplyTransitionV11(
  records: readonly PersistedTransitionRecordV11[],
  requestInput: TransitionRequestV11,
  currentFence: TransitionFenceV11,
  apply: () => TransitionOutcomeV11,
  validateReplay?: (
    record: PersistedTransitionRecordV11,
    records: readonly PersistedTransitionRecordV11[],
    currentFence: TransitionFenceV11,
  ) => void,
): { outcome: TransitionOutcomeV11; record: PersistedTransitionRecordV11; replayed: boolean } {
  const request = transitionRequestV11Schema.parse(requestInput);
  const { normalized_request_hash: _stored, ...unhashed } = request;
  if (normalizedTransitionRequestHash(unhashed as never) !== request.normalized_request_hash) {
    invalidReceipt(`transition request ${request.request_id} normalized request hash is invalid`);
  }
  const parsedRecords = records.map(validatePersistedTransitionRecordV11);
  const existing = parsedRecords.find(item => item.request_id === request.request_id);
  if (existing) {
    if (existing.payload.normalized_request_hash !== request.normalized_request_hash) {
      throw new TransitionReceiptError('REQUEST_CONFLICT', `request_id ${request.request_id} was already used`);
    }
    assertEvidenceBackedReplaySuccessor(existing, parsedRecords, currentFence);
    validateReplay?.(existing, parsedRecords, currentFence);
    return { outcome: existing.outcome, record: existing, replayed: true };
  }
  const outcome = transitionOutcomeV11Schema.parse(apply());
  if (outcome.request_id !== request.request_id
    || outcome.request_hash !== request.normalized_request_hash
    || outcome.operation !== request.operation
    || !sameFence(outcome.subject, request.subject)
    || sha256Digest(stableJsonUtf8(outcome.result)) !== outcome.result_hash) {
    invalidReceipt(`transition outcome does not bind request ${request.request_id}`);
  }
  const record = validatePersistedTransitionRecordV11({
    request_id: request.request_id,
    type: 'transition',
    status: outcome.status,
    payload: request,
    claimed_by_run_id: outcome.subject.run_id,
    outcome,
  });
  return { outcome, record, replayed: false };
}

export {
  persistedTransitionRecordSchema,
  transitionOutcomeSchema,
  transitionRequestSchema,
  type PersistedTransitionRecord,
  type TransitionFence,
  type TransitionOutcome,
  type TransitionRequest,
} from './protocol-schemas.js';
