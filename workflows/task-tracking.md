<!-- session-mode: none -->
<!-- lifecycle-profile: neutral -->
# Task Tracking Protocol

Task 工具是 session 权威状态的 **UI 镜像**，不替代 session 状态。

## 原则

- 权威真相在 `session.json` / `run.json`，task 工具是只读投影
- LLM 不维护镜像一致性——插件/宿主负责对账
- 手工 update 仅用于 LLM 主动发现的状态变更（完成/失败），不用于中间进度

## Claude Code 操作表

| 时机 | 操作 | 示例 |
|------|------|------|
| Session 创建后 | [@task] TaskCreate session goal | `TaskCreate({ description: "所有 steps completed", subject: "Session: {intent_summary}" })` |
| Step 派发时 | [@task] TaskCreate step goal | `TaskCreate({ description: "{step.stage} 完成", subject: "Step {index}: {step.skill}" })` |
| Step 完成时 | [@task] TaskUpdate step goal | `TaskUpdate({ taskId: step_goal_id, status: "completed" })` |
| 子目标全完成时 | [@task] TaskUpdate session goal | `TaskUpdate({ taskId: session_goal_id, status: "completed" })` |
| Step 失败时 | [@task] TaskUpdate step goal | `TaskUpdate({ taskId: step_goal_id, status: "failed" })` |

## 字段语义

| 字段 | 含义 | 示例 |
|------|------|------|
| `subject` | 任务标题（显示名） | `"Step 3: implement"` |
| `description` | 完成判据 | `"implement 阶段完成 + tests pass"` |

## Goal 设置

Goal 是 LLM 内置的终止条件追踪器，与 task 工具互补：
- **task** = 步骤进度镜像（UI 投影）
- **goal** = 终止条件（LLM 自主判断何时停止）

Goal 工具是 LLM 内置工具，不检测可用性——LLM 能调就调，不能调就不调。

| 平台 | 设置方式 | 说明 |
|------|----------|------|
| Claude | 输出 `/goal` 提示词，用户复制输入 | 非阻塞，执行中可随时输入 |
| Codex | 调用 `create_goal` / `update_goal` | LLM 内置工具 |
| Pi | 调用 `goal({ action: "create" })` | harness 内置工具 |
| Agents-Standard | `create_task` 作为 session goal | 镜像协议 |

### 启用方式

prepare 文件 frontmatter 声明 `goal: true` 即启用。Runtime 在 `maestro run brief` / `prepare` / `skill` 的 JSON 输出中注入 `goal_mode` 字段，包含平台专属提示词。

当前已启用 `goal: true` 的 prepare 文件：
- `prepare/ralph.md` — Ralph 编排器
- `prepare/odyssey-debug.md` — Odyssey debug 模式
- `prepare/odyssey-improve.md` — Odyssey improve 模式
- `prepare/odyssey-planex.md` — Odyssey planex 模式
- `prepare/odyssey-review.md` — Odyssey review 模式
- `prepare/odyssey-security.md` — Odyssey security 模式
- `prepare/odyssey-ui.md` — Odyssey ui 模式
