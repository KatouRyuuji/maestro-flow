import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

import { assertSafePathSegment } from '../ids.js';
import type { SessionStateV30 } from '../schemas.js';
import { SessionStore } from '../store.js';
import { V3StructuredError } from './errors.js';
import {
  canonicalPayloadHash,
  createRequestReceipt,
  createTransitionReceipt,
  replayRequestReceipt,
  transitionReceiptRef,
} from './receipts.js';

const nonEmptyString = z.string().min(1);

/** A participant identifies one source window. It carries no execution authority. */
export const participantIdentitySchema = z.object({
  schema_version: z.literal('participant-identity/1.0'),
  session_id: nonEmptyString,
  participant_id: nonEmptyString,
  actor_id: nonEmptyString,
  status: z.enum(['registered', 'unregistered']),
  registered_at: nonEmptyString,
  registered_request_id: nonEmptyString,
  unregistered_at: nonEmptyString.nullable(),
  unregistered_request_id: nonEmptyString.nullable(),
}).strict();

export const participantProjectionSchema = participantIdentitySchema.pick({
  participant_id: true,
  actor_id: true,
  status: true,
  registered_at: true,
  unregistered_at: true,
}).strict();

export const participantStatusSchema = z.object({
  schema_version: z.literal('participant-status/1.0'),
  session_id: nonEmptyString,
  participants: z.array(participantProjectionSchema),
}).strict();

export type ParticipantIdentity = z.infer<typeof participantIdentitySchema>;
export type ParticipantProjection = z.infer<typeof participantProjectionSchema>;
export type ParticipantStatus = z.infer<typeof participantStatusSchema>;

export interface ParticipantMutationInput {
  sessionId: string;
  participantId: string;
  actorId: string;
  requestId: string;
  recordedAt?: string;
}

export interface ParticipantMutationResult {
  outcome: 'applied' | 'replayed';
  participant: ParticipantProjection;
}

function participantPath(store: SessionStore, sessionId: string, participantId: string): string {
  assertSafePathSegment(participantId, 'participant ID');
  return join(store.sessionDir(sessionId), 'participants', `${participantId}.json`);
}

function requireMutableV30Session(session: SessionStateV30): void {
  if (session.status === 'archived') {
    throw new V3StructuredError('SESSION_ARCHIVED', `Session ${session.session_id} is archived`, {
      details: { session_id: session.session_id, mutation_allowed: false },
      next_actions: ['use-participant-status'],
    });
  }
}

function projection(identity: ParticipantIdentity): ParticipantProjection {
  return participantProjectionSchema.parse({
    participant_id: identity.participant_id,
    actor_id: identity.actor_id,
    status: identity.status,
    registered_at: identity.registered_at,
    unregistered_at: identity.unregistered_at,
  });
}

function assertCanonicalIdentity(
  identity: ParticipantIdentity,
  sessionId: string,
  participantId: string,
): void {
  if (identity.session_id !== sessionId || identity.participant_id !== participantId) {
    throw new Error(`Participant identity does not match its canonical path: ${sessionId}/${participantId}`);
  }
}

function identityConflict(
  participantId: string,
  existingActorId: string,
  requestedActorId: string,
): V3StructuredError {
  return new V3StructuredError(
    'REQUEST_CONFLICT',
    `participant ${participantId} is already bound to a different actor identity`,
    {
      details: {
        participant_id: participantId,
        existing_actor_id: existingActorId,
        requested_actor_id: requestedActorId,
      },
      next_actions: ['use-the-registered-actor', 'choose-a-new-participant-id'],
    },
  );
}

