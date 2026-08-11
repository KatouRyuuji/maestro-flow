import { beforeEach, describe, expect, it, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import { AgentManager } from './agent-manager.js';
import { DashboardEventBus } from '../state/event-bus.js';
import { EntryNormalizer } from './entry-normalizer.js';
import type { AgentAdapter } from './base-adapter.js';
import type { AgentConfig, AgentProcess, NormalizedEntry } from '../../shared/agent-types.js';

vi.mock('node:fs', () => ({
  appendFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  existsSync: vi.fn(() => true),
}));

describe('AgentManager CLI history persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function persistTerminal(
    status: 'stopped' | 'error',
    reason: string,
  ): Promise<Record<string, unknown>> {
    let entryListener: ((entry: NormalizedEntry) => void) | undefined;
    const process: AgentProcess = {
      id: `pi-process-${status}-${reason}`,
      type: 'pi',
      status: 'running',
      config: { type: 'pi', prompt: 'terminal case', workDir: 'D:/maestro2' },
      startedAt: '2026-08-11T12:00:00.000Z',
    };
    const adapter = {
      agentType: 'pi',
      spawn: vi.fn(async (_config: AgentConfig) => process),
      stop: vi.fn(),
      sendMessage: vi.fn(),
      onEntry: vi.fn((_processId: string, listener: (entry: NormalizedEntry) => void) => {
        entryListener = listener;
        return () => {};
      }),
      onApproval: vi.fn(() => () => {}),
      respondApproval: vi.fn(),
      supportsInteractive: vi.fn(() => false),
      endInput: vi.fn(),
      getProcess: vi.fn(() => process),
      listProcesses: vi.fn(() => [process]),
    } satisfies AgentAdapter;

    const manager = new AgentManager(new DashboardEventBus());
    manager.registerAdapter(adapter);
    await manager.spawn('pi', process.config);
    entryListener?.(EntryNormalizer.statusChange(process.id, status, reason));

    const call = vi.mocked(writeFileSync).mock.calls.at(-1);
    return JSON.parse(String(call?.[1])) as Record<string, unknown>;
  }

  it('writes running metadata immediately and preserves successful terminal status', async () => {
    let entryListener: ((entry: NormalizedEntry) => void) | undefined;
    const process: AgentProcess = {
      id: 'pi-process-1',
      type: 'pi',
      status: 'running',
      config: { type: 'pi', prompt: 'stream this', workDir: 'D:/maestro2' },
      startedAt: '2026-08-11T12:00:00.000Z',
    };
    const adapter = {
      agentType: 'pi',
      spawn: vi.fn(async (_config: AgentConfig) => process),
      stop: vi.fn(),
      sendMessage: vi.fn(),
      onEntry: vi.fn((_processId: string, listener: (entry: NormalizedEntry) => void) => {
        entryListener = listener;
        return () => {};
      }),
      onApproval: vi.fn(() => () => {}),
      respondApproval: vi.fn(),
      supportsInteractive: vi.fn(() => false),
      endInput: vi.fn(),
      getProcess: vi.fn(() => process),
      listProcesses: vi.fn(() => [process]),
    } satisfies AgentAdapter;

    const manager = new AgentManager(new DashboardEventBus());
    manager.registerAdapter(adapter);
    await manager.spawn('pi', process.config);

    expect(writeFileSync).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(String(vi.mocked(writeFileSync).mock.calls[0][1]));
    expect(payload).toMatchObject({
      tool: 'pi',
      prompt: 'stream this',
      startedAt: process.startedAt,
    });
    expect(payload).not.toHaveProperty('completedAt');
    expect(payload).not.toHaveProperty('exitCode');

    entryListener?.(EntryNormalizer.statusChange(process.id, 'stopped', 'Exited with code: 0'));

    expect(writeFileSync).toHaveBeenCalledTimes(2);
    const completed = JSON.parse(String(vi.mocked(writeFileSync).mock.calls[1][1]));
    expect(completed).toMatchObject({ exitCode: 0 });
    expect(completed.completedAt).toEqual(expect.any(String));
  });

  it.each([
    ['Stream stale after 300000ms', 1],
    ['Terminated by signal: SIGTERM', 1],
    ['Exited with code: 9', 9],
  ])('persists abnormal stopped reason %s with exit code %s', async (reason, expected) => {
    const completed = await persistTerminal('stopped', reason);
    expect(completed.exitCode).toBe(expected);
  });

  it('persists explicit error status as failure', async () => {
    const completed = await persistTerminal('error', 'spawn pi ENOENT');
    expect(completed.exitCode).toBe(1);
  });
});
