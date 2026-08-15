import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runResponseV11Schema } from '../run/protocol-schemas.js';
import { SessionStore } from '../run/store.js';
import { registerExecutionCommand } from './execution.js';
import { registerRunCommand } from './run.js';

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
  root = mkdtempSync(join(tmpdir(), 'maestro-execution-run-cli-'));
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
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  process.exitCode = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  rmSync(root, { recursive: true, force: true });
});

function program(register: (program: Command) => void): Command {
  const value = new Command();
  value.exitOverride();
  value.configureOutput({ writeOut: () => undefined, writeErr: () => undefined });
  register(value);
  return value;
}

async function invokeExecution(...args: string[]): Promise<ReturnType<typeof runResponseV11Schema.parse>> {
  stdout = [];
  await program(registerExecutionCommand).parseAsync(['node', 'maestro', 'execution', ...args, '--workflow-root', root]);
  return runResponseV11Schema.parse(JSON.parse(stdout[0]));
}

function executionStartArgs(sessionId: string, requestId: string, ownerId: string): string[] {
  const session = new SessionStore(root).readBundle(sessionId).session;
  return [
    'start', '--session', sessionId, '--request-id', requestId,
    '--expected-identity-revision', String(session.identity_revision),
    '--expected-activity-revision', String(session.activity_revision),
    '--execution-owner', ownerId, '--owner-kind', 'pi', '--expected-lease-epoch', '0',
    '--actor', ownerId, '--reason', 'start generation', '--evidence', `TEST-${requestId}`, '--json',
  ];
}

function runProgram(): Command {
  return program(registerRunCommand);
}

