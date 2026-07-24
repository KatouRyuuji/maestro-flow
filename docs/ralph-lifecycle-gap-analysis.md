# Ralph 生命周期 Gap 分析与 Run/Session 收敛规划

> ⚠️ **本文档已被 [conflict-resolution.md](./conflict-resolution.md) 修正。以下为修正要点：**
> - `run graph` → **`session graph`**（注册到 session 命令面）
> - 目标流程中 executor 不再调 `run brief`，改用 **`session next --inline-brief`** 内联正文
> - `run next/done/decide/seal` → **`session next/done/decide/seal`**
> - Brief 定位：仅回溯工具，非正常流程
> - CLI 次数/步：**3 次**（session next + run check + session done）
>
> 实施时以 conflict-resolution.md 的「统一后权威流程」为准。

## 一、用户心智模型（目标态）

```
Ralph 编排器（prompt 层策略循环）
│
├─ 1. 创建 Session + 分析任务 + 构建执行链
│     maestro run start "{intent}" --chain-file {path} --no-dispatch
│
├─ 2. 查看整体队列
│     maestro run graph --session {id}          ← 需要新增
│
└─ 3. Skill 步进循环（每步一个 agent）
      │
      ├─ run next --session {id} --json
      │   → 简要信息: { step_index, command, run_id, queue_preview }
      │   → Run 已创建（原子绑定），但不输出 skill 正文
      │
      ├─ dispatch run-executor(session_id, run_id)
      │   │
      │   ├─ run brief {run_id} --session {id}
      │   │   → 完整执行上下文: skill 正文 + upstream + prev handoff + contract + gates
      │   │
      │   ├─ 执行 skill
      │   │
      │   ├─ run check {run_id}
      │   │   → gate 状态 + finish checklist
      │   │
      │   └─ 返回结果给编排器
      │
      ├─ run done {run_id} --session {id} --verdict done --json
      │   → continuation: { action: "next" | "decide" | "seal", command: "..." }
      │
      └─ 根据 continuation 回到循环顶部 / 处理 decision / seal
```

**核心原则**: 编排器只看指针（next），agent 只读正文（brief），正文单源，职责分离。

---

## 二、当前实现 vs 目标态 Gap 矩阵

### 2.1 命令级 Gap

| 目标命令 | 当前状态 | Gap |
|---|---|---|
| `run next --json` → 简要指针 | ✅ 存在，birth packet 含 step/run_id/queue | ⚠️ ralph 路径不走这里，走 `ralph next` 的 emitPrompt 重建全量 prompt |
| `run brief {run_id}` → 完整正文 | ✅ 存在，是权威注入点 | ⚠️ 仅 executor 调用；ralph emitPrompt 绕过它自行组装 |
| `run prepare {step}` → 预读/预览 | ✅ 存在，read-only 无状态 | ⚠️ 定位模糊：返回 prepare 全文但 workflow 只返回行数；与 brief 职责重叠 |
| `run done --verdict` → 完成 + continuation | ✅ 存在 | ⚠️ ralph 路径走 `ralph complete`，不走 `run done` |
| `run graph` → 链可视化 | ❌ 不存在 | 需新增 |
| `run status` → Session 概览 | ✅ 存在 | 含 progress/active_step/recovery，但无链步骤逐条视图 |
| `run start --chain-file` → 创建 Session | ✅ 存在 | Ralph SKILL.md 已在用 |
| `run decide` → 决策裁决 | ✅ 存在 | Ralph SKILL.md 已在用 |
| `run seal-session` → 关闭 | ✅ 存在 | Ralph SKILL.md 已在用 |

### 2.2 流程级 Gap

