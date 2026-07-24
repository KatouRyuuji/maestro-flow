# Ralph → Run/Session 完全迁移优化清单

> ⚠️ **本文档已被 [conflict-resolution.md](./conflict-resolution.md) 修正。以下为修正要点：**
> - 命令命名空间：`maestro run next/done/decide/seal` → **`maestro session next/done/decide/seal`**（Session 级操作归 session 命令面）
> - Brief 定位：正常流程不调 `run brief`，改用 **`session next --inline-brief`** 内联正文；brief 仅回溯用
> - CLI 次数/步：非 1-2 次，而是 **3 次**（session next + run check + session done），check 不可省（finish 注入点）
> - `run graph` → **`session graph`**
> - 多 Session 并行：不依赖 `active_session_id` 单数快速路径
>
> 实施时以 conflict-resolution.md 的「统一后权威流程」为准。

> 方向：Ralph 完全切换到 session/run 原生命令，消除所有 ralph 私有 CLI 动词和冗余 prompt 组装。
> session 天然支持 skill 步进（next → execute → check → done → decide → seal），
> Ralph 只需作为 prompt 层编排器（策略循环），不再拥有任何 CLI 驱动或 prompt 组装逻辑。

---

## 一、现状诊断

### 1.1 Ralph 私有 CLI 动词 vs Run/Session 原生命令对照

| Ralph 私有动词 | Run/Session 原生等价 | 状态 |
|---|---|---|
| `maestro ralph next` | `maestro run next` | 已标记 deprecated，但 emitPrompt 仍重建全量 prompt |
| `maestro ralph complete <idx>` | `maestro run done <run-id> --verdict ...` | 已标记 deprecated，仍走 ralph 适配层 |
| `maestro ralph retry <idx>` | `maestro run done --verdict needs-retry` | 已标记 deprecated |
| `maestro ralph check` | `maestro session check` / `maestro run check` | 已是 thin alias |
| `maestro ralph session` | `maestro session show` / `maestro run status` | 仍读 ralph-meta fallback |
| `maestro ralph skills` | `maestro skills` | 已是 thin alias |
| `maestro ralph ledger` | `maestro session evidence` | 已标记 legacy |

### 1.2 Prompt 注入冗余（ralph cmd-next emitPrompt 产生）

| 编号 | 冗余 | 严重度 | 说明 |
|---|---|---|---|
| R1 | Session Anchor 双重注入 | 🔴 高 | ralph 构建完整 anchor → executor 调 brief 再建一份 |
| R2 | Upstream/Prev-Handoff 三重注入 | 🔴 高 | ralph prompt + birth packet + brief 各一份 |
| R3 | Run-Mode 双重注入 + 语义矛盾 | 🟡 中 | ralph 注入摘要版含 "Do NOT call run create"，brief 注入完整版含 "run create" 指令 |
| R4 | Completion 指令矛盾 | 🟡 中 | ralph completionMeta 指导调 `run done`，executor 约束说 "Do not call run complete" |
| R5 | resolveStepContent 4 次重复解析 | 🟡 中 | 同一 .md 文件被读磁盘 + YAML parse + sha256 四次 |
| R6 | Progress/Signals 三次遍历 | 🟢 低 | completedSteps handoff 被遍历三次 |
| R7 | Coordinator prompt-assembler 平行体系 | 🟢 低 | 不复用 inject.ts，独立实现 Intent/Progress/State |

### 1.3 Ralph 私有文件清单（src/ralph/）

| 文件 | 行数 | 迁移处置 |
|---|---|---|
| `cmd-next.ts` | 417 | **删除** — emitPrompt 全部冗余，run next + brief 已覆盖 |
| `cmd-complete.ts` | 206 | **删除** — run done --verdict 已覆盖 |
| `cmd-check.ts` | 69 | **删除** — 已是 session check 的 thin alias |
| `cmd-session.ts` | 75 | **删除** — session show 已覆盖 |
| `cmd-ledger.ts` | 164 | **删除** — session evidence 已覆盖 |
| `cmd-skills.ts` | 2 | **删除** — 已是 re-export |
| `session-adapter.ts` | 449 | **拆分** — 有效部分合入 run/，ralph-meta fallback 保留为 migrate 兼容 |
| `status-schema.ts` | 159 | **合入** run/schemas.ts（部分已在） |
| `status-store.ts` | 52 | **删除** — SessionStore 已覆盖 |
| `status-checker.ts` | 18 | **删除** — session-check.ts 已覆盖 |
| `verification-ledger.ts` | 94 | **合入** run/ 或标记 legacy |
| `skill-resolver.ts` | 2 | **删除** — re-export |
| `skill-scanner.ts` | 2 | **删除** — re-export |

---

## 二、迁移任务清单

### Phase 0: Prompt 层切换（SKILL.md + executor，零代码破坏）

