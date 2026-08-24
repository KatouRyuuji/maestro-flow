import { describe, expect, it, vi } from 'vitest';

import { ToolRegistry } from '../core/tool-registry.js';
import type { Tool } from '../types/index.js';
import {
  createMcpToolAccessPolicy,
  createMcpToolRequestHandlers,
} from './tool-access.js';

function makeTool(name: string, handler: Tool['handler'] = async () => ({
  content: [{ type: 'text', text: `${name} result` }],
})): Tool {
  return {
    name,
    description: `Test tool: ${name}`,
    inputSchema: { type: 'object', properties: {} },
    handler,
  };
}

function registryWith(...tools: Tool[]): ToolRegistry {
  const registry = new ToolRegistry();
  for (const tool of tools) registry.register(tool);
  return registry;
}

describe('MCP tool access policy', () => {
  it('uses configured tools when the environment override is absent', async () => {
    const registry = registryWith(makeTool('read'), makeTool('team_agent'));
    const policy = createMcpToolAccessPolicy(['read'], undefined);

    expect(policy.filter(registry.list()).map((tool) => tool.name)).toEqual(['read']);
    expect((await policy.execute(registry, 'read', {})).isError).toBeUndefined();
  });

  it('uses a non-empty environment override instead of configured tools', async () => {
    const registry = registryWith(makeTool('read'), makeTool('team_agent'));
    const policy = createMcpToolAccessPolicy(['read'], ' team_agent, ');

    expect(policy.filter(registry.list()).map((tool) => tool.name)).toEqual(['team_agent']);
    expect((await policy.execute(registry, 'read', {})).isError).toBe(true);
    expect((await policy.execute(registry, 'team_agent', {})).isError).toBeUndefined();
  });

  it('keeps the existing empty-environment fallback behavior', () => {
    const registry = registryWith(makeTool('read'), makeTool('team_agent'));
    const policy = createMcpToolAccessPolicy(['read'], '');

    expect(policy.filter(registry.list()).map((tool) => tool.name)).toEqual(['read']);
  });

  it('allows discovery and execution of every registered tool with all', async () => {
    const registry = registryWith(makeTool('read'), makeTool('team_agent'));
    const policy = createMcpToolAccessPolicy(['all'], undefined);

    expect(policy.filter(registry.list()).map((tool) => tool.name)).toEqual([
      'read',
      'team_agent',
    ]);
    expect((await policy.execute(registry, 'team_agent', {})).isError).toBeUndefined();
  });

  it('rejects a hidden registered tool without invoking its handler', async () => {
    const hiddenHandler = vi.fn(async () => ({
      content: [{ type: 'text' as const, text: 'must not execute' }],
    }));
    const registry = registryWith(makeTool('read'), makeTool('team_agent', hiddenHandler));
    const policy = createMcpToolAccessPolicy(['read'], undefined);

    const result = await policy.execute(registry, 'team_agent', { session_id: 'guessed' });

    expect(result).toEqual({
      content: [{ type: 'text', text: 'Tool is not available: team_agent' }],
      isError: true,
    });
    expect(hiddenHandler).not.toHaveBeenCalled();
  });

  it('preserves ToolRegistry unknown-tool behavior after authorization', async () => {
    const policy = createMcpToolAccessPolicy(['all'], undefined);
    const result = await policy.execute(new ToolRegistry(), 'does_not_exist', {});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('Unknown tool: does_not_exist');
  });

  it('captures a policy snapshot instead of retaining the mutable config array', () => {
    const configured = ['read'];
    const policy = createMcpToolAccessPolicy(configured, undefined);
    configured.push('team_agent');
    const registry = registryWith(makeTool('read'), makeTool('team_agent'));

    expect(policy.filter(registry.list()).map((tool) => tool.name)).toEqual(['read']);
  });
});

describe('MCP tool request handlers', () => {
  it('applies an environment override to both ListTools and CallTool', async () => {
    const registry = registryWith(makeTool('read'), makeTool('team_agent'));
    const handlers = createMcpToolRequestHandlers(registry, ['read'], 'team_agent');

    expect(handlers.list().tools.map((tool) => tool.name)).toEqual(['team_agent']);
    expect((await handlers.call('read', {})).isError).toBe(true);
    expect((await handlers.call('team_agent', {})).isError).toBeUndefined();
  });

  it('uses config fallback for both handlers and never invokes a hidden tool', async () => {
    const hiddenHandler = vi.fn(async () => ({
      content: [{ type: 'text' as const, text: 'must not execute' }],
    }));
    const registry = registryWith(makeTool('read'), makeTool('team_agent', hiddenHandler));
    const handlers = createMcpToolRequestHandlers(registry, ['read'], '');

    expect(handlers.list().tools.map((tool) => tool.name)).toEqual(['read']);
    expect((await handlers.call('team_agent', {})).isError).toBe(true);
    expect(hiddenHandler).not.toHaveBeenCalled();
  });

  it('applies an environment all override to discovery and execution', async () => {
    const registry = registryWith(makeTool('read'), makeTool('team_agent'));
    const handlers = createMcpToolRequestHandlers(registry, [], 'all');

    expect(handlers.list().tools.map((tool) => tool.name)).toEqual([
      'read',
      'team_agent',
    ]);
    expect((await handlers.call('team_agent', {})).isError).toBeUndefined();
  });
});
