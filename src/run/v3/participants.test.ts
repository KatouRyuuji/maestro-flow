import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { SessionStateV30 } from '../schemas.js';
import { SessionStore } from '../store.js';
import {
  participantIdentitySchema,
  participantStatus,
  registerParticipant,
  unregisterParticipant,
} from './participants.js';
import { readStoredTransitionReceiptRef } from './receipts.js';

const roots: string[] = [];

function fixture(status: SessionStateV30['status'] = 'open') {
  const root = mkdtempSync(join(tmpdir(), 'maestro-participants-'));
  roots.push(root);
  const sessionDir = join(root, '.workflow', 'sessions', 's-v3');
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(join(root, '.workflow', 'config.json'), `${JSON.stringify({
    session_schema: {
      schema_version: 'session-schema-selection/1.0',
      writer: 'session/3.0',
      features: { session_statusless: false },
    },
  }, null, 2)}\n`);
  const session: SessionStateV30 = {
    schema_version: 'session/3.0',
    session_id: 's-v3',
    objective: 'participant identity tests',
    definition_of_done: 'identity sidecars remain separate from Session authority',
    status,
    identity_revision: 7,
    orchestration_revision: 11,
    activity_revision: 13,
    chain: [],
    decisions: [],
    active_run_ids: [],
    gates_ref: 'gates.json',
    artifacts_ref: 'artifacts.json',
    evidence_ref: 'evidence.json',
    created_at: '2026-08-12T00:00:00.000Z',
    updated_at: '2026-08-12T00:00:00.000Z',
    completed_at: null,
    archived_at: status === 'archived' ? '2026-08-12T01:00:00.000Z' : null,
  };
  const sessionPath = join(sessionDir, 'session.json');
  writeFileSync(sessionPath, `${JSON.stringify(session, null, 2)}\n`);
  return { root, sessionDir, sessionPath, store: new SessionStore(root) };
}

