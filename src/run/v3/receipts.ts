import type { SessionV30StoreTransaction, SessionStore } from '../store.js';
import {
  requestReceiptV20Schema,
  transitionReceiptV20Schema,
  type RequestReceiptV20,
  type TransitionReceiptV20,
} from '../protocol-schemas.js';
import { assertSafePathSegment } from '../ids.js';
import { sha256Digest, stableJsonUtf8 } from '../transition-receipts.js';
import { createRequestConflictError, V3StructuredError } from './errors.js';

const TRANSITION_RECEIPT_REF = /^receipts\/transitions\/([0-9]{12})-(.+)\.json$/;
const MAX_TRANSITION_RECEIPT_ACTIVITY_REVISION = 999_999_999_999;

export interface TransitionReceiptLocator {
  activityRevision: number;
  transitionId: string;
}

export interface TransitionReceiptReader {
  readTransitionReceipt(
    activityRevision: number,
    transitionId: string,
  ): TransitionReceiptV20 | null;
}

export function canonicalPayloadHash(payload: unknown): string {
  return sha256Digest(stableJsonUtf8(payload));
}

export function transitionReceiptRef(
  activityRevision: number,
  transitionId: string,
): string {
  if (!Number.isSafeInteger(activityRevision)
    || activityRevision <= 0
    || activityRevision > MAX_TRANSITION_RECEIPT_ACTIVITY_REVISION) {
    throw new Error(`invalid transition receipt activity revision: ${activityRevision}`);
  }
  assertSafePathSegment(transitionId, 'transition ID');
  return `receipts/transitions/${String(activityRevision).padStart(12, '0')}-${transitionId}.json`;
}

export function parseTransitionReceiptRef(reference: string): TransitionReceiptLocator {
  const match = TRANSITION_RECEIPT_REF.exec(reference);
  if (!match) throw invalidReceipt(`invalid transition receipt reference: ${reference}`);
  const activityRevision = Number(match[1]);
  const transitionId = match[2];
  if (!Number.isSafeInteger(activityRevision) || activityRevision <= 0) {
    throw invalidReceipt(`invalid transition receipt sequence: ${reference}`);
  }
  try {
    assertSafePathSegment(transitionId, 'transition ID');
  } catch {
    throw invalidReceipt(`invalid transition receipt ID: ${reference}`);
  }
  if (transitionReceiptRef(activityRevision, transitionId) !== reference) {
    throw invalidReceipt(`non-canonical transition receipt reference: ${reference}`);
  }
  return { activityRevision, transitionId };
}

export function readTransitionReceiptRef(
  reader: TransitionReceiptReader,
  reference: string,
): TransitionReceiptV20 {
  const locator = parseTransitionReceiptRef(reference);
  const receipt = reader.readTransitionReceipt(locator.activityRevision, locator.transitionId);
  if (!receipt) throw invalidReceipt(`missing transition receipt: ${reference}`);
  return validatedLocatedTransitionReceipt(receipt, locator, reference);
}

export function readStoredTransitionReceiptRef(
  store: Pick<SessionStore, 'readTransitionReceiptV20'>,
  sessionId: string,
  reference: string,
): TransitionReceiptV20 {
  const locator = parseTransitionReceiptRef(reference);
  const receipt = store.readTransitionReceiptV20(
    sessionId,
    locator.activityRevision,
    locator.transitionId,
  );
  if (!receipt) throw invalidReceipt(`missing transition receipt: ${reference}`);
  const validated = validatedLocatedTransitionReceipt(receipt, locator, reference);
  if (validated.session_id !== sessionId) {
    throw invalidReceipt(`transition receipt Session mismatch: ${reference}`);
  }
  return validated;
}

export function createRequestReceipt(input: {
  requestId: string;
  participantId: string;
  payloadHash: string;
  transitionReceiptRef: string;
}): RequestReceiptV20 {
  parseTransitionReceiptRef(input.transitionReceiptRef);
  return requestReceiptV20Schema.parse({
    schema_version: 'request-receipt/2.0',
    request_id: input.requestId,
    participant_id: input.participantId,
    payload_hash: input.payloadHash,
    transition_receipt_ref: input.transitionReceiptRef,
  });
}

export function createTransitionReceipt(input: {
  transitionId: string;
  requestId: string;
  sessionId: string;
  activityRevision: number;
  targetType: TransitionReceiptV20['target_type'];
  targetId: string;
  revisionBefore: number;
  revisionAfter: number;
  actorId: string;
  participantId: string;
  reason: string;
  evidenceRefs?: readonly string[];
  recordedAt: string;
  result: unknown;
}): TransitionReceiptV20 {
  // Write-path invariant (audit H2): participant identity is an actor alias in
  // v3 — receipts must never carry a participant different from the actor.
  // Reads stay tolerant for legacy receipts written before the invariant.
  if (input.participantId !== input.actorId) {
    throw new Error(`participantId must equal actorId for transition receipts (got ${input.participantId} != ${input.actorId})`);
  }
  return transitionReceiptV20Schema.parse({
    schema_version: 'transition-receipt/2.0',
    transition_id: input.transitionId,
    request_id: input.requestId,
    session_id: input.sessionId,
    activity_revision: input.activityRevision,
    target_type: input.targetType,
    target_id: input.targetId,
    revision_before: input.revisionBefore,
    revision_after: input.revisionAfter,
    actor_id: input.actorId,
    participant_id: input.participantId,
    reason: input.reason,
    evidence_refs: [...(input.evidenceRefs ?? [])],
    recorded_at: input.recordedAt,
    result: input.result,
  });
}

export function replayRequestReceipt(input: {
  tx: Pick<SessionV30StoreTransaction, 'readRequestReceipt' | 'readTransitionReceipt'>;
  sessionId?: string;
  requestId: string;
  participantId: string;
  payloadHash: string;
}): TransitionReceiptV20 | null {
  const storedRequest = input.tx.readRequestReceipt(input.requestId);
  if (!storedRequest) return null;
  const request = requestReceiptV20Schema.parse(storedRequest);
  if (request.participant_id !== input.participantId
    || request.payload_hash !== input.payloadHash) {
    throw createRequestConflictError({
      requestId: input.requestId,
      changedBy: request.participant_id,
    });
  }
  const transition = readTransitionReceiptRef(input.tx, request.transition_receipt_ref);
  if (input.sessionId !== undefined && transition.session_id !== input.sessionId) {
    throw invalidReceipt(`request receipt ${request.request_id} points outside its Session`);
  }
  if (transition.request_id !== request.request_id
    || transition.participant_id !== request.participant_id) {
    throw invalidReceipt(`request receipt ${request.request_id} points to a mismatched transition`);
  }
  return transition;
}

function validatedLocatedTransitionReceipt(
  receipt: TransitionReceiptV20,
  locator: TransitionReceiptLocator,
  reference: string,
): TransitionReceiptV20 {
  const validated = transitionReceiptV20Schema.parse(receipt);
  if (validated.activity_revision !== locator.activityRevision
    || validated.transition_id !== locator.transitionId) {
    throw invalidReceipt(`transition receipt identity mismatch: ${reference}`);
  }
  return validated;
}

function invalidReceipt(message: string): V3StructuredError {
  return new V3StructuredError('INVALID_TRANSITION_RECEIPT', message, {
    next_actions: ['inspect-session-receipts', 'repair-receipt-index'],
  });
}
