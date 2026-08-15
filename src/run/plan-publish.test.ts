import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { runNextStep } from './next.js';
import { createChainSession } from './chain-admin.js';
import { startExecution } from './execution.js';
import { migrateSession } from './migrate.js';
import { publishPlan } from './plan-publish.js';
import { createRun } from './runtime.js';
import { SessionStore } from './store.js';

function v2Workspace(root: string): void {
  mkdirSync(join(root, ".workflow"), { recursive: true });
  writeFileSync(join(root, ".workflow", "config.json"), JSON.stringify({
    session_schema: { schema_version: "session-schema-selection/1.0", writer: "session/1.3", features: { session_statusless: false } },
  }));
}

const roots: string[] = [];

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'maestro-plan-publish-'));

  v2Workspace(value);
  roots.push(value);
  mkdirSync(join(value, 'prepare'), { recursive: true });
  writeFileSync(join(value, 'prepare', 'plan-publish.md'), `---
name: plan-publish
session-mode: run
contract:
  contract_version: 2.1
  arguments: []
  consumes: []
  produces:
    - path: outputs/plan.json
      kind: plan
      alias: current-plan
      role: primary
      required: true
      schema: plan/1.0
  gates:
    entry: []
    exit: []
---
`, 'utf8');
  return value;
}

function source(projectRoot: string, markdown = '# Approved\n\nShip it.\n'): string {
  const path = join(projectRoot, 'approved.md');
  writeFileSync(path, markdown, 'utf8');
  return path;
}

function writeKnownSchemaExecuteContract(projectRoot: string): void {
  // The reuse-assessment/1.1 policy intentionally REVIEWs unknown consumer schemas.
  // Positive REUSE coverage must declare the accepted Plan schema explicitly.
  writeFileSync(join(projectRoot, 'prepare', 'execute.md'), `---
name: execute
session-mode: run
contract:
  contract_version: 2.1
  arguments: []
  consumes:
    - kind: plan
      alias: current-plan
      required: true
      require_status: sealed
      schema: plan/1.0
  produces: []
  gates:
    entry: []
    exit: []
---
`, 'utf8');
}

function enableSessionV20(projectRoot: string): void {
  mkdirSync(join(projectRoot, '.workflow'), { recursive: true });
  writeFileSync(join(projectRoot, '.workflow', 'config.json'), JSON.stringify({
    session_schema: {
      schema_version: 'session-schema-selection/1.0',
      writer: 'session/2.0',
      features: { session_statusless: true },
    },
  }), 'utf8');
}

function executionTarget(projectRoot: string, slug = 'current') {
  const created = createChainSession(projectRoot, slug, {
    intent: 'Implement approved Plan',
    engine: 'manual',
    definition: {
      intent: 'Implement approved Plan',
      engine: 'manual',
      steps: [{ command: 'execute' }, { command: 'verify' }],
    },
  });
  const sessionId = created.sessionId;
  const started = startExecution(projectRoot, sessionId, {
    requestId: 'req-start-plan-execution',
    ownerId: 'pi-session-1',
    ownerKind: 'pi',
    actor: 'pi-session-1',
    reason: 'Approve current Plan',
    evidence: ['pi-session:pi-session-1'],
  });
  enableSessionV20(projectRoot);
  migrateSession(projectRoot, sessionId);
  const store = new SessionStore(projectRoot);
  const session = store.readSessionRecord(sessionId);
  const execution = store.readExecution(sessionId, started.execution.execution_id);
  return {
    store,
    sessionId,
    session,
    execution,
    lease: {
      executionOwner: started.lease_claim.owner_id,
      ownerKind: started.lease_claim.owner_kind,
      ownerEpoch: started.lease_claim.epoch,
      leaseId: started.lease_claim.lease_id,
    },
  };
}

