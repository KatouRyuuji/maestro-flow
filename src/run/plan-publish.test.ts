import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { runNextStep } from './next.js';
import { publishPlan } from './plan-publish.js';
import { createRun } from './runtime.js';
import { SessionStore } from './store.js';

const roots: string[] = [];

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'maestro-plan-publish-'));
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

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('canonical Pi Plan publisher', () => {
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