function mutateParticipant(
  store: SessionStore,
  input: ParticipantMutationInput,
  operation: 'register' | 'unregister',
): ParticipantMutationResult {
  const recordedAt = input.recordedAt ?? new Date().toISOString();
  const path = participantPath(store, input.sessionId, input.participantId);
  const payloadHash = canonicalPayloadHash({
    operation: `participant-${operation}`,
    participant_id: input.participantId,
    actor_id: input.actorId,
  });

  return store.withV30Transaction(input.sessionId, tx => {
    const replayed = replayRequestReceipt({
      tx,
      sessionId: input.sessionId,
      requestId: input.requestId,
      participantId: input.participantId,
      payloadHash,
    });
    if (replayed) {
      return {
        outcome: 'replayed',
        participant: participantProjectionSchema.parse(replayed.result),
      };
    }

    const session = tx.readSession();
    requireMutableV30Session(session);
    const existed = existsSync(path);
    if (operation === 'unregister' && !existed) {
      throw new V3StructuredError('PARTICIPANT_REQUIRED', `participant ${input.participantId} is not registered`, {
        details: { participant_id: input.participantId },
        next_actions: ['participant-register'],
      });
    }

    const current = existed ? tx.readJson(path, participantIdentitySchema) : null;
    if (current) {
      assertCanonicalIdentity(current, input.sessionId, input.participantId);
      if (current.actor_id !== input.actorId) {
        throw identityConflict(input.participantId, current.actor_id, input.actorId);
      }
    }

    const identity: ParticipantIdentity = operation === 'register'
      ? {
          schema_version: 'participant-identity/1.0',
          session_id: input.sessionId,
          participant_id: input.participantId,
          actor_id: input.actorId,
          status: 'registered',
          registered_at: recordedAt,
          registered_request_id: input.requestId,
          unregistered_at: null,
          unregistered_request_id: null,
        }
      : {
          ...current!,
          status: 'unregistered',
          unregistered_at: recordedAt,
          unregistered_request_id: input.requestId,
        };
    const participant = projection(identity);
    const nextSession: SessionStateV30 = {
      ...session,
      identity_revision: session.identity_revision + 1,
      activity_revision: session.activity_revision + 1,
      updated_at: recordedAt,
    };
    const transition = createTransitionReceipt({
      transitionId: `participant-${randomUUID()}`,
      requestId: input.requestId,
      sessionId: input.sessionId,
      activityRevision: nextSession.activity_revision,
      targetType: 'session-identity',
      targetId: input.participantId,
      revisionBefore: session.identity_revision,
      revisionAfter: nextSession.identity_revision,
      actorId: input.actorId,
      participantId: input.participantId,
      reason: `${operation} participant ${input.participantId}`,
      recordedAt,
      result: participant,
    });
    const request = createRequestReceipt({
      requestId: input.requestId,
      participantId: input.participantId,
      payloadHash,
      transitionReceiptRef: transitionReceiptRef(
        transition.activity_revision,
        transition.transition_id,
      ),
    });

    tx.writeSession(nextSession);
    tx.writeJson(path, identity, participantIdentitySchema);
    tx.writeTransitionReceipt(transition);
    tx.writeRequestReceipt(request);
    return { outcome: 'applied', participant };
  });
}

export function registerParticipant(
  store: SessionStore,
  input: ParticipantMutationInput,
): ParticipantMutationResult {
  return mutateParticipant(store, input, 'register');
}

export function unregisterParticipant(
  store: SessionStore,
  input: ParticipantMutationInput,
): ParticipantMutationResult {
  return mutateParticipant(store, input, 'unregister');
}

/** Read-only projection: no lock acquisition, recovery, or projection writes. */
export function participantStatus(store: SessionStore, sessionId: string): ParticipantStatus {
  const session = store.readSessionRecordReadOnly(sessionId);
  if (session.schema_version !== 'session/3.0') {
    throw new V3StructuredError(
      'SESSION_SCHEMA_UNSUPPORTED',
      `Session ${sessionId} uses ${session.schema_version}; session/3.0 is required`,
      { details: { session_id: sessionId, schema_version: session.schema_version } },
    );
  }

  const directory = join(store.sessionDir(sessionId), 'participants');
  if (!existsSync(directory)) {
    return participantStatusSchema.parse({
      schema_version: 'participant-status/1.0',
      session_id: sessionId,
      participants: [],
    });
  }
  const directoryStat = lstatSync(directory);
  if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
    throw new Error(`Invalid participant identity directory: ${directory}`);
  }

  const participants = readdirSync(directory)
    .filter(name => name.endsWith('.json'))
    .sort((left, right) => left.localeCompare(right))
    .map(name => {
      const path = join(directory, name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        throw new Error(`Invalid participant identity file: ${path}`);
      }
      const participantId = name.slice(0, -'.json'.length);
      const identity = store.readJsonFileReadOnly(path, participantIdentitySchema);
      assertCanonicalIdentity(identity, sessionId, participantId);
      return projection(identity);
    })
    .sort((left, right) => left.participant_id.localeCompare(right.participant_id));

  return participantStatusSchema.parse({
    schema_version: 'participant-status/1.0',
    session_id: sessionId,
    participants,
  });
}
