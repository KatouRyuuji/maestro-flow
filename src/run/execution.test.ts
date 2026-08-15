import { createHash } from 'node:crypto';
import { z } from 'zod';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  acceptExecutionHandoff,
  attachExecution,
  bootstrapExecutionChain,
  cancelExecutionHandoff,
  executionStatus,
  heartbeatExecutionLease,
  pauseExecution,
  prepareExecutionHandoff,
  recoverExecutionLease,
  releaseExecutionLease,
  resolveExecution,
  resumeExecution,
  sealExecution,
  startExecution,
} from './execution.js';
import type { ExecutionLeaseClaim } from './lease.js';
import { createChainSession } from './chain-admin.js';
import { migrateSession } from './migrate.js';
import { archiveSession, unarchiveSession } from './session-transition.js';
import { completeExecutionRun, createExecutionRun, createRun } from './runtime.js';

function v2Workspace(root: string): void {
  mkdirSync(join(root, ".workflow"), { recursive: true });
  writeFileSync(join(root, ".workflow", "config.json"), JSON.stringify({
    session_schema: { schema_version: "session-schema-selection/1.0", writer: "session/1.3", features: { session_statusless: false } },
  }));
}
import {
  createSessionArchiveReceipt,
  executionSealReceiptHash,
  SessionStore,
  SessionStoreLock,
  StoreTransaction,
} from './store.js';

const roots: string[] = [];

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'maestro-execution-'));

  v2Workspace(value);
  roots.push(value);
  return value;
}

function claim(value: { owner_id: string; owner_kind: ExecutionLeaseClaim['ownerKind']; epoch: number; lease_id: string }): ExecutionLeaseClaim {
  return { ownerId: value.owner_id, ownerKind: value.owner_kind, epoch: value.epoch, leaseId: value.lease_id };
}

function prepareHandoff(
  projectRoot: string,
  store: SessionStore,
  sessionId: string,
  executionId: string,
  leaseValue: Parameters<typeof claim>[0],
  requestId: string,
  toOwnerId: string,
) {
  return prepareExecutionHandoff(projectRoot, {
    sessionId,
    executionId,
    requestId,
    expectedExecutionRevision: store.readExecution(sessionId, executionId).revision,
    lease: claim(leaseValue),
    toOwnerId,
  });
}

function commandFile(projectRoot: string, name = 'demo'): void {
  const directory = join(projectRoot, '.claude', 'commands');
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, `${name}.md`), `<contract>\nconsumes: []\nproduces: []\ngates:\n  entry: []\n  exit: []\n</contract>\n`, 'utf8');
}

function enableSessionV20(projectRoot: string): void {
  const workflowRoot = join(projectRoot, '.workflow');
  mkdirSync(workflowRoot, { recursive: true });
  writeFileSync(join(workflowRoot, 'config.json'), `${JSON.stringify({
    session_schema: {
      schema_version: 'session-schema-selection/1.0',
      writer: 'session/2.0',
      features: { session_statusless: true },
    },
  }, null, 2)}\n`, 'utf8');
}

