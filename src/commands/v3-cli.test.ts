import { Command } from 'commander';
import { mkdirSync, mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { runResponseV12Schema } from '../run/protocol-schemas.js';
import type { RunV30, SessionStateV30 } from '../run/schemas.js';
import { createSessionState } from '../run/defaults.js';
import { registerExecutionV3RetiredCommand } from './execution-v3-retired.js';
import { registerRunV3Command } from './run-v3.js';
import { registerSessionV3Command } from './session-v3.js';
import { emitV3Error } from './v3-cli-shared.js';

const roots: string[] = [];
const originalExitCode = process.exitCode;

function fixture(input: {
  status?: SessionStateV30['status'];
  stepStatus?: SessionStateV30['chain'][number]['status'];
  run?: Partial<RunV30>;
} = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'maestro-v3-cli-'));
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
  writeFileSync(join(sessionDir, 'artifacts.json'), `${JSON.stringify({
    schema_version: 'artifacts/1.0', revision: 0, artifacts: {}, aliases: {},
  }, null, 2)}\n`);
  const hasRun = input.run !== undefined;
  const session: SessionStateV30 = {
    schema_version: 'session/3.0', session_id: 's-v3', objective: 'exercise CLI',
    definition_of_done: 'commands persist atomically', status: input.status ?? 'open',
    orchestration_revision: 0, activity_revision: 0,
    chain: [{
      step_id: 'step-1', command: 'implement', args: [], status: input.stepStatus ?? 'pending',
      run_ids: hasRun ? ['run-1'] : [], goal_ref: null, decision_refs: [],
    }],
    decisions: [], active_run_ids: hasRun ? ['run-1'] : [],
    artifacts_ref: 'artifacts.json', evidence_ref: 'evidence.json',
    created_at: '2026-08-12T00:00:00.000Z', updated_at: '2026-08-12T00:00:00.000Z',
    completed_at: null, archived_at: null,
  };
  writeFileSync(join(sessionDir, 'session.json'), `${JSON.stringify(session, null, 2)}\n`);
  if (hasRun) {
    const runDir = join(sessionDir, 'runs', 'run-1');
    mkdirSync(runDir, { recursive: true });
    const run: RunV30 = {
      schema_version: 'run/3.0', run_id: 'run-1', session_id: 's-v3', step_id: 'step-1',
      parent_run_id: null, retry_of_run_id: null, attempt: 1, command: 'implement', args: [], goal: null,
      status: 'pending', revision: 0, actor_id: 'actor',
      input_refs: [], output_refs: [], primary_artifact_id: null, verdict: null, summary: null,
      created_at: '2026-08-12T00:00:00.000Z', started_at: null, ended_at: null, sealed_at: null,
      ...input.run,
    };
    writeFileSync(join(runDir, 'run.json'), `${JSON.stringify(run, null, 2)}\n`);
  }
  return root;
}

async function invoke(register: (program: Command) => void, args: string[]) {
  const writes: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
    writes.push(String(chunk));
    return true;
  }) as typeof process.stdout.write);
  const program = new Command().name('maestro').exitOverride();
  register(program);
  await program.parseAsync(['node', 'maestro', ...args]);
  expect(writes).toHaveLength(1);
  expect(writes[0].trim().split(/\r?\n/)).toHaveLength(1);
  return runResponseV12Schema.parse(JSON.parse(writes[0]));
}