function emptyExecutionTarget(projectRoot: string, sessionId = 'empty-current') {
  enableSessionV20(projectRoot);
  const store = new SessionStore(projectRoot);
  store.createSession(sessionId, 'Implement approved Plan');
  const started = startExecution(projectRoot, sessionId, {
    requestId: 'req-start-empty-plan-execution',
    ownerId: 'pi-session-1',
    ownerKind: 'pi',
    actor: 'pi-session-1',
    reason: 'Start empty current Execution',
    evidence: ['pi-session:pi-session-1'],
  });
  return {
    store,
    sessionId,
    session: store.readSessionRecord(sessionId),
    execution: store.readExecution(sessionId, started.execution.execution_id),
    lease: {
      executionOwner: started.lease_claim.owner_id,
      ownerKind: started.lease_claim.owner_kind,
      ownerEpoch: started.lease_claim.epoch,
      leaseId: started.lease_claim.lease_id,
    },
  };
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('canonical Pi Plan publisher', () => {
  it('publishes and replays under exact current Execution authority with command-run/1.4 receipts', () => {
    const projectRoot = root();
    const target = executionTarget(projectRoot);
    const path = source(projectRoot);
    const options = {
      projectRoot,
      sourcePath: path,
      sessionId: target.sessionId,
      handoffKey: 'handoff-execution-current',
      sourcePiSession: 'pi-session-1',
      planRevision: 4,
      approvedAt: '2026-08-11T20:00:00.000Z',
      requestId: 'req-plan-execution-current',
      executionId: target.execution.execution_id,
      generation: target.execution.generation,
      expectedExecutionRevision: target.execution.revision,
      expectedIdentityRevision: target.session.identity_revision as number,
      expectedActivityRevision: target.session.activity_revision as number,
      ...target.lease,
      actor: 'pi-session-1',
      reason: 'Publish approved current Plan',
      evidence: ['pi-plan:handoff-execution-current'],
    };

    const first = publishPlan(options);
    const replay = publishPlan(options);

    expect(first).toMatchObject({
      schema_version: 'plan-publish-result/1.1',
      session_id: target.sessionId,
      execution_id: target.execution.execution_id,
      generation: 1,
      execution_revision: target.execution.revision + 2,
      replayed: false,
      claim: {
        owner_id: 'pi-session-1', owner_kind: 'pi', epoch: 1,
        lease_id_hash: expect.stringMatching(/^sha256:/),
      },
    });
    expect(replay).toMatchObject({
      schema_version: 'plan-publish-result/1.1',
      run_id: first.run_id,
      artifact_id: first.artifact_id,
      execution_revision: first.execution_revision,
      replayed: true,
      transition: { transition_id: first.transition.transition_id },
    });
    const run = target.store.readExecutionRun(target.sessionId, first.run_id);
    expect(run).toMatchObject({
      schema_version: 'command-run/1.4',
      execution_id: target.execution.execution_id,
      generation: 1,
      status: 'sealed',
    });
    expect(target.store.readExecutionTransition(
      target.sessionId, target.execution.execution_id, 'req-plan-execution-current__allocate',
    )?.payload.operation).toBe('create');
    expect(target.store.readExecutionTransition(
      target.sessionId, target.execution.execution_id, 'req-plan-execution-current__complete',
    )?.payload.operation).toBe('complete');
    expect(readFileSync(join(target.store.runDir(target.sessionId, first.run_id), 'run.json'), 'utf8'))
      .not.toContain(target.lease.leaseId);
  });

  it('bootstraps an empty Execution once and recovers publication from the refreshed post-bootstrap fence', () => {
    const projectRoot = root();
    const target = emptyExecutionTarget(projectRoot);
    const options = {
      projectRoot,
      sourcePath: source(projectRoot),
      sessionId: target.sessionId,
      handoffKey: 'handoff-empty-execution',
      sourcePiSession: 'pi-session-1',
      planRevision: 1,
      approvedAt: '2026-08-12T01:00:00.000Z',
      requestId: 'req-plan-empty-execution',
      executionId: target.execution.execution_id,
      generation: target.execution.generation,
      expectedExecutionRevision: target.execution.revision,
      expectedIdentityRevision: target.session.identity_revision,
      expectedActivityRevision: target.session.activity_revision,
      ...target.lease,
      actor: 'pi-session-1',
      reason: 'Publish approved Plan into empty Execution',
      evidence: ['pi-plan:handoff-empty-execution'],
    };

    expect(() => publishPlan(options, {
      afterExecutionChainBootstrapped() { throw new Error('simulated bootstrap response loss'); },
    })).toThrow(/simulated bootstrap response loss/);

    const bootstrapped = target.store.readExecution(target.sessionId, target.execution.execution_id);
    expect(bootstrapped).toMatchObject({ revision: target.execution.revision + 1, active_run_id: null });
    expect(bootstrapped.chain.map(step => ({ command: step.command, status: step.status, run: step.run_id })))
      .toEqual([
        { command: 'execute', status: 'pending', run: null },
        { command: 'verify', status: 'pending', run: null },
      ]);
    expect(target.store.readSessionRecord(target.sessionId)).toMatchObject({
      activity_revision: target.session.activity_revision + 1,
    });
    expect(target.store.listBoundExecutionRuns(
      target.sessionId,
      target.execution.execution_id,
      target.execution.generation,
    )).toEqual([]);

    const refreshedOptions = {
      ...options,
      expectedExecutionRevision: options.expectedExecutionRevision + 1,
      expectedActivityRevision: options.expectedActivityRevision + 1,
    };
    const recovered = publishPlan(refreshedOptions);
    const replay = publishPlan(refreshedOptions);
    expect(recovered).toMatchObject({
      schema_version: 'plan-publish-result/1.1',
      execution_revision: options.expectedExecutionRevision + 3,
      session_activity_revision: options.expectedActivityRevision + 3,
      replayed: false,
    });
    expect(replay).toMatchObject({
      run_id: recovered.run_id,
      artifact_id: recovered.artifact_id,
      execution_revision: recovered.execution_revision,
      replayed: true,
      transition: { transition_id: recovered.transition.transition_id },
    });
    expect(target.store.listBoundExecutionRuns(
      target.sessionId,
      target.execution.execution_id,
      target.execution.generation,
    )).toHaveLength(1);
    expect(target.store.readExecutionRun(target.sessionId, recovered.run_id)).toMatchObject({
      schema_version: 'command-run/1.4',
      status: 'sealed',
      execution_id: target.execution.execution_id,
      generation: 1,
    });

    const bootstrapReceipt = target.store.readExecutionTransition(
      target.sessionId,
      target.execution.execution_id,
      'req-plan-empty-execution__bootstrap',
    );
    expect(bootstrapReceipt?.payload.operation).toBe('execution-chain-bootstrap');
    expect(bootstrapReceipt?.payload.preconditions).toMatchObject({
      execution_revision: options.expectedExecutionRevision,
      session_activity_revision: options.expectedActivityRevision,
    });
    expect(JSON.stringify(bootstrapReceipt)).not.toContain(target.lease.leaseId);
    expect(target.store.readExecutionTransition(
      target.sessionId,
      target.execution.execution_id,
      'req-plan-empty-execution__allocate',
    )?.payload.preconditions).toMatchObject({
      execution_revision: options.expectedExecutionRevision + 1,
      session_activity_revision: options.expectedActivityRevision + 1,
    });
  });

  it('rejects stale Execution revision, lease tuple, and replay audit conflicts before mutation', () => {
    const projectRoot = root();
    const target = executionTarget(projectRoot);
    const base = {
      projectRoot,
      sourcePath: source(projectRoot),
      sessionId: target.sessionId,
      handoffKey: 'handoff-execution-fences',
      requestId: 'req-plan-execution-fences',
      executionId: target.execution.execution_id,
      generation: target.execution.generation,
      expectedExecutionRevision: target.execution.revision,
      expectedIdentityRevision: target.session.identity_revision as number,
      expectedActivityRevision: target.session.activity_revision as number,
      ...target.lease,
      actor: 'pi-session-1',
      reason: 'Publish fenced Plan',
      evidence: ['pi-plan:fences'],
    };

    expect(() => publishPlan({ ...base, expectedExecutionRevision: target.execution.revision - 1 }))
      .toThrow(/execution revision conflict/);
    expect(() => publishPlan({ ...base, leaseId: `${target.lease.leaseId}-stale` }))
      .toThrow(/lease fence conflict/);
    expect(target.store.readExecution(target.sessionId, target.execution.execution_id).active_run_id).toBeNull();

    const published = publishPlan(base);
    expect(() => publishPlan({ ...base, reason: 'changed replay audit' }))
      .toThrow(/authority or audit changed/);
    expect(target.store.readExecution(target.sessionId, target.execution.execution_id).revision)
      .toBe(published.execution_revision);
  });

  it('publishes into a current running Session and replays the same Run and artifact', () => {
    const projectRoot = root();
    const store = new SessionStore(projectRoot);
    store.createSession('current', 'Implement approved Plan');
    const path = source(projectRoot);

    const first = publishPlan({
      projectRoot,
      sourcePath: path,
      sessionId: 'current',
      handoffKey: 'handoff-current',
      sourcePiSession: 'pi-session-1',
      planRevision: 3,
      approvedAt: '2026-08-01T12:00:00.000Z',
    });
    const replay = publishPlan({
      projectRoot,
      sourcePath: path,
      sessionId: 'current',
      handoffKey: 'handoff-current',
      sourcePiSession: 'pi-session-1',
      planRevision: 3,
      approvedAt: '2026-08-01T12:00:00.000Z',
    });

    expect(first.created_session).toBe(false);
    expect(first.replayed).toBe(false);
    expect(replay).toMatchObject({
      session_id: first.session_id,
      run_id: first.run_id,
      artifact_id: first.artifact_id,
      replayed: true,
    });
    const bundle = store.readBundle('current');
    expect(bundle.artifacts.aliases['current-plan']).toBe(first.artifact_id);
    expect(Object.keys(bundle.artifacts.artifacts)).toHaveLength(1);
    const run = store.readRun('current', first.run_id);
    expect(run.command.name).toBe('plan-publish');
    expect(run.status).toBe('sealed');
    expect(run.gate_ids.map(id => bundle.gates.gates[id]?.status)).toEqual(['passed', 'passed']);
    expect(bundle.gates.summary.blocked).toBe(0);
    expect(run.handoff).toMatchObject({ verdict: 'ready', concerns: [] });
    const plan = JSON.parse(readFileSync(
      join(store.sessionDir('current'), bundle.artifacts.artifacts[first.artifact_id].relative_path),
      'utf8',
    ));
    expect(plan).toMatchObject({
      _meta: { kind: 'plan', schema: 'plan/1.0', alias: 'current-plan', role: 'primary' },
      source_format: 'pi-markdown',
      handoff_key: 'handoff-current',
      source_pi_session: 'pi-session-1',
      revision: 3,
      approved_at: '2026-08-01T12:00:00.000Z',
      markdown: '# Approved\n\nShip it.\n',
    });
    expect(plan.source_checksum).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it('rejects changed approved bytes on replay', () => {
    const projectRoot = root();
    const store = new SessionStore(projectRoot);
    store.createSession('current', 'Implement approved Plan');
    const path = source(projectRoot);
    publishPlan({ projectRoot, sourcePath: path, sessionId: 'current', handoffKey: 'handoff-fence' });
    writeFileSync(path, '# Changed after approval\n', 'utf8');

    expect(() => publishPlan({
      projectRoot,
      sourcePath: path,
      sessionId: 'current',
      handoffKey: 'handoff-fence',
    })).toThrow(/source bytes changed/);
    expect(Object.keys(store.readBundle('current').artifacts.artifacts)).toHaveLength(1);
  });

  it('recovers the matching dangling publisher Run after interruption', () => {
    const projectRoot = root();
    const store = new SessionStore(projectRoot);
    store.createSession('current', 'Implement approved Plan');
    const options = {
      projectRoot,
      sourcePath: source(projectRoot),
      sessionId: 'current',
      handoffKey: 'handoff-dangling',
    };
    expect(() => publishPlan(options, {
      afterRunCreated() { throw new Error('simulated interruption'); },
    })).toThrow(/simulated interruption/);
    const danglingRunId = store.readBundle('current').session.active_run_id;
    expect(danglingRunId).not.toBeNull();

    const recovered = publishPlan(options);
    expect(recovered.run_id).toBe(danglingRunId);
    expect(recovered.replayed).toBe(false);
    expect(store.readBundle('current').session.active_run_id).toBeNull();
  });

  it('supersedes the previous alias owner and makes the Plan REUSE-eligible for execute', () => {
    const projectRoot = root();
    writeKnownSchemaExecuteContract(projectRoot);
    const store = new SessionStore(projectRoot);
    store.createSession('current', 'Implement approved Plan');
    const path = source(projectRoot);
    const first = publishPlan({ projectRoot, sourcePath: path, sessionId: 'current', handoffKey: 'handoff-old' });
    writeFileSync(path, '# Revised approved Plan\n', 'utf8');
    const second = publishPlan({ projectRoot, sourcePath: path, sessionId: 'current', handoffKey: 'handoff-new' });
    const bundle = store.readBundle('current');
    expect(bundle.artifacts.artifacts[first.artifact_id].status).toBe('superseded');
    expect(bundle.artifacts.artifacts[second.artifact_id].replaces).toBe(first.artifact_id);
    expect(bundle.artifacts.aliases['current-plan']).toBe(second.artifact_id);

    writeFileSync(path, '# Approved\n\nShip it.\n', 'utf8');
    const historicalReplay = publishPlan({
      projectRoot,
      sourcePath: path,
      sessionId: 'current',
      handoffKey: 'handoff-old',
    });
    expect(historicalReplay).toMatchObject({
      run_id: first.run_id,
      artifact_id: first.artifact_id,
      replayed: true,
    });
    expect(store.readBundle('current').artifacts.aliases['current-plan']).toBe(second.artifact_id);
    expect(store.readBundle('current').artifacts.artifacts[first.artifact_id].status).toBe('superseded');
    writeFileSync(path, '# Revised approved Plan\n', 'utf8');

    const execute = createRun({ projectRoot, command: 'execute', sessionId: 'current', intent: 'Execute approved Plan' });
    const run = store.readRun('current', execute.run_id);
    expect(run.input.consumes).toContain(second.artifact_id);
    expect(run.input.reuse_assessments).toEqual(expect.arrayContaining([
      expect.objectContaining({ decision: 'REUSE', source_fence: expect.objectContaining({ artifact_id: second.artifact_id }) }),
    ]));
    const replayAfterExecuteStarted = publishPlan({
      projectRoot,
      sourcePath: path,
      sessionId: 'current',
      handoffKey: 'handoff-new',
    });
    expect(replayAfterExecuteStarted).toMatchObject({
      session_id: 'current',
      run_id: second.run_id,
      artifact_id: second.artifact_id,
      replayed: true,
    });
    expect(store.readBundle('current').session.active_run_id).toBe(execute.run_id);
  });

  it('rejects partial lease claims before allocating a publisher Run', () => {
    const projectRoot = root();
    const store = new SessionStore(projectRoot);
    store.createSession('current', 'Implement approved Plan');
    expect(() => publishPlan({
      projectRoot,
      sourcePath: source(projectRoot),
      sessionId: 'current',
      handoffKey: 'handoff-partial-lease',
      executionOwner: 'pi-session',
    })).toThrow(/requires --execution-owner, --owner-epoch, and --lease-id together/);
    expect(store.readBundle('current').session.active_run_id).toBeNull();
    expect(() => publishPlan({
      projectRoot,
      sourcePath: source(projectRoot),
      sessionId: 'current',
      handoffKey: 'handoff-unleased-claim',
      executionOwner: 'pi-session',
      ownerEpoch: 1,
      leaseId: 'lease-1',
    })).toThrow(/has no active lease to verify/);
    expect(store.readBundle('current').session.active_run_id).toBeNull();
    store.update('current', (draft) => {
      draft.session.orchestration.lease = { owner: 'pi-session', epoch: 1, id: 'lease-1' };
    });
    const leased = publishPlan({
      projectRoot,
      sourcePath: source(projectRoot),
      sessionId: 'current',
      handoffKey: 'handoff-leased-claim',
      executionOwner: 'pi-session',
      ownerEpoch: 1,
      leaseId: 'lease-1',
    });
    expect(leased.artifact_id).toMatch(/^ART-/);
  });

  it('reads an approved Plan from an explicit external containment root', () => {
    const projectRoot = root();
    const sourceRoot = root();
    const external = source(sourceRoot, '# Plan stored under Pi workspace\n');
    const result = publishPlan({
      projectRoot,
      sourceRoot,
      sourcePath: external,
      handoffKey: 'handoff-external-root',
      intent: 'External approved Plan',
    });
    expect(result.created_session).toBe(true);
    expect(result.source_checksum).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it('creates a manual execute to verify Session when no Session is supplied', () => {
    const projectRoot = root();
    writeKnownSchemaExecuteContract(projectRoot);
    const result = publishPlan({
      projectRoot,
      sourcePath: source(projectRoot),
      handoffKey: 'handoff-new',
      intent: 'Implement the approved migration',
      topic: 'Migration rollout',
    });

    expect(result.created_session).toBe(true);
    const session = new SessionStore(projectRoot).readBundle(result.session_id).session;
    expect(session).toMatchObject({
      intent: 'Implement the approved migration',
      status: 'running',
      active_run_id: null,
      orchestration: { engine: 'manual' },
    });
    expect(session.topic_identity?.verbatim).toBe('Migration rollout');
    expect(session.orchestration.chain.map(step => step.command)).toEqual(['execute', 'verify']);
    expect(session.orchestration.chain.map(step => step.status)).toEqual(['pending', 'pending']);

    const execute = runNextStep(projectRoot, { sessionId: result.session_id, inlineBrief: true });
    expect(execute.exitCode).toBe(0);
    expect(execute.result).not.toBeNull();
    const allocated = execute.result!;
    expect(allocated.step.command).toBe('execute');
    expect(allocated.reuse_assessments).toEqual(expect.arrayContaining([
      expect.objectContaining({ decision: 'REUSE', source_fence: expect.objectContaining({ artifact_id: result.artifact_id }) }),
    ]));
    const executeWorkflow = readFileSync(join(process.cwd(), 'workflows', 'execute.md'), 'utf8');
    expect(executeWorkflow).toContain('source_format: pi-markdown');
    expect(executeWorkflow).toContain('normalizedPlan');
    const verifyWorkflow = readFileSync(join(process.cwd(), 'workflows', 'verify.md'), 'utf8');
    expect(verifyWorkflow).toContain('current-plan.source_format == "pi-markdown"');
    expect(verifyWorkflow).toContain('normalizedContract.criteria');
  });

  it('rejects a current Session with an unrelated active Run', () => {
    const projectRoot = root();
    writeFileSync(join(projectRoot, 'prepare', 'unrelated.md'), `---
name: unrelated
session-mode: run
contract:
  contract_version: 2.1
  arguments: []
  consumes: []
  produces: []
  gates: { entry: [], exit: [] }
---
`, 'utf8');
    const active = createRun({
      projectRoot,
      command: 'unrelated',
      sessionId: 'busy',
      intent: 'Busy Session',
    });

    expect(() => publishPlan({
      projectRoot,
      sourcePath: source(projectRoot),
      sessionId: 'busy',
      handoffKey: 'handoff-busy',
    })).toThrow(new RegExp(`unrelated active Run ${active.run_id}`));
    expect(new SessionStore(projectRoot).readBundle('busy').session.active_run_id).toBe(active.run_id);
  });
});
