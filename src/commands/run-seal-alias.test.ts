import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startExecution } from '../run/execution.js';
import { runResponseV10Schema, runResponseV11Schema } from '../run/protocol-schemas.js';
import { SessionStore } from '../run/store.js';
import { registerRunCommand } from './run.js';

function v2Workspace(root: string): void {
  mkdirSync(join(root, ".workflow"), { recursive: true });
  writeFileSync(join(root, ".workflow", "config.json"), JSON.stringify({
    session_schema: { schema_version: "session-schema-selection/1.0", writer: "session/1.3", features: { session_statusless: false } },
  }));
}

let projectRoot: string;
let stdout: string[];

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'maestro-run-seal-alias-'));
  v2Workspace(projectRoot);
  stdout = [];
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
    stdout.push(String(chunk));
    return true;
  }) as typeof process.stdout.write);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  process.exitCode = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  rmSync(projectRoot, { recursive: true, force: true });
});

function enableSessionV20(): void {
  mkdirSync(join(projectRoot, '.workflow'), { recursive: true });
  writeFileSync(join(projectRoot, '.workflow', 'config.json'), JSON.stringify({
    session_schema: {
      schema_version: 'session-schema-selection/1.0',
      writer: 'session/2.0',
      features: { session_statusless: true },
    },
  }));
}

function program(): Command {
  const value = new Command();
  value.exitOverride();
  value.configureOutput({ writeOut: () => undefined, writeErr: () => undefined });
  registerRunCommand(value);
  return value;
}

async function invoke(...args: string[]): Promise<unknown> {
  stdout = [];
  await program().parseAsync(['node', 'maestro', 'run', 'seal-session', ...args, '--workflow-root', projectRoot]);
  expect(stdout).toHaveLength(1);
  return JSON.parse(stdout[0]);
}

describe('run seal-session Execution compatibility alias', () => {
  it('resolves canonical current authority, reports fence errors, and replays through Execution seal', async () => {
    enableSessionV20();
    const store = new SessionStore(projectRoot);
    store.createSession('s', 'fenced alias');
    const started = startExecution(projectRoot, 's', {
      requestId: 'req-start', ownerId: 'worker', ownerKind: 'codex',
    });
    const common = [
      's', '--request-id', 'req-seal', '--expected-execution-revision', '1',
      '--expected-activity-revision', '1',
      '--owner-id', started.lease_claim.owner_id, '--owner-kind', started.lease_claim.owner_kind,
      '--lease-epoch', String(started.lease_claim.epoch), '--lease-id', started.lease_claim.lease_id,
      '--actor', 'reviewer', '--reason', 'verified alias seal',
      '--evidence', 'evidence/review.json',
      '--outcome', 'done', '--summary', 'alias complete', '--json',
    ];

    for (const flag of ['--expected-activity-revision', '--actor', '--reason', '--evidence']) {
      const missing = [...common];
      const index = missing.indexOf(flag);
      missing.splice(index, 2);
      const usage = runResponseV11Schema.parse(await invoke(...missing));
      expect(usage, flag).toMatchObject({
        operation: 'execution-seal', ok: false, exit_code: 2,
        error: { code: 'COMMANDER_USAGE' },
        warnings: [{ code: 'DEPRECATED_ALIAS', replacement_command: 'maestro execution seal' }],
      });
      expect(store.readExecutionTransition('s', started.execution.execution_id, 'req-seal')).toBeNull();
      expect(store.readExecution('s', started.execution.execution_id)).toMatchObject({ status: 'active', revision: 1 });
    }

    const applied = runResponseV11Schema.parse(await invoke(...common));
    expect(applied).toMatchObject({
      operation: 'execution-seal', ok: true,
      locator: { session_id: 's', execution_id: started.execution.execution_id, generation: 1 },
      fence: { session_activity_revision: 2, execution_revision: 2, lease_epoch: null },
      replay: { status: 'applied' },
      warnings: [{ code: 'DEPRECATED_ALIAS', replacement_command: 'maestro execution seal' }],
      result: { execution: { status: 'sealed' } },
    });
    expect(store.readExecutionTransition('s', started.execution.execution_id, 'req-seal')).toMatchObject({
      payload: {
        preconditions: { session_activity_revision: 1, execution_revision: 1 },
        payload: {
          actor: 'reviewer',
          reason: 'verified alias seal',
          evidence_refs: ['evidence/review.json'],
          summary: 'alias complete',
          outcome: 'done',
        },
      },
    });

    const replayed = runResponseV11Schema.parse(await invoke(...common));
    expect(replayed).toMatchObject({
      operation: 'execution-seal', ok: true,
      replay: { status: 'replayed', transition_id: applied.replay?.transition_id },
      warnings: [{ code: 'DEPRECATED_ALIAS', replacement_command: 'maestro execution seal' }],
    });

    const conflictArgs = [...common];
    conflictArgs[conflictArgs.indexOf('--reason') + 1] = 'different audit reason';
    const conflict = runResponseV11Schema.parse(await invoke(...conflictArgs));
    expect(conflict).toMatchObject({
      operation: 'execution-seal', ok: false, exit_code: 1,
      error: { code: 'REQUEST_CONFLICT' },
      replay: null,
      warnings: [{ code: 'DEPRECATED_ALIAS', replacement_command: 'maestro execution seal' }],
    });
    expect(store.readExecution('s', started.execution.execution_id)).toMatchObject({ status: 'sealed', revision: 2 });
  });

  it('preserves the legacy Session seal when session/1.x has no Execution', async () => {
    const store = new SessionStore(projectRoot);
    store.createSession('legacy', 'legacy Session seal');

    const response = runResponseV10Schema.parse(await invoke('legacy', '--summary', 'legacy complete', '--json'));
    expect(response).toMatchObject({
      schema_version: 'run-response/1.0', operation: 'seal-session', ok: true,
      locator: { session_id: 'legacy', run_id: null },
      result: { session_id: 'legacy', status: 'sealed' },
    });
    expect(store.readBundle('legacy').session.status).toBe('sealed');
  });
});
