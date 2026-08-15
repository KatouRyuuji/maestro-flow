import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command, CommanderError } from 'commander';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { maestroCapabilitiesSchema, runResponseV11Schema } from '../run/protocol-schemas.js';
import { SessionStore } from '../run/store.js';
import { emitExecutionError, sanitizeCommanderError } from './execution-cli-shared.js';
import { registerCapabilitiesCommand } from './capabilities.js';
import { registerRunCommand } from './run.js';
import { registerExecutionCommand } from './execution.js';

function v2Workspace(root: string): void {
  mkdirSync(join(root, ".workflow"), { recursive: true });
  writeFileSync(join(root, ".workflow", "config.json"), JSON.stringify({
    session_schema: { schema_version: "session-schema-selection/1.0", writer: "session/1.3", features: { session_statusless: false } },
  }));
}

let root: string;
let stdout: string[];
let logs: string[];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'maestro-execution-cli-'));
  v2Workspace(root);
  stdout = [];
  logs = [];
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
    stdout.push(String(chunk));
    return true;
  }) as typeof process.stdout.write);
  vi.spyOn(console, 'log').mockImplementation((value: unknown) => { logs.push(String(value)); });
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  process.exitCode = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  rmSync(root, { recursive: true, force: true });
});

function executionProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeOut: () => undefined, writeErr: () => undefined });
  registerExecutionCommand(program);
  return program;
}

function runProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeOut: () => undefined, writeErr: () => undefined });
  registerRunCommand(program);
  return program;
}

async function invokeExecution(...args: string[]): Promise<ReturnType<typeof runResponseV11Schema.parse>> {
  stdout = [];
  await executionProgram().parseAsync(['node', 'maestro', 'execution', ...args, '--workflow-root', root]);
  expect(stdout).toHaveLength(1);
  return runResponseV11Schema.parse(JSON.parse(stdout[0]));
}

describe('maestro capabilities', () => {
  async function capabilities(workflowRoot: string) {
    stdout = [];
    const program = new Command();
    program.exitOverride();
    registerCapabilitiesCommand(program);
    await program.parseAsync(['node', 'maestro', 'capabilities', '--json', '--workflow-root', workflowRoot]);
    expect(stdout).toHaveLength(1);
    return maestroCapabilitiesSchema.parse(JSON.parse(stdout[0]));
  }

  it('advertises the existing v2 mutation protocol for non-v3 workspaces', async () => {
    expect(await capabilities(root)).toEqual({
      schema_version: 'maestro-capabilities/1.0',
      cli_version: expect.any(String),
      session_schema_writes: ['session/1.3'],
      execution_schema_writes: ['execution/1.0'],
      run_response_writes: ['run-response/1.0', 'run-response/1.1', 'run-response/1.2'],
      features: {
        execution_generation: true,
        core_execution_lease: true,
        execution_handoff: true,
        session_statusless: true,
        legacy_session_aliases: true,
        session_run_minimal_v3: false,
        entity_revision_cas: false,
        participant_identity: false,
        request_receipts_v2: false,
        execution_lease: true,
        operation_registry: false,
        artifact_compatibility_v1: true,
        atomic_run_complete_seal: true,
        generation_scoped_seal_receipts: true,
      },
    });
  });

  it('advertises the complete minimal v3 protocol only for session/3.0 workspaces', async () => {
    mkdirSync(join(root, '.workflow'), { recursive: true });
    writeFileSync(join(root, '.workflow', 'config.json'), JSON.stringify({
      session_schema: {
        schema_version: 'session-schema-selection/1.0',
        writer: 'session/3.0',
        features: { session_statusless: false },
      },
    }));
    expect(await capabilities(root)).toEqual({
      schema_version: 'maestro-capabilities/1.0',
      cli_version: expect.any(String),
      session_schema_writes: ['session/3.0'],
      execution_schema_writes: [],
      run_response_writes: ['run-response/1.0', 'run-response/1.1', 'run-response/1.2'],
      features: {
        execution_generation: false,
        core_execution_lease: false,
        execution_handoff: false,
        session_statusless: false,
        legacy_session_aliases: false,
        session_run_minimal_v3: true,
        entity_revision_cas: true,
        participant_identity: true,
        request_receipts_v2: true,
        execution_lease: false,
        operation_registry: false,
        artifact_compatibility_v1: true,
        atomic_run_complete_seal: true,
        generation_scoped_seal_receipts: true,
      },
    });
  });
});

