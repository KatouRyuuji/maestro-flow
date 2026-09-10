import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { maestroHookCommand } from '../core/mcp-launch.js';
import {
  CODEX_HOOK_DEFS,
  GROK_HOOK_DEFS,
  HOOK_DEFS,
  conversationPayloadFromHook,
  getGenericHooksForLevel,
  getHooksForLevel,
  installCodexHooksByLevel,
  installGenericHooksByLevel,
} from './hooks.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempHooksPath(): string {
  const root = mkdtempSync(join(tmpdir(), 'maestro-codex-hooks-'));
  roots.push(root);
  return join(root, 'hooks.json');
}

describe('Codex prompt context lifecycle', () => {
  it('keeps one prompt context hook and only guards in PreToolUse', () => {
    expect(CODEX_HOOK_DEFS['keyword-spec-injector']).toMatchObject({
      event: 'UserPromptSubmit',
      level: 'standard',
    });
    expect(CODEX_HOOK_DEFS['kg-context-injector']).toBeUndefined();
    expect(CODEX_HOOK_DEFS['kg-unified-injector']).toBeUndefined();
    expect(CODEX_HOOK_DEFS['kg-unified-injector-agent']).toBeUndefined();
    expect(CODEX_HOOK_DEFS['spec-validator'].matcher).toBe('Write');

    const preToolHooks = Object.entries(CODEX_HOOK_DEFS)
      .filter(([, def]) => def.event === 'PreToolUse')
      .map(([name]) => name);
    expect(preToolHooks).toEqual(['preflight-guard', 'spec-validator', 'workflow-guard']);
  });

  it('installs one prompt context hook and removes all legacy KG hook entries', () => {
    const hooksPath = tempHooksPath();
    writeFileSync(hooksPath, JSON.stringify({
      hooks: {
        PreToolUse: [
          {
            matcher: 'Agent',
            hooks: [{ type: 'command', command: 'maestro hooks run kg-context-injector' }],
          },
          {
            matcher: 'Agent',
            hooks: [{ type: 'command', command: 'maestro hooks run kg-unified-injector-agent' }],
          },
        ],
        UserPromptSubmit: [
          {
            hooks: [{ type: 'command', command: 'maestro hooks run kg-unified-injector' }],
          },
        ],
      },
    }));

    installCodexHooksByLevel('standard', { hooksPath });
    const installed = JSON.parse(readFileSync(hooksPath, 'utf8'));
    const preToolCommands = (installed.hooks.PreToolUse ?? [])
      .flatMap((group: { hooks: Array<{ command: string }> }) => group.hooks.map(hook => hook.command));
    const promptCommands = (installed.hooks.UserPromptSubmit ?? [])
      .flatMap((group: { hooks: Array<{ command: string }> }) => group.hooks.map(hook => hook.command));

    expect(preToolCommands).toEqual([
      maestroHookCommand('preflight-guard'),
      maestroHookCommand('spec-validator'),
    ]);
    expect(promptCommands).toContain(maestroHookCommand('keyword-spec-injector'));
    expect(promptCommands).toContain(maestroHookCommand('memory-inject'));
    expect(JSON.stringify(installed)).not.toMatch(/kg-(?:context|unified)-injector/);
  });

  it('does not expose removed KG hook variants through generic platforms', () => {
    expect(getGenericHooksForLevel('codebuddy', 'standard')).not.toContain('kg-context-injector');
    expect(getGenericHooksForLevel('cursor', 'standard')).not.toContain('kg-context-injector');
    expect(getGenericHooksForLevel('cursor', 'standard')).not.toContain('kg-unified-injector');
    expect(getGenericHooksForLevel('cursor', 'standard')).not.toContain('kg-unified-injector-agent');
  });

  it('installs working-memory inject on Cursor and extract on Codex Stop', () => {
    expect(CODEX_HOOK_DEFS['memory-inject-prompt']).toMatchObject({
      event: 'UserPromptSubmit',
      runner: 'memory-inject',
    });
    expect(CODEX_HOOK_DEFS['memory-extract']).toMatchObject({ event: 'Stop' });
    expect(getGenericHooksForLevel('cursor', 'standard')).toEqual(expect.arrayContaining([
      'memory-inject-start',
      'memory-inject-prompt',
      'memory-extract',
      'memory-extract-end',
    ]));
  });

  it('writes Cursor native camelCase keys and version 1', () => {
    const hooksPath = tempHooksPath();
    const result = installGenericHooksByLevel('cursor', 'standard', { hooksPath });
    const installed = JSON.parse(readFileSync(hooksPath, 'utf8'));
    expect(result.installedHooks).toEqual(expect.arrayContaining([
      'memory-extract',
      'memory-extract-end',
      'memory-inject-start',
      'memory-inject-prompt',
    ]));
    expect(installed.version).toBe(1);
    expect(installed.hooks.stop.map((item: { command: string }) => item.command).join('\n'))
      .toContain('hooks run memory-extract');
    expect(installed.hooks.sessionEnd.map((item: { command: string }) => item.command).join('\n'))
      .toContain('hooks run memory-extract');
    expect(installed.hooks.beforeSubmitPrompt.map((item: { command: string }) => item.command).join('\n'))
      .toContain('hooks run memory-inject');
    expect(installed.hooks.sessionStart.map((item: { command: string }) => item.command).join('\n'))
      .toContain('hooks run memory-inject');
    expect(installed.hooks.Stop).toBeUndefined();
    expect(installed.hooks.UserPromptSubmit).toBeUndefined();
  });

  it('keeps existing Claude-compat Cursor hooks and dual-writes Maestro commands', () => {
    const hooksPath = tempHooksPath();
    writeFileSync(hooksPath, JSON.stringify({
      hooks: {
        Stop: [
          {
            hooks: [{ type: 'command', command: 'python kk-mem/hooks/stop.py', timeout: 10 }],
          },
        ],
        SessionStart: [
          {
            matcher: 'startup|resume',
            hooks: [{ type: 'command', command: 'python kk-mem/hooks/session-start.py' }],
          },
        ],
      },
    }));

    installGenericHooksByLevel('cursor', 'standard', { hooksPath });
    const installed = JSON.parse(readFileSync(hooksPath, 'utf8'));
    expect(installed.version).toBe(1);
    expect(JSON.stringify(installed.hooks.Stop)).toContain('kk-mem/hooks/stop.py');
    expect(JSON.stringify(installed.hooks.Stop)).toContain('hooks run memory-extract');
    expect(JSON.stringify(installed.hooks.stop)).toContain('hooks run memory-extract');
    expect(JSON.stringify(installed.hooks.SessionStart)).toContain('kk-mem/hooks/session-start.py');
  });

  it('maps Cursor conversation_id into the working-memory payload', () => {
    const payload = conversationPayloadFromHook({
      conversation_id: 'conv-cursor-1',
      transcript_path: 'C:/tmp/transcript.jsonl',
      workspace_roots: ['D:/proj'],
      hook_event_name: 'stop',
    }, 'D:/proj');
    expect(payload.session_id).toBe('conv-cursor-1');
    expect(payload.transcript_path).toBe('C:/tmp/transcript.jsonl');
    expect(payload.hook_event_name).toBe('stop');
  });

  it('includes working-memory extract and inject on standard install', () => {
    expect(getHooksForLevel('standard', 'claude')).toEqual(expect.arrayContaining([
      'memory-extract',
      'memory-inject-start',
      'memory-inject-prompt',
    ]));
    expect(getHooksForLevel('standard', 'codex')).toEqual(expect.arrayContaining([
      'memory-extract',
      'memory-inject-start',
      'memory-inject-prompt',
    ]));
    expect(getHooksForLevel('standard', 'agy')).toEqual(expect.arrayContaining([
      'memory-extract',
      'memory-inject',
    ]));
  });

  it('places Grok memory-inject on PreToolUse and Claude/Codex on UserPromptSubmit', () => {
    expect(HOOK_DEFS['memory-inject-prompt']).toMatchObject({
      event: 'UserPromptSubmit',
      runner: 'memory-inject',
    });
    expect(CODEX_HOOK_DEFS['memory-inject-prompt']).toMatchObject({
      event: 'UserPromptSubmit',
      runner: 'memory-inject',
    });
    expect(GROK_HOOK_DEFS['memory-inject-prompt']).toMatchObject({
      event: 'PreToolUse',
      runner: 'memory-inject',
    });
    expect(GROK_HOOK_DEFS['memory-inject-prompt'].matcher).toBeUndefined();
    expect(getGenericHooksForLevel('grok', 'standard')).toEqual(expect.arrayContaining([
      'memory-inject-start',
      'memory-inject-prompt',
      'memory-extract',
      'memory-extract-end',
    ]));
  });

  it('installs Grok standard memory-inject on PreToolUse', () => {
    const hooksPath = tempHooksPath();
    const result = installGenericHooksByLevel('grok', 'standard', { hooksPath });
    const installed = JSON.parse(readFileSync(hooksPath, 'utf8'));
    expect(result.installedHooks).toEqual(expect.arrayContaining([
      'memory-inject-prompt',
      'memory-extract',
    ]));
    const preToolCommands = (installed.hooks.PreToolUse ?? [])
      .flatMap((group: { hooks: Array<{ command?: string }> }) => group.hooks.map(hook => hook.command ?? ''));
    const promptCommands = (installed.hooks.UserPromptSubmit ?? [])
      .flatMap((group: { hooks: Array<{ command?: string }> }) => group.hooks.map(hook => hook.command ?? ''));
    expect(preToolCommands.some(command => command.includes('hooks run memory-inject'))).toBe(true);
    expect(promptCommands.some(command => command.includes('hooks run memory-inject'))).toBe(false);
  });
});
