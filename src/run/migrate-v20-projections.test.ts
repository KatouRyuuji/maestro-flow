import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { sealExecution, startExecution } from './execution.js';
import { migrateSession } from './migrate.js';
import { sealSession } from './runtime.js';
import { SessionStore } from './store.js';

function v2Workspace(root: string): void {
  mkdirSync(join(root, ".workflow"), { recursive: true });
  writeFileSync(join(root, ".workflow", "config.json"), JSON.stringify({
    session_schema: { schema_version: "session-schema-selection/1.0", writer: "session/1.3", features: { session_statusless: false } },
  }));
}

const roots: string[] = [];

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'maestro-migrate-v20-projections-'));

  v2Workspace(value);
  roots.push(value);
  return value;
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
  }, null, 2)}\n`);
}

afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('session/2.0 migration of Wave1 Execution projections', () => {
  it('preserves generations and leases while deriving current/latest from the maximum generation', () => {
    const projectRoot = root();
    const store = new SessionStore(projectRoot);
    store.createSession('s', 'Wave1 multi-generation migration');

    const first = startExecution(projectRoot, 's', {
      requestId: 'req-start-1', ownerId: 'worker-1', ownerKind: 'codex',
    });
    sealExecution(projectRoot, {
      sessionId: 's',
      executionId: first.execution.execution_id,
      requestId: 'req-seal-1',
      expectedExecutionRevision: 1,
      lease: {
        ownerId: first.lease_claim.owner_id,
        ownerKind: first.lease_claim.owner_kind,
        epoch: first.lease_claim.epoch,
        leaseId: first.lease_claim.lease_id,
      },
      summary: 'generation one complete',
      outcome: 'done',
    });
    const second = startExecution(projectRoot, 's', {
      requestId: 'req-start-2', ownerId: 'worker-2', ownerKind: 'pi',
    });
    expect(second.execution.generation).toBe(2);

    const executionPaths = [first.execution.execution_id, second.execution.execution_id]
      .map(executionId => store.executionPath('s', executionId));
    const executionBytes = executionPaths.map(path => readFileSync(path));
    const secondLease = store.readExecution('s', second.execution.execution_id).lease;

    enableSessionV20(projectRoot);
    expect(migrateSession(projectRoot, 's')).toMatchObject({
      status: 'migrated-to-2.0',
      legacy_execution_id: second.execution.execution_id,
    });
    expect(executionPaths.map(path => readFileSync(path))).toEqual(executionBytes);
    expect(store.readExecution('s', second.execution.execution_id).lease).toEqual(secondLease);
    expect(store.readSessionRecord('s')).toMatchObject({
      schema_version: 'session/2.0',
      current_execution_id: second.execution.execution_id,
      latest_execution_id: second.execution.execution_id,
    });
    expect(store.listExecutions('s').map(execution => execution.generation)).toEqual([1, 2]);
    expect(migrateSession(projectRoot, 's').status).toBe('already-migrated');
  });

  it.each([
    ['running', 'active', true, false],
    ['paused', 'paused', true, false],
    ['failed', 'paused', true, false],
    ['sealed', 'sealed', false, false],
    ['archived', 'sealed', false, true],
  ] as const)(
    'deterministically projects legacy %s authority into statusless Execution state',
    (legacyStatus, executionStatus, hasCurrentExecution, isArchived) => {
      const projectRoot = root();
      const store = new SessionStore(projectRoot);
      store.createSession(legacyStatus, `${legacyStatus} migration`);
      store.update(legacyStatus, draft => {
        draft.session.status = legacyStatus;
        if (legacyStatus === 'sealed' || legacyStatus === 'archived') {
          draft.session.lifecycle.sealed_at = '2026-08-06T00:00:00.000Z';
          draft.session.lifecycle.seal_summary = `${legacyStatus} legacy Session`;
        }
      });

      enableSessionV20(projectRoot);
      expect(migrateSession(projectRoot, legacyStatus)).toMatchObject({
        status: 'migrated-to-2.0', legacy_execution_id: 'execution-legacy-g1',
      });
      expect(store.readSessionRecord(legacyStatus)).toMatchObject({
        schema_version: 'session/2.0',
        current_execution_id: hasCurrentExecution ? 'execution-legacy-g1' : null,
        latest_execution_id: 'execution-legacy-g1',
        archived_at: isArchived ? '2026-08-06T00:00:00.000Z' : null,
        archived_by: isArchived ? 'legacy-migration' : null,
      });
      expect(store.readExecution(legacyStatus, 'execution-legacy-g1')).toMatchObject({
        generation: 1, status: executionStatus, lease: null,
      });
      expect(migrateSession(projectRoot, legacyStatus).status).toBe('already-migrated');
    },
  );

  it('starts a new generation after migrating a sealed legacy Session without consulting compatibility status', () => {
    const projectRoot = root();
    const store = new SessionStore(projectRoot);
    store.createSession('sealed', 'sealed migration');
    const first = startExecution(projectRoot, 'sealed', {
      requestId: 'req-start-1', ownerId: 'worker-1', ownerKind: 'codex',
      now: new Date('2026-08-06T00:00:00.000Z'),
    });
    sealExecution(projectRoot, {
      sessionId: 'sealed', executionId: first.execution.execution_id, requestId: 'req-seal-1',
      expectedExecutionRevision: 1,
      lease: {
        ownerId: first.lease_claim.owner_id,
        ownerKind: first.lease_claim.owner_kind,
        epoch: first.lease_claim.epoch,
        leaseId: first.lease_claim.lease_id,
      },
      summary: 'legacy generation complete', outcome: 'done',
      now: new Date('2026-08-06T00:00:01.000Z'),
    });
    sealSession(projectRoot, 'sealed', 'legacy Session sealed');
    expect(store.readBundle('sealed').session.status).toBe('sealed');

    enableSessionV20(projectRoot);
    expect(migrateSession(projectRoot, 'sealed')).toMatchObject({
      status: 'migrated-to-2.0', legacy_execution_id: first.execution.execution_id,
    });
    expect(store.readSessionRecord('sealed')).toMatchObject({
      schema_version: 'session/2.0', current_execution_id: null,
      latest_execution_id: first.execution.execution_id, archived_at: null,
    });
    expect(store.readBundle('sealed').session.status).toBe('sealed');

    const second = startExecution(projectRoot, 'sealed', {
      requestId: 'req-start-2', ownerId: 'worker-2', ownerKind: 'pi',
      now: new Date('2026-08-06T00:02:00.000Z'),
    });
    expect(second.execution).toMatchObject({ generation: 2, status: 'active' });
    expect(store.readSessionRecord('sealed')).toMatchObject({
      current_execution_id: second.execution.execution_id,
      latest_execution_id: second.execution.execution_id,
    });
  });
});