function mutationFlags(root: string, revisionFlag: string, revision = 0): string[] {
  return [
    '--session', 's-v3', '--participant', 'participant', '--actor', 'actor',
    '--request-id', `req-${Math.random()}`, revisionFlag, String(revision),
    '--reason', 'focused test', '--evidence', 'evidence-1', '--json', '--workflow-root', root,
  ];
}

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = originalExitCode;
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('formal session/3.0 Commander modules', () => {
  it('marks STORE_BUSY errors retryable in the 1.2 envelope', () => {
    const writes: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    emitV3Error('session-status', new Error('SessionStore locked by another process'), { session: 's-v3' });
    expect(writes).toHaveLength(1);
    expect(runResponseV12Schema.parse(JSON.parse(writes[0]))).toMatchObject({
      ok: false, error: { code: 'STORE_BUSY', retryable: true },
    });
  });

  it('resolves the unique open Session when --session is omitted', async () => {
    const root = fixture();
    const response = await invoke(registerSessionV3Command, [
      'session', 'status', '--json', '--workflow-root', root,
    ]);
    expect(response).toMatchObject({
      operation: 'session-status', ok: true,
      locator: { session_id: 's-v3' },
      result: { schema_version: 'session/3.0', session_id: 's-v3', status: 'open' },
    });
  });

  it('fails closed with stable candidates when --session is omitted and multiple Sessions are open', async () => {
    const root = fixture();
    const firstPath = join(root, '.workflow', 'sessions', 's-v3', 'session.json');
    const secondDir = join(root, '.workflow', 'sessions', 's-v3-b');
    const second = JSON.parse(readFileSync(firstPath, 'utf8')) as SessionStateV30;
    mkdirSync(secondDir, { recursive: true });
    writeFileSync(join(secondDir, 'session.json'), `${JSON.stringify({
      ...second, session_id: 's-v3-b', objective: 'second open Session',
    }, null, 2)}\n`);

    const response = await invoke(registerSessionV3Command, [
      'session', 'status', '--json', '--workflow-root', root,
    ]);
    expect(response).toMatchObject({
      operation: 'session-status', ok: false,
      error: {
        code: 'SESSION_AMBIGUOUS',
        details: {
          context_error_code: 'SESSION_AMBIGUOUS', source: 'open_sessions',
          candidates: ['s-v3', 's-v3-b'],
        },
        next_actions: ['select-session:s-v3', 'select-session:s-v3-b'],
      },
    });
  });

  it('opens and replays a new Session with canonical registries and receipts', async () => {
    const root = mkdtempSync(join(tmpdir(), 'maestro-v3-open-'));
    roots.push(root);
    mkdirSync(join(root, '.workflow'), { recursive: true });
    writeFileSync(join(root, '.workflow', 'config.json'), JSON.stringify({
      session_schema: { schema_version: 'session-schema-selection/1.0', writer: 'session/3.0', features: { session_statusless: false } },
    }));
    const argv = [
      'session', 'open', 'new objective', '--id', 's-open', '--participant', 'p-1', '--actor', 'actor',
      '--request-id', 'req-open', '--reason', 'open test', '--json', '--workflow-root', root,
    ];
    const applied = await invoke(registerSessionV3Command, argv);
    vi.restoreAllMocks();
    const replayed = await invoke(registerSessionV3Command, argv);
    expect(applied).toMatchObject({ operation: 'session-open', ok: true, replay: { status: 'applied' } });
    expect(replayed).toMatchObject({ operation: 'session-open', ok: true, replay: { status: 'replayed' } });
    const dir = join(root, '.workflow', 'sessions', 's-open');
    expect(JSON.parse(readFileSync(join(dir, 'session.json'), 'utf8'))).toMatchObject({
      schema_version: 'session/3.0', orchestration_revision: 1, activity_revision: 1,
    });
    expect(JSON.parse(readFileSync(join(dir, 'evidence.json'), 'utf8'))).toMatchObject({ records: {} });
    expect(existsSync(join(dir, 'gates.json'))).toBe(false);
  });

  it('inserts a chain step and creates its next Run', async () => {
    const root = fixture();
    const inserted = await invoke(registerSessionV3Command, [
      'session', 'chain', 'insert', '--step-id', 'step-2', '--command', 'verify', '--after-step', 'step-1',
      ...mutationFlags(root, '--expected-orchestration-revision'),
    ]);
    expect(inserted).toMatchObject({ operation: 'session-chain-insert', ok: true });
    vi.restoreAllMocks();
    const nextArgs = [
      'run', 'next', '--run', 'run-next', ...mutationFlags(root, '--expected-orchestration-revision', 1),
    ];
    const next = await invoke(registerRunV3Command, nextArgs);
    expect(next).toMatchObject({ operation: 'next', ok: true, replay: { status: 'applied' } });
    vi.restoreAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-12T05:00:00.000Z'));
    const replayedNext = await invoke(registerRunV3Command, nextArgs);
    expect(replayedNext).toMatchObject({ operation: 'next', ok: true, replay: { status: 'replayed' } });
    vi.useRealTimers();
    expect(JSON.parse(readFileSync(join(root, '.workflow', 'sessions', 's-v3', 'runs', 'run-next', 'run.json'), 'utf8')))
      .toMatchObject({ step_id: 'step-1', status: 'running', revision: 1 });
    vi.restoreAllMocks();
    const completed = await invoke(registerRunV3Command, [
      'run', 'complete', 'run-next', '--summary', 'done', '--advance', '--expected-orchestration-revision', '2',
      ...mutationFlags(root, '--expected-run-revision', 1),
    ]);
    expect(completed).toMatchObject({ operation: 'complete', ok: true });
    expect(JSON.parse(readFileSync(join(root, '.workflow', 'sessions', 's-v3', 'session.json'), 'utf8')))
      .toMatchObject({
        orchestration_revision: 3,
        chain: [{ status: 'completed' }, { status: 'pending', run_ids: [] }],
      });
  });

  it('exposes active Run block and evidence-backed fail transitions', async () => {
    const root = fixture({ stepStatus: 'running', run: {
      status: 'running', started_at: '2026-08-12T00:01:00.000Z',
    } });
    const blocked = await invoke(registerRunV3Command, [
      'run', 'transition', 'run-1', 'blocked',
      ...mutationFlags(root, '--expected-run-revision'),
    ]);
    expect(blocked).toMatchObject({ operation: 'run-transition', ok: true, result: { status: 'blocked' } });
    vi.restoreAllMocks();
    const failed = await invoke(registerRunV3Command, [
      'run', 'transition', 'run-1', 'failed',
      ...mutationFlags(root, '--expected-run-revision', 1),
    ]);
    expect(failed).toMatchObject({ operation: 'run-transition', ok: true, result: { status: 'failed' } });
    expect(JSON.parse(readFileSync(join(root, '.workflow', 'sessions', 's-v3', 'runs', 'run-1', 'run.json'), 'utf8')))
      .toMatchObject({ status: 'failed', revision: 2, verdict: 'needs_retry' });
  });

  it('preserves each requested operation in retired Execution errors', async () => {
    const root = fixture();
    for (const [path, operation] of [
      [['handoff', 'prepare'], 'execution-handoff-prepare'],
      [['operation', 'claim'], 'execution-operation-claim'],
      [['operation', 'heartbeat'], 'execution-operation-heartbeat'],
      [['operation', 'release'], 'execution-operation-release'],
      [['operation', 'status'], 'execution-operation-status'],
    ] as const) {
      const response = await invoke(registerExecutionV3RetiredCommand, [
        'execution', ...path, '--session', 's-v3', '--request-id', `req-retired-${operation}`,
        '--json', '--workflow-root', root,
      ]);
      expect(response).toMatchObject({
        operation, ok: false, error: { code: 'SESSION_SCHEMA_UNSUPPORTED' },
      });
      vi.restoreAllMocks();
    }
  });

  it('seals a completed Run and removes it from active Runs', async () => {
    const root = fixture({ stepStatus: 'completed', run: {
      status: 'completed', revision: 2, ended_at: '2026-08-12T00:02:00.000Z', verdict: 'done', summary: 'done',
    } });
    const response = await invoke(registerRunV3Command, [
      'run', 'seal', 'run-1', ...mutationFlags(root, '--expected-run-revision', 2),
    ]);
    expect(response).toMatchObject({ operation: 'run-seal', ok: true });
    expect(JSON.parse(readFileSync(join(root, '.workflow', 'sessions', 's-v3', 'session.json'), 'utf8')))
      .toMatchObject({ active_run_ids: [], activity_revision: 1 });
  });

  it('keeps run seal as terminal-record recovery and refuses a running Run', async () => {
    const root = fixture({ stepStatus: 'running', run: {
      status: 'running', started_at: '2026-08-12T00:01:00.000Z',
    } });
    const beforeArtifacts = readFileSync(join(root, '.workflow', 'sessions', 's-v3', 'artifacts.json'), 'utf8');
    const response = await invoke(registerRunV3Command, [
      'run', 'seal', 'run-1', ...mutationFlags(root, '--expected-run-revision'),
    ]);
    expect(response).toMatchObject({
      operation: 'run-seal', ok: false,
      error: { code: 'INVALID_STATE_TRANSITION' },
    });
    expect(JSON.parse(readFileSync(join(root, '.workflow', 'sessions', 's-v3', 'runs', 'run-1', 'run.json'), 'utf8')))
      .toMatchObject({ status: 'running', revision: 0, output_refs: [] });
    expect(readFileSync(join(root, '.workflow', 'sessions', 's-v3', 'artifacts.json'), 'utf8')).toBe(beforeArtifacts);
  });

  it('creates and starts a Run through the mutation engine', async () => {
    const root = fixture();
    const createArgs = [
      'run', 'create', 'implement', '--run', 'run-new', '--step', 'step-1',
      ...mutationFlags(root, '--expected-orchestration-revision'),
    ];
    const response = await invoke(registerRunV3Command, createArgs);
    expect(response).toMatchObject({ operation: 'create', ok: true, replay: { status: 'applied' } });
    vi.restoreAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-12T06:00:00.000Z'));
    const replayed = await invoke(registerRunV3Command, createArgs);
    expect(replayed).toMatchObject({ operation: 'create', ok: true, replay: { status: 'replayed' } });
    vi.useRealTimers();
    expect(JSON.parse(readFileSync(join(root, '.workflow', 'sessions', 's-v3', 'runs', 'run-new', 'run.json'), 'utf8')))
      .toMatchObject({ schema_version: 'run/3.0', status: 'running', revision: 1 });
  });

  it('requires --advance before completing a running Run', async () => {
    const root = fixture({ stepStatus: 'running', run: { status: 'running', started_at: '2026-08-12T00:01:00.000Z' } });
    const response = await invoke(registerRunV3Command, [
      'run', 'complete', 'run-1', '--summary', 'done',
      '--expected-orchestration-revision', '0',
      ...mutationFlags(root, '--expected-run-revision'),
    ]);
    expect(response).toMatchObject({
      operation: 'complete', ok: false,
      error: { message: expect.stringContaining('requires --advance') },
    });
    expect(JSON.parse(readFileSync(join(root, '.workflow', 'sessions', 's-v3', 'session.json'), 'utf8')))
      .toMatchObject({ orchestration_revision: 0, active_run_ids: ['run-1'], chain: [{ status: 'running' }] });
    expect(JSON.parse(readFileSync(join(root, '.workflow', 'sessions', 's-v3', 'runs', 'run-1', 'run.json'), 'utf8')))
      .toMatchObject({ status: 'running', revision: 0 });
  });

  it('run check is read-only and omits knowledge_reconciliation without a receipt', async () => {
    const root = fixture({ run: {} });
    const response = await invoke(registerRunV3Command, [
      'run', 'check', 'run-1', '--session', 's-v3', '--json', '--workflow-root', root,
    ]);
    expect(response).toMatchObject({
      operation: 'check', ok: true,
      result: {
        run_id: 'run-1', status: 'pending', revision: 0,
        available_transitions: ['running', 'cancelled'],
      },
    });
    const result = response.result as Record<string, unknown>;
    expect(result.knowledge_reconciliation).toBeUndefined();
    expect(result.warnings).toBeUndefined();
    expect(existsSync(join(root, '.workflow', 'sessions', 's-v3', 'runs', 'run-1', 'knowledge-reconciliation.json'))).toBe(false);
  });

  it('completes and seals a running Run and its chain step atomically with --advance', async () => {
    const root = fixture({ stepStatus: 'running', run: { status: 'running', started_at: '2026-08-12T00:01:00.000Z' } });
    const response = await invoke(registerRunV3Command, [
      'run', 'complete', 'run-1', '--summary', 'done', '--advance',
      '--expected-orchestration-revision', '0',
      ...mutationFlags(root, '--expected-run-revision'),
    ]);
    expect(response).toMatchObject({
      operation: 'complete', ok: true,
      result: {
        operation: 'run-complete-and-seal', status: 'sealed',
        artifact_publication: { authority: 'transition-receipt/2.0', artifact_ids: [] },
        next: { suggest_only: true, command: 'maestro run next --session s-v3' },
      },
    });
    const session = JSON.parse(readFileSync(join(root, '.workflow', 'sessions', 's-v3', 'session.json'), 'utf8'));
    const run = JSON.parse(readFileSync(join(root, '.workflow', 'sessions', 's-v3', 'runs', 'run-1', 'run.json'), 'utf8'));
    expect(session).toMatchObject({ orchestration_revision: 1, active_run_ids: [], chain: [{ status: 'completed' }] });
    expect(run).toMatchObject({
      status: 'sealed', revision: 1, verdict: 'done', summary: 'done',
      ended_at: expect.any(String), sealed_at: expect.any(String),
    });
  });

  it('derives retry attempt metadata instead of accepting a caller attempt', async () => {
    const root = fixture({ stepStatus: 'failed', run: {
      status: 'failed', attempt: 3, revision: 2, ended_at: '2026-08-12T00:02:00.000Z', verdict: 'needs_retry',
    } });
    const response = await invoke(registerRunV3Command, [
      'run', 'create', 'implement', '--run', 'run-retry', '--step', 'step-1', '--retry-of-run', 'run-1',
      ...mutationFlags(root, '--expected-orchestration-revision'),
    ]);
    expect(response).toMatchObject({ operation: 'create', ok: true });
    expect(JSON.parse(readFileSync(join(root, '.workflow', 'sessions', 's-v3', 'runs', 'run-retry', 'run.json'), 'utf8')))
      .toMatchObject({ retry_of_run_id: 'run-1', attempt: 4, status: 'running' });

    const program = new Command();
    registerRunV3Command(program);
    const create = program.commands.find(command => command.name() === 'run')
      ?.commands.find(command => command.name() === 'create');
    expect(create?.options.map(option => option.long)).not.toContain('--attempt');
  });

  it('cancels a pending Run through the mutation engine', async () => {
    const root = fixture({ run: {} });
    const response = await invoke(registerRunV3Command, [
      'run', 'cancel', 'run-1', ...mutationFlags(root, '--expected-run-revision'),
    ]);
    expect(response).toMatchObject({ operation: 'run-cancel', ok: true });
    expect(JSON.parse(readFileSync(join(root, '.workflow', 'sessions', 's-v3', 'runs', 'run-1', 'run.json'), 'utf8')))
      .toMatchObject({ status: 'cancelled', revision: 1 });
  });

  it('projects an empty blocking gate set and draft publications from authoritative registries', async () => {
    const root = fixture();
    const sessionDir = join(root, '.workflow', 'sessions', 's-v3');
    writeFileSync(join(sessionDir, 'artifacts.json'), `${JSON.stringify({
      schema_version: 'artifacts/1.0', revision: 4,
      artifacts: {
        'publication-draft': {
          kind: 'report', role: 'primary', producer_run_id: 'run-source', relative_path: 'outputs/draft.md',
          media_type: 'text/markdown', schema_version: 'report/1.0', content_hash: 'a'.repeat(64),
          size: 12, status: 'draft', derived_from: [], replaces: null,
        },
      },
      aliases: {},
    }, null, 2)}\n`);
    const response = await invoke(registerSessionV3Command, [
      'session', 'resume-view', '--session', 's-v3', '--json', '--workflow-root', root,
    ]);
    expect(response).toMatchObject({
      operation: 'session-resume-view', ok: true,
      result: {
        blockingGates: [],
        pendingPublications: [{ publicationId: 'publication-draft', resourceUri: 'outputs/draft.md' }],
      },
    });
  });

  it('completes a satisfied Session and exposes all read commands', async () => {
    const root = fixture({ stepStatus: 'completed', run: { status: 'sealed', revision: 2, ended_at: '2026-08-12T00:02:00.000Z', sealed_at: '2026-08-12T00:03:00.000Z' } });
    const response = await invoke(registerSessionV3Command, [
      'session', 'complete', ...mutationFlags(root, '--expected-orchestration-revision'),
    ]);
    expect(response).toMatchObject({ operation: 'session-complete', ok: true });

    vi.restoreAllMocks();
    const program = new Command();
    registerSessionV3Command(program);
    registerRunV3Command(program);
    expect(program.commands.find(command => command.name() === 'session')?.commands.map(command => command.name()))
      .toEqual(expect.arrayContaining(['open', 'migrate', 'complete', 'status', 'resume-view', 'archive', 'unarchive', 'chain']));
    expect(program.commands.find(command => command.name() === 'run')?.commands.map(command => command.name()))
      .toEqual(expect.arrayContaining(['next', 'create', 'transition', 'complete', 'cancel', 'seal', 'brief', 'check']));
  });

  it('opens a Session with a generated pending chain when --chain is provided', async () => {
    const root = mkdtempSync(join(tmpdir(), 'maestro-v3-open-chain-'));
    roots.push(root);
    mkdirSync(join(root, '.workflow'), { recursive: true });
    writeFileSync(join(root, '.workflow', 'config.json'), JSON.stringify({
      session_schema: { schema_version: 'session-schema-selection/1.0', writer: 'session/3.0', features: { session_statusless: false } },
    }));
    const chained = await invoke(registerSessionV3Command, [
      'session', 'open', 'chain objective', '--id', 's-chain', '--participant', 'p-1', '--actor', 'actor',
      '--request-id', 'req-chain', '--reason', 'chain test', '--chain', 'build', 'test', 'ship',
      '--json', '--workflow-root', root,
    ]);
    expect(chained).toMatchObject({ operation: 'session-open', ok: true });
    expect(JSON.parse(readFileSync(join(root, '.workflow', 'sessions', 's-chain', 'session.json'), 'utf8')))
      .toMatchObject({ chain: [
        { step_id: 's-1', command: 'build', args: [], status: 'pending', run_ids: [], goal_ref: null, decision_refs: [], stage: null },
        { step_id: 's-2', command: 'test', args: [], status: 'pending', run_ids: [], goal_ref: null, decision_refs: [], stage: null },
        { step_id: 's-3', command: 'ship', args: [], status: 'pending', run_ids: [], goal_ref: null, decision_refs: [], stage: null },
      ] });
    vi.restoreAllMocks();
    const plain = await invoke(registerSessionV3Command, [
      'session', 'open', 'plain objective', '--id', 's-plain', '--participant', 'p-1', '--actor', 'actor',
      '--request-id', 'req-plain', '--reason', 'plain test', '--json', '--workflow-root', root,
    ]);
    expect(plain).toMatchObject({ operation: 'session-open', ok: true });
    expect(JSON.parse(readFileSync(join(root, '.workflow', 'sessions', 's-plain', 'session.json'), 'utf8')))
      .toMatchObject({ chain: [] });
  });

  it('lists v3 Sessions sorted by updated_at descending and skips non-v3 entries', async () => {
    const root = fixture();
    const sessionDir = join(root, '.workflow', 'sessions');
    const second = JSON.parse(readFileSync(join(sessionDir, 's-v3', 'session.json'), 'utf8')) as SessionStateV30;
    mkdirSync(join(sessionDir, 's-v3-b'), { recursive: true });
    writeFileSync(join(sessionDir, 's-v3-b', 'session.json'), `${JSON.stringify({
      ...second, session_id: 's-v3-b', objective: 'second Session',
      active_run_ids: ['run-b'], updated_at: '2026-08-12T03:00:00.000Z',
    }, null, 2)}\n`);
    mkdirSync(join(sessionDir, 's-v2'), { recursive: true });
    writeFileSync(join(sessionDir, 's-v2', 'session.json'), `${JSON.stringify({
      schema_version: 'session/2.0', session_id: 's-v2', intent: 'legacy',
    }, null, 2)}\n`);

    const response = await invoke(registerSessionV3Command, [
      'session', 'list', '--json', '--workflow-root', root,
    ]);
    expect(response).toMatchObject({ operation: 'session-list', ok: true, locator: { session_id: null } });
    expect(response.result).toEqual([
      { session_id: 's-v3-b', status: 'open', objective: 'second Session', orchestration_revision: 0, activity_revision: 0, active_run_ids: ['run-b'], updated_at: '2026-08-12T03:00:00.000Z' },
      { session_id: 's-v3', status: 'open', objective: 'exercise CLI', orchestration_revision: 0, activity_revision: 0, active_run_ids: [], updated_at: '2026-08-12T00:00:00.000Z' },
    ]);
  });

  it('returns an empty list for a workspace without sessions', async () => {
    const root = mkdtempSync(join(tmpdir(), 'maestro-v3-list-empty-'));
    roots.push(root);
    mkdirSync(join(root, '.workflow'), { recursive: true });
    writeFileSync(join(root, '.workflow', 'config.json'), JSON.stringify({
      session_schema: { schema_version: 'session-schema-selection/1.0', writer: 'session/3.0', features: { session_statusless: false } },
    }));
    const response = await invoke(registerSessionV3Command, [
      'session', 'list', '--json', '--workflow-root', root,
    ]);
    expect(response).toMatchObject({ operation: 'session-list', ok: true });
    expect(response.result).toEqual([]);
  });

  it('recalls v3 Sessions by objective, definition_of_done, and chain command read-only', async () => {
    const root = fixture();
    const sessionDir = join(root, '.workflow', 'sessions');
    const second = JSON.parse(readFileSync(join(sessionDir, 's-v3', 'session.json'), 'utf8')) as SessionStateV30;
    mkdirSync(join(sessionDir, 's-impl'), { recursive: true });
    writeFileSync(join(sessionDir, 's-impl', 'session.json'), `${JSON.stringify({
      ...second, session_id: 's-impl', objective: 'implement the widget', definition_of_done: 'verified',
      chain: [{ step_id: 'step-1', command: 'verify', args: [], status: 'pending', run_ids: [], goal_ref: null, decision_refs: [] }],
      updated_at: '2026-08-12T01:00:00.000Z',
    }, null, 2)}\n`);
    mkdirSync(join(sessionDir, 's-deploy'), { recursive: true });
    writeFileSync(join(sessionDir, 's-deploy', 'session.json'), `${JSON.stringify({
      ...second, session_id: 's-deploy', objective: 'unrelated topic', definition_of_done: 'nothing in common',
      chain: [{ step_id: 'step-1', command: 'deploy', args: [], status: 'pending', run_ids: [], goal_ref: null, decision_refs: [] }],
      updated_at: '2026-08-12T02:00:00.000Z',
    }, null, 2)}\n`);

    const before = readFileSync(join(sessionDir, 's-v3', 'session.json'), 'utf8');
    const byObjective = await invoke(registerRunV3Command, [
      'run', 'recall', 'implement', '--json', '--workflow-root', root,
    ]);
    expect(byObjective).toMatchObject({ operation: 'recall', ok: true, locator: { session_id: null } });
    expect(byObjective.result).toEqual([
      { session_id: 's-impl', status: 'open', objective: 'implement the widget', updated_at: '2026-08-12T01:00:00.000Z', matched: ['implement the widget'] },
      { session_id: 's-v3', status: 'open', objective: 'exercise CLI', updated_at: '2026-08-12T00:00:00.000Z', matched: ['implement'] },
    ]);
    vi.restoreAllMocks();
    const byDefinition = await invoke(registerRunV3Command, [
      'run', 'recall', 'persist', '--json', '--workflow-root', root,
    ]);
    expect(byDefinition.result).toEqual([
      { session_id: 's-v3', status: 'open', objective: 'exercise CLI', updated_at: '2026-08-12T00:00:00.000Z', matched: ['commands persist atomically'] },
    ]);
    expect(readFileSync(join(sessionDir, 's-v3', 'session.json'), 'utf8')).toBe(before);
  });

  it('inserts a chain step with goal reference and stage metadata', async () => {
    const root = fixture();
    const response = await invoke(registerSessionV3Command, [
      'session', 'chain', 'insert', '--step-id', 'step-2', '--command', 'verify',
      '--goal-ref', 'goal-7', '--stage', 'release', ...mutationFlags(root, '--expected-orchestration-revision'),
    ]);
    expect(response).toMatchObject({ operation: 'session-chain-insert', ok: true });
    const state = JSON.parse(readFileSync(join(root, '.workflow', 'sessions', 's-v3', 'session.json'), 'utf8')) as SessionStateV30;
    expect(state.chain[1]).toMatchObject({ step_id: 'step-2', command: 'verify', goal_ref: 'goal-7', stage: 'release' });
  });

  it('appends step_id and a next hint to the run next result', async () => {
    const root = fixture();
    const response = await invoke(registerRunV3Command, [
      'run', 'next', '--run', 'run-next', ...mutationFlags(root, '--expected-orchestration-revision'),
    ]);
    expect(response).toMatchObject({
      operation: 'next', ok: true,
      result: {
        run_id: 'run-next', status: 'running', revision: 1,
        step_id: 'step-1',
        next: {
          suggest_only: true,
          command: 'maestro run complete run-next --advance',
          reason: 'Run created — execute and complete it with run complete --advance',
        },
      },
    });
  });
});