describe('execution-aware run mutations', () => {
  it('routes create and complete through command-run/1.4 with 1.1 replay fences', async () => {
    mkdirSync(join(root, '.claude', 'commands'), { recursive: true });
    writeFileSync(join(root, '.claude', 'commands', 'demo.md'), '---\nsession-mode: run\n---\n# Demo\n');
    const store = new SessionStore(root);
    store.createSession('run-exec', 'execution-bound run');
    const started = await invokeExecution(...executionStartArgs('run-exec', 'req-start-run', 'pi-run'));
    const claim = (started.result as any).lease_claim;

    stdout = [];
    const createArgs = [
      'node', 'maestro', 'run', 'create', 'demo', '--session', 'run-exec',
      '--execution', 'execution-001', '--generation', '1', '--request-id', 'req-create-run',
      '--expected-execution-revision', '1', '--owner-id', claim.owner_id,
      '--owner-kind', claim.owner_kind, '--lease-epoch', String(claim.epoch), '--lease-id', claim.lease_id,
      '--json', '--workflow-root', root,
    ];
    await runProgram().parseAsync(createArgs);
    expect(stdout).toHaveLength(1);
    const created = runResponseV11Schema.parse(JSON.parse(stdout[0]));
    expect(created).toMatchObject({
      operation: 'create', ok: true,
      locator: { session_id: 'run-exec', execution_id: 'execution-001', generation: 1 },
      fence: { execution_revision: 2, lease_epoch: 1 },
      replay: { status: 'applied' },
    });
    const runId = (created.result as any).run_id as string;
    expect(store.readExecutionRun('run-exec', runId)).toMatchObject({
      schema_version: 'command-run/1.4', execution_id: 'execution-001', generation: 1,
    });

    stdout = [];
    await runProgram().parseAsync(createArgs);
    const replay = runResponseV11Schema.parse(JSON.parse(stdout[0]));
    expect(replay).toMatchObject({ operation: 'create', replay: { status: 'replayed' } });
    expect(replay.replay?.transition_id).toBe(created.replay?.transition_id);

    stdout = [];
    await runProgram().parseAsync([
      'node', 'maestro', 'run', 'complete', runId, '--session', 'run-exec',
      '--execution', 'execution-001', '--generation', '1', '--request-id', 'req-complete-stale-lease',
      '--expected-execution-revision', '2', '--owner-id', claim.owner_id,
      '--owner-kind', claim.owner_kind, '--lease-epoch', String(claim.epoch), '--lease-id', `${claim.lease_id}-stale`,
      '--json', '--workflow-root', root,
    ]);
    expect(runResponseV11Schema.parse(JSON.parse(stdout[0]))).toMatchObject({
      operation: 'complete', ok: false, exit_code: 1,
      locator: { session_id: 'run-exec', execution_id: 'execution-001', run_id: runId },
      fence: { execution_revision: 2, lease_epoch: 1 },
      error: { code: 'LEASE_FENCE_CONFLICT' },
    });
    expect(store.readExecution('run-exec', 'execution-001')).toMatchObject({
      revision: 2, active_run_id: runId,
    });

    stdout = [];
    await runProgram().parseAsync([
      'node', 'maestro', 'run', 'complete', runId, '--session', 'run-exec',
      '--execution', 'execution-001', '--generation', '1', '--request-id', 'req-complete-run',
      '--expected-execution-revision', '2', '--owner-id', claim.owner_id,
      '--owner-kind', claim.owner_kind, '--lease-epoch', String(claim.epoch), '--lease-id', claim.lease_id,
      '--json', '--workflow-root', root,
    ]);
    const completed = runResponseV11Schema.parse(JSON.parse(stdout[0]));
    expect(completed).toMatchObject({
      operation: 'complete', ok: true,
      locator: { session_id: 'run-exec', execution_id: 'execution-001', generation: 1, run_id: null },
      fence: { execution_revision: 3, lease_epoch: 1 },
      replay: { status: 'applied' },
    });
  });

  it('maps the read-only run status alias with a 1.1 deprecation warning', async () => {
    new SessionStore(root).createSession('run-status-alias', 'run status alias');
    const started = await invokeExecution(
      ...executionStartArgs('run-status-alias', 'req-run-status-start', 'pi-status'),
    );

    stdout = [];
    await runProgram().parseAsync([
      'node', 'maestro', 'run', 'status', 'run-status-alias',
      '--execution', (started.locator as any).execution_id, '--json', '--workflow-root', root,
    ]);
    expect(stdout).toHaveLength(1);
    const response = runResponseV11Schema.parse(JSON.parse(stdout[0]));
    expect(response).toMatchObject({
      operation: 'execution-status', ok: true,
      warnings: [{ code: 'DEPRECATED_ALIAS', replacement_command: 'maestro execution status' }],
    });
    expect(JSON.stringify(response.warnings)).not.toMatch(/token|lease[_-]id|handoff/i);
  });

  it.each([
    { input: 'done_with_concerns', verdict: 'done-with-concerns', executionStatus: 'active', sessionStatus: 'running', stepStatus: 'sealed' },
    { input: 'needs_retry', verdict: 'needs-retry', executionStatus: 'active', sessionStatus: 'running', stepStatus: 'pending' },
    { input: 'blocked', verdict: 'blocked', executionStatus: 'paused', sessionStatus: 'paused', stepStatus: 'failed' },
  ])('normalizes and forwards $verdict completion with replay', async ({
    input, verdict, executionStatus, sessionStatus, stepStatus,
  }) => {
    mkdirSync(join(root, '.claude', 'commands'), { recursive: true });
    mkdirSync(join(root, 'workflows'), { recursive: true });
    writeFileSync(join(root, '.claude', 'commands', 'demo.md'), '<contract>\nconsumes: []\nproduces: []\ngates:\n  entry: []\n  exit: []\n</contract>\n');
    writeFileSync(join(root, 'workflows', 'demo.md'), '# Demo\n');
    const sessionId = `complete-${verdict}`;
    const store = new SessionStore(root);
    store.createSession(sessionId, `${verdict} completion`);
    store.update(sessionId, draft => {
      draft.session.orchestration.chain.push({
        step_id: 'step-1', command: 'demo', status: 'pending', run_id: null,
        inserted_by: 'test', decision_ref: null,
      });
    });
    const started = await invokeExecution(
      ...executionStartArgs(sessionId, `req-start-${verdict}`, `owner-${verdict}`),
    );
    const claim = (started.result as any).lease_claim;

    stdout = [];
    await runProgram().parseAsync([
      'node', 'maestro', 'run', 'next', '--session', sessionId,
      '--execution', 'execution-001', '--generation', '1', '--request-id', `req-next-${verdict}`,
      '--expected-execution-revision', '1', '--owner-id', claim.owner_id,
      '--owner-kind', claim.owner_kind, '--lease-epoch', String(claim.epoch), '--lease-id', claim.lease_id,
      '--json', '--workflow-root', root,
    ]);
    const next = runResponseV11Schema.parse(JSON.parse(stdout[0]));
    const runId = (next.result as any).run_id as string;
    const reportVerdict = verdict === 'done-with-concerns' ? 'ready_with_concerns' : 'failed';
    writeFileSync(
      join(store.runDir(sessionId, runId), 'report.md'),
      `---\nverdict: ${reportVerdict}\nsummary: attempted\nconstraints: []\ndecisions: []\nconcerns: []\nnext: []\n---\n`,
    );
    const completeArgs = [
      'node', 'maestro', 'run', 'complete', runId, '--session', sessionId, '--verdict', input,
      '--execution', 'execution-001', '--generation', '1', '--request-id', `req-complete-${verdict}`,
      '--expected-execution-revision', '2', '--owner-id', claim.owner_id,
      '--owner-kind', claim.owner_kind, '--lease-epoch', String(claim.epoch), '--lease-id', claim.lease_id,
      '--json', '--workflow-root', root,
    ];

    stdout = [];
    await runProgram().parseAsync(completeArgs);
    const completed = runResponseV11Schema.parse(JSON.parse(stdout[0]));
    expect(completed).toMatchObject({
      operation: 'complete', ok: true, replay: { status: 'applied' },
      result: { chain_transition: { step_status: stepStatus } },
    });
    expect(store.readExecutionTransition(
      sessionId, 'execution-001', `req-complete-${verdict}`,
    )?.payload.payload).toMatchObject({ chain_verdict: verdict });
    expect(store.readExecution(sessionId, 'execution-001').status).toBe(executionStatus);
    expect(store.readBundle(sessionId).session).toMatchObject({
      status: sessionStatus,
      orchestration: { chain: [{ status: stepStatus }] },
    });

    stdout = [];
    await runProgram().parseAsync(completeArgs);
    const replayed = runResponseV11Schema.parse(JSON.parse(stdout[0]));
    expect(replayed).toMatchObject({ operation: 'complete', ok: true, replay: { status: 'replayed' } });
    expect(replayed.replay?.transition_id).toBe(completed.replay?.transition_id);
  });

  it('returns a typed 1.1 error for an invalid execution-aware completion verdict', async () => {
    new SessionStore(root).createSession('invalid-verdict', 'invalid verdict');
    const started = await invokeExecution(
      ...executionStartArgs('invalid-verdict', 'req-invalid-start', 'owner-invalid'),
    );
    const claim = (started.result as any).lease_claim;
    stdout = [];
    await runProgram().parseAsync([
      'node', 'maestro', 'run', 'complete', '--session', 'invalid-verdict', '--verdict', 'not-a-verdict',
      '--execution', 'execution-001', '--generation', '1', '--request-id', 'req-invalid-complete',
      '--expected-execution-revision', '1', '--owner-id', claim.owner_id,
      '--owner-kind', claim.owner_kind, '--lease-epoch', String(claim.epoch), '--lease-id', claim.lease_id,
      '--json', '--workflow-root', root,
    ]);
    expect(runResponseV11Schema.parse(JSON.parse(stdout[0]))).toMatchObject({
      operation: 'complete', ok: false, exit_code: 2,
      error: { code: 'INVALID_VERDICT' },
    });
  });

  it('fails lease-id-only authority closed as a 1.1 usage error without legacy mutation', async () => {
    mkdirSync(join(root, '.claude', 'commands'), { recursive: true });
    writeFileSync(join(root, '.claude', 'commands', 'demo.md'), '# Demo\n');
    const store = new SessionStore(root);
    store.createSession('lease-only', 'lease-only authority');
    const secret = 'lease-only-secret-rv007';

    stdout = [];
    stderr = [];
    await runProgram().parseAsync([
      'node', 'maestro', 'run', 'create', 'demo', '--session', 'lease-only',
      '--lease-id', secret, '--json', '--workflow-root', root,
    ]);

    expect(process.exitCode).toBe(2);
    expect(stderr).toEqual([]);
    expect(stdout).toHaveLength(1);
    const response = runResponseV11Schema.parse(JSON.parse(stdout[0]));
    expect(response).toMatchObject({
      operation: 'create', ok: false, exit_code: 2, disposition: 'usage_error',
      error: { code: 'COMMANDER_USAGE' },
    });
    expect(stdout.join('\n')).not.toContain(secret);
    expect(store.readBundle('lease-only').session.active_run_id).toBeNull();
  });

  it('fails partial execution authority as 1.1 COMMANDER_USAGE without falling back', async () => {
    mkdirSync(join(root, '.claude', 'commands'), { recursive: true });
    writeFileSync(join(root, '.claude', 'commands', 'demo.md'), '# Demo\n');
    new SessionStore(root).createSession('partial', 'partial authority');

    stdout = [];
    await runProgram().parseAsync([
      'node', 'maestro', 'run', 'create', 'demo', '--session', 'partial',
      '--execution', 'execution-001', '--request-id', 'req-partial', '--json', '--workflow-root', root,
    ]);
    const response = runResponseV11Schema.parse(JSON.parse(stdout[0]));
    expect(response).toMatchObject({
      operation: 'create', ok: false, exit_code: 2, disposition: 'usage_error',
      error: { code: 'COMMANDER_USAGE' },
    });
    expect(new SessionStore(root).readBundle('partial').session.active_run_id).toBeNull();
  });
});
