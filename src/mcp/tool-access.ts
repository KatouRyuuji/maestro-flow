import type { Tool, ToolResult } from '../types/index.js';
import type { ToolRegistry } from '../core/tool-registry.js';

export interface McpToolAccessPolicy {
  filter(tools: readonly Tool[]): Tool[];
  execute(
    registry: ToolRegistry,
    name: string,
    input: Record<string, unknown>,
  ): Promise<ToolResult>;
}

/**
 * Build one immutable authorization policy for an MCP server instance.
 *
 * MAESTRO_ENABLED_TOOLS keeps its existing precedence over persisted config.
 * Both discovery and execution must use this same policy snapshot; otherwise a
 * hidden, registered tool can still be invoked by guessing its name.
 */
export function createMcpToolAccessPolicy(
  configuredTools: readonly string[],
  environmentTools: string | undefined,
): McpToolAccessPolicy {
  const selected = environmentTools
    ? environmentTools.split(',').map((name) => name.trim()).filter(Boolean)
    : [...configuredTools];
  const enabled = new Set(selected);
  const allowAll = enabled.has('all');
  const isEnabled = (name: string): boolean => allowAll || enabled.has(name);

  return Object.freeze({
    filter(tools: readonly Tool[]): Tool[] {
      return tools.filter((tool) => isEnabled(tool.name));
    },

    async execute(
      registry: ToolRegistry,
      name: string,
      input: Record<string, unknown>,
    ): Promise<ToolResult> {
      if (!isEnabled(name)) {
        return {
          content: [{ type: 'text', text: `Tool is not available: ${name}` }],
          isError: true,
        };
      }
      return registry.execute(name, input);
    },
  });
}

export interface McpToolRequestHandlers {
  list(): {
    tools: Array<Pick<Tool, 'name' | 'description' | 'inputSchema'>>;
  };
  call(name: string, input: Record<string, unknown>): Promise<ToolResult>;
}

/** Create the paired ListTools and CallTool implementations from one policy. */
export function createMcpToolRequestHandlers(
  registry: ToolRegistry,
  configuredTools: readonly string[],
  environmentTools: string | undefined,
): McpToolRequestHandlers {
  const access = createMcpToolAccessPolicy(configuredTools, environmentTools);

  return Object.freeze({
    list() {
      return {
        tools: access.filter(registry.list()).map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        })),
      };
    },

    call(name: string, input: Record<string, unknown>): Promise<ToolResult> {
      return access.execute(registry, name, input);
    },
  });
}