function writeLegacySession(root: string, sessionId: string, intent: string): void {
  const dir = join(root, '.workflow', 'sessions', sessionId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'gates.json'), `${JSON.stringify({
    schema_version: 'gates/1.0', revision: 0, gates: {},
    summary: { total: 0, passed: 0, blocked: 0, failed: 0, active_gate_ids: [], blocking_run_id: null },
  }, null, 2)}\n`);
  writeFileSync(join(dir, 'artifacts.json'), `${JSON.stringify({
    schema_version: 'artifacts/1.0', revision: 0, artifacts: {}, aliases: {},
  }, null, 2)}\n`);
  writeFileSync(join(dir, 'evidence.json'), `${JSON.stringify({
    schema_version: 'evidence/1.0', revision: 0, records: {},
  }, null, 2)}\n`);
  writeFileSync(join(dir, 'session.json'), `${JSON.stringify(createSessionState(sessionId, intent), null, 2)}\n`);
}

function writeUnmigratableSession(root: string, sessionId: string): void {
  const dir = join(root, '.workflow', 'sessions', sessionId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'session.json'), `${JSON.stringify({
    schema_version: 'session/9.9', session_id: sessionId, intent: 'unmigratable',
  }, null, 2)}\n`);
}

function archiveFixture(root: string): string {
  const sessionPath = join(root, '.workflow', 'sessions', 's-v3', 'session.json');
  const state = JSON.parse(readFileSync(sessionPath, 'utf8')) as SessionStateV30;
  writeFileSync(sessionPath, `${JSON.stringify({
    ...state, status: 'archived', archived_at: '2026-08-12T02:00:00.000Z',
  }, null, 2)}\n`);
  return sessionPath;
}

