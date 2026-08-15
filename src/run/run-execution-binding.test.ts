import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runDecide, runDecideExecution, type DecideExecutionOptions } from './decide.js';
import { attachExecution, startExecution } from './execution.js';
import type { ExecutionLeaseClaim } from './lease.js';
import { runNextExecutionStep, runNextStep } from './next.js';
import {
  completeExecutionRun,
  completeRun,
  createExecutionRun,
  createRun,
} from './runtime.js';
import { SessionStore } from './store.js';
import { migrateSession } from './migrate.js';
import { readStateJson } from '../utils/state-schema.js';

function v2Workspace(root: string): void {
  mkdirSync(join(root, ".workflow"), { recursive: true });
  writeFileSync(join(root, ".workflow", "config.json"), JSON.stringify({
    session_schema: { schema_version: "session-schema-selection/1.0", writer: "session/1.3", features: { session_statusless: false } },
  }));
}

const roots: string[] = [];

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'maestro-run-execution-binding-'));

  v2Workspace(value);
  roots.push(value);
  return value;
}

function enableV20(projectRoot: string): void {
  mkdirSync(join(projectRoot, '.workflow'), { recursive: true });
  writeFileSync(join(projectRoot, '.workflow', 'config.json'), JSON.stringify({
    session_schema: {
      schema_version: 'session-schema-selection/1.0',
      writer: 'session/2.0',
      features: { session_statusless: true },
    },
  }));
}

function command(projectRoot: string, name: string): void {
  const commandDir = join(projectRoot, '.claude', 'commands');
  const workflowDir = join(projectRoot, 'workflows');
  mkdirSync(commandDir, { recursive: true });
  mkdirSync(workflowDir, { recursive: true });
  writeFileSync(
    join(commandDir, `${name}.md`),
    '<contract>\nconsumes: []\nproduces: []\ngates:\n  entry: []\n  exit: []\n</contract>\n',
    'utf8',
  );
  writeFileSync(join(workflowDir, `${name}.md`), `# ${name}\n\nwork\n`, 'utf8');
}

function seedChain(projectRoot: string, steps: Array<{ command: string; decision?: string }>): SessionStore {
  const store = new SessionStore(projectRoot);
  store.createSession('s', 'execution authority');
  store.update('s', draft => {
    draft.session.orchestration.chain = steps.map((step, index) => ({
      step_id: `step-${index + 1}`,
      command: step.command,
      status: 'pending',
      run_id: null,
      inserted_by: 'test',
      decision_ref: step.decision ?? null,
    }));
    draft.session.orchestration.decision_points = steps
      .filter(step => step.decision)
      .map(step => ({
        point_id: step.decision!,
        after_step_id: null,
        status: 'pending',
        retry_count: 0,
        max_retries: 2,
        evidence_ref: null,
      }));
  });
  return store;
}

function claim(started: ReturnType<typeof startExecution>): ExecutionLeaseClaim {
  return {
    ownerId: started.lease_claim.owner_id,
    ownerKind: started.lease_claim.owner_kind,
    epoch: started.lease_claim.epoch,
    leaseId: started.lease_claim.lease_id,
  };
}

function report(store: SessionStore, runId: string): void {
  writeFileSync(
    join(store.runDir('s', runId), 'report.md'),
    '---\nverdict: ready\nsummary: complete\nconstraints: []\ndecisions: []\nconcerns: []\nnext: []\n---\n',
    'utf8',
  );
}

function runBytes(store: SessionStore, runId: string): Buffer {
  return readFileSync(join(store.runDir('s', runId), 'run.json'));
}

