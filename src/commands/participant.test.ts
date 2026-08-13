import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { runResponseV12Schema } from '../run/protocol-schemas.js';
import type { SessionStateV30 } from '../run/schemas.js';

const roots: string[] = [];

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'maestro-participant-cli-'));
  roots.push(root);
  const sessionDir = join(root, '.workflow', 'sessions', 's-v3');
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(join(root, '.workflow', 'config.json'), `${JSON.stringify({
    session_schema: {
      schema_version: 'session-schema-selection/1.0',
      writer: 'session/3.0',
      features: { session_statusless: false },
    },
  }, null, 2)}\n`);
  const session: SessionStateV30 = {
    schema_version: 'session/3.0', session_id: 's-v3', objective: 'real Commander test',
    definition_of_done: 'participant command is registered', status: 'open',
    identity_revision: 2, orchestration_revision: 3, activity_revision: 4,
    chain: [], decisions: [], active_run_ids: [],
    gates_ref: 'gates.json', artifacts_ref: 'artifacts.json', evidence_ref: 'evidence.json',
    created_at: '2026-08-12T00:00:00.000Z', updated_at: '2026-08-12T00:00:00.000Z',
    completed_at: null, archived_at: null,
  };
  writeFileSync(join(sessionDir, 'session.json'), `${JSON.stringify(session, null, 2)}\n`);
  return { root, sessionDir };
}

function invoke(root: string, args: string[], rootSyntax: 'split' | 'equal' = 'split') {
  const workflowRootArgs = rootSyntax === 'split' ? ['--workflow-root', root] : [`--workflow-root=${root}`];
  const result = spawnSync(process.execPath, [resolve('dist/src/cli.js'), ...args, ...workflowRootArgs], {
    cwd: resolve('.'),
    encoding: 'utf8',
  });
  const lines = result.stdout.trim().split(/\r?\n/).filter(Boolean);
  return {
    status: result.status,
    stderr: result.stderr,
    lines,
    response: lines.length === 1 ? runResponseV12Schema.parse(JSON.parse(lines[0])) : null,
  };
}

afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('participant command through the real CLI', () => {
  it('registers, reads, and unregisters with single-line run-response/1.2 exit parity', () => {
    const { root, sessionDir } = fixture();
    const common = ['--session', 's-v3', '--participant', 'window-a', '--actor', 'actor-a', '--json'];

    const registered = invoke(root, [
      'participant', 'register', ...common, '--request-id', 'req-register',
    ]);
    expect(registered).toMatchObject({ status: 0, stderr: '', lines: [expect.any(String)] });
    expect(registered.response).toMatchObject({
      schema_version: 'run-response/1.2', operation: 'participant-register', ok: true, exit_code: 0,
      request_id: 'req-register', result: { outcome: 'applied', participant: { status: 'registered' } },
    });

    const status = invoke(root, [
      'participant', 'status', '--session', 's-v3', '--participant', 'window-a',
      '--actor', 'actor-a', '--request-id', 'req-status', '--json',
    ]);
    expect(status).toMatchObject({ status: 0, stderr: '', lines: [expect.any(String)] });
    expect(status.response).toMatchObject({
      operation: 'participant-status', ok: true, request_id: 'req-status',
      result: { participants: [{ participant_id: 'window-a', actor_id: 'actor-a' }] },
    });

    const sessionPath = join(sessionDir, 'session.json');
    const before = JSON.parse(readFileSync(sessionPath, 'utf8')) as SessionStateV30;
    const unregistered = invoke(root, [
      'participant', 'unregister', ...common, '--request-id', 'req-unregister',
    ]);
    expect(unregistered).toMatchObject({ status: 0, stderr: '', lines: [expect.any(String)] });
    expect(unregistered.response).toMatchObject({
      operation: 'participant-unregister', ok: true, exit_code: 0,
      result: { outcome: 'applied', participant: { status: 'unregistered' } },
    });
    const after = JSON.parse(readFileSync(sessionPath, 'utf8')) as SessionStateV30;
    expect(after).toMatchObject({
      identity_revision: before.identity_revision + 1,
      activity_revision: before.activity_revision + 1,
      orchestration_revision: before.orchestration_revision,
      chain: before.chain,
      decisions: before.decisions,
      active_run_ids: before.active_run_ids,
    });
  });

  it.each(['split', 'equal'] as const)(
    'pre-dispatches %s workflow roots across the v3 command surface',
    (rootSyntax) => {
      const { root } = fixture();
      const cases = [
        {
          args: ['run', 'check', '--json'],
          operation: 'check',
          status: 2,
          code: 'COMMANDER_USAGE',
        },
        {
          args: ['session', 'pause', '--json'],
          operation: 'session-pause',
          status: 2,
          code: 'COMMANDER_USAGE',
        },
        {
          args: ['participant', 'register', '--json'],
          operation: 'participant-register',
          status: 2,
          code: 'COMMANDER_USAGE',
        },
        {
          args: ['execution', 'operation', 'claim', '--json'],
          operation: 'execution-operation-claim',
          status: 1,
          code: 'SESSION_SCHEMA_UNSUPPORTED',
        },
      ];

      for (const testCase of cases) {
        const result = invoke(root, testCase.args, rootSyntax);
        expect(result, testCase.args.join(' ')).toMatchObject({
          status: testCase.status,
          stderr: '',
          lines: [expect.any(String)],
          response: {
            schema_version: 'run-response/1.2',
            operation: testCase.operation,
            ok: false,
            exit_code: testCase.status,
            error: { code: testCase.code },
          },
        });
      }
    },
  );

  it('lets Commander structure a missing split workflow-root value', () => {
    const { root } = fixture();
    const result = spawnSync(process.execPath, [
      resolve('dist/src/cli.js'), 'participant', 'register', '--session', 's-v3', '--json', '--workflow-root',
    ], {
      cwd: root,
      encoding: 'utf8',
    });
    const lines = result.stdout.trim().split(/\r?\n/).filter(Boolean);
    expect(result.status).toBe(2);
    expect(result.stderr).toBe('');
    expect(lines).toHaveLength(1);
    expect(runResponseV12Schema.parse(JSON.parse(lines[0]))).toMatchObject({
      operation: 'participant-register',
      disposition: 'usage_error',
      error: { code: 'COMMANDER_USAGE', message: expect.stringMatching(/workflow-root.*argument missing/i) },
    });
  });

  it('emits Commander usage errors as one v1.2 line with exit code 2', () => {
    const { root } = fixture();
    const result = invoke(root, ['participant', 'register', '--session', 's-v3', '--json']);
    expect(result).toMatchObject({ status: 2, stderr: '', lines: [expect.any(String)] });
    expect(result.response).toMatchObject({
      operation: 'participant-register', ok: false, exit_code: 2,
      disposition: 'usage_error', error: { code: 'COMMANDER_USAGE' },
    });
  });
});
