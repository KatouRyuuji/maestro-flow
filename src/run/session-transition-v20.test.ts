import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { pauseExecution, resumeExecution, sealExecution, startExecution } from './execution.js';
import type { ExecutionLeaseClaim } from './lease.js';
import { archiveSession, unarchiveSession } from './session-transition.js';
import { SessionStore } from './store.js';

const roots: string[] = [];

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'session-transition-v20-'));
  roots.push(value);
  mkdirSync(join(value, '.workflow'), { recursive: true });
  writeFileSync(join(value, '.workflow', 'config.json'), JSON.stringify({
    session_schema: {
      schema_version: 'session-schema-selection/1.0',
      writer: 'session/2.0',
      features: { session_statusless: true },
    },
  }));
  return value;
}

function claim(started: { lease_claim: {
  owner_id: string;
  owner_kind: ExecutionLeaseClaim['ownerKind'];
  epoch: number;
  lease_id: string;
} }): ExecutionLeaseClaim {
  return {
    ownerId: started.lease_claim.owner_id,
    ownerKind: started.lease_claim.owner_kind,
    epoch: started.lease_claim.epoch,
    leaseId: started.lease_claim.lease_id,
  };
}

afterEach(() => {
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
});

describe('session/2.0 archive transitions', () => {
  it('requires CAS audit evidence, replays by request ID, and leaves Execution bytes untouched', () => {
    const projectRoot = root();
    const store = new SessionStore(projectRoot);
    store.createSession('s', 'archive lifecycle');
    const started = startExecution(projectRoot, 's', {
      requestId: 'start-1', ownerId: 'worker', ownerKind: 'codex',
      now: new Date('2026-08-04T00:00:00.000Z'),
    });

    expect(() => archiveSession(projectRoot, 's', {
      requestId: 'archive-active', actor: 'operator', reason: 'premature', evidence: ['evidence/a'],
      expectedIdentityRevision: 1, expectedActivityRevision: 1,
    })).toThrow(/active current Execution/);

    const paused = pauseExecution(projectRoot, {
      sessionId: 's', executionId: started.execution.execution_id,
      requestId: 'pause-1', expectedExecutionRevision: 1, lease: claim(started),
      now: new Date('2026-08-04T00:30:00.000Z'),
    });
    expect(() => archiveSession(projectRoot, 's', {
      requestId: 'archive-paused', actor: 'operator', reason: 'premature', evidence: ['evidence/a'],
      expectedIdentityRevision: 1, expectedActivityRevision: 2,
    })).toThrow(/paused current Execution/);
    const resumed = resumeExecution(projectRoot, {
      sessionId: 's', executionId: started.execution.execution_id,
      requestId: 'resume-1', expectedExecutionRevision: paused.execution.revision,
      ownerId: 'worker', ownerKind: 'codex',
      now: new Date('2026-08-04T00:45:00.000Z'),
    });

    sealExecution(projectRoot, {
      sessionId: 's', executionId: started.execution.execution_id,
      requestId: 'seal-1', expectedExecutionRevision: resumed.execution.revision, lease: claim(resumed),
      summary: 'historical generation', outcome: 'done',
      now: new Date('2026-08-04T00:45:00.000Z'),
    });
    const executionBefore = store.readExecution('s', started.execution.execution_id);
    const archiveOptions = {
      requestId: 'archive-1', actor: 'operator', reason: 'retain as history',
      evidence: ['evidence/archive.json'], expectedIdentityRevision: 1, expectedActivityRevision: 4,
      now: new Date('2026-08-04T02:00:00.000Z'),
    };
    const archived = archiveSession(projectRoot, 's', archiveOptions);
    expect(archived).toMatchObject({ replayed: false, session: { archived_by: 'operator', activity_revision: 5 } });
    expect(archiveSession(projectRoot, 's', archiveOptions)).toMatchObject({ replayed: true });
    expect(() => unarchiveSession(projectRoot, 's', {
      requestId: 'unarchive-stale', actor: 'operator', reason: 'stale', evidence: ['evidence/archive.json'],
      expectedIdentityRevision: 1, expectedActivityRevision: 4,
    })).toThrow(/stale activity revision/);

    const unarchived = unarchiveSession(projectRoot, 's', {
      requestId: 'unarchive-1', actor: 'operator', reason: 'continue topic',
      evidence: ['evidence/unarchive.json'], expectedIdentityRevision: 1, expectedActivityRevision: 5,
      now: new Date('2026-08-04T03:00:00.000Z'),
    });
    expect(unarchived.session).toMatchObject({ archived_at: null, archived_by: null, activity_revision: 6 });
    expect(store.readExecution('s', started.execution.execution_id)).toEqual(executionBefore);

    const next = startExecution(projectRoot, 's', {
      requestId: 'start-2', ownerId: 'worker', ownerKind: 'codex',
      now: new Date('2026-08-04T04:00:00.000Z'),
    });
    expect(next.execution).toMatchObject({ generation: 2, status: 'active' });
    expect(store.readSessionRecord('s')).toMatchObject({
      current_execution_id: next.execution.execution_id,
      latest_execution_id: next.execution.execution_id,
    });
  });

  it('rejects empty audit fields before writing a receipt', () => {
    const projectRoot = root();
    const store = new SessionStore(projectRoot);
    store.createSession('s', 'audit validation');
    expect(() => archiveSession(projectRoot, 's', {
      requestId: 'archive-empty', actor: ' ', reason: 'reason', evidence: [' '],
      expectedIdentityRevision: 1, expectedActivityRevision: 0,
    })).toThrow(/actor is required/);
    expect(store.listSessionArchiveReceipts('s')).toEqual([]);
  });
});