function hash(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function escalationFixture(): {
  projectRoot: string;
  store: SessionStore;
  executionId: string;
  decide: (overrides?: Partial<DecideExecutionOptions>) => ReturnType<typeof runDecideExecution>;
} {
  const projectRoot = root();
  command(projectRoot, 'gate');
  const store = seedChain(projectRoot, [{ command: 'gate', decision: 'DP-1' }]);
  const started = startExecution(projectRoot, 's', {
    requestId: 'req-start', ownerId: 'worker', ownerKind: 'codex',
  });
  const executionId = started.execution.execution_id;
  const input: DecideExecutionOptions = {
    verdict: 'escalate', confidence: 'high', requestId: 'req-decide',
    expectedExecutionRevision: 1, executionLease: claim(started),
  };
  return {
    projectRoot,
    store,
    executionId,
    decide: (overrides = {}) => runDecideExecution(
      projectRoot,
      's',
      executionId,
      'DP-1',
      { ...input, ...overrides },
    ),
  };
}

afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('execution-bound Run authority', () => {
  it('dispatches from derived current Execution state after explicit session/2.0 migration', () => {
    const projectRoot = root();
    command(projectRoot, 'demo');
    const store = seedChain(projectRoot, [{ command: 'demo' }]);
    enableV20(projectRoot);
    const migrated = migrateSession(projectRoot, 's');
    expect(migrated).toMatchObject({ status: 'migrated-to-2.0', legacy_execution_id: 'execution-legacy-g1' });
    const attached = attachExecution(projectRoot, {
      sessionId: 's', executionId: 'execution-legacy-g1', requestId: 'attach-v2',
      expectedExecutionRevision: 0, ownerId: 'worker', ownerKind: 'codex',
    });

    const next = runNextExecutionStep(projectRoot, {
      sessionId: 's', executionId: 'execution-legacy-g1', generation: 1,
      expectedExecutionRevision: 1, executionLease: claim(attached), requestId: 'next-v2',
    });
    expect(next).toMatchObject({ exitCode: 0, result: { session_id: 's', run_already_created: true } });
    expect(store.readSessionRecord('s')).toMatchObject({
      schema_version: 'session/2.0', current_execution_id: 'execution-legacy-g1',
    });
    expect(store.readExecution('s', 'execution-legacy-g1')).toMatchObject({ status: 'active', active_run_id: next.result?.run_id });
    const projection = readStateJson(projectRoot)?.sessions?.find(entry => entry.session_id === 's');
    expect(projection).toMatchObject({
      session_schema_version: 'session/2.0',
      current_execution_id: 'execution-legacy-g1',
      latest_execution_id: 'execution-legacy-g1',
    });
    expect(projection).not.toHaveProperty('status');
    expect(projection).not.toHaveProperty('active_run_id');
  });

  it('rejects every legacy mutation path while an Execution is open', () => {
    const projectRoot = root();
    command(projectRoot, 'demo');
    const store = seedChain(projectRoot, [{ command: 'demo' }, { command: 'gate', decision: 'DP-1' }]);
    const started = startExecution(projectRoot, 's', {
      requestId: 'req-start', ownerId: 'worker', ownerKind: 'codex',
    });

    expect(() => createRun({ projectRoot, command: 'demo', sessionId: 's' })).toThrow(/open Execution/);
    expect(runNextStep(projectRoot, { sessionId: 's' })).toMatchObject({ exitCode: 1 });
    expect(() => runDecide(projectRoot, 's', 'DP-1', {
      verdict: 'proceed', confidence: 'high',
    })).toThrow(/open Execution/);

    const created = createExecutionRun({
      projectRoot, command: 'demo', sessionId: 's', chainStepId: 'step-1',
      executionId: started.execution.execution_id, generation: 1,
      expectedExecutionRevision: 1, executionLease: claim(started), requestId: 'req-create',
    });
    report(store, created.run_id);
    expect(() => completeRun(projectRoot, created.run_id, 's')).toThrow(/open Execution/);
    expect(store.readExecutionRun('s', created.run_id).schema_version).toBe('command-run/1.4');
  });

  it('persists create receipts atomically and distinguishes replay, conflict, divergence, and stale fences', () => {
    const projectRoot = root();
    command(projectRoot, 'demo');
    const store = seedChain(projectRoot, [{ command: 'demo' }]);
    const started = startExecution(projectRoot, 's', {
      requestId: 'req-start', ownerId: 'worker', ownerKind: 'codex',
    });
    const input = {
      projectRoot, command: 'demo', sessionId: 's', chainStepId: 'step-1',
      executionId: started.execution.execution_id, generation: 1,
      expectedExecutionRevision: 1, executionLease: claim(started), requestId: 'req-create',
    };
    expect(() => createExecutionRun({
      ...input,
      requestId: 'req-stale-revision',
      expectedExecutionRevision: 0,
    })).toThrow(/revision conflict/);
    expect(() => createExecutionRun({
      ...input,
      requestId: 'req-stale-lease',
      executionLease: { ...claim(started), epoch: 2 },
    })).toThrow(/fence conflict/);

    const created = createExecutionRun(input);
    expect(createExecutionRun(input).run_id).toBe(created.run_id);
    const receipt = store.readExecutionTransition('s', started.execution.execution_id, 'req-create');
    expect(receipt).toMatchObject({
      payload: { schema_version: 'transition-request/1.1', operation: 'create' },
      outcome: { schema_version: 'transition-outcome/1.1', status: 'applied' },
    });
    expect(JSON.stringify(receipt)).not.toContain(started.lease_claim.lease_id);

    expect(() => createExecutionRun({ ...input, args: ['changed'] })).toThrowError(
      expect.objectContaining({ code: 'REQUEST_CONFLICT' }),
    );

    report(store, created.run_id);
    completeExecutionRun(projectRoot, created.run_id, {
      sessionId: 's', executionId: started.execution.execution_id, generation: 1,
      expectedExecutionRevision: 2, executionLease: claim(started), requestId: 'req-complete-for-divergence',
      chainVerdict: 'done',
    });
    expect(createExecutionRun(input)).toMatchObject({ run_id: created.run_id });
  });

  it('reconciles a sealed prior Run and allocates next under one execution-fenced transaction', () => {
    const projectRoot = root();
    command(projectRoot, 'one');
    command(projectRoot, 'two');
    const store = seedChain(projectRoot, [{ command: 'one' }, { command: 'two' }]);
    const started = startExecution(projectRoot, 's', {
      requestId: 'req-start', ownerId: 'worker', ownerKind: 'codex',
    });
    const lease = claim(started);
    const first = createExecutionRun({
      projectRoot, command: 'one', sessionId: 's', chainStepId: 'step-1',
      executionId: started.execution.execution_id, generation: 1,
      expectedExecutionRevision: 1, executionLease: lease, requestId: 'req-first',
      transitionOperation: 'next',
    });
    report(store, first.run_id);
    expect(completeExecutionRun(projectRoot, first.run_id, {
      sessionId: 's', executionId: started.execution.execution_id, generation: 1,
      expectedExecutionRevision: 2, executionLease: lease, requestId: 'req-complete-first',
    }).sealed).toBe(true);
    expect(store.readBundle('s').session.orchestration.chain[0].status).toBe('running');

    const next = runNextExecutionStep(projectRoot, {
      sessionId: 's', executionId: started.execution.execution_id, generation: 1,
      expectedExecutionRevision: 3, executionLease: lease, requestId: 'req-next',
    });
    expect(next).toMatchObject({ exitCode: 0, result: { step: { step_id: 'step-2' } } });
    expect(store.readBundle('s').session.orchestration.chain).toMatchObject([
      { step_id: 'step-1', status: 'sealed', run_id: first.run_id },
      { step_id: 'step-2', status: 'running', run_id: next.result!.run_id },
    ]);
    expect(store.readExecutionTransition('s', started.execution.execution_id, 'req-next')?.payload.operation).toBe('next');
    expect(runNextExecutionStep(projectRoot, {
      sessionId: 's', executionId: started.execution.execution_id, generation: 1,
      expectedExecutionRevision: 3, executionLease: lease, requestId: 'req-next',
    }).result?.run_id).toBe(next.result?.run_id);
    expect(completeExecutionRun(projectRoot, first.run_id, {
      sessionId: 's', executionId: started.execution.execution_id, generation: 1,
      expectedExecutionRevision: 2, executionLease: lease, requestId: 'req-complete-first',
    })).toMatchObject({
      transition: { status: 'replayed' },
      run_id: first.run_id,
      sealed: true,
    });
  });

  it('replays complete exactly, rejects changed requests, and preserves command-run/1.4', () => {
    const projectRoot = root();
    command(projectRoot, 'demo');
    const store = seedChain(projectRoot, [{ command: 'demo' }]);
    const started = startExecution(projectRoot, 's', {
      requestId: 'req-start', ownerId: 'worker', ownerKind: 'codex',
    });
    const lease = claim(started);
    const created = createExecutionRun({
      projectRoot, command: 'demo', sessionId: 's', chainStepId: 'step-1',
      executionId: started.execution.execution_id, generation: 1,
      expectedExecutionRevision: 1, executionLease: lease, requestId: 'req-create',
    });
    report(store, created.run_id);
    expect(() => completeExecutionRun(projectRoot, created.run_id, {
      sessionId: 's', executionId: started.execution.execution_id, generation: 1,
      expectedExecutionRevision: 1, executionLease: lease, requestId: 'req-complete-stale-revision',
    })).toThrow(/revision conflict/);
    expect(() => completeExecutionRun(projectRoot, created.run_id, {
      sessionId: 's', executionId: started.execution.execution_id, generation: 1,
      expectedExecutionRevision: 2,
      executionLease: { ...lease, leaseId: `${lease.leaseId}-stale` },
      requestId: 'req-complete-stale-lease',
    })).toThrow(/fence conflict/);
    const input = {
      sessionId: 's', executionId: started.execution.execution_id, generation: 1,
      expectedExecutionRevision: 2, executionLease: lease, requestId: 'req-complete',
      chainVerdict: 'done' as const,
    };
    const first = completeExecutionRun(projectRoot, created.run_id, input);
    const persisted = readFileSync(join(store.runDir('s', created.run_id), 'run.json'), 'utf8');
    const replay = completeExecutionRun(projectRoot, created.run_id, input);
    expect(first.transition.status).toBe('applied');
    expect(replay.transition).toMatchObject({ status: 'replayed', transition_id: first.transition.transition_id });
    expect(readFileSync(join(store.runDir('s', created.run_id), 'run.json'), 'utf8')).toBe(persisted);
    expect(store.readExecutionRun('s', created.run_id).schema_version).toBe('command-run/1.4');
    expect(store.readExecution('s', started.execution.execution_id)).toMatchObject({ status: 'active', lease: expect.any(Object) });
    expect(() => completeExecutionRun(projectRoot, created.run_id, {
      ...input, notes: ['changed'],
    })).toThrowError(expect.objectContaining({ code: 'REQUEST_CONFLICT' }));
  });

  it('pauses and releases the Execution on blocked completion but keeps retry active', () => {
    for (const verdict of ['blocked', 'needs-retry'] as const) {
      const projectRoot = root();
      command(projectRoot, 'demo');
      const store = seedChain(projectRoot, [{ command: 'demo' }]);
      const started = startExecution(projectRoot, 's', {
        requestId: 'req-start', ownerId: 'worker', ownerKind: 'codex',
      });
      const lease = claim(started);
      const created = createExecutionRun({
        projectRoot, command: 'demo', sessionId: 's', chainStepId: 'step-1',
        executionId: started.execution.execution_id, generation: 1,
        expectedExecutionRevision: 1, executionLease: lease, requestId: 'req-create',
      });
      report(store, created.run_id);
      completeExecutionRun(projectRoot, created.run_id, {
        sessionId: 's', executionId: started.execution.execution_id, generation: 1,
        expectedExecutionRevision: 2, executionLease: lease, requestId: `req-${verdict}`,
        chainVerdict: verdict,
      });
      const execution = store.readExecution('s', started.execution.execution_id);
      if (verdict === 'blocked') {
        expect(execution).toMatchObject({ status: 'paused', lease: null });
        expect(store.readBundle('s').session.status).toBe('paused');
      } else {
        expect(execution.status).toBe('active');
        expect(execution.lease).not.toBeNull();
      }
    }
  });

  it('keeps a sealed retry parent byte-identical when an Execution replacement is allocated', () => {
    const projectRoot = root();
    command(projectRoot, 'demo');
    const store = seedChain(projectRoot, [{ command: 'demo' }]);
    const started = startExecution(projectRoot, 's', {
      requestId: 'req-start', ownerId: 'worker', ownerKind: 'codex',
    });
    const lease = claim(started);
    const first = createExecutionRun({
      projectRoot, command: 'demo', sessionId: 's', chainStepId: 'step-1',
      executionId: started.execution.execution_id, generation: 1,
      expectedExecutionRevision: 1, executionLease: lease, requestId: 'req-create-first',
    });
    report(store, first.run_id);
    completeExecutionRun(projectRoot, first.run_id, {
      sessionId: 's', executionId: started.execution.execution_id, generation: 1,
      expectedExecutionRevision: 2, executionLease: lease, requestId: 'req-retry-first',
      chainVerdict: 'needs-retry',
    });
    const before = runBytes(store, first.run_id);
    const beforeHash = hash(before);

    const replacement = runNextExecutionStep(projectRoot, {
      sessionId: 's', executionId: started.execution.execution_id, generation: 1,
      expectedExecutionRevision: 3, executionLease: lease, requestId: 'req-next-retry',
    });
    expect(replacement.exitCode).toBe(0);
    expect(store.readExecutionRun('s', replacement.result!.run_id)).toMatchObject({
      parent_run_id: first.run_id,
      chain_step_id: 'step-1',
    });
    const after = runBytes(store, first.run_id);
    expect(after.equals(before)).toBe(true);
    expect(hash(after)).toBe(beforeHash);
    expect(JSON.parse(after.toString('utf8')).retry_fence.consumed_at).toBeNull();
    expect(store.readRun('s', first.run_id).retry_fence?.consumed_at).not.toBeNull();
    expect(store.readBundle('s').session.orchestration.chain[0].pending_retry).toBeNull();
  });

  it('replays the exact escalation after its first commit pauses and releases the Execution', () => {
    const fixture = escalationFixture();
    const first = fixture.decide();
    const persisted = readFileSync(join(fixture.store.sessionDir('s'), 'decisions.ndjson'), 'utf8');
    const replay = fixture.decide();

    expect(first.session_status).toBe('paused');
    expect(first.projection_pending).toBe(false);
    expect(replay.transition).toMatchObject({
      status: 'replayed', transition_id: first.transition.transition_id,
    });
    expect(readFileSync(join(fixture.store.sessionDir('s'), 'decisions.ndjson'), 'utf8')).toBe(persisted);
    expect(fixture.store.readExecution('s', fixture.executionId)).toMatchObject({
      revision: 2, status: 'paused', lease: null,
    });
  });

  it('rejects a changed escalation payload before paused-status apply checks', () => {
    const fixture = escalationFixture();
    fixture.decide();

    expect(() => fixture.decide({ summary: 'changed payload' })).toThrowError(
      expect.objectContaining({ code: 'REQUEST_CONFLICT' }),
    );
  });

  it('rejects a new decision request against a paused Execution with no lease', () => {
    const fixture = escalationFixture();
    fixture.decide();

    expect(() => fixture.decide({
      requestId: 'req-decide-new',
      expectedExecutionRevision: 2,
    })).toThrow(`Execution ${fixture.executionId} is paused`);
  });

  it('fails closed for corrupt, illegally rewritten, and state-diverged escalation receipts', () => {
    const corrupt = escalationFixture();
    corrupt.decide();
    const receiptPath = corrupt.store.executionTransitionPath('s', corrupt.executionId, 'req-decide');
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8')) as {
      outcome: { result_hash: string };
    };
    receipt.outcome.result_hash = `sha256:${'0'.repeat(64)}`;
    writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
    expect(() => corrupt.decide()).toThrowError(
      expect.objectContaining({ code: 'INVALID_TRANSITION_RECEIPT' }),
    );

    const rewritten = escalationFixture();
    rewritten.decide();
    const rewrittenPath = rewritten.store.executionTransitionPath('s', rewritten.executionId, 'req-decide');
    const rewrittenReceipt = JSON.parse(readFileSync(rewrittenPath, 'utf8')) as {
      outcome: { postconditions: { execution_status: string } };
    };
    rewrittenReceipt.outcome.postconditions.execution_status = 'active';
    writeFileSync(rewrittenPath, `${JSON.stringify(rewrittenReceipt, null, 2)}\n`, 'utf8');
    expect(() => rewritten.decide()).toThrowError(
      expect.objectContaining({ code: 'REPLAY_STATE_DIVERGED' }),
    );

    const diverged = escalationFixture();
    diverged.decide();
    const executionPath = diverged.store.executionPath('s', diverged.executionId);
    const execution = JSON.parse(readFileSync(executionPath, 'utf8')) as { revision: number };
    execution.revision++;
    writeFileSync(executionPath, `${JSON.stringify(execution, null, 2)}\n`, 'utf8');
    expect(() => diverged.decide()).toThrowError(
      expect.objectContaining({ code: 'REPLAY_STATE_DIVERGED' }),
    );
  });
});