function fileHash(path: string): string {
  return `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;
}

function authorityBytes(store: SessionStore, sessionId: string, executionId: string): {
  session: Buffer;
  execution: Buffer;
  handoff: Buffer | null;
} {
  const handoffPath = join(store.executionDir(sessionId, executionId), '.handoff-claim.json');
  return {
    session: readFileSync(join(store.sessionDir(sessionId), 'session.json')),
    execution: readFileSync(store.executionPath(sessionId, executionId)),
    handoff: existsSync(handoffPath) ? readFileSync(handoffPath) : null,
  };
}

function expectAuthorityBytesUnchanged(
  before: ReturnType<typeof authorityBytes>,
  after: ReturnType<typeof authorityBytes>,
): void {
  expect(after.session.equals(before.session)).toBe(true);
  expect(after.execution.equals(before.execution)).toBe(true);
  if (before.handoff === null) expect(after.handoff).toBeNull();
  else expect(after.handoff?.equals(before.handoff)).toBe(true);
}

function expectTransitionReceiptsHashOnly(
  store: SessionStore,
  sessionId: string,
  executionId: string,
  rawSecrets: readonly string[],
): void {
  const corpus = JSON.stringify(store.listExecutionTransitions(sessionId, executionId));
  expect(corpus).toContain('lease_id_hash');
  expect(corpus).not.toContain('"lease_id":');
  for (const secret of rawSecrets) expect(corpus).not.toContain(secret);
}

function expectUnavailableAcquisitionReplay(
  replay: unknown,
  status: 'superseded' | 'released' | 'different_current_claim',
  forbiddenToken?: string,
): void {
  expect(replay).toMatchObject({
    replayed: true,
    lease_claim: null,
    credential_status: status,
    recovery_instruction: expect.stringMatching(/authorized acquisition|current claim/),
  });
  const serialized = JSON.stringify(replay);
  expect(serialized).not.toContain('"lease_id":');
  if (forbiddenToken) expect(serialized).not.toContain(forbiddenToken);
}

function expectReleaseBlocked(operation: () => unknown, message: RegExp): void {
  try {
    operation();
    throw new Error('expected Execution lease release to be blocked');
  } catch (error) {
    expect(error).toMatchObject({ code: 'LEASE_RELEASE_BLOCKED' });
    expect((error as Error).message).toMatch(message);
  }
}

afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('Execution chain bootstrap authority', () => {
  it('atomically installs the canonical manual chain and replays with audit, lease, and CAS fencing', () => {
    const projectRoot = root();
    enableSessionV20(projectRoot);
    const store = new SessionStore(projectRoot);
    store.createSession('s', 'empty Plan execution');
    const started = startExecution(projectRoot, 's', {
      requestId: 'req-start', ownerId: 'pi-session', ownerKind: 'pi',
    });
    const options = {
      sessionId: 's',
      executionId: started.execution.execution_id,
      generation: 1,
      requestId: 'req-plan__bootstrap',
      expectedIdentityRevision: 1,
      expectedActivityRevision: 1,
      expectedExecutionRevision: 1,
      lease: claim(started.lease_claim),
      actor: 'pi-session',
      reason: 'Publish approved Plan',
      evidence: ['pi-plan:approved'],
      now: new Date('2026-08-12T00:00:00.000Z'),
    };

    const acquire = vi.spyOn(SessionStoreLock.prototype, 'acquire');
    const release = vi.spyOn(SessionStoreLock.prototype, 'release');
    const first = bootstrapExecutionChain(projectRoot, options);
    expect(acquire).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
    acquire.mockRestore();
    release.mockRestore();

    expect(first).toMatchObject({
      replayed: false,
      execution: { revision: 2, generation: 1, status: 'active', active_run_id: null },
    });
    const chain = store.readBundle('s').session.orchestration.chain;
    expect(chain).toEqual([
      expect.objectContaining({
        step_id: 'step-000-execute', command: 'execute', status: 'pending', run_id: null,
        inserted_by: 'plan-publish', retry: { count: 0, max: 2 },
      }),
      expect.objectContaining({
        step_id: 'step-001-verify', command: 'verify', status: 'pending', run_id: null,
        inserted_by: 'plan-publish', retry: { count: 0, max: 2 },
      }),
    ]);
    expect(store.readExecution('s', started.execution.execution_id).chain).toEqual(chain);
    expect(store.readSessionRecord('s')).toMatchObject({
      schema_version: 'session/2.0', identity_revision: 1, activity_revision: 2,
      current_execution_id: started.execution.execution_id,
    });

    const receiptPath = store.executionTransitionPath('s', started.execution.execution_id, options.requestId);
    const receiptBytes = readFileSync(receiptPath, 'utf8');
    const receipt = store.readExecutionTransition('s', started.execution.execution_id, options.requestId)!;
    expect(receipt).toMatchObject({
      status: 'applied',
      payload: {
        schema_version: 'transition-request/1.1',
        operation: 'execution-chain-bootstrap',
        preconditions: { execution_revision: 1, session_activity_revision: 1 },
        payload: {
          actor: 'pi-session', reason: 'Publish approved Plan', evidence_refs: ['pi-plan:approved'],
          lease: {
            owner_id: 'pi-session', owner_kind: 'pi', epoch: 1,
            lease_id_hash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
          },
        },
      },
      outcome: {
        schema_version: 'transition-outcome/1.1',
        postconditions: { execution_revision: 2, session_activity_revision: 2 },
      },
    });
    expect(receiptBytes).not.toContain(started.lease_claim.lease_id);

    const replay = bootstrapExecutionChain(projectRoot, {
      ...options,
      now: new Date('2026-08-12T00:00:01.000Z'),
    });
    expect(replay).toMatchObject({ replayed: true, transition_id: first.transition_id, execution: { revision: 2 } });
    expect(readFileSync(receiptPath, 'utf8')).toBe(receiptBytes);
    expect(store.readSessionRecord('s')).toMatchObject({ activity_revision: 2 });

    expect(() => bootstrapExecutionChain(projectRoot, { ...options, reason: 'changed audit' }))
      .toThrowError(expect.objectContaining({ code: 'REQUEST_CONFLICT' }));
    expect(() => bootstrapExecutionChain(projectRoot, {
      ...options, lease: { ...options.lease, leaseId: `${options.lease.leaseId}-changed` },
    })).toThrowError(expect.objectContaining({ code: 'REQUEST_CONFLICT' }));
    expect(() => bootstrapExecutionChain(projectRoot, { ...options, expectedActivityRevision: 2 }))
      .toThrowError(expect.objectContaining({ code: 'FENCE_CONFLICT' }));
    expect(readFileSync(receiptPath, 'utf8')).toBe(receiptBytes);
  });

  it('refuses unrelated non-empty authority and detects post-bootstrap chain divergence without mutation', () => {
    const nonEmptyRoot = root();
    const created = createChainSession(nonEmptyRoot, 's', {
      intent: 'unrelated chain',
      engine: 'manual',
      definition: { intent: 'unrelated chain', engine: 'manual', steps: [{ command: 'review' }] },
    });
    const nonEmptyStart = startExecution(nonEmptyRoot, created.sessionId, {
      requestId: 'req-start', ownerId: 'pi-session', ownerKind: 'pi',
    });
    enableSessionV20(nonEmptyRoot);
    migrateSession(nonEmptyRoot, created.sessionId);
    const nonEmptyStore = new SessionStore(nonEmptyRoot);
    const beforeExecution = readFileSync(
      nonEmptyStore.executionPath(created.sessionId, nonEmptyStart.execution.execution_id),
      'utf8',
    );
    expect(() => bootstrapExecutionChain(nonEmptyRoot, {
      sessionId: created.sessionId,
      executionId: nonEmptyStart.execution.execution_id,
      generation: 1,
      requestId: 'req-unrelated-bootstrap',
      expectedIdentityRevision: 1,
      expectedActivityRevision: 1,
      expectedExecutionRevision: 1,
      lease: claim(nonEmptyStart.lease_claim),
      actor: 'pi-session', reason: 'Publish approved Plan', evidence: ['pi-plan:unrelated'],
    })).toThrowError(expect.objectContaining({ code: 'REQUEST_CONFLICT' }));
    expect(readFileSync(
      nonEmptyStore.executionPath(created.sessionId, nonEmptyStart.execution.execution_id),
      'utf8',
    )).toBe(beforeExecution);
    expect(nonEmptyStore.readExecutionTransition(
      created.sessionId,
      nonEmptyStart.execution.execution_id,
      'req-unrelated-bootstrap',
    )).toBeNull();

    const divergentRoot = root();
    enableSessionV20(divergentRoot);
    const divergentStore = new SessionStore(divergentRoot);
    divergentStore.createSession('s', 'divergent chain');
    const divergentStart = startExecution(divergentRoot, 's', {
      requestId: 'req-start', ownerId: 'pi-session', ownerKind: 'pi',
    });
    const divergentOptions = {
      sessionId: 's', executionId: divergentStart.execution.execution_id, generation: 1,
      requestId: 'req-bootstrap', expectedIdentityRevision: 1, expectedActivityRevision: 1,
      expectedExecutionRevision: 1, lease: claim(divergentStart.lease_claim),
      actor: 'pi-session', reason: 'Publish approved Plan', evidence: ['pi-plan:divergence'],
    };
    bootstrapExecutionChain(divergentRoot, divergentOptions);
    divergentStore.updateExecutionAtomic('s', divergentStart.execution.execution_id, 2, (draft, execution) => {
      const changed = structuredClone(execution.chain);
      changed[0] = { ...changed[0], command: 'changed' };
      draft.session.orchestration.chain = changed;
      execution.chain = structuredClone(changed);
    });
    const divergentBytes = readFileSync(
      divergentStore.executionPath('s', divergentStart.execution.execution_id),
      'utf8',
    );
    expect(() => bootstrapExecutionChain(divergentRoot, divergentOptions))
      .toThrowError(expect.objectContaining({ code: 'FENCE_CONFLICT' }));
    expect(readFileSync(
      divergentStore.executionPath('s', divergentStart.execution.execution_id),
      'utf8',
    )).toBe(divergentBytes);
  });
});

describe('Execution lifecycle and lease authority', () => {
  it('sequences generations, permits at most one open Execution, and keeps Session status authoritative', () => {
    const projectRoot = root();
    const store = new SessionStore(projectRoot);
    store.createSession('s', 'execution lifecycle');
    const first = startExecution(projectRoot, 's', {
      requestId: 'req-start-1', ownerId: 'worker-a', ownerKind: 'codex',
      now: new Date('2026-01-01T00:00:00.000Z'),
    });
    expect(first.execution.generation).toBe(1);
    expect(() => startExecution(projectRoot, 's', {
      requestId: 'req-start-busy', ownerId: 'worker-b', ownerKind: 'pi',
    })).toThrow(/open Execution/);

    const paused = pauseExecution(projectRoot, {
      sessionId: 's', executionId: first.execution.execution_id, requestId: 'req-pause',
      expectedExecutionRevision: 1, lease: claim(first.lease_claim),
    });
    expect(paused.execution.status).toBe('paused');
    expect(paused.execution.lease).toBeNull();
    expect(store.readBundle('s').session.status).toBe('paused');
    const resumed = resumeExecution(projectRoot, {
      sessionId: 's', executionId: first.execution.execution_id, requestId: 'req-resume',
      expectedExecutionRevision: 2, ownerId: 'worker-a', ownerKind: 'codex',
    });
    expect(resumed.execution.status).toBe('active');
    expect(resumed.lease_claim.epoch).toBe(2);
    expect(store.readBundle('s').session.status).toBe('running');
    const sealed = sealExecution(projectRoot, {
      sessionId: 's', executionId: first.execution.execution_id, requestId: 'req-seal',
      expectedExecutionRevision: 3, lease: claim(resumed.lease_claim), summary: 'generation complete', outcome: 'done',
    });
    expect(sealed.execution.status).toBe('sealed');
    expect(store.readBundle('s').session.status).toBe('running');

    const second = startExecution(projectRoot, 's', {
      requestId: 'req-start-2', ownerId: 'worker-b', ownerKind: 'pi',
    });
    expect(second.execution.generation).toBe(2);
    expect(second.execution.execution_id).toBe('execution-002');
    expect(store.listExecutions('s').map(item => item.generation)).toEqual([1, 2]);
  });

  it('rejects closed or legacy-active Session acquisition and only attaches active unowned Executions', () => {
    for (const status of ['paused', 'failed'] as const) {
      const projectRoot = root();
      const store = new SessionStore(projectRoot);
      store.createSession('s', `${status} acquisition`);
      store.update('s', draft => {
        draft.session.status = status;
      });
      expect(() => startExecution(projectRoot, 's', {
        requestId: `req-${status}`, ownerId: 'worker', ownerKind: 'codex',
      })).toThrow(new RegExp(`${status}.*requires running status`));
      expect(store.listExecutions('s')).toEqual([]);
    }

    const sealedRoot = root();
    const sealedStore = new SessionStore(sealedRoot);
    sealedStore.createSession('s', 'sealed pending acquisition');
    sealedStore.update('s', draft => {
      draft.session.status = 'sealed';
      draft.session.orchestration.chain = [{
        step_id: 'pending-step', command: 'demo', status: 'pending', run_id: null,
        inserted_by: 'test', decision_ref: null,
      }];
    });
    expect(() => startExecution(sealedRoot, 's', {
      requestId: 'req-sealed', ownerId: 'worker', ownerKind: 'codex',
    })).toThrow(/sealed.*requires running status/);

    const activeRunRoot = root();
    const activeRunStore = new SessionStore(activeRunRoot);
    activeRunStore.createSession('s', 'legacy active run');
    activeRunStore.update('s', draft => {
      draft.session.active_run_id = 'legacy-run';
    });
    expect(() => startExecution(activeRunRoot, 's', {
      requestId: 'req-active-run', ownerId: 'worker', ownerKind: 'codex',
    })).toThrow(/legacy active Run legacy-run.*migration/);

    const pausedRoot = root();
    const pausedStore = new SessionStore(pausedRoot);
    pausedStore.createSession('s', 'paused attach');
    const started = startExecution(pausedRoot, 's', {
      requestId: 'req-start', ownerId: 'worker', ownerKind: 'codex',
    });
    pauseExecution(pausedRoot, {
      sessionId: 's', executionId: started.execution.execution_id, requestId: 'req-pause',
      expectedExecutionRevision: 1, lease: claim(started.lease_claim),
    });
    expect(() => attachExecution(pausedRoot, {
      sessionId: 's', executionId: started.execution.execution_id, requestId: 'req-attach-paused',
      expectedExecutionRevision: 2, ownerId: 'worker-2', ownerKind: 'pi',
    })).toThrow(/paused.*active authority is required/);
    expect(pausedStore.readExecution('s', started.execution.execution_id).lease).toBeNull();
  });

  it('rejects Execution start after canonical archive even when the compatibility sidecar is running', () => {
    const projectRoot = root();
    enableSessionV20(projectRoot);
    const store = new SessionStore(projectRoot);
    store.createSession('archived', 'canonical archive fence');
    const current = store.readSessionRecord('archived');
    if (current.schema_version !== 'session/2.0') throw new Error('expected session/2.0');
    store.applySessionArchiveReceipt(createSessionArchiveReceipt({
      receipt_id: 'archive-before-start',
      operation: 'archive',
      session_id: 'archived',
      actor: 'operator',
      reason: 'closed history',
      evidence_refs: ['operator-decision:closed'],
      recorded_at: '2026-01-01T00:00:00.000Z',
      before: {
        identity_revision: current.identity_revision,
        activity_revision: current.activity_revision,
        archived_at: null,
        archived_by: null,
      },
      after: {
        identity_revision: current.identity_revision,
        activity_revision: current.activity_revision + 1,
        archived_at: '2026-01-01T00:00:00.000Z',
        archived_by: 'operator',
      },
      previous_receipt_hash: null,
    }));
    expect(store.readBundle('archived').session.status).toBe('running');
    expect(() => startExecution(projectRoot, 'archived', {
      requestId: 'req-start-after-archive', ownerId: 'worker', ownerKind: 'codex',
    })).toThrow(/Session archived is archived; unarchive it before starting an Execution/);
    expect(store.listExecutions('archived')).toEqual([]);
  });

  it('uses only canonical session/2.0 authority for replay, unarchive, and the next generation', () => {
    const projectRoot = root();
    enableSessionV20(projectRoot);
    const store = new SessionStore(projectRoot);
    store.createSession('s', 'statusless start authority');
    const compatibilityPath = store.sessionCompatibilityPath('s');
    const writeCompatibilityStatus = (status: string): void => {
      const compatibility = JSON.parse(readFileSync(compatibilityPath, 'utf8')) as Record<string, unknown>;
      compatibility.status = status;
      writeFileSync(compatibilityPath, `${JSON.stringify(compatibility, null, 2)}\n`, 'utf8');
    };

    writeCompatibilityStatus('sealed');
    const firstInput = {
      requestId: 'req-start-1', ownerId: 'worker-1', ownerKind: 'codex' as const,
      now: new Date('2026-08-05T00:00:00.000Z'),
    };
    const first = startExecution(projectRoot, 's', firstInput);
    writeCompatibilityStatus('failed');
    expect(startExecution(projectRoot, 's', firstInput)).toMatchObject({
      replayed: true,
      execution: { execution_id: first.execution.execution_id, generation: 1 },
    });
    writeCompatibilityStatus('running');
    sealExecution(projectRoot, {
      sessionId: 's', executionId: first.execution.execution_id, requestId: 'req-seal-1',
      expectedExecutionRevision: 1, lease: claim(first.lease_claim), summary: 'first generation', outcome: 'done',
      now: new Date('2026-08-05T00:00:01.000Z'),
    });
    archiveSession(projectRoot, 's', {
      requestId: 'req-archive', actor: 'operator', reason: 'temporary archive', evidence: ['test:archive'],
      expectedIdentityRevision: 1, expectedActivityRevision: 2,
      now: new Date('2026-08-05T00:02:00.000Z'),
    });
    unarchiveSession(projectRoot, 's', {
      requestId: 'req-unarchive', actor: 'operator', reason: 'continue work', evidence: ['test:unarchive'],
      expectedIdentityRevision: 1, expectedActivityRevision: 3,
      now: new Date('2026-08-05T00:03:00.000Z'),
    });
    writeCompatibilityStatus('archived');

    const second = startExecution(projectRoot, 's', {
      requestId: 'req-start-2', ownerId: 'worker-2', ownerKind: 'pi',
      now: new Date('2026-08-05T00:04:00.000Z'),
    });
    expect(second.execution).toMatchObject({ generation: 2, status: 'active' });
    expect(store.readSessionRecord('s')).toMatchObject({
      current_execution_id: second.execution.execution_id,
      latest_execution_id: second.execution.execution_id,
      archived_at: null,
      activity_revision: 5,
    });
  });

  it('fails lease release with typed authority while active work remains', () => {
    const activeRoot = root();
    commandFile(activeRoot);
    const activeStore = new SessionStore(activeRoot);
    activeStore.createSession('active', 'active Run release');
    const active = startExecution(activeRoot, 'active', {
      requestId: 'req-start', ownerId: 'worker', ownerKind: 'codex',
    });
    createExecutionRun({
      projectRoot: activeRoot, sessionId: 'active', command: 'demo', executionId: active.execution.execution_id,
      generation: 1, expectedExecutionRevision: 1, executionLease: claim(active.lease_claim), requestId: 'req-create',
    });
    expectReleaseBlocked(() => releaseExecutionLease(activeRoot, {
      sessionId: 'active', executionId: active.execution.execution_id, requestId: 'req-release',
      expectedExecutionRevision: 2, lease: claim(active.lease_claim),
    }), /active_run_id=/);
    expect(activeStore.readExecution('active', active.execution.execution_id)).toMatchObject({ revision: 2, lease: expect.any(Object) });

    const requestRoot = root();
    const requestStore = new SessionStore(requestRoot);
    requestStore.createSession('request', 'claimed request release');
    const requested = startExecution(requestRoot, 'request', {
      requestId: 'req-start', ownerId: 'worker', ownerKind: 'codex',
    });
    requestStore.update('request', draft => {
      draft.session.requests.push({
        request_id: 'claimed-request', type: 'transition', status: 'claimed', payload: {}, claimed_by_run_id: null,
      });
    }, { allowOpenExecution: true });
    expectReleaseBlocked(() => releaseExecutionLease(requestRoot, {
      sessionId: 'request', executionId: requested.execution.execution_id, requestId: 'req-release',
      expectedExecutionRevision: 1, lease: claim(requested.lease_claim),
    }), /claimed requests=claimed-request/);

    const transitionRoot = root();
    const transitionStore = new SessionStore(transitionRoot);
    transitionStore.createSession('transition', 'in-flight chain transition release');
    transitionStore.update('transition', draft => {
      draft.session.orchestration.chain.push({
        step_id: 'running-step', command: 'demo', status: 'running', run_id: null,
        inserted_by: 'test', decision_ref: null,
      });
    });
    const transitioning = startExecution(transitionRoot, 'transition', {
      requestId: 'req-start', ownerId: 'worker', ownerKind: 'codex',
    });
    expectReleaseBlocked(() => releaseExecutionLease(transitionRoot, {
      sessionId: 'transition', executionId: transitioning.execution.execution_id, requestId: 'req-release',
      expectedExecutionRevision: 1, lease: claim(transitioning.lease_claim),
    }), /in-flight chain transitions=running-step/);

    const handoffRoot = root();
    const handoffStore = new SessionStore(handoffRoot);
    handoffStore.createSession('handoff', 'handoff release');
    const handed = startExecution(handoffRoot, 'handoff', {
      requestId: 'req-start', ownerId: 'worker', ownerKind: 'codex',
    });
    prepareExecutionHandoff(handoffRoot, {
      sessionId: 'handoff', executionId: handed.execution.execution_id, requestId: 'req-handoff',
      expectedExecutionRevision: 1, lease: claim(handed.lease_claim), toOwnerId: 'next-owner',
    });
    expectReleaseBlocked(() => releaseExecutionLease(handoffRoot, {
      sessionId: 'handoff', executionId: handed.execution.execution_id, requestId: 'req-release',
      expectedExecutionRevision: 2, lease: claim(handed.lease_claim),
    }), /in-flight handoff=next-owner/);

    const idleRoot = root();
    commandFile(idleRoot);
    const idleStore = new SessionStore(idleRoot);
    idleStore.createSession('idle', 'non-stable idle release');
    const idle = startExecution(idleRoot, 'idle', {
      requestId: 'req-start', ownerId: 'worker', ownerKind: 'codex',
    });
    createExecutionRun({
      projectRoot: idleRoot, sessionId: 'idle', command: 'demo', executionId: idle.execution.execution_id,
      generation: 1, expectedExecutionRevision: 1, executionLease: claim(idle.lease_claim), requestId: 'req-create',
    });
    idleStore.update('idle', draft => {
      draft.session.active_run_id = null;
    }, { allowOpenExecution: true });
    idleStore.updateExecution('idle', idle.execution.execution_id, 2, execution => {
      execution.active_run_id = null;
      execution.chain = execution.chain.map(step => ({ ...step, status: 'pending', run_id: null }));
    });
    expectReleaseBlocked(() => releaseExecutionLease(idleRoot, {
      sessionId: 'idle', executionId: idle.execution.execution_id, requestId: 'req-release',
      expectedExecutionRevision: 2, lease: claim(idle.lease_claim),
    }), /non-stable-idle Runs=/);
    expect(idleStore.readExecution('idle', idle.execution.execution_id)).toMatchObject({ revision: 2, lease: expect.any(Object) });
  });

  it('fails closed on persisted paused lease corruption', () => {
    const projectRoot = root();
    const store = new SessionStore(projectRoot);
    store.createSession('s', 'lifecycle corruption');
    const started = startExecution(projectRoot, 's', {
      requestId: 'req-start', ownerId: 'worker', ownerKind: 'codex',
    });
    const executionPath = store.executionPath('s', started.execution.execution_id);
    const persisted = JSON.parse(readFileSync(executionPath, 'utf8')) as Record<string, unknown>;
    persisted.status = 'paused';
    writeFileSync(executionPath, `${JSON.stringify(persisted, null, 2)}\n`, 'utf8');
    expect(() => new SessionStore(projectRoot).readExecution('s', started.execution.execution_id))
      .toThrow(/paused Execution.*must not retain a lease/);
  });

  it('replays start exactly and fails closed on conflicts or corrupt receipt content', async () => {
    const projectRoot = root();
    const store = new SessionStore(projectRoot);
    store.createSession('s', 'start replay');
    const input = { requestId: 'req-start', ownerId: 'worker', ownerKind: 'codex' as const };
    const [first, replay] = await Promise.all([
      Promise.resolve().then(() => startExecution(projectRoot, 's', input)),
      Promise.resolve().then(() => startExecution(projectRoot, 's', input)),
    ]);
    expect(replay).toMatchObject({
      replayed: true,
      transition_id: first.transition_id,
      lease_claim: first.lease_claim,
      execution: { execution_id: first.execution.execution_id, generation: first.execution.generation },
    });
    expect(store.listExecutions('s')).toHaveLength(1);
    expect(() => startExecution(projectRoot, 's', { ...input, ownerId: 'different' }))
      .toThrow(/already used with different/);
    expect(() => startExecution(projectRoot, 's', { ...input, executionId: 'different-execution' }))
      .toThrow(/already used with different/);

    const receiptPath = store.executionTransitionPath('s', first.execution.execution_id, input.requestId);
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8')) as {
      outcome: { result_hash: string };
    };
    receipt.outcome.result_hash = `sha256:${'0'.repeat(64)}`;
    writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
    expect(() => startExecution(projectRoot, 's', input)).toThrow(/not a valid transition\/1.1 receipt/);
  });

  it('rejects seal with an unsealed bound Run, blocking gate, claimed request, or handoff', () => {
    const unsealedRoot = root();
    commandFile(unsealedRoot);
    const unsealedStore = new SessionStore(unsealedRoot);
    unsealedStore.createSession('s', 'unsealed run');
    const unsealedStart = startExecution(unsealedRoot, 's', {
      requestId: 'req-start', ownerId: 'worker', ownerKind: 'codex',
    });
    const created = createExecutionRun({
      projectRoot: unsealedRoot, sessionId: 's', command: 'demo', intent: 'unsealed run',
      executionId: unsealedStart.execution.execution_id, generation: 1,
      expectedExecutionRevision: 1, executionLease: claim(unsealedStart.lease_claim), requestId: 'req-create',
    });
    expect(() => sealExecution(unsealedRoot, {
      sessionId: 's', executionId: unsealedStart.execution.execution_id, requestId: 'req-seal-active',
      expectedExecutionRevision: 2, lease: claim(unsealedStart.lease_claim), summary: 'no', outcome: 'done',
    })).toThrow(/active Run/);
    unsealedStore.update('s', draft => {
      draft.session.active_run_id = null;
    }, { allowOpenExecution: true });
    unsealedStore.updateExecution('s', unsealedStart.execution.execution_id, 2, execution => {
      execution.active_run_id = null;
    });
    expect(() => sealExecution(unsealedRoot, {
      sessionId: 's', executionId: unsealedStart.execution.execution_id, requestId: 'req-seal',
      expectedExecutionRevision: 2, lease: claim(unsealedStart.lease_claim), summary: 'no', outcome: 'done',
    })).toThrow(new RegExp(`unsealed Runs: ${created.run_id}`));

    const chainRoot = root();
    const chainStore = new SessionStore(chainRoot);
    chainStore.createSession('s', 'nonterminal chain');
    chainStore.update('s', draft => {
      draft.session.orchestration.chain = [{
        step_id: 'pending-step', command: 'demo', status: 'pending', run_id: null,
        inserted_by: 'test', decision_ref: null,
      }];
    });
    const chainStart = startExecution(chainRoot, 's', {
      requestId: 'req-start', ownerId: 'worker', ownerKind: 'codex',
    });
    expect(() => sealExecution(chainRoot, {
      sessionId: 's', executionId: chainStart.execution.execution_id, requestId: 'req-seal',
      expectedExecutionRevision: 1, lease: claim(chainStart.lease_claim), summary: 'no', outcome: 'done',
    })).toThrow(/chain is not terminal/);

    const gateRoot = root();
    const gateStore = new SessionStore(gateRoot);
    gateStore.createSession('s', 'blocking gate');
    const gateStart = startExecution(gateRoot, 's', {
      requestId: 'req-start', ownerId: 'worker', ownerKind: 'codex',
    });
    gateStore.update('s', draft => {
      draft.gates.gates['gate-blocking'] = {
        key: 'gate-blocking', title: 'Blocking approval', scope: 'session', run_id: null,
        required: true, blocking: true, applicable_modes: ['standard'], status: 'failed',
        check: { type: 'manual', prompt: 'approve' }, evidence_refs: [], waiver: null,
      };
    }, { allowOpenExecution: true });
    expect(() => sealExecution(gateRoot, {
      sessionId: 's', executionId: gateStart.execution.execution_id, requestId: 'req-seal',
      expectedExecutionRevision: 1, lease: claim(gateStart.lease_claim), summary: 'no', outcome: 'done',
    })).toThrow(/gates are not complete: gate-blocking/);

    const requestRoot = root();
    const requestStore = new SessionStore(requestRoot);
    requestStore.createSession('s', 'claimed request');
    const requestStart = startExecution(requestRoot, 's', {
      requestId: 'req-start', ownerId: 'worker', ownerKind: 'codex',
    });
    requestStore.update('s', draft => {
      draft.session.requests.push({
        request_id: 'claimed-request', type: 'legacy', status: 'claimed', payload: {}, claimed_by_run_id: null,
      });
    }, { allowOpenExecution: true });
    expect(() => sealExecution(requestRoot, {
      sessionId: 's', executionId: requestStart.execution.execution_id, requestId: 'req-seal',
      expectedExecutionRevision: 1, lease: claim(requestStart.lease_claim), summary: 'no', outcome: 'done',
    })).toThrow(/claimed requests: claimed-request/);

    const handoffRoot = root();
    const handoffStore = new SessionStore(handoffRoot);
    handoffStore.createSession('s', 'handoff seal');
    const handoffStart = startExecution(handoffRoot, 's', {
      requestId: 'req-start', ownerId: 'worker', ownerKind: 'codex',
    });
    prepareExecutionHandoff(handoffRoot, {
      sessionId: 's', executionId: handoffStart.execution.execution_id, requestId: 'req-handoff',
      expectedExecutionRevision: 1, lease: claim(handoffStart.lease_claim), toOwnerId: 'other',
    });
    expect(() => sealExecution(handoffRoot, {
      sessionId: 's', executionId: handoffStart.execution.execution_id, requestId: 'req-seal',
      expectedExecutionRevision: 2, lease: claim(handoffStart.lease_claim), summary: 'no', outcome: 'done',
    })).toThrow(/handoff in progress/);
  });

  it('fences legacy active-Run sidecar mutation only when open Execution authority exists', () => {
    const schema = z.object({ count: z.number().int() }).strict();

    const legacyRoot = root();
    commandFile(legacyRoot);
    const legacyStore = new SessionStore(legacyRoot);
    legacyStore.createSession('s', 'legacy sidecar');
    const legacyRun = createRun({ projectRoot: legacyRoot, sessionId: 's', command: 'demo' });
    const legacyPath = join(legacyStore.runDir('s', legacyRun.run_id), 'focused-sidecar.json');
    expect(legacyStore.updateActiveRunSidecar(
      's', legacyRun.run_id, legacyPath, schema, { count: 0 }, draft => ++draft.count,
    )).toBe(1);

    const executionRoot = root();
    commandFile(executionRoot);
    const executionStore = new SessionStore(executionRoot);
    executionStore.createSession('s', 'execution sidecar');
    const started = startExecution(executionRoot, 's', {
      requestId: 'req-start', ownerId: 'worker', ownerKind: 'codex',
    });
    const boundRun = createExecutionRun({
      projectRoot: executionRoot, sessionId: 's', command: 'demo',
      executionId: started.execution.execution_id, generation: 1,
      expectedExecutionRevision: 1, executionLease: claim(started.lease_claim), requestId: 'req-create',
    });
    const boundPath = join(executionStore.runDir('s', boundRun.run_id), 'focused-sidecar.json');
    expect(() => executionStore.updateActiveRunSidecar(
      's', boundRun.run_id, boundPath, schema, { count: 0 }, draft => ++draft.count,
    )).toThrow(/open Execution.*explicit Execution sidecar authority is required/);
  });

  it('persists audited lifecycle metadata in exact transition/1.1 receipts and binds it to replay', () => {
    const projectRoot = root();
    const store = new SessionStore(projectRoot);
    store.createSession('s', 'audited receipts');
    const audit = {
      actor: ' release-operator ',
      reason: ' pause for audit ',
      evidence: [' test:audit '],
    };
    const started = startExecution(projectRoot, 's', {
      requestId: 'req-start', ownerId: 'worker', ownerKind: 'codex',
      expectedIdentityRevision: 1, expectedActivityRevision: 0, expectedLeaseEpoch: 0,
      ...audit,
      now: new Date('2026-09-01T00:00:00.000Z'),
    });
    const startReceipt = store.readExecutionTransition('s', started.execution.execution_id, 'req-start')!;
    expect(startReceipt.payload.preconditions).toEqual({
      session_identity_revision: 1,
      session_activity_revision: 0,
      execution_id: null,
      execution_generation: null,
      execution_revision: null,
      execution_status: null,
      lease_epoch: null,
      active_run_id: null,
      run_hash: null,
      artifact_registry_revision: 0,
    });
    expect(startReceipt.payload.payload).toEqual({
      owner_id: 'worker',
      owner_kind: 'codex',
      lease_id_hash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      actor: 'release-operator',
      reason: 'pause for audit',
      evidence_refs: ['test:audit'],
    });

    const pauseInput = {
      sessionId: 's', executionId: started.execution.execution_id, requestId: 'req-pause',
      expectedExecutionRevision: 1, lease: claim(started.lease_claim), ...audit,
      now: new Date('2026-09-01T00:00:01.000Z'),
    };
    const applied = pauseExecution(projectRoot, pauseInput);
    const receiptPath = store.executionTransitionPath('s', started.execution.execution_id, 'req-pause');
    const receiptBytes = readFileSync(receiptPath, 'utf8');
    const receipt = JSON.parse(receiptBytes);
    expect(receipt).toEqual({
      request_id: 'req-pause',
      type: 'transition',
      status: 'applied',
      payload: {
        schema_version: 'transition-request/1.1',
        request_id: 'req-pause',
        operation: 'execution-pause',
        subject: {
          session_id: 's', execution_id: started.execution.execution_id,
          generation: 1, run_id: null, chain_step_id: null,
        },
        normalized_request_hash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        requested_at: '2026-09-01T00:00:01.000Z',
        preconditions: {
          session_identity_revision: 1,
          session_activity_revision: 1,
          execution_id: started.execution.execution_id,
          execution_generation: 1,
          execution_revision: 1,
          execution_status: 'active',
          lease_epoch: 1,
          active_run_id: null,
          run_hash: null,
          artifact_registry_revision: 0,
        },
        payload: {
          actor: 'release-operator',
          reason: 'pause for audit',
          evidence_refs: ['test:audit'],
          lease: {
            owner_id: 'worker', owner_kind: 'codex', epoch: 1,
            lease_id_hash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
          },
        },
      },
      claimed_by_run_id: null,
      outcome: {
        schema_version: 'transition-outcome/1.1',
        transition_id: applied.transition_id,
        request_id: 'req-pause',
        request_hash: receipt.payload.normalized_request_hash,
        operation: 'execution-pause',
        status: 'applied',
        applied_at: '2026-09-01T00:00:01.000Z',
        subject: receipt.payload.subject,
        postconditions: {
          session_identity_revision: 1,
          session_activity_revision: 2,
          execution_id: started.execution.execution_id,
          execution_generation: 1,
          execution_revision: 2,
          execution_status: 'paused',
          lease_epoch: null,
          active_run_id: null,
          run_hash: null,
          artifact_registry_revision: 0,
        },
        exit_code: 0,
        error_code: null,
        result_hash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        result: { status: 'paused', released_epoch: 1 },
      },
    });
    expect(receiptBytes).not.toContain(started.lease_claim.lease_id);

    expect(pauseExecution(projectRoot, pauseInput)).toMatchObject({
      replayed: true,
      transition_id: applied.transition_id,
    });
    expect(readFileSync(receiptPath, 'utf8')).toBe(receiptBytes);
    expect(() => pauseExecution(projectRoot, { ...pauseInput, reason: 'different reason' }))
      .toThrow(expect.objectContaining({ code: 'REQUEST_CONFLICT' }));
    expect(readFileSync(receiptPath, 'utf8')).toBe(receiptBytes);

    const invalidRoot = root();
    new SessionStore(invalidRoot).createSession('invalid', 'invalid audit');
    expect(() => startExecution(invalidRoot, 'invalid', {
      requestId: 'req-invalid', ownerId: 'worker', ownerKind: 'codex',
      actor: 'operator', reason: 'missing evidence', evidence: [],
    })).toThrow();
  });

  it('keeps raw claims private and transition/1.1 receipts hash-only', () => {
    const projectRoot = root();
    const store = new SessionStore(projectRoot);
    store.createSession('s', 'private claims');
    const started = startExecution(projectRoot, 's', {
      requestId: 'req-start', ownerId: 'worker', ownerKind: 'codex',
    });
    const status = executionStatus(projectRoot, 's', started.execution.execution_id);
    expect(JSON.stringify(status)).not.toContain(started.lease_claim.lease_id);
    expect(status.lease.lease_id_hash).toMatch(/^sha256:/);

    const receiptPath = store.executionTransitionPath('s', started.execution.execution_id, 'req-start');
    const receipt = readFileSync(receiptPath, 'utf8');
    expect(receipt).not.toContain(started.lease_claim.lease_id);
    expect(receipt).toContain('lease_id_hash');
    if (process.platform !== 'win32') {
      expect(statSync(store.executionPath('s', started.execution.execution_id)).mode & 0o777).toBe(0o600);
    }

    const replay = startExecution(projectRoot, 's', {
      requestId: 'req-start', ownerId: 'worker', ownerKind: 'codex',
    });
    expect(replay.replayed).toBe(true);
    expect(replay.lease_claim.lease_id).toBe(started.lease_claim.lease_id);
  });

  it('heartbeats, recovers only stale leases, increments epochs, and fences the old owner', () => {
    const projectRoot = root();
    const store = new SessionStore(projectRoot);
    store.createSession('s', 'recovery');
    const started = startExecution(projectRoot, 's', {
      requestId: 'req-start', ownerId: 'old', ownerKind: 'codex',
      now: new Date('2026-01-01T00:00:00.000Z'),
    });
    expect(() => recoverExecutionLease(projectRoot, {
      sessionId: 's', executionId: started.execution.execution_id, requestId: 'req-too-soon',
      expectedExecutionRevision: 1,
      ownerId: 'new', ownerKind: 'pi',
      now: new Date('2026-01-01T00:00:10.000Z'), staleAfterMs: 30_000,
    })).toThrow(/not stale/);
    const recovered = recoverExecutionLease(projectRoot, {
      sessionId: 's', executionId: started.execution.execution_id, requestId: 'req-recover',
      expectedExecutionRevision: 1,
      ownerId: 'new', ownerKind: 'pi',
      now: new Date('2026-01-01T00:00:31.000Z'), staleAfterMs: 30_000,
    });
    expect(recovered.lease_claim.epoch).toBe(2);
    const replayedRecovery = recoverExecutionLease(projectRoot, {
      sessionId: 's', executionId: started.execution.execution_id, requestId: 'req-recover',
      expectedExecutionRevision: 1,
      ownerId: 'new', ownerKind: 'pi',
      now: new Date('2026-01-01T00:00:32.000Z'), staleAfterMs: 30_000,
    });
    expect(replayedRecovery).toMatchObject({ replayed: true, lease_claim: recovered.lease_claim });
    expect(() => heartbeatExecutionLease(projectRoot, {
      sessionId: 's', executionId: started.execution.execution_id, requestId: 'req-old-heartbeat',
      expectedExecutionRevision: 2, lease: claim(started.lease_claim),
    })).toThrow(/fence conflict/);
    expect(heartbeatExecutionLease(projectRoot, {
      sessionId: 's', executionId: started.execution.execution_id, requestId: 'req-new-heartbeat',
      expectedExecutionRevision: 2, lease: claim(recovered.lease_claim),
    }).execution.revision).toBe(2);
  });

  it('prepares and accepts a handoff while fencing the prior owner', () => {
    const projectRoot = root();
    const store = new SessionStore(projectRoot);
    store.createSession('s', 'handoff');
    const started = startExecution(projectRoot, 's', {
      requestId: 'req-start', ownerId: 'old', ownerKind: 'codex',
    });
    const prepared = prepareHandoff(
      projectRoot,
      store,
      's',
      started.execution.execution_id,
      started.lease_claim,
      'req-prepare',
      'new',
    );
    const accepted = acceptExecutionHandoff(projectRoot, {
      sessionId: 's', executionId: started.execution.execution_id, requestId: 'req-accept',
      expectedExecutionRevision: 2,
      ownerId: 'new', ownerKind: 'pi', handoffToken: prepared.handoff_token!,
    });
    expect(accepted.lease_claim.epoch).toBe(2);
    expect(JSON.stringify(accepted.execution)).not.toContain(accepted.lease_claim.lease_id);
    expect(() => heartbeatExecutionLease(projectRoot, {
      sessionId: 's', executionId: started.execution.execution_id, requestId: 'req-stale',
      expectedExecutionRevision: 3, lease: claim(started.lease_claim),
    })).toThrow(/fence conflict/);
  });
  it('refuses handoff prepare atomically until active work reaches stable idle', () => {
    const projectRoot = root();
    commandFile(projectRoot);
    const store = new SessionStore(projectRoot);
    store.createSession('s', 'prepare stable idle');
    store.update('s', draft => {
      draft.session.orchestration.chain = [{
        step_id: 'running-step', command: 'demo', status: 'pending', run_id: null,
        inserted_by: 'test', decision_ref: null,
      }];
    });
    const started = startExecution(projectRoot, 's', {
      requestId: 'req-start', ownerId: 'old', ownerKind: 'codex',
    });
    createExecutionRun({
      projectRoot, sessionId: 's', command: 'demo', intent: 'in flight', chainStepId: 'running-step',
      executionId: started.execution.execution_id, generation: 1,
      expectedExecutionRevision: 1, executionLease: claim(started.lease_claim), requestId: 'req-create',
    });
    store.updateExecutionAtomic('s', started.execution.execution_id, 2, (draft) => {
      draft.session.requests.push({
        request_id: 'claimed-request', type: 'transition', status: 'claimed', payload: {}, claimed_by_run_id: null,
      });
      return null;
    });
    const before = authorityBytes(store, 's', started.execution.execution_id);

    expect(() => prepareExecutionHandoff(projectRoot, {
      sessionId: 's', executionId: started.execution.execution_id, requestId: 'req-prepare',
      expectedExecutionRevision: 2,
      lease: claim(started.lease_claim), toOwnerId: 'new',
    })).toThrow(/stable idle.*active_run_id=.*claimed requests=claimed-request.*non-stable-idle Runs=.*in-flight chain transitions=/);

    expectAuthorityBytesUnchanged(before, authorityBytes(store, 's', started.execution.execution_id));
    expect(store.readExecutionTransition('s', started.execution.execution_id, 'req-prepare')).toBeNull();
    expect(store.readExecution('s', started.execution.execution_id)).toMatchObject({
      revision: 2,
      lease: { owner_id: 'old', epoch: 1, handoff_to: null },
    });
  });

  it('refuses handoff accept atomically when work appears after prepare', () => {
    const projectRoot = root();
    const store = new SessionStore(projectRoot);
    store.createSession('s', 'accept stable idle');
    const started = startExecution(projectRoot, 's', {
      requestId: 'req-start', ownerId: 'old', ownerKind: 'codex',
    });
    const prepared = prepareExecutionHandoff(projectRoot, {
      sessionId: 's', executionId: started.execution.execution_id, requestId: 'req-prepare',
      expectedExecutionRevision: 1,
      lease: claim(started.lease_claim), toOwnerId: 'new',
    });
    store.updateExecutionAtomic('s', started.execution.execution_id, 2, (draft, execution) => {
      const running = {
        step_id: 'running-step', command: 'demo', status: 'running' as const, run_id: 'inflight-run',
        inserted_by: 'test', decision_ref: null,
      };
      draft.session.active_run_id = 'inflight-run';
      draft.session.orchestration.chain = [running];
      draft.session.requests.push({
        request_id: 'claimed-request', type: 'transition', status: 'claimed', payload: {}, claimed_by_run_id: null,
      });
      execution.active_run_id = 'inflight-run';
      execution.chain = [structuredClone(running)];
      return null;
    });
    const listRuns = vi.spyOn(StoreTransaction.prototype, 'listBoundExecutionRuns').mockReturnValue([{
      run_id: 'inflight-run', status: 'running',
    } as never]);
    const before = authorityBytes(store, 's', started.execution.execution_id);
    try {
      expect(() => acceptExecutionHandoff(projectRoot, {
        sessionId: 's', executionId: started.execution.execution_id, requestId: 'req-accept',
        expectedExecutionRevision: 2,
        ownerId: 'new', ownerKind: 'pi',
        handoffToken: prepared.handoff_token!,
      })).toThrow(/stable idle.*active_run_id=inflight-run.*claimed requests=claimed-request.*non-stable-idle Runs=inflight-run:running.*in-flight chain transitions=running-step/);
    } finally {
      listRuns.mockRestore();
    }

    expectAuthorityBytesUnchanged(before, authorityBytes(store, 's', started.execution.execution_id));
    expect(store.readExecutionTransition('s', started.execution.execution_id, 'req-accept')).toBeNull();
    expect(store.readExecution('s', started.execution.execution_id)).toMatchObject({
      revision: 2,
      lease: { owner_id: 'old', epoch: 1, handoff_to: 'new' },
    });
  });

  it('replays lifecycle mutations before CAS and keeps credentials usable only in explicit claims', () => {
    const projectRoot = root();
    const store = new SessionStore(projectRoot);
    store.createSession('s', 'replay lifecycle');
    const started = startExecution(projectRoot, 's', {
      requestId: 'req-start', ownerId: 'worker', ownerKind: 'codex',
    });
    expect(JSON.stringify(started.execution)).not.toContain(started.lease_claim.lease_id);

    const firstHeartbeat = heartbeatExecutionLease(projectRoot, {
      sessionId: 's', executionId: started.execution.execution_id, requestId: 'req-heartbeat',
      expectedExecutionRevision: 1, lease: claim(started.lease_claim),
      now: new Date('2026-01-01T00:00:01.000Z'),
    });
    const replayedHeartbeat = heartbeatExecutionLease(projectRoot, {
      sessionId: 's', executionId: started.execution.execution_id, requestId: 'req-heartbeat',
      expectedExecutionRevision: 1, lease: claim(started.lease_claim),
      now: new Date('2026-01-01T00:00:02.000Z'),
    });
    expect(firstHeartbeat.execution.revision).toBe(1);
    expect(replayedHeartbeat).toMatchObject({ replayed: true, execution: { revision: 1 } });

    const paused = pauseExecution(projectRoot, {
      sessionId: 's', executionId: started.execution.execution_id, requestId: 'req-pause',
      expectedExecutionRevision: 1, lease: claim(started.lease_claim),
    });
    const replayedPause = pauseExecution(projectRoot, {
      sessionId: 's', executionId: started.execution.execution_id, requestId: 'req-pause',
      expectedExecutionRevision: 1, lease: claim(started.lease_claim),
    });
    expect(paused.execution.lease).toBeNull();
    expect(replayedPause).toMatchObject({ replayed: true, execution: { revision: 2, lease: null } });

    const resumed = resumeExecution(projectRoot, {
      sessionId: 's', executionId: started.execution.execution_id, requestId: 'req-resume',
      expectedExecutionRevision: 2, ownerId: 'worker', ownerKind: 'codex',
    });
    const replayedResume = resumeExecution(projectRoot, {
      sessionId: 's', executionId: started.execution.execution_id, requestId: 'req-resume',
      expectedExecutionRevision: 2, ownerId: 'worker', ownerKind: 'codex',
    });
    expect(replayedResume.replayed).toBe(true);
    expect(replayedResume.lease_claim).toEqual(resumed.lease_claim);
    expect(JSON.stringify(resumed.execution)).not.toContain(resumed.lease_claim.lease_id);
    expect(pauseExecution(projectRoot, {
      sessionId: 's', executionId: started.execution.execution_id, requestId: 'req-pause',
      expectedExecutionRevision: 1, lease: claim(started.lease_claim),
    })).toMatchObject({
      replayed: true,
      transition_id: paused.transition_id,
      execution: { revision: 3, status: 'active', lease: { epoch: 2 } },
    });

    const released = releaseExecutionLease(projectRoot, {
      sessionId: 's', executionId: started.execution.execution_id, requestId: 'req-release',
      expectedExecutionRevision: 3, lease: claim(resumed.lease_claim),
    });
    const replayedRelease = releaseExecutionLease(projectRoot, {
      sessionId: 's', executionId: started.execution.execution_id, requestId: 'req-release',
      expectedExecutionRevision: 3, lease: claim(resumed.lease_claim),
    });
    expect(released.execution.lease).toBeNull();
    expect(replayedRelease).toMatchObject({ replayed: true, execution: { revision: 4, lease: null } });
  });

  it('resolves paused authority without a lease and resumes with a fresh epoch', () => {
    const projectRoot = root();
    const store = new SessionStore(projectRoot);
    store.createSession('s', 'unleased resolution');
    store.update('s', draft => {
      draft.session.orchestration.decision_points = [{
        point_id: 'decision-1', after_step_id: null, status: 'escalated', retry_count: 0,
        max_retries: 1, evidence_ref: null,
      }];
      return null;
    });
    const started = startExecution(projectRoot, 's', {
      requestId: 'req-start', ownerId: 'worker', ownerKind: 'codex',
    });
    pauseExecution(projectRoot, {
      sessionId: 's', executionId: started.execution.execution_id, requestId: 'req-pause',
      expectedExecutionRevision: 1, lease: claim(started.lease_claim),
    });
    const resolved = resolveExecution(projectRoot, {
      sessionId: 's', executionId: started.execution.execution_id, requestId: 'req-resolve',
      expectedExecutionRevision: 2,
      target: { kind: 'decision', id: 'decision-1', disposition: 'proceed' },
    });
    expect(resolved.execution).toMatchObject({ status: 'paused', revision: 3, lease: null });
    const resumed = resumeExecution(projectRoot, {
      sessionId: 's', executionId: started.execution.execution_id, requestId: 'req-resume',
      expectedExecutionRevision: 3, ownerId: 'worker-2', ownerKind: 'pi',
    });
    expect(resumed.lease_claim).toMatchObject({ owner_id: 'worker-2', epoch: 2 });
  });

  it('replays attach, handoff prepare/accept, and cancel without minting unusable credentials', () => {
    const projectRoot = root();
    const store = new SessionStore(projectRoot);
    store.createSession('s', 'credential replay');
    const started = startExecution(projectRoot, 's', {
      requestId: 'req-start', ownerId: 'worker-a', ownerKind: 'codex',
    });
    releaseExecutionLease(projectRoot, {
      sessionId: 's', executionId: started.execution.execution_id, requestId: 'req-release',
      expectedExecutionRevision: 1, lease: claim(started.lease_claim),
    });
    const attached = attachExecution(projectRoot, {
      sessionId: 's', executionId: started.execution.execution_id, requestId: 'req-attach',
      expectedExecutionRevision: 2, ownerId: 'worker-a', ownerKind: 'codex',
    });
    const replayedAttach = attachExecution(projectRoot, {
      sessionId: 's', executionId: started.execution.execution_id, requestId: 'req-attach',
      expectedExecutionRevision: 2, ownerId: 'worker-a', ownerKind: 'codex',
    });
    expect(replayedAttach.lease_claim).toEqual(attached.lease_claim);
    expect(attached.lease_claim.epoch).toBe(2);

    const prepareInput = {
      sessionId: 's', executionId: started.execution.execution_id, requestId: 'req-prepare',
      expectedExecutionRevision: 3,
      lease: claim(attached.lease_claim), toOwnerId: 'worker-b',
    };
    const prepared = prepareExecutionHandoff(projectRoot, prepareInput);
    const replayedPrepare = prepareExecutionHandoff(projectRoot, prepareInput);
    expect(prepared).toMatchObject({ credential_status: 'issued', recovery: 'none' });
    expect(replayedPrepare).toMatchObject({
      replayed: true, handoff_token: null, credential_status: 'already_applied', recovery: 'cancel_and_prepare_new',
    });
    expect(() => prepareExecutionHandoff(projectRoot, {
      ...prepareInput,
      toOwnerId: 'different-worker',
    })).toThrow(/already used/);

    const acceptInput = {
      sessionId: 's', executionId: started.execution.execution_id, requestId: 'req-accept',
      expectedExecutionRevision: 4,
      ownerId: 'worker-b', ownerKind: 'pi' as const, handoffToken: prepared.handoff_token!,
    };
    const accepted = acceptExecutionHandoff(projectRoot, acceptInput);
    const replayedAccept = acceptExecutionHandoff(projectRoot, acceptInput);
    expect(replayedAccept.lease_claim).toEqual(accepted.lease_claim);

    const preparedCancel = prepareExecutionHandoff(projectRoot, {
      sessionId: 's', executionId: started.execution.execution_id, requestId: 'req-prepare-cancel',
      expectedExecutionRevision: 5,
      lease: claim(accepted.lease_claim), toOwnerId: 'worker-c',
    });
    expect(preparedCancel.handoff_token).not.toBeNull();
    const cancelInput = {
      sessionId: 's', executionId: started.execution.execution_id, requestId: 'req-cancel',
      expectedExecutionRevision: 6,
      lease: claim(accepted.lease_claim),
    };
    const cancelled = cancelExecutionHandoff(projectRoot, cancelInput);
    const replayedCancel = cancelExecutionHandoff(projectRoot, cancelInput);
    expect(cancelled.execution.lease?.handoff_to).toBeNull();
    expect(replayedCancel.replayed).toBe(true);
  });

  it('binds attach replay to the exact acquisition instead of a later same-owner lease', () => {
    const projectRoot = root();
    const store = new SessionStore(projectRoot);
    store.createSession('s', 'attach acquisition binding');
    const started = startExecution(projectRoot, 's', {
      requestId: 'req-start', ownerId: 'worker', ownerKind: 'codex',
    });
    releaseExecutionLease(projectRoot, {
      sessionId: 's', executionId: started.execution.execution_id, requestId: 'req-release-start',
      expectedExecutionRevision: 1, lease: claim(started.lease_claim),
    });
    const attachAInput = {
      sessionId: 's', executionId: started.execution.execution_id, requestId: 'req-attach-a',
      expectedExecutionRevision: 2, ownerId: 'worker', ownerKind: 'codex' as const,
    };
    const acquisitionA = attachExecution(projectRoot, attachAInput);
    expect(attachExecution(projectRoot, attachAInput)).toMatchObject({
      replayed: true,
      lease_claim: acquisitionA.lease_claim,
    });

    releaseExecutionLease(projectRoot, {
      sessionId: 's', executionId: started.execution.execution_id, requestId: 'req-release-a',
      expectedExecutionRevision: 3, lease: claim(acquisitionA.lease_claim!),
    });
    expectUnavailableAcquisitionReplay(
      attachExecution(projectRoot, attachAInput),
      'released',
      acquisitionA.lease_claim!.lease_id,
    );

    const acquisitionB = attachExecution(projectRoot, {
      sessionId: 's', executionId: started.execution.execution_id, requestId: 'req-attach-b',
      expectedExecutionRevision: 4, ownerId: 'worker', ownerKind: 'codex',
    });
    const replayA = attachExecution(projectRoot, attachAInput);
    expectUnavailableAcquisitionReplay(replayA, 'superseded', acquisitionB.lease_claim!.lease_id);
    expect(replayA.lease_claim).not.toEqual(acquisitionB.lease_claim);
    expectTransitionReceiptsHashOnly(store, 's', started.execution.execution_id, [
      started.lease_claim.lease_id,
      acquisitionA.lease_claim!.lease_id,
      acquisitionB.lease_claim!.lease_id,
    ]);
  });

  it('binds resume replay to the exact acquisition instead of a later same-owner lease', () => {
    const projectRoot = root();
    const store = new SessionStore(projectRoot);
    store.createSession('s', 'resume acquisition binding');
    const started = startExecution(projectRoot, 's', {
      requestId: 'req-start', ownerId: 'worker', ownerKind: 'codex',
    });
    pauseExecution(projectRoot, {
      sessionId: 's', executionId: started.execution.execution_id, requestId: 'req-pause-start',
      expectedExecutionRevision: 1, lease: claim(started.lease_claim),
    });
    const resumeAInput = {
      sessionId: 's', executionId: started.execution.execution_id, requestId: 'req-resume-a',
      expectedExecutionRevision: 2, ownerId: 'worker', ownerKind: 'codex' as const,
    };
    const acquisitionA = resumeExecution(projectRoot, resumeAInput);
    expect(resumeExecution(projectRoot, resumeAInput)).toMatchObject({
      replayed: true,
      lease_claim: acquisitionA.lease_claim,
    });

    pauseExecution(projectRoot, {
      sessionId: 's', executionId: started.execution.execution_id, requestId: 'req-pause-a',
      expectedExecutionRevision: 3, lease: claim(acquisitionA.lease_claim!),
    });
    expectUnavailableAcquisitionReplay(
      resumeExecution(projectRoot, resumeAInput),
      'released',
      acquisitionA.lease_claim!.lease_id,
    );

    const acquisitionB = resumeExecution(projectRoot, {
      sessionId: 's', executionId: started.execution.execution_id, requestId: 'req-resume-b',
      expectedExecutionRevision: 4, ownerId: 'worker', ownerKind: 'codex',
    });
    const replayA = resumeExecution(projectRoot, resumeAInput);
    expectUnavailableAcquisitionReplay(replayA, 'superseded', acquisitionB.lease_claim!.lease_id);
    expect(replayA.lease_claim).not.toEqual(acquisitionB.lease_claim);
    expectTransitionReceiptsHashOnly(store, 's', started.execution.execution_id, [
      started.lease_claim.lease_id,
      acquisitionA.lease_claim!.lease_id,
      acquisitionB.lease_claim!.lease_id,
    ]);
  });

  it('binds recovery replay to the exact acquisition instead of a later same-owner lease', () => {
    const projectRoot = root();
    const store = new SessionStore(projectRoot);
    store.createSession('s', 'recovery acquisition binding');
    const started = startExecution(projectRoot, 's', {
      requestId: 'req-start', ownerId: 'old', ownerKind: 'codex',
      now: new Date('2026-01-01T00:00:00.000Z'),
    });
    const recoverAInput = {
      sessionId: 's', executionId: started.execution.execution_id, requestId: 'req-recover-a',
      expectedExecutionRevision: 1,
      ownerId: 'worker', ownerKind: 'codex' as const,
      now: new Date('2026-01-01T00:00:31.000Z'), staleAfterMs: 30_000,
    };
    const acquisitionA = recoverExecutionLease(projectRoot, recoverAInput);
    expect(recoverExecutionLease(projectRoot, recoverAInput)).toMatchObject({
      replayed: true,
      lease_claim: acquisitionA.lease_claim,
    });

    const acquisitionB = recoverExecutionLease(projectRoot, {
      sessionId: 's', executionId: started.execution.execution_id, requestId: 'req-recover-b',
      expectedExecutionRevision: 2,
      ownerId: 'worker', ownerKind: 'codex',
      now: new Date('2026-01-01T00:01:02.000Z'), staleAfterMs: 30_000,
    });
    const replayA = recoverExecutionLease(projectRoot, recoverAInput);
    expectUnavailableAcquisitionReplay(replayA, 'superseded', acquisitionB.lease_claim!.lease_id);
    expect(replayA.lease_claim).not.toEqual(acquisitionB.lease_claim);
    expectTransitionReceiptsHashOnly(store, 's', started.execution.execution_id, [
      started.lease_claim.lease_id,
      acquisitionA.lease_claim!.lease_id,
      acquisitionB.lease_claim!.lease_id,
    ]);
  });

  it('binds handoff acceptance replay to the exact acquisition instead of a later same-owner lease', () => {
    const projectRoot = root();
    const store = new SessionStore(projectRoot);
    store.createSession('s', 'handoff acquisition binding');
    const started = startExecution(projectRoot, 's', {
      requestId: 'req-start', ownerId: 'old', ownerKind: 'codex',
    });
    const preparedA = prepareHandoff(
      projectRoot,
      store,
      's',
      started.execution.execution_id,
      started.lease_claim,
      'req-prepare-a',
      'worker',
    );
    const acceptAInput = {
      sessionId: 's', executionId: started.execution.execution_id, requestId: 'req-accept-a',
      expectedExecutionRevision: 2,
      ownerId: 'worker', ownerKind: 'pi' as const,
      handoffToken: preparedA.handoff_token!,
    };
    const acquisitionA = acceptExecutionHandoff(projectRoot, acceptAInput);
    expect(acceptExecutionHandoff(projectRoot, acceptAInput)).toMatchObject({
      replayed: true,
      lease_claim: acquisitionA.lease_claim,
    });

    const preparedB = prepareHandoff(
      projectRoot,
      store,
      's',
      started.execution.execution_id,
      acquisitionA.lease_claim!,
      'req-prepare-b',
      'worker',
    );
    const acquisitionB = acceptExecutionHandoff(projectRoot, {
      sessionId: 's', executionId: started.execution.execution_id, requestId: 'req-accept-b',
      expectedExecutionRevision: 4,
      ownerId: 'worker', ownerKind: 'pi',
      handoffToken: preparedB.handoff_token!,
    });
    const replayA = acceptExecutionHandoff(projectRoot, acceptAInput);
    expectUnavailableAcquisitionReplay(replayA, 'superseded', acquisitionB.lease_claim!.lease_id);
    expect(replayA.lease_claim).not.toEqual(acquisitionB.lease_claim);
    expectTransitionReceiptsHashOnly(store, 's', started.execution.execution_id, [
      started.lease_claim.lease_id,
      acquisitionA.lease_claim!.lease_id,
      acquisitionB.lease_claim!.lease_id,
      preparedA.handoff_token!,
      preparedB.handoff_token!,
    ]);
  });

  it('rejects sealed mutation and release during an in-flight handoff', () => {
    const projectRoot = root();
    const store = new SessionStore(projectRoot);
    store.createSession('s', 'guards');
    const started = startExecution(projectRoot, 's', {
      requestId: 'req-start', ownerId: 'worker', ownerKind: 'codex',
    });
    prepareExecutionHandoff(projectRoot, {
      sessionId: 's', executionId: started.execution.execution_id, requestId: 'req-prepare',
      expectedExecutionRevision: 1, lease: claim(started.lease_claim), toOwnerId: 'other',
    });
    expectReleaseBlocked(() => releaseExecutionLease(projectRoot, {
      sessionId: 's', executionId: started.execution.execution_id, requestId: 'req-release',
      expectedExecutionRevision: 2, lease: claim(started.lease_claim),
    }), /in-flight handoff=other/);
    cancelExecutionHandoff(projectRoot, {
      sessionId: 's', executionId: started.execution.execution_id, requestId: 'req-cancel',
      expectedExecutionRevision: 2,
      lease: claim(started.lease_claim),
    });
    sealExecution(projectRoot, {
      sessionId: 's', executionId: started.execution.execution_id, requestId: 'req-seal',
      expectedExecutionRevision: 3, lease: claim(started.lease_claim), summary: 'done', outcome: 'done',
    });
    expect(() => store.updateExecution('s', started.execution.execution_id, 4, draft => {
      draft.status = 'active';
      return null;
    })).toThrow(/sealed and immutable/);
  });
});

describe('Execution-aware Run APIs', () => {
  it('binds create and complete to command-run/1.4 and advances the Execution revision', () => {
    const projectRoot = root();
    commandFile(projectRoot);
    const store = new SessionStore(projectRoot);
    store.createSession('s', 'bound run');
    const started = startExecution(projectRoot, 's', {
      requestId: 'req-start', ownerId: 'worker', ownerKind: 'codex',
    });
    const created = createExecutionRun({
      projectRoot,
      sessionId: 's',
      command: 'demo',
      intent: 'bound run',
      executionId: started.execution.execution_id,
      generation: started.execution.generation,
      expectedExecutionRevision: 1,
      executionLease: claim(started.lease_claim),
      requestId: 'req-create-run',
    });
    expect(store.readExecutionRun('s', created.run_id)).toMatchObject({
      schema_version: 'command-run/1.4', execution_id: started.execution.execution_id, generation: 1,
    });
    expect(store.readExecution('s', started.execution.execution_id)).toMatchObject({
      revision: 2, active_run_id: created.run_id,
    });

    const completed = completeExecutionRun(projectRoot, created.run_id, {
      sessionId: 's', executionId: started.execution.execution_id, generation: 1,
      expectedExecutionRevision: 2, executionLease: claim(started.lease_claim),
      requestId: 'req-complete-run',
    });
    expect(completed.sealed).toBe(true);
    expect(store.readExecutionRun('s', created.run_id).schema_version).toBe('command-run/1.4');
    expect(store.readExecution('s', started.execution.execution_id)).toMatchObject({ revision: 3, active_run_id: null });
    const sealed = sealExecution(projectRoot, {
      sessionId: 's', executionId: started.execution.execution_id, requestId: 'req-seal',
      expectedExecutionRevision: 3, lease: claim(started.lease_claim), summary: 'bound run complete', outcome: 'done',
    });
    expect(sealed.execution).toMatchObject({ status: 'sealed', lease: null, final_outcome: 'done' });
  });
});

describe('Execution seal snapshot authority', () => {
  it('atomically captures deterministic Run, chain, gate, artifact, evidence, corpus, and revision authority', () => {
    const projectRoot = root();
    commandFile(projectRoot);
    const store = new SessionStore(projectRoot);
    store.createSession('s', 'receipt snapshot');
    const started = startExecution(projectRoot, 's', {
      requestId: 'req-start', ownerId: 'worker', ownerKind: 'codex',
    });
    const run = createExecutionRun({
      projectRoot, sessionId: 's', command: 'demo', intent: 'snapshot run',
      executionId: started.execution.execution_id, generation: 1,
      expectedExecutionRevision: 1, executionLease: claim(started.lease_claim), requestId: 'req-create',
    });
    completeExecutionRun(projectRoot, run.run_id, {
      sessionId: 's', executionId: started.execution.execution_id, generation: 1,
      expectedExecutionRevision: 2, executionLease: claim(started.lease_claim), requestId: 'req-complete',
    });
    const artifactBytes = 'hello report';
    const artifactHash = createHash('sha256').update(artifactBytes).digest('hex');
    mkdirSync(join(store.sessionDir('s'), 'outputs'), { recursive: true });
    writeFileSync(join(store.sessionDir('s'), 'outputs', 'report.md'), artifactBytes);
    store.update('s', draft => {
      draft.gates.revision = 1;
      draft.gates.gates.approval = {
        key: 'approval', title: 'Approval', scope: 'session', run_id: null,
        required: true, blocking: true, applicable_modes: ['standard'], status: 'passed',
        check: { type: 'manual', prompt: 'approved' }, evidence_refs: ['evidence-1'], waiver: null,
      };
      draft.artifacts.revision = 1;
      draft.artifacts.artifacts['artifact-1'] = {
        kind: 'report', role: 'report', producer_run_id: run.run_id,
        relative_path: 'outputs/report.md', media_type: 'text/markdown', schema_version: 'report/1.0',
        content_hash: artifactHash, size: 12, status: 'sealed', derived_from: [], replaces: null,
      };
      draft.evidence.revision = 1;
      draft.evidence.records['evidence-1'] = {
        run_id: run.run_id, command: 'demo', kind: 'test', point: 'seal', claim: 'verified',
        outcome: 'pass', rationale: 'focused test', status: 'accepted',
        artifact_refs: ['artifact-1'], gate_refs: ['approval'], source_refs: [],
      };
    }, { allowOpenExecution: true });

    const result = sealExecution(projectRoot, {
      sessionId: 's', executionId: started.execution.execution_id, requestId: 'req-seal',
      expectedExecutionRevision: 3, lease: claim(started.lease_claim),
      summary: 'snapshot complete', outcome: 'done',
    });
    const receipt = store.readExecutionSealReceipt('s', started.execution.execution_id)!;
    expect(receipt).toMatchObject({
      schema_version: 'execution-seal-receipt/1.1', session_id: 's',
      execution_id: started.execution.execution_id, generation: 1, execution_revision: 4,
      session_identity_revision: 2, runs: [{ run_id: run.run_id }],
      gates: { clean: true, blocking_gate_ids: [], registry_revision: 1 },
      artifacts: {
        registry_revision: 1,
        content_hashes: { 'artifact-1': `sha256:${artifactHash}` },
        snapshots: [{
          artifact_id: 'artifact-1', role: 'report', producer_run_id: run.run_id,
          content_hash: `sha256:${artifactHash}`,
        }],
      },
      evidence: { store_revision: 1, record_refs: ['evidence-1'], snapshots: [{ record_id: 'evidence-1' }] },
    });
    expect(receipt.runs[0]).not.toHaveProperty('status');
    expect(receipt.runs[0].content_hash).toBe(fileHash(join(store.runDir('s', run.run_id), 'run.json')));
    if (receipt.schema_version !== 'execution-seal-receipt/1.1') throw new Error('expected receipt/1.1');
    expect(receipt.execution_hash).toBe(fileHash(store.executionPath('s', started.execution.execution_id)));
    expect(receipt.chain_hash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(receipt.gates.registry_hash).toBe(fileHash(join(store.sessionDir('s'), 'gates.json')));
    expect(receipt.artifacts.registry_hash).toBe(fileHash(join(store.sessionDir('s'), 'artifacts.json')));
    expect(receipt.evidence.store_hash).toBe(fileHash(join(store.sessionDir('s'), 'evidence.json')));
    expect(receipt.corpus_refs).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'command-guidance', content_hash: expect.stringMatching(/^sha256:/) }),
    ]));
    expect(receipt.overall_hash).toBe(executionSealReceiptHash(receipt));
    const transition = store.readExecutionTransition('s', started.execution.execution_id, 'req-seal')!;
    expect(transition.outcome.result.seal_receipt_hash).toBe(receipt.overall_hash);
    expect(result.execution).toMatchObject({ status: 'sealed', revision: 4, lease: null });
    expect(store.readBundle('s').session.schema_version).toBe('session/1.3');
  });

  it('replays the immutable receipt without disturbing a later v2 generation and rejects conflicts or corruption', () => {
    const projectRoot = root();
    enableSessionV20(projectRoot);
    const store = new SessionStore(projectRoot);
    store.createSession('s', 'immutable replay');
    const first = startExecution(projectRoot, 's', {
      requestId: 'req-start-1', ownerId: 'worker', ownerKind: 'codex',
      now: new Date('2026-08-01T00:00:00.000Z'),
    });
    const sealInput = {
      sessionId: 's', executionId: first.execution.execution_id, requestId: 'req-seal',
      expectedExecutionRevision: 1, expectedActivityRevision: 1,
      lease: claim(first.lease_claim), summary: 'first complete', outcome: 'done' as const,
      now: new Date('2026-08-01T00:00:01.000Z'),
    };
    const applied = sealExecution(projectRoot, sealInput);
    const receiptPath = store.executionSealReceiptPath('s', first.execution.execution_id);
    const receiptBytes = readFileSync(receiptPath, 'utf8');
    const second = startExecution(projectRoot, 's', {
      requestId: 'req-start-2', ownerId: 'worker-2', ownerKind: 'pi',
      now: new Date('2026-08-01T00:00:02.000Z'),
    });

    expect(sealExecution(projectRoot, sealInput)).toMatchObject({
      replayed: true, transition_id: applied.transition_id,
      execution: { execution_id: first.execution.execution_id, status: 'sealed' },
    });
    expect(readFileSync(receiptPath, 'utf8')).toBe(receiptBytes);
    expect(store.readSessionRecord('s')).toMatchObject({
      current_execution_id: second.execution.execution_id,
      latest_execution_id: second.execution.execution_id,
      activity_revision: 3,
    });
    expect(() => sealExecution(projectRoot, { ...sealInput, summary: 'different' }))
      .toThrow(/different execution-seal inputs/);

    const corrupt = JSON.parse(receiptBytes) as { overall_hash: string };
    corrupt.overall_hash = `sha256:${'0'.repeat(64)}`;
    writeFileSync(receiptPath, `${JSON.stringify(corrupt, null, 2)}\n`, 'utf8');
    expect(() => sealExecution(projectRoot, sealInput)).toThrow(/overall hash mismatch/);
  });

  it('rejects stale lease, unresolved decision, stale v2 activity, and a mismatched v2 current pointer', () => {
    const staleRoot = root();
    const staleStore = new SessionStore(staleRoot);
    staleStore.createSession('s', 'stale lease');
    const stale = startExecution(staleRoot, 's', {
      requestId: 'req-start', ownerId: 'worker', ownerKind: 'codex',
      now: new Date('2026-08-01T00:00:00.000Z'),
    });
    expect(() => sealExecution(staleRoot, {
      sessionId: 's', executionId: stale.execution.execution_id, requestId: 'req-seal',
      expectedExecutionRevision: 1, lease: claim(stale.lease_claim), summary: 'no', outcome: 'done',
      now: new Date('2026-08-01T00:00:31.000Z'),
    })).toThrow(/lease is stale/);
    expect(staleStore.readExecution('s', stale.execution.execution_id).status).toBe('active');
    expect(staleStore.readExecutionSealReceipt('s', stale.execution.execution_id)).toBeNull();

    const decisionRoot = root();
    const decisionStore = new SessionStore(decisionRoot);
    decisionStore.createSession('s', 'unresolved decision');
    decisionStore.update('s', draft => {
      draft.session.orchestration.decision_points = [{
        point_id: 'decision-1', after_step_id: null, status: 'pending', retry_count: 0,
        max_retries: 1, evidence_ref: null,
      }];
    });
    const decision = startExecution(decisionRoot, 's', {
      requestId: 'req-start', ownerId: 'worker', ownerKind: 'codex',
    });
    expect(() => sealExecution(decisionRoot, {
      sessionId: 's', executionId: decision.execution.execution_id, requestId: 'req-seal',
      expectedExecutionRevision: 1, lease: claim(decision.lease_claim), summary: 'no', outcome: 'done',
    })).toThrow(/unresolved decisions: decision-1/);

    const v2Root = root();
    enableSessionV20(v2Root);
    const v2Store = new SessionStore(v2Root);
    v2Store.createSession('s', 'v2 fences');
    const v2 = startExecution(v2Root, 's', {
      requestId: 'req-start', ownerId: 'worker', ownerKind: 'codex',
    });
    expect(() => sealExecution(v2Root, {
      sessionId: 's', executionId: v2.execution.execution_id, requestId: 'req-stale-activity',
      expectedExecutionRevision: 1, expectedActivityRevision: 0,
      lease: claim(v2.lease_claim), summary: 'no', outcome: 'done',
    })).toThrow(/session activity revision conflict: expected 0, current 1/);
    const identityPath = join(v2Store.sessionDir('s'), 'session.json');
    const identity = JSON.parse(readFileSync(identityPath, 'utf8')) as { current_execution_id: string | null };
    identity.current_execution_id = null;
    writeFileSync(identityPath, `${JSON.stringify(identity, null, 2)}\n`, 'utf8');
    expect(() => sealExecution(v2Root, {
      sessionId: 's', executionId: v2.execution.execution_id, requestId: 'req-pointer',
      expectedExecutionRevision: 1, expectedActivityRevision: 1,
      lease: claim(v2.lease_claim), summary: 'no', outcome: 'done',
    })).toThrow(/current Execution pointer mismatch/);
  });

  it('commits the seal before lock release so release failure cannot roll it back', () => {
    const projectRoot = root();
    const store = new SessionStore(projectRoot);
    store.createSession('s', 'release ordering');
    const started = startExecution(projectRoot, 's', {
      requestId: 'req-start', ownerId: 'worker', ownerKind: 'codex',
    });
    const originalRelease = SessionStoreLock.prototype.release;
    let releases = 0;
    const release = vi.spyOn(SessionStoreLock.prototype, 'release').mockImplementation(function () {
      originalRelease.call(this);
      releases++;
      if (releases === 3) throw new Error('injected release failure');
    });
    try {
      expect(() => sealExecution(projectRoot, {
        sessionId: 's', executionId: started.execution.execution_id, requestId: 'req-seal',
        expectedExecutionRevision: 1, lease: claim(started.lease_claim), summary: 'done', outcome: 'done',
      })).toThrow(/injected release failure/);
    } finally {
      release.mockRestore();
    }
    expect(store.readExecution('s', started.execution.execution_id)).toMatchObject({ status: 'sealed', lease: null });
    expect(store.readExecutionSealReceipt('s', started.execution.execution_id)).not.toBeNull();
    expect(store.readExecutionTransition('s', started.execution.execution_id, 'req-seal')).toMatchObject({
      status: 'applied',
      payload: { operation: 'execution-seal' },
      outcome: { result: { status: 'sealed', final_outcome: 'done' } },
    });
    expect(sealExecution(projectRoot, {
      sessionId: 's', executionId: started.execution.execution_id, requestId: 'req-seal',
      expectedExecutionRevision: 1, lease: claim(started.lease_claim), summary: 'done', outcome: 'done',
    })).toMatchObject({ replayed: true, execution: { status: 'sealed', lease: null } });
  });

  it('commits the lease release before lock release so release failure cannot roll it back and remains replayable', () => {
    const projectRoot = root();
    const store = new SessionStore(projectRoot);
    store.createSession('s', 'lease release ordering');
    const started = startExecution(projectRoot, 's', {
      requestId: 'req-start', ownerId: 'worker', ownerKind: 'codex',
    });
    const releaseInput = {
      sessionId: 's', executionId: started.execution.execution_id, requestId: 'req-release',
      expectedExecutionRevision: 1, lease: claim(started.lease_claim),
    };
    const originalRelease = SessionStoreLock.prototype.release;
    const release = vi.spyOn(SessionStoreLock.prototype, 'release').mockImplementation(function () {
      originalRelease.call(this);
      throw new Error('injected release failure');
    });
    try {
      expect(() => releaseExecutionLease(projectRoot, releaseInput)).toThrow(/injected release failure/);
    } finally {
      release.mockRestore();
    }

    expect(store.readExecution('s', started.execution.execution_id)).toMatchObject({
      status: 'active', revision: 2, lease: null,
    });
    expect(store.readExecutionTransition('s', started.execution.execution_id, 'req-release')).toMatchObject({
      status: 'applied',
      payload: { operation: 'execution-lease-release' },
      outcome: {
        postconditions: { execution_revision: 2, lease_epoch: null },
        result: { released: true },
      },
    });
    expect(releaseExecutionLease(projectRoot, releaseInput)).toMatchObject({
      replayed: true, execution: { status: 'active', revision: 2, lease: null },
    });
    expect(attachExecution(projectRoot, {
      sessionId: 's', executionId: started.execution.execution_id, requestId: 'req-attach-after-release-failure',
      expectedExecutionRevision: 2, ownerId: 'recovery-worker', ownerKind: 'manual',
    })).toMatchObject({
      replayed: false,
      execution: { status: 'active', revision: 3 },
      lease_claim: { owner_id: 'recovery-worker', owner_kind: 'manual', epoch: 2 },
    });
  });
});
