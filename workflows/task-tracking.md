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

Goal 跟各宿主原生 `/goal` 走。Maestro 不改 Goal 行为。
- **task** = 步骤进度镜像（UI 投影）
- **goal** = 宿主自己的终止条件（设定 / 暂停 / 继续 / 清除都由宿主管理）

用户清除 Goal 之后，不要重建、不要刷新。外观必须保持消失。

| 平台 | 原生用法 | Maestro |
|------|----------|---------|
| Claude Code | 用户输入 `/goal`；清除/关闭由宿主管理 | 可提示一次；clear 后不要再贴 `/goal` |
| Cursor | `/goal <objective>` → `CreateGoal`；完成才 `UpdateGoal complete`；暂停后继续才 `active` | 不要用 `UpdateGoal` 刷新外观；clear 后不要重建 |
| Grok | `/goal <objective>` / `status` / `pause` / `resume` / `clear` | clear/pause 后不要再 `create_goal` / `update_goal` |
| Codex | `create_goal` / `update_goal` | 跟宿主工具走 |
| Pi | `goal({ action: "create" })` | 跟宿主工具走 |

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