- [ ] **P0-1** 修改 `maestro-ralph SKILL.md` 的 `A_EXECUTE` 动作：
  - 编排循环改为 `maestro run next --session {id} --json` → 提取 run_id → dispatch run-executor（仅传 session_id + run_id）
  - 删除对 `maestro ralph next` 的调用
  - 删除对 `maestro ralph complete` 的调用，改为 `maestro run done {run_id} --session {id} --verdict ... --json`

- [ ] **P0-2** 修改 `run-executor.md` agent 定义：
  - 确认 dispatch prompt 只需 `session_id` + `run_id`（已满足）
  - 删除对 ralph completionMeta 的兼容处理（如有）

- [ ] **P0-3** 修改 `orchestrator-run-loop.md`：
  - 确认循环动词全部为 `maestro run ...`（next/brief/check/done/decide/seal-session）
  - 删除任何 `maestro ralph ...` 引用

### Phase 1: 消除 ralph emitPrompt 冗余（核心瘦身）

- [ ] **P1-1** 将 `ralph/cmd-next.ts` 的 `emitPrompt()` 瘦身为 birth pointer：
  - 仅输出 `run_id` + `session_id` + `step.index` + `step.total` + `step.command`
  - **删除** buildSessionAnchor()（R1 消除）
  - **删除** buildUpstreamSection()（R2 消除）
  - **删除** summarizeRunMode() 注入（R3 消除）
  - **删除** completionMeta HTML 注释（R4 消除）
  - **删除** buildRefsSection()（brief 已提供）
  - **删除** buildSkillConfigSection()（brief 已提供）
  - 预估：每步节省 ~150 行 prompt / ~2-4K tokens

- [ ] **P1-2** 或者更彻底：**直接删除 `ralph/cmd-next.ts`**，
  让 SKILL.md 直接调用 `maestro run next --session {id} --json`。
  run next 的 renderBirthPacket 已包含所有必要元数据。
  executor 通过 `maestro run brief {run_id}` 获取完整上下文。

- [ ] **P1-3** 删除 `ralph/cmd-complete.ts`，
  SKILL.md 直接使用 `maestro run done {run_id} --session {id} --verdict {v} --json`。
  run done 已支持 `--verdict done|done-with-concerns|needs-retry|blocked`、
  `--summary`、`--note`、`--evidence`、`--decision`。

- [ ] **P1-4** 删除 `ralph/cmd-check.ts`、`ralph/cmd-session.ts`、`ralph/cmd-ledger.ts`、
  `ralph/cmd-skills.ts`（均已是 thin alias 或 legacy）。

### Phase 2: session-adapter 拆分合入

- [ ] **P2-1** `effectivePosition()` / `effectiveDecomposition()` / `effectiveLease()`：
  - 这些是 session.json-first + ralph-meta fallback 的读取器
  - 合入 `run/schemas.ts` 或新建 `run/orchestration-readers.ts`
  - 所有调用方（hooks/coordinator-tracker、run/decide 等）改为从 run/ 导入

- [ ] **P2-2** `resolveRalphSession()`：
  - 核心是 `resolveCompatibleSession()` + `readMeta()` fallback
  - 合入 `run/session-resolver.ts`，增加 `engineFilter` 选项
  - 删除 ralph 私有解析路径

- [ ] **P2-3** `createRalphSession()`：
  - 核心是 `createChainSession()` + ralph_authority 标记 + position 初始化
  - 合入 `run/chain-admin.ts`，增加 `engine: 'ralph'` 选项
  - SKILL.md 的 A_CREATE 改为调用 `maestro run start --chain-file ...`（已在用）

- [ ] **P2-4** ralph-meta.json 兼容：
  - 保留 `readMeta()` 作为 `run/migrate.ts` 的输入（1.0 → 1.3 迁移）
  - 新 session 不再创建 ralph-meta.json（已实现 canonical_complete）
  - 设定 sunset 日期：N 个版本后删除 fallback

### Phase 3: 性能优化

- [ ] **P3-1** `resolveStepContent` / `resolveCommandSource` 进程级缓存：
  - 在 `run/contract.ts` 增加 `Map<string, ResolvedStepContent>` 缓存
  - key = `${command}:${platformSuffix ?? ''}`
  - 同一进程内（run next → createRun → brief）避免 4 次重复磁盘读取
  - 预估：每次链路减少 ~3 次文件读取 + YAML parse + sha256

- [ ] **P3-2** `run next --json` 可选内联 brief 数据：
  - 增加 `--inline-brief` 标志，返回 birth packet + guidance + contract + continuity
  - executor 无需再调一次 `maestro run brief`，省去一次 CLI 往返（~200-500ms）
  - 需评估 JSON 体积（workflow 正文可能很大），可设为 opt-in

