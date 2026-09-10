import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

import { loadMemoryConfig } from './config.js';
import { recallWorkingMemory } from './recall.js';
import { retainWorkingMemory } from './retain.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: process.platform === 'win32' ? 8 : 0, retryDelay: 50 });
    } catch {
      /* ignore */
    }
  }
});

function tempProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'maestro-kkmem-e2e-'));
  roots.push(root);
  mkdirSync(join(root, '.workflow'), { recursive: true });
  return root;
}

function whichPython(): string | null {
  for (const command of ['python3', 'python']) {
    try {
      const result = spawnSync(command, ['-c', 'import sys; print(sys.version)'], {
        encoding: 'utf8',
        timeout: 8000,
        windowsHide: true,
      });
      if (result.status === 0 && (result.stdout ?? '').trim()) return command;
    } catch {
      /* try next */
    }
  }
  return null;
}

function findMcpServerPy(): string | null {
  const envPath = process.env.MAESTRO_MEMORY_MCP_ARGS?.trim();
  if (envPath && existsSync(envPath) && envPath.endsWith('.py')) return envPath;
  const pluginRoot = join(homedir(), '.grok', 'installed-plugins');
  if (!existsSync(pluginRoot)) return null;
  for (const name of readdirSync(pluginRoot)) {
    const candidate = join(pluginRoot, name, 'lib', 'mcp_server.py');
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function mem0Configured(): boolean {
  const file = join(homedir(), '.config', 'mem0-claude', 'config.json');
  if (!existsSync(file)) return false;
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as { base_url?: string; api_key?: string };
    return Boolean(raw.base_url && raw.api_key);
  } catch {
    return false;
  }
}

const python = whichPython();
const serverPy = findMcpServerPy();
const ready = Boolean(python && serverPy && mem0Configured());
const skipReason = !python
  ? 'python3/python not on PATH'
  : !serverPy
    ? 'no installed MCP memory server (lib/mcp_server.py)'
    : !mem0Configured()
      ? 'mem0 client config missing'
      : '';

describe.skipIf(!ready)('local memory MCP e2e (real stdio server)', () => {
  it('round-trips add then search twice through shipped retain/recall', async () => {
    const root = tempProject();
    const token = `maestro-orch-e2e-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const statement = `remember: orchestration e2e prefers ${token} as the maple-glaze marker`;
    const loaded = loadMemoryConfig(root, {
      ...process.env,
      MAESTRO_MEMORY_MCP_DISCOVER: '1',
      MAESTRO_MEMORY_AUTO: 'index',
      MAESTRO_MEMORY_MCP_WRITE: 'true',
      MAESTRO_MEMORY_REMOTE: undefined,
    }, {});
    expect(loaded.remote).toBe('mcp');
    expect(loaded.mcpCommand).toBeTruthy();
    expect(loaded.mcpArgs.some(arg => arg.endsWith('mcp_server.py'))).toBe(true);
    const config = {
      ...loaded,
      auto: 'index' as const,
      autoStageSafe: false,
      mcpWrite: true,
    };
    for (const round of [1, 2]) {
      const retained = await retainWorkingMemory(root, { user_prompt: statement }, {
        config,
        autoStage: false,
      });
      expect(retained.mcp.skipped, `round ${round} add skipped`).toBe(false);
      expect(retained.added, `round ${round} local extract must stay off`).toEqual([]);
      const recalled = await recallWorkingMemory(root, token, {
        config: { ...config, mcpWrite: false },
        touch: false,
      });
      expect(recalled.mcp.skipped, `round ${round} search skipped`).toBe(false);
      expect(recalled.facts, `round ${round} local facts must be empty`).toEqual([]);
      expect(
        recalled.mcp.texts.some(text => text.includes(token)),
        `round ${round} MCP hit missing token: ${JSON.stringify(recalled.mcp.texts)}`,
      ).toBe(true);
    }
  }, 180_000);
});

export const kkmemE2eSkipReason = skipReason;
export const kkmemE2eReady = ready;
