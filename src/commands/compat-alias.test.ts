import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { pauseExecution, startExecution } from '../run/execution.js';
import { runResponseSchema, runResponseV10Schema, runResponseV11Schema } from '../run/protocol-schemas.js';
import { SessionStore } from '../run/store.js';
import { registerRunCommand } from './run.js';
import { registerSessionCommand } from './session.js';

function v2Workspace(root: string): void {
  mkdirSync(join(root, ".workflow"), { recursive: true });
  writeFileSync(join(root, ".workflow", "config.json"), JSON.stringify({
    session_schema: { schema_version: "session-schema-selection/1.0", writer: "session/1.3", features: { session_statusless: false } },
  }));
}

let root: string;
let stdout: string[];
let stderr: string[];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'maestro-compat-alias-'));
  v2Workspace(root);
  stdout = [];
  stderr = [];
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
    stdout.push(String(chunk));
    return true;
  }) as typeof process.stdout.write);
  vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => {
    stderr.push(String(chunk));
    return true;
  }) as typeof process.stderr.write);
  vi.spyOn(console, 'log').mockImplementation((value: unknown) => { stdout.push(`${String(value)}\n`); });
  vi.spyOn(console, 'error').mockImplementation((value: unknown) => { stderr.push(`${String(value)}\n`); });
  process.exitCode = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  rmSync(root, { recursive: true, force: true });
});

function enableV20(): void {
  mkdirSync(join(root, '.workflow'), { recursive: true });
  writeFileSync(join(root, '.workflow', 'config.json'), JSON.stringify({
    session_schema: {
      schema_version: 'session-schema-selection/1.0',
      writer: 'session/2.0',
      features: { session_statusless: true },
    },
  }));
}

function commandProgram(register: (program: Command) => void): Command {
  const value = new Command();
  value.exitOverride();
  value.configureOutput({ writeOut: () => undefined, writeErr: () => undefined });
  register(value);
  return value;
}

async function invoke(kind: 'session' | 'run', ...args: string[]): Promise<ReturnType<typeof runResponseSchema.parse>> {
  stdout = [];
  stderr = [];
  process.exitCode = undefined;
  const register = kind === 'session' ? registerSessionCommand : registerRunCommand;
  await commandProgram(register).parseAsync(['node', 'maestro', kind, ...args, '--workflow-root', root]);
  expect(stderr).toEqual([]);
  expect(stdout).toHaveLength(1);
  return runResponseSchema.parse(JSON.parse(stdout[0]));
}

function installDemoCommand(): void {
  mkdirSync(join(root, '.claude', 'commands'), { recursive: true });
  mkdirSync(join(root, 'workflows'), { recursive: true });
  writeFileSync(
    join(root, '.claude', 'commands', 'demo.md'),
    '<contract>\nconsumes: []\nproduces: []\ngates:\n  entry: []\n  exit: []\n</contract>\n',
  );
  writeFileSync(join(root, 'workflows', 'demo.md'), '# Demo\n');
}

function createChainSession(sessionId: string, statusless: boolean): SessionStore {
  if (statusless) enableV20();
  const store = new SessionStore(root);
  store.createSession(sessionId, `${sessionId} intent`);
  store.update(sessionId, draft => {
    draft.session.orchestration.chain.push({
      step_id: 'step-1', command: 'demo', status: 'pending', run_id: null,
      inserted_by: 'test', decision_ref: null,
    });
  });
  return store;
}

function executionFenceArgs(started: ReturnType<typeof startExecution>, requestId: string, revision: number): string[] {
  return [
    '--request-id', requestId,
    '--expected-execution-revision', String(revision),
    '--owner-id', started.lease_claim.owner_id,
    '--owner-kind', started.lease_claim.owner_kind,
    '--lease-epoch', String(started.lease_claim.epoch),
    '--lease-id', started.lease_claim.lease_id,
  ];
}