- [ ] **P3-3** completedSteps handoff 遍历合并：
  - `buildAnchorSections()` 内一次遍历产出 progress + signals + caveats
  - 消除 collectSignals / buildProgressSection / buildAnchorSections 三次遍历

### Phase 4: 清理与统一

- [ ] **P4-1** 删除 `src/commands/ralph.ts` 整个命令注册：
  - 所有子命令已在 Phase 1 中删除或迁移
  - 从 `src/cli.ts` 移除 `registerRalphCommand` 调用

- [ ] **P4-2** 删除 `src/ralph/` 目录：
  - 有效代码已在 Phase 2 合入 run/
  - 测试文件迁移到对应 run/ 模块

- [ ] **P4-3** 清理 hooks 中的 ralph 特殊分支：
  - `hooks/coordinator-tracker.ts`：`source === 'ralph'` 分支改为统一 `engine` 判断
  - `hooks/statusline.ts`：`isRalph` 分支合并
  - `hooks/skill-context.ts`：`/maestro-ralph` pattern 保留（SKILL.md 仍存在）

- [ ] **P4-4** 统一 `run/schemas.ts` 中的 ralph 类型：
  - `ralphAuthoritySchema` 保留（session.json 仍有该字段）
  - `engine: z.enum(['ralph', 'coordinator', 'manual'])` 中 `'ralph'` 保留为历史值
  - 新 session 可用 `engine: 'orchestrated'` 或保持 `'ralph'`（仅标识来源）

- [ ] **P4-5** coordinator `prompt-assembler.ts` 复用 inject.ts：
  - 将 buildPreviousContext / buildStateSnapshot 改为调用 inject.ts builder
  - 消除 Intent/Progress/State 的平行实现

- [ ] **P4-6** 提取共享 section builder 到 inject.ts：
  - `buildRefsSection()`（当前在 ralph/cmd-next.ts 和 run/next.ts 各一份）
  - `buildUpstreamSection()`（同上）
  - 统一为 inject.ts 导出

### Phase 5: SKILL.md 最终形态

- [ ] **P5-1** `maestro-ralph SKILL.md` 最终版：
  - `<required_reading>` 仅保留 `run-mode.md` + `orchestrator-run-loop.md`
  - 所有 CLI 调用统一为 `maestro run ...` / `maestro session ...`
  - 状态机不变（PARSE→RESOLVE→DECOMPOSE→BUILD→CREATE→LOOP→DONE）
  - A_EXECUTE 循环：`run next --json` → dispatch executor(session_id, run_id) → `run done --json` → 读 continuation → 循环
  - A_EVALUATE：`run decide --json` → 读 continuation
  - A_DONE：`run seal-session`
  - 不再有任何 `maestro ralph ...` 调用

- [ ] **P5-2** `run-executor.md` 最终版：
  - 入口：收到 `session_id` + `run_id` → `maestro run brief {run_id} --session {session_id}`
  - 执行：按 brief 返回的 guidance.workflow / guidance.prepare 执行
  - 退出：`maestro run check {run_id}` → 返回结果
  - 不调用任何 `maestro ralph ...` 命令

---

## 三、依赖关系

```
P0 (SKILL.md 切换)
  │
  ├──→ P1 (删除 emitPrompt / ralph CLI 动词)
  │      │
  │      └──→ P2 (session-adapter 合入 run/)
  │             │
  │             └──→ P4 (清理 src/ralph/ + hooks)
  │
  └──→ P3 (性能优化，可并行)
  │
  └──→ P5 (SKILL.md 最终形态，依赖 P1+P2)
```

## 四、风险与兼容

| 风险 | 缓解 |
|---|---|
| 未迁移的 1.0 ralph-meta session 仍依赖 fallback | P2-4 保留 readMeta 在 run/migrate.ts，设 sunset |
| 外部脚本/CI 调用 `maestro ralph next` | P1 保留 deprecated alias 1-2 个版本，stderr 警告 |
| coordinator-tracker 依赖 `engine === 'ralph'` 判断 | P4-3 改为统一 engine 判断，不删除 engine 值 |
| emitPrompt 删除后旧版 executor 依赖 stdout prompt | P0 先切 SKILL.md，确认 executor 走 brief 后再删 |

## 五、预估收益

| 指标 | 当前 | 迁移后 |
|---|---|---|
| 每步 prompt tokens | ~4-6K（anchor+upstream+run-mode+body+meta） | ~2-3K（brief 单源） |
| CLI 往返/步 | 2（ralph next + run brief） | 1（run next --inline-brief）或 2（run next + run brief） |
| 文件解析/步 | 4 次 resolveStepContent/CommandSource | 1 次（缓存） |
| src/ralph/ 代码量 | 1917 行 | 0（合入 run/ ~200 行） |
| 矛盾指令 | 4 处（R1-R4） | 0 |
| ralph 私有 CLI 动词 | 7 个 | 0 |