describe('maestro execution', () => {
  it('registers the complete Wave 1 command tree', () => {
    const command = executionProgram().commands.find(item => item.name() === 'execution');
    expect(command?.commands.map(item => item.name()).sort()).toEqual([
      'attach', 'handoff', 'lease', 'pause', 'resolve', 'resume', 'seal', 'start', 'status',
    ]);
    expect(command?.commands.find(item => item.name() === 'handoff')?.commands.map(item => item.name()).sort())
      .toEqual(['accept', 'cancel', 'prepare']);
    expect(command?.commands.find(item => item.name() === 'lease')?.commands.map(item => item.name()).sort())
      .toEqual(['heartbeat', 'recover', 'release', 'status']);
  });

  it('redacts malformed secret-bearing Commander input from the 1.1 machine envelope', async () => {
    const secrets = [
      'handoff-secret-rv009',
      join(root, 'private', 'claim-secret-rv009.json'),
      'generic-api-secret-rv009',
    ];
    const argv = [
      'node', 'maestro', 'execution', 'handoff', 'accept',
      '--handoff-token', secrets[0], '--claim-output', secrets[1],
      `--api-key=${secrets[2]}`, '--json', '--workflow-root', root,
    ];
    const stderr: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      stderr.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);

    let commanderError: CommanderError | null = null;
    try {
      await executionProgram().parseAsync(argv);
    } catch (error) {
      expect(error).toBeInstanceOf(CommanderError);
      commanderError = error as CommanderError;
    }
    expect(commanderError).not.toBeNull();
    const sanitized = sanitizeCommanderError(commanderError!, argv.slice(2));
    emitExecutionError({
      operation: 'execution-handoff-accept',
      error: new Error(sanitized.message),
      projectRoot: root,
      exitCode: 2,
      disposition: 'usage_error',
      code: 'COMMANDER_USAGE',
      details: sanitized.details,
    });

    expect(stdout).toHaveLength(1);
    expect(stderr).toEqual([]);
    const response = runResponseV11Schema.parse(JSON.parse(stdout[0]));
    expect(response).toMatchObject({
      schema_version: 'run-response/1.1', ok: false, exit_code: 2,
      error: { code: 'COMMANDER_USAGE', details: { commander_code: expect.any(String) } },
    });
    expect((response.error as any).details).not.toHaveProperty('argv');
    const emitted = `${stdout.join('')}\n${stderr.join('')}`;
    for (const secret of secrets) expect(emitted).not.toContain(secret);
  });

  it('emits fenced 1.1 lifecycle responses and only acquisition results expose a raw token', async () => {
    new SessionStore(root).createSession('s', 'execution cli');
    const started = await invokeExecution(
      'start', '--session', 's', '--request-id', 'req-start',
      '--expected-identity-revision', '1', '--expected-activity-revision', '0',
      '--execution-owner', 'pi-1', '--owner-kind', 'pi', '--expected-lease-epoch', '0',
      '--actor', 'pi-1', '--reason', 'start generation', '--evidence', 'TEST-start', '--json',
    );
    expect(started).toMatchObject({
      schema_version: 'run-response/1.1', operation: 'execution-start', ok: true,
      locator: { session_id: 's', execution_id: 'execution-001', generation: 1, run_id: null },
      fence: { execution_revision: 1, lease_epoch: 1 },
      replay: { status: 'applied' },
      result: { lease_claim: { owner_id: 'pi-1', owner_kind: 'pi', epoch: 1, lease_id: expect.any(String) } },
    });
    const firstClaim = (started.result as any).lease_claim;

    const heartbeat = await invokeExecution(
      'lease', 'heartbeat', '--session', 's', '--execution', 'execution-001',
      '--request-id', 'req-heartbeat', '--expected-execution-revision', '1',
      '--execution-owner', firstClaim.owner_id, '--owner-kind', firstClaim.owner_kind,
      '--owner-epoch', String(firstClaim.epoch), '--lease-id', firstClaim.lease_id, '--json',
    );
    expect(heartbeat).toMatchObject({
      operation: 'execution-lease-heartbeat', ok: true,
      fence: { execution_revision: 1, lease_epoch: 1 }, replay: { status: 'applied' },
    });
    expect(JSON.stringify(heartbeat)).not.toContain(firstClaim.lease_id);

    const pause = await invokeExecution(
      'pause', '--session', 's', '--execution', 'execution-001',
      '--request-id', 'req-pause', '--expected-execution-revision', '1',
      '--execution-owner', firstClaim.owner_id, '--owner-kind', firstClaim.owner_kind,
      '--owner-epoch', '1', '--lease-id', firstClaim.lease_id,
      '--actor', 'pi-1', '--reason', 'pause generation', '--evidence', 'TEST-pause', '--json',
    );
    expect(pause).toMatchObject({
      operation: 'execution-pause', ok: true,
      fence: { execution_revision: 2, lease_epoch: null }, replay: { status: 'applied' },
    });

    const resumed = await invokeExecution(
      'resume', '--session', 's', '--execution', 'execution-001',
      '--request-id', 'req-resume', '--expected-execution-revision', '2',
      '--expected-activity-revision', '2', '--expected-lease-epoch', '1',
      '--owner-id', 'pi-2', '--owner-kind', 'pi',
      '--actor', 'pi-2', '--reason', 'resume generation', '--evidence', 'TEST-resume', '--json',
    );
    const resumedClaim = (resumed.result as any).lease_claim;
    expect(resumed).toMatchObject({
      operation: 'execution-resume', ok: true,
      fence: { execution_revision: 3, lease_epoch: 2 },
      result: { lease_claim: { owner_id: 'pi-2', epoch: 2, lease_id: expect.any(String) } },
    });

    const sealed = await invokeExecution(
      'seal', '--session', 's', '--execution', 'execution-001',
      '--request-id', 'req-seal', '--expected-execution-revision', '3',
      '--expected-activity-revision', '3',
      '--execution-owner', resumedClaim.owner_id, '--owner-kind', resumedClaim.owner_kind,
      '--owner-epoch', String(resumedClaim.epoch), '--lease-id', resumedClaim.lease_id,
      '--actor', 'pi-2', '--reason', 'seal generation', '--evidence', 'TEST-seal',
      '--outcome', 'done', '--summary', 'generation done', '--json',
    );
    expect(sealed).toMatchObject({
      operation: 'execution-seal', ok: true,
      fence: { execution_revision: 4, lease_epoch: null },
      result: { execution: { status: 'sealed' } },
    });
    expect(JSON.stringify(sealed)).not.toContain(resumedClaim.lease_id);

    const session = new SessionStore(root).readBundle('s').session;
    expect(session.schema_version).toBe('session/1.3');
    expect(session.status).toBe('running');
    expect(session.lifecycle.sealed_at).toBeNull();
  });

  it('writes human acquisition claims privately and redacts them from stdout', async () => {
    new SessionStore(root).createSession('claim', 'claim output');
    const claimPath = join(root, 'private', 'lease.json');
    await executionProgram().parseAsync([
      'node', 'maestro', 'execution', 'start', '--session', 'claim', '--request-id', 'req-claim',
      '--expected-identity-revision', '1', '--expected-activity-revision', '0',
      '--execution-owner', 'manual-owner', '--owner-kind', 'manual', '--expected-lease-epoch', '0',
      '--actor', 'manual-owner', '--reason', 'start generation', '--evidence', 'TEST-claim',
      '--claim-output', claimPath,
      '--workflow-root', root,
    ]);

    expect(logs).toHaveLength(1);
    expect(JSON.parse(logs[0])).toMatchObject({ lease_claim: null, claim_output: claimPath });
    const persisted = JSON.parse(readFileSync(claimPath, 'utf8'));
    expect(persisted).toMatchObject({ owner_id: 'manual-owner', owner_kind: 'manual', lease_id: expect.any(String) });
    expect(logs[0]).not.toContain(persisted.lease_id);
    if (process.platform !== 'win32') {
      expect(statSync(join(root, 'private')).mode & 0o777).toBe(0o700);
      expect(statSync(claimPath).mode & 0o777).toBe(0o600);
    }
  });

  it('uses a private exclusive default claim file and refuses existing or symlink targets', async () => {
    new SessionStore(root).createSession('default-claim', 'default claim output');
    await executionProgram().parseAsync([
      'node', 'maestro', 'execution', 'start', '--session', 'default-claim', '--request-id', 'req-default-claim',
      '--expected-identity-revision', '1', '--expected-activity-revision', '0',
      '--execution-owner', 'manual-owner', '--owner-kind', 'manual', '--expected-lease-epoch', '0',
      '--actor', 'manual-owner', '--reason', 'start generation', '--evidence', 'TEST-default-claim',
      '--workflow-root', root,
    ]);
    const projected = JSON.parse(logs[0]) as { claim_output: string; lease_claim: null };
    const persisted = JSON.parse(readFileSync(projected.claim_output, 'utf8')) as { lease_id: string };
    expect(projected.lease_claim).toBeNull();
    expect(logs[0]).not.toContain(persisted.lease_id);
    if (process.platform !== 'win32') {
      expect(statSync(join(root, '.workflow', 'tmp', 'claims')).mode & 0o777).toBe(0o700);
      expect(statSync(projected.claim_output).mode & 0o777).toBe(0o600);
    }

    new SessionStore(root).createSession('existing-claim', 'existing claim output');
    const existing = join(root, 'private-existing', 'claim.json');
    mkdirSync(join(root, 'private-existing'), { recursive: true });
    writeFileSync(existing, 'do-not-replace\n');
    logs = [];
    await executionProgram().parseAsync([
      'node', 'maestro', 'execution', 'start', '--session', 'existing-claim', '--request-id', 'req-existing-claim',
      '--expected-identity-revision', '1', '--expected-activity-revision', '0',
      '--execution-owner', 'manual-owner', '--owner-kind', 'manual', '--expected-lease-epoch', '0',
      '--actor', 'manual-owner', '--reason', 'start generation', '--evidence', 'TEST-existing-claim',
      '--claim-output', existing, '--workflow-root', root,
    ]);
    expect(process.exitCode).toBe(1);
    expect(logs).toEqual([]);
    expect(readFileSync(existing, 'utf8')).toBe('do-not-replace\n');

    if (process.platform !== 'win32') {
      process.exitCode = undefined;
      new SessionStore(root).createSession('symlink-claim', 'symlink claim output');
      const outside = join(root, 'outside-claim.json');
      writeFileSync(outside, 'outside\n');
      const symlinkPath = join(root, 'private-existing', 'symlink.json');
      symlinkSync(outside, symlinkPath);
      await executionProgram().parseAsync([
        'node', 'maestro', 'execution', 'start', '--session', 'symlink-claim', '--request-id', 'req-symlink-claim',
        '--expected-identity-revision', '1', '--expected-activity-revision', '0',
        '--execution-owner', 'manual-owner', '--owner-kind', 'manual', '--expected-lease-epoch', '0',
        '--actor', 'manual-owner', '--reason', 'start generation', '--evidence', 'TEST-symlink-claim',
        '--claim-output', symlinkPath, '--workflow-root', root,
      ]);
      expect(process.exitCode).toBe(1);
      expect(readFileSync(outside, 'utf8')).toBe('outside\n');
    }
  });

  it('normalizes canonical and deprecated owner/epoch aliases in split and equals forms', async () => {
    new SessionStore(root).createSession('aliases', 'alias normalization');
    const started = await invokeExecution(
      'start', '--session=aliases', '--request-id=req-alias-start',
      '--expected-identity-revision=1', '--expected-activity-revision=0',
      '--owner-id=alias-owner', '--owner-kind=pi', '--expected-lease-epoch=0',
      '--actor=alias-owner', '--reason=alias-start', '--evidence=TEST-alias-start', '--json',
    );
    const claim = (started.result as any).lease_claim;
    expect(claim.owner_id).toBe('alias-owner');

    const heartbeat = await invokeExecution(
      'lease', 'heartbeat', '--session', 'aliases', '--execution=execution-001',
      '--request-id=req-alias-heartbeat', '--expected-execution-revision=1',
      '--execution-owner=alias-owner', '--owner-kind=pi', '--lease-epoch=1',
      `--lease-id=${claim.lease_id}`, '--json',
    );
    expect(heartbeat).toMatchObject({ operation: 'execution-lease-heartbeat', ok: true, fence: { lease_epoch: 1 } });
  });

  it('returns typed errors with locator and current fence', async () => {
    new SessionStore(root).createSession('errors', 'typed error');
    const started = await invokeExecution(
      'start', '--session', 'errors', '--request-id', 'req-start-errors',
      '--expected-identity-revision', '1', '--expected-activity-revision', '0',
      '--execution-owner', 'pi-1', '--owner-kind', 'pi', '--expected-lease-epoch', '0',
      '--actor', 'pi-1', '--reason', 'start generation', '--evidence', 'TEST-error', '--json',
    );
    const claim = (started.result as any).lease_claim;
    const failed = await invokeExecution(
      'pause', '--session', 'errors', '--execution', 'execution-001',
      '--request-id', 'req-bad-fence', '--expected-execution-revision', '1',
      '--execution-owner', claim.owner_id, '--owner-kind', claim.owner_kind,
      '--owner-epoch', '1', '--lease-id', `${claim.lease_id}-stale`,
      '--actor', 'pi-1', '--reason', 'pause generation', '--evidence', 'TEST-error-pause', '--json',
    );
    expect(failed).toMatchObject({
      operation: 'execution-pause', ok: false, exit_code: 1, disposition: 'domain_error',
      locator: { session_id: 'errors', execution_id: 'execution-001', generation: 1 },
      fence: { execution_revision: 1, lease_epoch: 1 },
      error: { code: 'LEASE_FENCE_CONFLICT', recovery_command: expect.stringContaining('execution lease status') },
    });
  });
});