describe('migration plan 8.12 compatibility aliases', () => {
  it('session next auto-resolves current Execution, fences mutation, replays/conflicts, and preserves 1.0 fallback', async () => {
    installDemoCommand();
    const store = createChainSession('next-v20', false);
    const started = startExecution(root, 'next-v20', {
      requestId: 'start-next', ownerId: 'next-owner', ownerKind: 'codex',
    });

    const missing = runResponseV11Schema.parse(await invoke(
      'session', 'next', '--session', 'next-v20', '--json',
    ));
    expect(missing).toMatchObject({
      operation: 'next', ok: false, exit_code: 2,
      error: { code: 'COMMANDER_USAGE' },
      warnings: [{ code: 'DEPRECATED_ALIAS', replacement_command: 'maestro run next' }],
    });
    expect(store.readExecution('next-v20', started.execution.execution_id)).toMatchObject({
      revision: 1, active_run_id: null,
    });

    const args = [
      'next', '--session', 'next-v20',
      ...executionFenceArgs(started, 'alias-next', 1), '--json',
    ];
    const applied = runResponseV11Schema.parse(await invoke('session', ...args));
    expect(applied).toMatchObject({
      operation: 'next', ok: true, replay: { status: 'applied' },
      locator: { session_id: 'next-v20', execution_id: started.execution.execution_id, generation: 1 },
      warnings: [{ code: 'DEPRECATED_ALIAS', replacement_command: 'maestro run next' }],
    });
    const replayed = runResponseV11Schema.parse(await invoke('session', ...args));
    expect(replayed).toMatchObject({
      operation: 'next', ok: true,
      replay: { status: 'replayed', transition_id: applied.replay?.transition_id },
    });
    const conflict = runResponseV11Schema.parse(await invoke('session', ...args.slice(0, -1), '--pick', 'other-step', '--json'));
    expect(conflict).toMatchObject({ operation: 'next', ok: false, error: { code: 'PICK_NOT_FOUND' } });
    expect(store.readExecution('next-v20', started.execution.execution_id).active_run_id).not.toBeNull();

    rmSync(root, { recursive: true, force: true });
    root = mkdtempSync(join(tmpdir(), 'maestro-compat-alias-legacy-'));
    v2Workspace(root);
    installDemoCommand();
    const legacy = createChainSession('next-legacy', false);
    const response = runResponseV10Schema.parse(await invoke(
      'session', 'next', '--session', 'next-legacy', '--json',
    ));
    expect(response).toMatchObject({
      schema_version: 'run-response/1.0', operation: 'next', ok: true,
      locator: { session_id: 'next-legacy' },
    });
    expect(legacy.listExecutions('next-legacy')).toEqual([]);
    expect(legacy.readBundle('next-legacy').session.active_run_id).not.toBeNull();
  });

  it('session done uses canonical Execution completion with replacement, replay, and no-fence protection', async () => {
    installDemoCommand();
    const store = createChainSession('done-v20', false);
    const started = startExecution(root, 'done-v20', {
      requestId: 'start-done', ownerId: 'done-owner', ownerKind: 'codex',
    });
    const next = runResponseV11Schema.parse(await invoke(
      'session', 'next', '--session', 'done-v20',
      ...executionFenceArgs(started, 'done-next', 1), '--json',
    ));
    const runId = (next.result as { run_id: string }).run_id;
    writeFileSync(
      join(store.runDir('done-v20', runId), 'report.md'),
      '---\nverdict: ready\nsummary: complete\nconstraints: []\ndecisions: []\nconcerns: []\nnext: []\n---\n',
    );

    const missing = runResponseV11Schema.parse(await invoke(
      'session', 'done', runId, '--session', 'done-v20', '--json',
    ));
    expect(missing).toMatchObject({
      operation: 'complete', ok: false, exit_code: 2,
      error: { code: 'COMMANDER_USAGE' },
      warnings: [{ code: 'DEPRECATED_ALIAS', replacement_command: 'maestro run complete' }],
    });
    expect(store.readExecutionRun('done-v20', runId).status).toBe('running');

    const args = [
      'done', runId, '--session', 'done-v20',
      ...executionFenceArgs(started, 'alias-done', 2), '--json',
    ];
    const applied = runResponseV11Schema.parse(await invoke('session', ...args));
    const replayed = runResponseV11Schema.parse(await invoke('session', ...args));
    expect(applied).toMatchObject({
      operation: 'complete', ok: true, replay: { status: 'applied' },
      warnings: [{ code: 'DEPRECATED_ALIAS', replacement_command: 'maestro run complete' }],
    });
    expect(replayed.replay).toEqual({ status: 'replayed', transition_id: applied.replay?.transition_id });
  });

  it.each([
    { kind: 'run' as const, command: ['start', 'alias start', '--cmd', 'demo'], replacement: 'maestro run create' },
    { kind: 'session' as const, command: ['start', 'alias start', '--session', 'start-v20', '--chain', 'demo'], replacement: 'maestro run create' },
  ])('$kind start uses current Execution and never falls back on a missing fence', async ({ kind, command, replacement }) => {
    installDemoCommand();
    enableV20();
    const store = new SessionStore(root);
    store.createSession('start-v20', 'start alias');
    const started = startExecution(root, 'start-v20', {
      requestId: 'start-generation', ownerId: 'start-owner', ownerKind: 'codex',
    });
    const fullCommand = kind === 'run' ? [...command, '--session', 'start-v20'] : command;

    const missing = runResponseV11Schema.parse(await invoke(kind, ...fullCommand, '--json'));
    expect(missing).toMatchObject({
      ok: false, exit_code: 2, error: { code: 'COMMANDER_USAGE' },
      warnings: [{ code: 'DEPRECATED_ALIAS', replacement_command: replacement }],
    });
    expect(store.readExecution('start-v20', started.execution.execution_id).active_run_id).toBeNull();

    const args = [
      ...fullCommand,
      ...executionFenceArgs(started, `${kind}-start-create`, 1), '--json',
    ];
    const applied = runResponseV11Schema.parse(await invoke(kind, ...args));
    const replayed = runResponseV11Schema.parse(await invoke(kind, ...args));
    expect(applied).toMatchObject({
      operation: 'create', ok: true, replay: { status: 'applied' },
      warnings: [{ code: 'DEPRECATED_ALIAS', replacement_command: replacement }],
    });
    expect(replayed.replay).toEqual({ status: 'replayed', transition_id: applied.replay?.transition_id });
    expect(store.readExecution('start-v20', started.execution.execution_id).active_run_id).not.toBeNull();
  });

  it.each([
    { kind: 'run' as const, args: ['start', 'fresh start', '--cmd', 'demo', '--id', 'fresh-run'] },
    { kind: 'session' as const, args: ['start', 'fresh start', '--chain', 'demo', '--id', 'fresh-session'] },
  ])('$kind start creates a fresh statusless identity before canonical Execution start', async ({ kind, args }) => {
    installDemoCommand();
    enableV20();
    const response = runResponseV11Schema.parse(await invoke(
      kind, ...args,
      '--request-id', `${kind}-fresh-start`, '--expected-identity-revision', '1',
      '--expected-activity-revision', '0', '--expected-lease-epoch', '0',
      '--owner-id', `${kind}-owner`, '--owner-kind', 'codex',
      '--actor', `${kind}-owner`, '--reason', 'fresh statusless start',
      '--evidence', `test/${kind}-fresh-start`, '--json',
    ));
    expect(response).toMatchObject({
      operation: 'execution-start', ok: true, replay: { status: 'applied' },
      locator: { generation: 1, run_id: expect.any(String) },
      warnings: [{ code: 'DEPRECATED_ALIAS', replacement_command: 'maestro execution start' }],
    });
    const store = new SessionStore(root);
    const record = store.readSessionRecord(response.locator!.session_id!);
    expect(record).toMatchObject({
      schema_version: 'session/2.0', current_execution_id: response.locator!.execution_id,
    });
    expect(store.readExecution(response.locator!.session_id!, response.locator!.execution_id!))
      .toMatchObject({ revision: 2, active_run_id: response.locator!.run_id });
  });

  it('run recover preserves the resolve/resume phases and emits exact replacements', async () => {
    const store = new SessionStore(root);
    store.createSession('recover-v20', 'recover alias');
    store.update('recover-v20', draft => {
      draft.session.orchestration.chain.push({
        step_id: 'failed-step', command: 'demo', status: 'failed', run_id: null,
        inserted_by: 'test', decision_ref: null,
      });
    });
    const started = startExecution(root, 'recover-v20', {
      requestId: 'start-recover', ownerId: 'recover-owner', ownerKind: 'codex',
    });
    pauseExecution(root, {
      sessionId: 'recover-v20', executionId: started.execution.execution_id,
      requestId: 'pause-recover', expectedExecutionRevision: 1,
      lease: {
        ownerId: started.lease_claim.owner_id, ownerKind: started.lease_claim.owner_kind,
        epoch: started.lease_claim.epoch, leaseId: started.lease_claim.lease_id,
      },
      actor: 'operator', reason: 'prepare recovery', evidence: ['test/pause'],
    });
    const session = store.readBundle('recover-v20').session;
    const common = [
      '--session', 'recover-v20', '--actor', 'operator', '--reason', 'recover alias',
      '--evidence', 'test/recover', '--expected-identity-revision', String(session.identity_revision),
      '--expected-activity-revision', String(session.activity_revision), '--json',
    ];

    const resolved = runResponseV11Schema.parse(await invoke(
      'run', 'recover', ...common, '--request-id', 'alias-resolve',
      '--expected-execution-revision', '2', '--step', 'failed-step', '--disposition', 'skip',
    ));
    expect(resolved).toMatchObject({
      operation: 'execution-resolve', ok: true, replay: { status: 'applied' },
      warnings: [{ code: 'DEPRECATED_ALIAS', replacement_command: 'maestro execution resolve' }],
    });

    const afterResolve = store.readBundle('recover-v20').session;
    const resumed = runResponseV11Schema.parse(await invoke(
      'run', 'recover', '--session', 'recover-v20', '--request-id', 'alias-resume',
      '--actor', 'operator', '--reason', 'resume alias', '--evidence', 'test/resume',
      '--expected-identity-revision', String(afterResolve.identity_revision),
      '--expected-activity-revision', String(afterResolve.activity_revision),
      '--expected-execution-revision', '3', '--expected-lease-epoch', '1',
      '--owner-id', 'new-owner', '--owner-kind', 'codex', '--resume', '--json',
    ));
    expect(resumed).toMatchObject({
      operation: 'execution-resume', ok: true, replay: { status: 'applied' },
      warnings: [{ code: 'DEPRECATED_ALIAS', replacement_command: 'maestro execution resume' }],
    });
  });

  it('session resolve/resume auto-resolve the paused Execution and retain canonical audit fences', async () => {
    const store = new SessionStore(root);
    store.createSession('session-recover', 'session recover alias');
    store.update('session-recover', draft => {
      draft.session.orchestration.chain.push({
        step_id: 'failed-step', command: 'demo', status: 'failed', run_id: null,
        inserted_by: 'test', decision_ref: null,
      });
    });
    const started = startExecution(root, 'session-recover', {
      requestId: 'session-recover-start', ownerId: 'session-owner', ownerKind: 'codex',
    });
    pauseExecution(root, {
      sessionId: 'session-recover', executionId: started.execution.execution_id,
      requestId: 'session-recover-pause', expectedExecutionRevision: 1,
      lease: {
        ownerId: started.lease_claim.owner_id, ownerKind: started.lease_claim.owner_kind,
        epoch: started.lease_claim.epoch, leaseId: started.lease_claim.lease_id,
      },
      actor: 'operator', reason: 'pause for alias', evidence: ['test/session-pause'],
    });
    const paused = store.readBundle('session-recover').session;
    const resolved = runResponseV11Schema.parse(await invoke(
      'session', 'resolve', '--session', 'session-recover', '--request-id', 'session-alias-resolve',
      '--actor', 'operator', '--reason', 'resolve through alias', '--evidence', 'test/session-resolve',
      '--expected-identity-revision', String(paused.identity_revision),
      '--expected-activity-revision', String(paused.activity_revision),
      '--expected-execution-revision', '2', '--step', 'failed-step', '--disposition', 'skip', '--json',
    ));
    expect(resolved).toMatchObject({
      operation: 'execution-resolve', ok: true, replay: { status: 'applied' },
      warnings: [{ code: 'DEPRECATED_ALIAS', replacement_command: 'maestro execution resolve' }],
    });
    const resolvedSession = store.readBundle('session-recover').session;
    const resumed = runResponseV11Schema.parse(await invoke(
      'session', 'resume', '--session', 'session-recover', '--request-id', 'session-alias-resume',
      '--actor', 'operator', '--reason', 'resume through alias', '--evidence', 'test/session-resume',
      '--expected-identity-revision', String(resolvedSession.identity_revision),
      '--expected-activity-revision', String(resolvedSession.activity_revision),
      '--expected-execution-revision', '3', '--expected-lease-epoch', '1',
      '--owner-id', 'session-owner-2', '--owner-kind', 'codex', '--json',
    ));
    expect(resumed).toMatchObject({
      operation: 'execution-resume', ok: true, replay: { status: 'applied' },
      warnings: [{ code: 'DEPRECATED_ALIAS', replacement_command: 'maestro execution resume' }],
    });
  });

  it('fails closed when a statusless alias cannot uniquely resolve current Execution authority', async () => {
    enableV20();
    const store = new SessionStore(root);
    for (const id of ['ambiguous-a', 'ambiguous-b']) {
      store.createSession(id, id);
      startExecution(root, id, { requestId: `start-${id}`, ownerId: id, ownerKind: 'codex' });
    }
    const response = runResponseV11Schema.parse(await invoke(
      'session', 'next', '--request-id', 'ambiguous-next', '--expected-execution-revision', '1',
      '--owner-id', 'ambiguous-a', '--owner-kind', 'codex', '--lease-epoch', '1',
      '--lease-id', 'redacted-not-authority', '--json',
    ));
    expect(response).toMatchObject({
      operation: 'next', ok: false,
      error: { code: 'EXECUTION_ALREADY_ACTIVE', message: expect.stringContaining('ambiguous across Sessions') },
      warnings: [{ code: 'DEPRECATED_ALIAS', replacement_command: 'maestro run next' }],
    });
    for (const id of ['ambiguous-a', 'ambiguous-b']) {
      expect(store.readOpenExecution(id)).toMatchObject({ revision: 1, active_run_id: null });
    }
  });

  it('session create --chain starts a fenced Execution and reports its composite replacement', async () => {
    installDemoCommand();
    enableV20();
    const missing = runResponseV11Schema.parse(await invoke(
      'session', 'create', 'chain alias', '--id', 'chain-alias', '--chain', 'demo', '--json',
    ));
    expect(missing).toMatchObject({
      operation: 'execution-start', ok: false, exit_code: 2,
      error: { code: 'COMMANDER_USAGE' },
      warnings: [{
        code: 'DEPRECATED_ALIAS',
        replacement_command: 'maestro session create + maestro execution start',
      }],
    });
    expect(new SessionStore(root).listSessionsReadOnly().candidates).toEqual([]);

    const unsupportedV20 = runResponseV11Schema.parse(await invoke(
      'session', 'create', 'chain alias', '--id', 'chain-alias', '--chain', 'demo',
      '--request-id', 'create-chain-alias', '--expected-identity-revision', '1',
      '--expected-activity-revision', '0', '--expected-lease-epoch', '0',
      '--owner-id', 'chain-owner', '--owner-kind', 'codex',
      '--actor', 'chain-owner', '--reason', 'create chain alias', '--evidence', 'test/create-chain', '--json',
    ));
    expect(unsupportedV20).toMatchObject({
      operation: 'execution-start', ok: false, exit_code: 2,
      error: { code: 'COMMANDER_USAGE', message: expect.stringContaining('canonical Execution chain operation') },
    });
    expect(new SessionStore(root).listSessionsReadOnly().candidates).toEqual([]);

    rmSync(root, { recursive: true, force: true });
    root = mkdtempSync(join(tmpdir(), 'maestro-compat-alias-create-'));
    v2Workspace(root);
    installDemoCommand();
    const response = runResponseV11Schema.parse(await invoke(
      'session', 'create', 'chain alias', '--id', 'chain-alias', '--chain', 'demo',
      '--request-id', 'create-chain-alias', '--expected-identity-revision', '1',
      '--expected-activity-revision', '0', '--expected-lease-epoch', '0',
      '--owner-id', 'chain-owner', '--owner-kind', 'codex',
      '--actor', 'chain-owner', '--reason', 'create chain alias', '--evidence', 'test/create-chain', '--json',
    ));
    expect(response).toMatchObject({
      operation: 'execution-start', ok: true, replay: { status: 'applied' },
      warnings: [{
        code: 'DEPRECATED_ALIAS',
        replacement_command: 'maestro session create + maestro execution start',
      }],
    });
    const sessionId = response.locator?.session_id as string;
    expect(new SessionStore(root).readExecution(sessionId, response.locator!.execution_id!)).toMatchObject({
      generation: 1, status: 'active', revision: 1,
    });
  });
});