| Gap | 当前 | 目标 | 影响 |
|---|---|---|---|
| **G1: 双入口** | ralph 走 `ralph next` (emitPrompt)，run 走 `run next` (birth packet) | 统一为 `run next --json` | ralph emitPrompt 417 行全部冗余 |
| **G2: 正文双源** | ralph emitPrompt 组装 anchor+upstream+run-mode+body；brief 再组装一份 | brief 是唯一正文源 | 每步 ~2-4K tokens 冗余 + 4 处语义矛盾 |
| **G3: 完成双路径** | ralph 走 `ralph complete <idx> --status S`；run 走 `run done <run_id> --verdict v` | 统一为 `run done --verdict --json` | ralph complete 206 行冗余 |
| **G4: 无链视图** | queue preview 嵌在 birth packet 里（最多 3 条）；无独立命令 | `run graph --session {id}` 独立命令 | 编排器无法一览全局 |
| **G5: prepare 定位模糊** | 返回 prepare 全文 + workflow 行数 + run-mode 摘要 + refs + goal_mode + session_guidance | 明确为"预读/规划用"，执行正文走 brief | 与 brief 职责边界不清 |
| **G6: next 副作用** | `run next` 原子创建 Run（find + create 一步） | 保持（原子性好），但输出应精简为指针 | 当前 birth packet 已是指针级，问题在 ralph 不用它 |

### 2.3 数据流级 Gap

```
当前 ralph 路径（冗余）:
  ralph next
    ├─ resolveRalphSession()          ← session-adapter.ts (ralph 私有)
    ├─ checkLease()                   ← run/lease.ts (共享)
    ├─ runNextStep()                  ← run/next.ts (共享)
    │   ├─ resolveStepContent()       ← 第 1 次解析 .md
    │   ├─ createRun()                ← run/runtime.ts
    │   │   └─ resolveCommandSource() ← 第 2 次解析 .md
    │   └─ renderBirthPacket()        ← 输出 birth packet（ralph 不用这个）
    └─ emitPrompt()                   ← ralph 私有，重建全量 prompt
        ├─ buildSessionAnchor()       ← 重建 Intent/Boundary/Progress/Goals/Signals
        ├─ buildUpstreamSection()     ← 重建 upstream + prev handoff
        ├─ summarizeRunMode()         ← 注入 run-mode 摘要
        ├─ workflow.raw || prepare.raw← 注入 skill 正文
        ├─ buildRefsSection()         ← 重建 refs
        ├─ buildSkillConfigSection()  ← 重建 skill config
        └─ completionMeta             ← 注入完成指令（与 executor 约束矛盾）

  executor 收到后:
    └─ run brief {run_id}             ← 第 3+4 次解析 .md，重建全部上下文
        ├─ resolveStepContent()       ← 第 3 次
        ├─ contractForRun()           ← 第 4 次
        ├─ buildAnchorSections()      ← 又建一份 anchor
        └─ 返回 JSON（guidance + contract + continuity）

目标路径（精简）:
  run next --session {id} --json
    ├─ resolveStepContent()           ← 第 1 次（缓存）
    ├─ createRun()                    ← 原子创建
    └─ 输出: { run_id, step, queue }  ← 指针，无正文

  executor:
    └─ run brief {run_id} --json      ← 唯一正文源
        ├─ resolveStepContent()       ← 命中缓存
        └─ 输出: { guidance, contract, continuity }

  run done {run_id} --verdict --json
    └─ 输出: { continuation }         ← 驱动循环
```

---

## 三、`run graph` 命令设计

### 3.1 定位

独立的链可视化命令，让编排器（和人类）一览执行链全貌。
与 `run status`（Session 概览）和 `run next`（步进指针）互补。

### 3.2 接口

```bash
maestro run graph [--session <id>] [--json]
```

### 3.3 输出（人类可读模式）

```
Session: 20250723-fix-auth-bug
Intent:  修复认证模块的 token 刷新问题
Status:  running | Engine: ralph | Progress: 2/5

Chain:
  [0] ✓ analyze          (sealed, run: 20250723-001-analyze)
  [1] ✓ plan             (sealed, run: 20250723-002-plan)
  [2] ▶ execute          (running, run: 20250723-003-execute)  ← active
  [3] ◆ quality-gate     (pending, decision)
  [4] ○ review           (pending)

Decisions:
  quality-gate: pending (after: execute, retries: 0/2)

Goals:
  [x] G1: 分析 token 刷新失败根因
  [x] G2: 制定修复方案
  [ ] G3: 实现修复并通过测试
  [ ] G4: 代码审查

Upcoming:
  [3] ◆ quality-gate — decision node (evaluate after execute)
  [4] ○ review — pending execution
```

### 3.4 输出（JSON 模式）