describe('session migrate --all', () => {
  const migrateAllFlags = (root: string): string[] => [
    '--to-v3', '--participant', 'participant', '--actor', 'actor', '--json', '--workflow-root', root,
  ];

  it('migrates every non-v3 Session and skips already-v3 Sessions', async () => {
    const root = fixture();
    writeLegacySession(root, 's-legacy', 'legacy objective');
    const response = await invoke(registerSessionV3Command, [
      'session', 'migrate', '--all', ...migrateAllFlags(root),
    ]);
    expect(response).toMatchObject({ operation: 'session-migrate', ok: true, locator: { session_id: null } });
    expect(response.result).toEqual([
      { session_id: 's-legacy', source_schema_version: 'session/1.3', outcome: 'migrated' },
    ]);
    expect(JSON.parse(readFileSync(join(root, '.workflow', 'sessions', 's-legacy', 'session.json'), 'utf8')))
      .toMatchObject({ schema_version: 'session/3.0', session_id: 's-legacy' });
    expect(JSON.parse(readFileSync(join(root, '.workflow', 'sessions', 's-v3', 'session.json'), 'utf8')))
      .toMatchObject({ schema_version: 'session/3.0', session_id: 's-v3', status: 'open' });
  });

  it('records a per-Session failure without interrupting the batch', async () => {
    const root = fixture();
    writeLegacySession(root, 's-legacy', 'legacy objective');
    writeUnmigratableSession(root, 's-bad');
    const response = await invoke(registerSessionV3Command, [
      'session', 'migrate', '--all', ...migrateAllFlags(root),
    ]);
    expect(response).toMatchObject({ operation: 'session-migrate', ok: true });
    expect(response.result).toEqual([
      { session_id: 's-bad', source_schema_version: 'session/9.9', outcome: 'failed',
        error: expect.stringContaining('cannot migrate from session/9.9') },
      { session_id: 's-legacy', source_schema_version: 'session/1.3', outcome: 'migrated' },
    ]);
    expect(JSON.parse(readFileSync(join(root, '.workflow', 'sessions', 's-legacy', 'session.json'), 'utf8')))
      .toMatchObject({ schema_version: 'session/3.0' });
  });

  it('rejects --all combined with --session as mutually exclusive', async () => {
    const root = fixture();
    const response = await invoke(registerSessionV3Command, [
      'session', 'migrate', '--all', '--session', 's-v3', ...migrateAllFlags(root),
    ]);
    expect(response).toMatchObject({ operation: 'session-migrate', ok: false });
    expect(response.error?.message).toContain('mutually exclusive');
  });
});

