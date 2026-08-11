import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { AgentConfig } from '../../shared/agent-types.js';

const spawnMock = vi.fn();
const killProcessTreeMock = vi.fn();

vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

vi.mock('node:fs', () => ({
  existsSync: vi.fn(() => false),
}));

vi.mock('./env-file-loader.js', () => ({
  loadEnvFile: vi.fn(() => ({})),
}));

vi.mock('./env-cleanup.js', () => ({
  cleanSpawnEnv: vi.fn((overrides: Record<string, string>) => ({
    ...process.env,
    ...overrides,
  })),
}));

vi.mock('./process-tree-kill.js', () => ({
  killProcessTree: (...args: unknown[]) => killProcessTreeMock(...args),
}));

import { PiAdapter } from './pi-adapter.js';

interface FakeChild extends EventEmitter {
  stdout: PassThrough;
  stderr: PassThrough;
  stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
  pid: number;
  exitCode: number | null;
  signalCode: string | null;
}

function createFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = { write: vi.fn(), end: vi.fn() };
  child.pid = 54321;
  child.exitCode = null;
  child.signalCode = null;
  return child;
}

function baseConfig(): AgentConfig {
  return {
    type: 'pi',
    prompt: 'Test Pi stream',
    workDir: 'D:/maestro2',
  };
}

async function flushLines(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

describe('PiAdapter', () => {
  let adapter: PiAdapter;
  let child: FakeChild;

  beforeEach(() => {
    adapter = new PiAdapter();
    child = createFakeChild();
    spawnMock.mockReset();
    spawnMock.mockReturnValue(child);
    killProcessTreeMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    if (adapter.listProcesses().length > 0) {
      child.exitCode = 0;
      child.emit('exit', 0, null);
    }
  });

  it('pipes the prompt and streams assistant deltas without duplicating message_end text', async () => {
    const process = await adapter.spawn(baseConfig());
    const entries: Array<Record<string, unknown>> = [];
    adapter.onEntry(process.id, (entry) => entries.push(entry as unknown as Record<string, unknown>));

    child.stdout.write(`${JSON.stringify({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: 'hello' },
    })}\n`);
    child.stdout.write(`${JSON.stringify({
      type: 'message_end',
      message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
    })}\n`);
    await flushLines();

    expect(child.stdin.write).toHaveBeenCalledWith('Test Pi stream');
    expect(child.stdin.end).toHaveBeenCalled();
    const messages = entries.filter((entry) => entry.type === 'assistant_message');
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ content: 'hello', partial: true });
  });

  it('deduplicates toolResult message after matching tool_execution_end', async () => {
    const process = await adapter.spawn(baseConfig());
    const entries: Array<Record<string, unknown>> = [];
    adapter.onEntry(process.id, (entry) => entries.push(entry as unknown as Record<string, unknown>));

    const events = [
      {
        type: 'message_update',
        assistantMessageEvent: {
          type: 'toolcall_end',
          toolCall: { id: 'call-1', name: 'bash', arguments: { command: 'printf ok' } },
        },
      },
      {
        type: 'tool_execution_end',
        toolCallId: 'call-1',
        toolName: 'bash',
        result: { content: [{ type: 'text', text: 'ok' }] },
        isError: false,
      },
      {
        type: 'message_end',
        message: {
          role: 'toolResult',
          toolCallId: 'call-1',
          toolName: 'bash',
          content: [{ type: 'text', text: 'ok' }],
          isError: false,
        },
      },
    ];
    for (const event of events) child.stdout.write(`${JSON.stringify(event)}\n`);
    await flushLines();

    const tools = entries.filter((entry) => entry.type === 'tool_use');
    expect(tools).toHaveLength(2);
    expect(tools.filter((entry) => entry.status === 'completed')).toHaveLength(1);
    expect(tools.at(-1)).toMatchObject({ name: 'bash', status: 'completed', result: 'ok' });
  });

  it('emits toolResult when the execution-end event was missed', async () => {
    const process = await adapter.spawn(baseConfig());
    const entries: Array<Record<string, unknown>> = [];
    adapter.onEntry(process.id, (entry) => entries.push(entry as unknown as Record<string, unknown>));

    child.stdout.write(`${JSON.stringify({
      type: 'message_end',
      message: {
        role: 'toolResult',
        toolCallId: 'call-fallback',
        toolName: 'read',
        content: [{ type: 'text', text: 'fallback' }],
        isError: false,
      },
    })}\n`);
    await flushLines();

    expect(entries.filter((entry) => entry.type === 'tool_use')).toEqual([
      expect.objectContaining({ name: 'read', status: 'completed', result: 'fallback' }),
    ]);
  });

  it('emits terminal error status and removes process state on spawn error', async () => {
    const process = await adapter.spawn(baseConfig());
    const entries: Array<Record<string, unknown>> = [];
    adapter.onEntry(process.id, (entry) => entries.push(entry as unknown as Record<string, unknown>));

    child.emit('error', new Error('spawn pi ENOENT'));

    expect(entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'error', code: 'spawn_error' }),
      expect.objectContaining({ type: 'status_change', status: 'error', reason: 'spawn pi ENOENT' }),
    ]));
    expect(adapter.getProcess(process.id)).toBeUndefined();
  });

  it('does not escalate a stopped child to SIGKILL after its exit event', async () => {
    vi.useFakeTimers();
    const process = await adapter.spawn(baseConfig());

    await adapter.stop(process.id);
    child.signalCode = 'SIGTERM';
    child.emit('exit', null, 'SIGTERM');
    await vi.advanceTimersByTimeAsync(5000);

    expect(killProcessTreeMock).toHaveBeenCalledTimes(1);
    expect(killProcessTreeMock).toHaveBeenCalledWith(child.pid, 'SIGTERM');
  });

  it('escalates to SIGKILL when the child has not exited after five seconds', async () => {
    vi.useFakeTimers();
    const process = await adapter.spawn(baseConfig());

    await adapter.stop(process.id);
    await vi.advanceTimersByTimeAsync(5000);

    expect(killProcessTreeMock.mock.calls).toEqual([
      [child.pid, 'SIGTERM'],
      [child.pid, 'SIGKILL'],
    ]);
  });
});