```json
{
  "session_id": "20250723-fix-auth-bug",
  "intent": "修复认证模块的 token 刷新问题",
  "status": "running",
  "engine": "ralph",
  "progress": { "terminal": 2, "total": 5, "pending": 2, "running": 1 },
  "chain": [
    { "index": 0, "step_id": "S001", "command": "analyze", "status": "sealed", "run_id": "20250723-001-analyze", "decision_ref": null },
    { "index": 1, "step_id": "S002", "command": "plan", "status": "sealed", "run_id": "20250723-002-plan", "decision_ref": null },
    { "index": 2, "step_id": "S003", "command": "execute", "status": "running", "run_id": "20250723-003-execute", "decision_ref": null, "active": true },
    { "index": 3, "step_id": "S004", "command": "quality-gate", "status": "pending", "run_id": null, "decision_ref": "DP001" },
    { "index": 4, "step_id": "S005", "command": "review", "status": "pending", "run_id": null, "decision_ref": null }
  ],
  "decisions": [
    { "point_id": "DP001", "after_step_id": "S003", "status": "pending", "retry_count": 0, "max_retries": 2 }
  ],
  "goals": [
    { "id": "G1", "goal": "分析 token 刷新失败根因", "status": "done" },
    { "id": "G2", "goal": "制定修复方案", "status": "done" },
    { "id": "G3", "goal": "实现修复并通过测试", "status": "pending" },
    { "id": "G4", "goal": "代码审查", "status": "pending" }
  ],
  "position": { "lifecycle": "execute", "phase": 2, "milestone": "fix" },
  "continuation": { "action": "next", "command": "maestro run next --session 20250723-fix-auth-bug" }
}
```

### 3.5 实现位置

- 新建 `src/run/graph.ts`（~120 行）
- 读取 `SessionStore.readBundle()` + `activeStepIndex()` + decomposition
- 注册到 `src/commands/run.ts` 的 `run graph` 子命令
- 复用 `session-status.ts` 的 `summarizeSession()` 数据，增加逐步骤视图

---

## 四、`run prepare` 重新定位

### 4.1 当前问题

`run prepare` 返回 prepare 全文 + workflow **行数**（非正文）+ run-mode 摘要 + refs + goal_mode + session_guidance。
定位模糊：既不是执行正文（workflow 只给行数），也不是纯预览（prepare 给了全文）。

### 4.2 目标定位

**`run prepare` = 预读/规划工具**（read-only, stateless, pre-Run）

用途：
- 编排器在构建链之前预览某个 step 的内容和依赖
- 人类在手动执行前了解 step 要求
- 不绑定 Run，不创建任何状态

**`run brief` = 执行正文**（post-Run, 绑定 run_id）

用途：
- executor 获取完整执行上下文
- 单源注入：skill 正文 + upstream + prev handoff + contract + gates + refs

### 4.3 调整

| 字段 | 当前 prepare | 目标 prepare | 说明 |
|---|---|---|---|
| `prepare.content` | ✅ 全文 | ✅ 保留 | 预读用 |
| `workflow.line_count` | 仅行数 | 改为 `workflow.summary`（前 10 行或 frontmatter 摘要） | 预览足够，全文走 brief |
| `run_mode.summary` | 摘要 | ✅ 保留 | 预读用 |
| `refs` | ✅ | ✅ 保留 | 预读用 |
| `goal_mode` | ✅ | ✅ 保留 | 预读用 |
| `previous` | --session 时 | ✅ 保留 | 预读上下文 |
| `session_guidance` | --session 时 | ✅ 保留 | 链状态提醒 |
| `execution_contract` | ❌ | ❌ 不加 | 属于 brief |

---

## 五、收敛后的完整生命周期