describe('session unarchive', () => {
  it('moves an archived Session back to open and advances the orchestration revision', async () => {
    const root = fixture();
    const sessionPath = archiveFixture(root);
    const response = await invoke(registerSessionV3Command, [
      'session', 'unarchive', ...mutationFlags(root, '--expected-orchestration-revision'),
    ]);
    expect(response).toMatchObject({
      operation: 'session-unarchive', ok: true,
      result: { status: 'open', orchestration_revision: 1 },
    });
    expect(JSON.parse(readFileSync(sessionPath, 'utf8'))).toMatchObject({
      status: 'open', orchestration_revision: 1, activity_revision: 1, archived_at: null,
    });
  });

  it('rejects unarchive for a non-archived Session', async () => {
    const root = fixture();
    const sessionPath = join(root, '.workflow', 'sessions', 's-v3', 'session.json');
    const before = readFileSync(sessionPath, 'utf8');
    const response = await invoke(registerSessionV3Command, [
      'session', 'unarchive', ...mutationFlags(root, '--expected-orchestration-revision'),
    ]);
    expect(response).toMatchObject({
      operation: 'session-unarchive', ok: false,
      error: { code: 'INVALID_STATE_TRANSITION' },
    });
    expect(readFileSync(sessionPath, 'utf8')).toBe(before);
  });

  it('restores create_run permission after unarchive', async () => {
    const root = fixture();
    archiveFixture(root);
    const before = await invoke(registerRunV3Command, [
      'run', 'create', 'implement', '--run', 'run-before', '--step', 'step-1',
      ...mutationFlags(root, '--expected-orchestration-revision'),
    ]);
    expect(before).toMatchObject({ operation: 'create', ok: false, error: { code: 'INVALID_STATE_TRANSITION' } });
    vi.restoreAllMocks();
    const unarchive = await invoke(registerSessionV3Command, [
      'session', 'unarchive', ...mutationFlags(root, '--expected-orchestration-revision'),
    ]);
    expect(unarchive).toMatchObject({ operation: 'session-unarchive', ok: true });
    vi.restoreAllMocks();
    const created = await invoke(registerRunV3Command, [
      'run', 'create', 'implement', '--run', 'run-after', '--step', 'step-1',
      ...mutationFlags(root, '--expected-orchestration-revision', 1),
    ]);
    expect(created).toMatchObject({ operation: 'create', ok: true });
  });
});