function mutation(participantId: string, actorId = 'actor-a', requestId = `req-${participantId}`) {
  return {
    sessionId: 's-v3', participantId, actorId, requestId,
    recordedAt: '2026-08-12T02:00:00.000Z',
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('v3 participant identities', () => {
  it('registers with session-scoped receipts and rejects a conflicting actor identity', () => {
    const { store, sessionDir } = fixture();
    expect(registerParticipant(store, mutation('window-a'))).toMatchObject({
      outcome: 'applied', participant: { participant_id: 'window-a', actor_id: 'actor-a', status: 'registered' },
    });
    expect(registerParticipant(store, mutation('window-a', 'actor-a', 'req-retry'))).toMatchObject({
      outcome: 'applied', participant: { participant_id: 'window-a', actor_id: 'actor-a', status: 'registered' },
    });
    expect(registerParticipant(store, mutation('window-a'))).toMatchObject({ outcome: 'replayed' });
    expect(() => registerParticipant(store, mutation('window-a', 'actor-b', 'req-conflict')))
      .toThrow(/different actor identity/);

    const raw = JSON.parse(readFileSync(join(sessionDir, 'participants', 'window-a.json'), 'utf8'));
    expect(participantIdentitySchema.parse(raw)).toMatchObject({
      schema_version: 'participant-identity/1.0',
      session_id: 's-v3',
      participant_id: 'window-a',
      actor_id: 'actor-a',
      registered_request_id: 'req-retry',
    });
    expect(raw).not.toHaveProperty('requests');
    expect(JSON.stringify(raw)).not.toMatch(/lease|owner|execution|generation|heartbeat|handoff|token/i);
    expect(() => participantIdentitySchema.parse({ ...raw, requests: {} })).toThrow();
    expect(() => participantIdentitySchema.parse({ ...raw, lease_id: 'private-token' })).toThrow();

    const request = store.readRequestReceiptV20('s-v3', 'req-window-a');
    expect(request).toMatchObject({
      schema_version: 'request-receipt/2.0',
      request_id: 'req-window-a',
      participant_id: 'window-a',
    });
    expect(readStoredTransitionReceiptRef(store, 's-v3', request!.transition_receipt_ref)).toMatchObject({
      schema_version: 'transition-receipt/2.0',
      request_id: 'req-window-a',
      target_type: 'session-identity',
      target_id: 'window-a',
      result: { participant_id: 'window-a', status: 'registered' },
    });
  });

  it('returns a stable public projection sorted by participant ID', () => {
    const { store } = fixture();
    registerParticipant(store, mutation('window-z', 'actor-z'));
    registerParticipant(store, mutation('window-a', 'actor-a'));

    expect(participantStatus(store, 's-v3')).toEqual({
      schema_version: 'participant-status/1.0',
      session_id: 's-v3',
      participants: [
        {
          participant_id: 'window-a', actor_id: 'actor-a', status: 'registered',
          registered_at: '2026-08-12T02:00:00.000Z', unregistered_at: null,
        },
        {
          participant_id: 'window-z', actor_id: 'actor-z', status: 'registered',
          registered_at: '2026-08-12T02:00:00.000Z', unregistered_at: null,
        },
      ],
    });
  });

  it('replays the original register projection after unregister', () => {
    const { store } = fixture('paused');
    const registerInput = mutation('window-a', 'actor-a', 'req-register');
    const applied = registerParticipant(store, registerInput);
    unregisterParticipant(store, {
      ...mutation('window-a', 'actor-a', 'req-unregister'),
      recordedAt: '2026-08-12T03:00:00.000Z',
    });

    expect(registerParticipant(store, {
      ...registerInput,
      recordedAt: '2026-08-12T04:00:00.000Z',
    })).toEqual({ outcome: 'replayed', participant: applied.participant });
    expect(participantStatus(store, 's-v3').participants[0]).toMatchObject({
      status: 'unregistered',
      registered_at: '2026-08-12T02:00:00.000Z',
      unregistered_at: '2026-08-12T03:00:00.000Z',
    });
    expect(store.readSessionV30('s-v3')).toMatchObject({
      status: 'paused', identity_revision: 9, orchestration_revision: 11, activity_revision: 15,
      updated_at: '2026-08-12T03:00:00.000Z',
    });
  });

  it('rejects cross-participant request reuse and changed operation or payload', () => {
    const { store } = fixture();
    registerParticipant(store, mutation('window-a', 'actor-a', 'req-shared'));

    expect(() => registerParticipant(store, mutation('window-b', 'actor-a', 'req-shared')))
      .toThrow(expect.objectContaining({ code: 'REQUEST_CONFLICT' }));
    expect(() => unregisterParticipant(store, mutation('window-a', 'actor-a', 'req-shared')))
      .toThrow(expect.objectContaining({ code: 'REQUEST_CONFLICT' }));
    expect(() => registerParticipant(store, mutation('window-a', 'actor-b', 'req-shared')))
      .toThrow(expect.objectContaining({ code: 'REQUEST_CONFLICT' }));

    expect(participantStatus(store, 's-v3').participants).toHaveLength(1);
    expect(store.readSessionV30('s-v3')).toMatchObject({ identity_revision: 8, activity_revision: 14 });
  });

  it('rejects unregister for a missing participant without writing a receipt', () => {
    const { store } = fixture();
    expect(() => unregisterParticipant(store, mutation('window-missing', 'actor-a', 'req-missing')))
      .toThrow(expect.objectContaining({ code: 'PARTICIPANT_REQUIRED' }));
    expect(store.readRequestReceiptV20('s-v3', 'req-missing')).toBeNull();
    expect(store.readSessionV30('s-v3')).toMatchObject({ identity_revision: 7, activity_revision: 13 });
  });

  it('registers again after unregister with a new immutable transition', () => {
    const { store, sessionDir } = fixture();
    registerParticipant(store, mutation('window-a', 'actor-a', 'req-register-1'));
    unregisterParticipant(store, {
      ...mutation('window-a', 'actor-a', 'req-unregister'),
      recordedAt: '2026-08-12T03:00:00.000Z',
    });
    expect(registerParticipant(store, {
      ...mutation('window-a', 'actor-a', 'req-register-2'),
      recordedAt: '2026-08-12T04:00:00.000Z',
    })).toEqual({
      outcome: 'applied',
      participant: {
        participant_id: 'window-a', actor_id: 'actor-a', status: 'registered',
        registered_at: '2026-08-12T04:00:00.000Z', unregistered_at: null,
      },
    });

    expect(participantIdentitySchema.parse(JSON.parse(
      readFileSync(join(sessionDir, 'participants', 'window-a.json'), 'utf8'),
    ))).toMatchObject({
      status: 'registered',
      registered_request_id: 'req-register-2',
      unregistered_request_id: null,
    });
    expect(store.readSessionV30('s-v3')).toMatchObject({ identity_revision: 10, activity_revision: 16 });
  });

  it('rejects registration and unregistration after Session archive while status stays readable', () => {
    const { store, sessionDir } = fixture('archived');
    expect(() => registerParticipant(store, mutation('window-a'))).toThrow(/archived/);

    mkdirSync(join(sessionDir, 'participants'), { recursive: true });
    writeFileSync(join(sessionDir, 'participants', 'window-a.json'), `${JSON.stringify({
      schema_version: 'participant-identity/1.0',
      session_id: 's-v3',
      participant_id: 'window-a',
      actor_id: 'actor-a',
      status: 'registered',
      registered_at: '2026-08-12T00:30:00.000Z',
      registered_request_id: 'req-original',
      unregistered_at: null,
      unregistered_request_id: null,
    }, null, 2)}\n`);
    expect(() => unregisterParticipant(store, mutation('window-a', 'actor-a', 'req-remove'))).toThrow(/archived/);
    expect(participantStatus(store, 's-v3').participants).toHaveLength(1);
  });
});