```
┌──────────────────────────────────────────────────────────────────────┐
│  Ralph SKILL.md（prompt 层策略循环，不拥有 CLI）                       │
│                                                                      │
│  S_PARSE → S_RESOLVE → S_DECOMPOSE → S_BUILD → S_CREATE             │
│                                                                      │
│  S_CREATE:                                                           │
│    maestro run start "{intent}" --chain-file {path} --no-dispatch    │
│    → 返回 session_id                                                 │
│                                                                      │
│  S_LOOP:                                                             │
│    ┌─────────────────────────────────────────────────────────────┐   │
│    │  maestro run graph --session {id} --json  (可选，全局视图)    │   │
│    │                                                             │   │
│    │  maestro run next --session {id} --json                     │   │
│    │  → { run_id, step: {index, command}, queue: [...] }         │   │
│    │  → 简要指针，不含 skill 正文                                  │   │
│    │                                                             │   │
│    │  dispatch run-executor(session_id, run_id)                  │   │
│    │  ┌───────────────────────────────────────────────────────┐  │   │
│    │  │  run brief {run_id} --session {id} --json             │  │   │
│    │  │  → guidance: { prepare, workflow, run_mode, refs }    │  │   │
│    │  │  → execution_contract: { inputs, outputs, gates }     │  │   │
│    │  │  → continuity: { prev_handoff, anchor }               │  │   │
│    │  │                                                       │  │   │
│    │  │  执行 skill 正文                                       │  │   │
│    │  │                                                       │  │   │
│    │  │  run check {run_id} --session {id}                    │  │   │
│    │  │  → gates clean → finish checklist                     │  │   │
│    │  │                                                       │  │   │
│    │  │  返回: { run_id, status, summary, artifacts }         │  │   │
│    │  └───────────────────────────────────────────────────────┘  │   │
│    │                                                             │   │
│    │  maestro run done {run_id} --session {id}                   │   │
│    │    --verdict done --summary "..." --json                    │   │
│    │  → continuation: { action: "next", command: "run next" }   │   │
│    │                                                             │   │
│    │  根据 continuation.action:                                   │   │
│    │    "next"  → 回到循环顶部                                     │   │
│    │    "decide"→ run decide {point_id} --json → 读 continuation  │   │
│    │    "seal"  → run seal-session {id} → S_DONE                 │   │
│    └─────────────────────────────────────────────────────────────┘   │
│                                                                      │
│  S_EVALUATE (decision node):                                         │
│    dispatch evaluator → run decide {point_id} --verdict ... --json   │
│    → continuation 驱动循环                                            │
│                                                                      │
│  S_DONE:                                                             │
│    maestro run seal-session {id} --summary "..."                     │
└──────────────────────────────────────────────────────────────────────┘
```

### 命令职责边界（收敛后）

| 命令 | 职责 | 读/写 | 输出 |
|---|---|---|---|
| `run start` | 创建 Session + 链 | 写 | session_id |
| `run graph` | **链全景视图** | 读 | 逐步骤 + decisions + goals + position |
| `run next` | **步进指针**：找 pending step + 原子创建 Run | 写 | run_id + step 元数据 + queue preview |
| `run prepare` | **预读/规划**：step 内容预览 + 依赖 | 读 | prepare 全文 + workflow 摘要 + refs |
| `run brief` | **执行正文**（唯一注入点） | 读 | skill 全文 + contract + upstream + anchor |
| `run check` | gate 检查 + finish checklist | 读 | gates + finish |
| `run done` | 完成 Run + 链推进 | 写 | continuation（驱动循环） |
| `run decide` | 决策裁决 | 写 | continuation |
| `run seal-session` | 关闭 Session | 写 | 终态 |
| `run status` | Session 概览 | 读 | progress + active_step + recovery |

### 不存在的命令（全部删除）

| 命令 | 替代 |
|---|---|
| `maestro ralph next` | `maestro run next --json` |
| `maestro ralph complete` | `maestro run done --verdict --json` |
| `maestro ralph retry` | `maestro run done --verdict needs-retry` |
| `maestro ralph check` | `maestro session check` |
| `maestro ralph session` | `maestro run status` / `maestro run graph` |
| `maestro ralph skills` | `maestro skills` |
| `maestro ralph ledger` | `maestro session evidence` |

---

## 六、实施任务清单

### Phase A: 新增 `run graph`（独立，无破坏）

- [ ] **A1** 新建 `src/run/graph.ts`：
  - `buildGraph(sessionId)` → 逐步骤 chain + decisions + goals + position + continuation
  - 复用 `SessionStore.readBundle()` + `activeStepIndex()` + `effectiveDecomposition` 逻辑
  - 人类可读模式：`✓/▶/◆/○` 图标 + 缩进
  - JSON 模式：结构化输出

- [ ] **A2** 注册 `run graph` 子命令到 `src/commands/run.ts`：
  - `--session <id>`（可选，默认 resolve 唯一 running session）
  - `--json`

- [ ] **A3** Ralph SKILL.md 的 S_LOOP 入口增加可选 `run graph` 调用

