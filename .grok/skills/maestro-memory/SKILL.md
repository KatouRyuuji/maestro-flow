---
name: maestro-memory
description: Maestro 编排层记忆与本机长期记忆一起用。做跨会话偏好、项目约定、Grok/Claude 会话注入或 maestro memory 命令时使用。
---

# Maestro 记忆

编排层通过 MCP `tools/list` + `tools/call` 做 recall / retain。本机长期记忆由已安装的记忆 MCP（kk-mem）提供。两套同时启用。

## 分工

| 平面 | 行为 |
|---|---|
| kk-mem 插件 / 用户级 Grok hooks | 会话画像、每轮检索、Stop 抽取、MCP 工具 `memory_search` / `memory_add` |
| Maestro `memory-inject` / `memory-extract` | 编排层召回与本地 working-memory；`remote=mcp` 时召回走同一 MCP |
| `maestro memory remember/list/recall` | 同一套 `loadMemoryConfig` + recall/retain |

本机未写 `remote: off` 且装了 `lib/mcp_server.py` 时，`loadMemoryConfig` 自动 `remote=mcp`。`mcpWrite` 默认关闭，长期写入仍由 kk-mem 抽取完成。

## 宿主注入

| 宿主 | 注入事件 |
|---|---|
| Claude Code | `UserPromptSubmit` |
| Codex | `UserPromptSubmit` |
| Grok Build | `PreToolUse`（该宿主只把这次事件的 `additionalContext` 送进模型） |

Grok 上这一轮如果没有工具调用，hook 注入不会发生；模型仍可直接调 `memory_*` MCP 工具。

## 命令

```bash
maestro memory recall "<query>"
maestro memory remember "<fact>"
MAESTRO_MEMORY_REMOTE=off maestro memory recall "<query>"
```

显式打开编排层远程写入：`MAESTRO_MEMORY_MCP_WRITE=true` 或配置 `"mcpWrite": true`。

本机已启用的 Maestro CLI 后端：`claude`、`grok`（`~/.maestro/cli-tools.json`）。