### Phase B: 统一步进循环（消除 ralph 私有路径）

- [ ] **B1** Ralph SKILL.md 的 A_EXECUTE 改为：
  ```
  run next --session {id} --json → 提取 run_id
  dispatch run-executor(session_id, run_id)
  run done {run_id} --session {id} --verdict {v} --json → 读 continuation
  ```
  删除所有 `maestro ralph next/complete/retry` 调用

- [ ] **B2** 确认 `run next --json` 的 birth packet 满足编排器需求：
  - ✅ run_id, step.index, step.command, step.total
  - ✅ queue preview (后续 3 步)
  - ✅ prev_handoff (前序摘要)
  - ✅ entry_gates + blockers
  - ✅ refs (延迟读取清单)
  - 如需补充：增加 `goals_summary` 字段（当前仅在 ralph anchor 中）

- [ ] **B3** 确认 `run done --json` 的 continuation 满足循环驱动：
  - ✅ action: next | decide | seal | recover
  - ✅ command: 下一步具体命令
  - ✅ preconditions: 前置条件
  - 如需补充：增加 `queue_snapshot`（done 后的链状态快照）

### Phase C: 删除 ralph 私有 CLI（Phase B 完成后）

- [ ] **C1** 删除 `src/ralph/cmd-next.ts`（417 行）— emitPrompt 全部冗余
- [ ] **C2** 删除 `src/ralph/cmd-complete.ts`（206 行）— run done 已覆盖
- [ ] **C3** 删除 `src/ralph/cmd-check.ts`（69 行）— session check 已覆盖
- [ ] **C4** 删除 `src/ralph/cmd-session.ts`（75 行）— run graph / run status 已覆盖
- [ ] **C5** 删除 `src/ralph/cmd-ledger.ts`（164 行）— session evidence 已覆盖
- [ ] **C6** 删除 `src/commands/ralph.ts` 整个命令注册 + cli.ts 引用

### Phase D: session-adapter 合入 + 清理

- [ ] **D1** `effectivePosition/Decomposition/Lease` 合入 `run/` 模块
- [ ] **D2** `resolveRalphSession` 合入 `run/session-resolver.ts`
- [ ] **D3** `createRalphSession` 合入 `run/chain-admin.ts`
- [ ] **D4** ralph-meta.json fallback 保留在 `run/migrate.ts`，设 sunset
- [ ] **D5** 删除 `src/ralph/` 目录，测试迁移
- [ ] **D6** 清理 hooks 中 ralph 特殊分支

### Phase E: 性能优化（可并行）

- [ ] **E1** `resolveStepContent/CommandSource` 进程级缓存
- [ ] **E2** `run next --json` 可选 `--inline-brief`（省去 executor 一次 CLI 往返）
- [ ] **E3** handoff 遍历合并

### Phase F: prepare 重定位

- [ ] **F1** `run prepare` 的 workflow 字段从 `line_count` 改为 `summary`（前 10 行）
- [ ] **F2** 文档明确：prepare = 预读/规划（pre-Run），brief = 执行正文（post-Run）

---

## 七、依赖图

```
A (run graph)  ──────────────────────────────┐
                                              │
B (SKILL.md 统一循环) ──→ C (删除 ralph CLI) ──→ D (合入 + 清理)
                                              │
E (性能优化，并行) ─────────────────────────────┤
                                              │
F (prepare 重定位，并行) ──────────────────────┘
```

## 八、关键设计决策

| 决策 | 选择 | 理由 |
|---|---|---|
| `run next` 是否创建 Run | **是，保持原子创建** | 避免 peek-then-create 竞态；birth packet 已是指针级 |
| 正文注入点 | **brief 唯一** | 消除双源冗余和语义矛盾 |
| `run prepare` 定位 | **预读/规划（read-only）** | 与 brief 职责分离：prepare 在 Run 前，brief 在 Run 后 |
| `run graph` vs `run status` | **互补**：graph = 逐步骤链视图，status = Session 概览 | 编排器需要链全景来规划 |
| ralph engine 标识 | **保留 `engine: 'ralph'`** 作为历史值 | 不破坏已有 session；新 session 可用同值 |
| ralph-meta.json | **保留 read fallback，不写新文件** | 1.0 session 兼容；sunset 后删除 |
