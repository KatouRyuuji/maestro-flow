# Maestro Session / Run 职责分离架构

> ⚠️ **本文档已被 [conflict-resolution.md](./conflict-resolution.md) 修正。以下为修正要点：**
> - Run 生命周期：~~create → brief → execute → check → done~~ → **create(session next) → execute → check → done**；brief 仅回溯
> - 正常流程正文来源：**`session next --inline-brief`** 内联，非单独调 `run brief`
> - 每步 CLI：**3 次**（session next + run check + session done）
>
> 本文档的 Session/Run 职责分离方案（session 命令面 vs run 命令面）为最终采纳方案。

## 一、核心概念模型

```
┌─────────────────────────────────────────────────────────────────┐
│  Session（编排容器）                                              │
│                                                                  │
│  职责: 管理 Run 生命周期 + Chain 分解 + 进度追踪 + 决策裁决        │
│                                                                  │
│  ┌─────────────────────────────────────────────────────────┐     │
│  │  Chain（执行链）                                         │     │
│  │  [0] analyze → [1] plan → [2] execute → [3] ◆gate → [4] review │
│  └─────────────────────────────────────────────────────────┘     │
│                                                                  │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐                       │
│  │  Run 001 │  │  Run 002 │  │  Run 003 │  ← chain-bound runs   │
│  │ (sealed) │  │ (sealed) │  │ (running)│                       │
│  └──────────┘  └──────────┘  └──────────┘                       │
│                                                                  │
│  ┌──────────┐                                                    │
│  │  Run 004 │  ← independent run（独立创建，注册进 session）       │
│  │ (sealed) │                                                    │
│  └──────────┘                                                    │
│                                                                  │
│  Artifacts / Evidence / Gates / Decomposition / Position         │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│  Run（执行单元）                                                  │
│                                                                  │
│  职责: 承载一次 Skill 执行的完整上下文                              │
│                                                                  │
│  生命周期: create → brief → execute → check → done               │
│                                                                  │
│  内容: guidance(prepare+workflow) + contract + upstream + anchor  │
│  产物: outputs/ + report.md + evidence/                          │
│  交接: handoff (summary + decisions + concerns + next)           │
└─────────────────────────────────────────────────────────────────┘
```

### 关键关系

| 关系 | 说明 |
|---|---|
| Session 1:N Run | 一个 Session 管理多个 Run |
| Chain step 1:1 Run | 链步骤与 Run 一一绑定（`session next` 原子创建） |
| Independent Run → Session | 独立 Run 通过 topic matching 注册进已有 Session |
| Session 拥有 Chain | 链的 insert/skip/replace 是 Session 级操作 |
| Run 拥有 Content | brief/check/done 是 Run 级操作 |

---

## 二、当前问题：`maestro run` 是 God Command

当前 `maestro run` 混合了两个层级的操作：

```
maestro run
  ├── [Session 级] start        ← 创建 Session + Chain
  ├── [Session 级] next         ← 推进 Chain + 创建 Run
  ├── [Session 级] status       ← Session 概览
  ├── [Session 级] recover      ← Session 恢复
  ├── [Session 级] decide       ← 决策裁决
  ├── [Session 级] seal-session ← 关闭 Session
  ├── [Session 级] edit         ← 编辑 Chain
  ├── [Session 级] mutations    ← 变更审计
  │
  ├── [Run 级]     create       ← 创建独立 Run
  ├── [Run 级]     brief        ← 读取执行正文
  ├── [Run 级]     check        ← 检查 gates
  ├── [Run 级]     done         ← 完成 Run
  ├── [Run 级]     complete     ← 完成 Run（底层）
  ├── [Run 级]     rebind       ← 重绑定 prompt
  ├── [Run 级]     accept-reuse ← 接受复用评估
  │
  ├── [混合]       prepare      ← 预读（无状态，但含 session guidance）
  ├── [混合]       recall       ← 历史 Run 回忆
  └── [混合]       skill        ← 一次性 skill 执行
```

而 `maestro session` 被隐藏（`hidden: true`），处理的是：
- 管理: resolve, resume, migrate, list, show, status, check, evidence, seal, create
- 链编辑: chain insert/skip/replace
- 元数据: meta update

**问题**: 编排器（Ralph/Coordinator）需要的是 Session 级视图，但被迫通过 `maestro run` 这个 Run 级命名空间操作。Executor 需要的是 Run 级操作，但 `run next`/`run done` 实际是 Session 级。

---

## 三、目标架构：职责分离

### 3.1 `maestro session`（编排器命令面）

**定位**: 编排器（Ralph SKILL.md / Coordinator / 人类）的操作界面。
管理 Session 生命周期、Chain 步进、Run 注册、全局视图。

```
maestro session
  │
  ├── 生命周期 ─────────────────────────────────────────────
  │   create <topic>          创建 Session + Chain
  │   status [id]             Session 概览（progress/active/recovery）
  │   graph [id]              链全景视图（逐步骤 + decisions + goals）  ← 新增
  │   seal <id>               关闭 Session
  │   list                    列出所有 Session
  │   show <id>               原始 session.json
  │   check [id]              验证 Session 完整性
  │
  ├── 步进循环 ─────────────────────────────────────────────
  │   next [--session id]     推进 Chain → 原子创建 Run → 返回指针
  │                           输出: { run_id, step, queue_preview }
  │   done <run-id>           完成 Run 步骤 → 返回 continuation
  │                           输出: { continuation: { action, command } }
  │   decide <point-id>       决策裁决 → 返回 continuation
  │
  ├── Chain 编辑 ───────────────────────────────────────────
  │   chain insert            插入步骤
  │   chain skip              跳过步骤
  │   chain replace           替换步骤
  │   edit [commands...]      批量编辑（兼容）
  │
  ├── 恢复 ─────────────────────────────────────────────────
  │   recover                 解决 paused blocker / resume
  │   resolve                 解决单个 escalated decision/step
  │   resume                  恢复 cleared Session
  │
  ├── 元数据 ───────────────────────────────────────────────
  │   meta update             更新 position / decomposition
  │   evidence [id]           查询 Evidence Registry
  │   migrate                 ralph-meta → session.json 迁移
  │   mutations               变更审计日志
  │
  └── Run 注册 ─────────────────────────────────────────────
      （独立 Run 通过 topic matching 自动注册，无需显式命令）
      （chain-bound Run 由 session next 原子创建）
```

### 3.2 `maestro run`（执行器命令面）

**定位**: Executor（run-executor agent）的操作界面。
单个 Run 的执行上下文读取、gate 检查、产物管理。

```
maestro run
  │
  ├── 执行上下文 ───────────────────────────────────────────
  │   brief <run-id>          唯一正文注入点
  │                           输出: guidance + contract + upstream + anchor
  │   prepare <step>          预读/规划（read-only, stateless, pre-Run）
  │                           输出: prepare 全文 + workflow 摘要 + refs
  │
  ├── 质量门 ───────────────────────────────────────────────
  │   check <run-id>          检查 entry/exit gates + finish checklist
  │
  ├── 独立创建 ─────────────────────────────────────────────
  │   create <command>        创建独立 Run（自动注册进 topic-matched Session）
  │   skill <step>            一次性 skill 执行（无 Session 绑定）
  │
  ├── 维护 ─────────────────────────────────────────────────
  │   rebind <run-id>         prompt-only drift 重绑定
  │   accept-reuse <run-id>   接受 REVIEW 复用评估
  │   recall <command>        历史 Run 回忆（read-only）
  │
  └── 完成（底层）───────────────────────────────────────────
      complete [run-id]       底层完成逻辑（session done 调用它）
```

### 3.3 命令归属对照

| 当前命令 | 当前位置 | 目标位置 | 理由 |
|---|---|---|---|
| `run start` | run | **session create** | 创建 Session 是 Session 级操作 |
| `run next` | run | **session next** | 推进 Chain 是 Session 级操作 |
| `run status` | run | **session status** | Session 概览 |
| `run recover` | run | **session recover** | Session 恢复 |
| `run decide` | run | **session decide** | 决策是 Session 级 |
| `run seal-session` | run | **session seal** | 关闭 Session |
| `run edit` | run | **session chain edit** | Chain 编辑 |
| `run mutations` | run | **session mutations** | 审计 |
| `run done` | run | **session done** | 完成 Run 步骤 + 链推进 + continuation |
| `run brief` | run | **run brief** ✅ | Run 级，保持不变 |
| `run check` | run | **run check** ✅ | Run 级，保持不变 |
| `run create` | run | **run create** ✅ | 独立 Run 创建 |
| `run prepare` | run | **run prepare** ✅ | 预读，Run 级 |
| `run complete` | run | **run complete** ✅ | 底层完成逻辑 |
| `run rebind` | run | **run rebind** ✅ | Run 维护 |
| `run accept-reuse` | run | **run accept-reuse** ✅ | Run 维护 |
| `run recall` | run | **run recall** ✅ | Run 历史 |
| `run skill` | run | **run skill** ✅ | 一次性执行 |
| `session *` | session(hidden) | **session *** ✅ | 取消 hidden，成为主命令面 |

### 3.4 兼容别名（过渡期）

```
maestro run next       → alias for maestro session next（stderr 警告）
maestro run start      → alias for maestro session create（stderr 警告）
maestro run status     → alias for maestro session status（stderr 警告）
maestro run done       → alias for maestro session done（stderr 警告）
maestro run decide     → alias for maestro session decide（stderr 警告）
maestro run seal-session → alias for maestro session seal（stderr 警告）
maestro run recover    → alias for maestro session recover（stderr 警告）
maestro run edit       → alias for maestro session chain edit（stderr 警告）
```

---

## 四、收敛后的 Ralph 生命周期

```
Ralph SKILL.md（prompt 层策略循环）
│
├─ S_CREATE:
│   maestro session create "{intent}" --chain-file {path}
│   → { session_id, chain: { total, steps } }
│
├─ S_LOOP:
│   ┌─────────────────────────────────────────────────────────┐
│   │  maestro session graph --session {id}  (可选，全局视图)   │
│   │  → 逐步骤链 + decisions + goals + position              │
│   │                                                         │
│   │  maestro session next --session {id} --json             │
│   │  → { run_id, step: {index, command}, queue: [...] }     │
│   │  → 简要指针，Run 已原子创建                               │
│   │                                                         │
│   │  dispatch run-executor(session_id, run_id)              │
│   │  ┌───────────────────────────────────────────────────┐  │
│   │  │  maestro run brief {run_id} --session {id}        │  │
│   │  │  → 唯一正文: skill + contract + upstream + anchor │  │
│   │  │                                                   │  │
│   │  │  执行 skill                                       │  │
│   │  │                                                   │  │
│   │  │  maestro run check {run_id}                       │  │
│   │  │  → gates + finish checklist                       │  │
│   │  │                                                   │  │
│   │  │  返回: { run_id, status, summary, artifacts }     │  │
│   │  └───────────────────────────────────────────────────┘  │
│   │                                                         │
│   │  maestro session done {run_id} --session {id}           │
│   │    --verdict done --summary "..." --json                │
│   │  → { continuation: { action: "next", command: "..." } } │
│   │                                                         │
│   │  continuation.action:                                   │
│   │    "next"   → 回到循环顶部                                │
│   │    "decide" → session decide {point_id} → continuation  │
│   │    "seal"   → session seal {id} → S_DONE               │
│   └─────────────────────────────────────────────────────────┘
│
├─ S_EVALUATE (decision):
│   dispatch evaluator → maestro session decide {point_id} --json
│   → continuation 驱动循环
│
└─ S_DONE:
    maestro session seal {id} --summary "..."
```

### 命令调用频次（每步）

| 角色 | 命令 | 次数/步 |
|---|---|---|
| 编排器 | `session next` | 1 |
| 编排器 | `session done` | 1 |
| 编排器 | `session graph` | 0-1（可选） |
| Executor | `run brief` | 1 |
| Executor | `run check` | 1-2 |
| **总计** | | **3-5 次 CLI 调用/步** |

---

## 五、`session graph` 设计

### 接口

```bash
maestro session graph [--session <id>] [--json]
```

### 人类可读输出

```
Session: 20250723-fix-auth-bug
Intent:  修复认证模块的 token 刷新问题
Status:  running | Engine: ralph | Quality: standard
Progress: 2/5 sealed, 1 running, 2 pending

Chain:
  [0] ✓ analyze          sealed   run:20250723-001
  [1] ✓ plan             sealed   run:20250723-002
  [2] ▶ execute          running  run:20250723-003  ← active
  [3] ◆ quality-gate     pending  decision:DP001
  [4] ○ review           pending

Decisions:
  DP001 quality-gate: pending (after:execute, retries:0/2)

Goals:
  [x] G1: 分析 token 刷新失败根因
  [x] G2: 制定修复方案
  [ ] G3: 实现修复并通过测试 — done_when: 所有测试通过
  [ ] G4: 代码审查 — done_when: review 无 blocking issue

Position: execute | Phase 2 | Milestone: fix

Next: maestro session next --session 20250723-fix-auth-bug
```

### JSON 输出

```json
{
  "session_id": "...",
  "intent": "...",
  "status": "running",
  "engine": "ralph",
  "quality_mode": "standard",
  "progress": { "sealed": 2, "running": 1, "pending": 2, "total": 5 },
  "chain": [
    { "index": 0, "step_id": "S001", "command": "analyze", "status": "sealed", "run_id": "...", "decision_ref": null, "active": false },
    { "index": 2, "step_id": "S003", "command": "execute", "status": "running", "run_id": "...", "decision_ref": null, "active": true }
  ],
  "decisions": [
    { "point_id": "DP001", "status": "pending", "after_step_id": "S003", "retry_count": 0, "max_retries": 2 }
  ],
  "goals": [
    { "id": "G1", "goal": "...", "status": "done", "done_when": "..." }
  ],
  "position": { "lifecycle": "execute", "phase": 2, "milestone": "fix" },
  "continuation": { "action": "next", "command": "maestro session next --session ..." }
}
```

### 实现

- 新建 `src/run/graph.ts`（~150 行）
- 复用 `SessionStore.readBundle()` + `activeStepIndex()` + decomposition/position readers
- 注册到 `src/commands/session.ts`

---

## 六、`session next` vs `run create` 的区别

| 维度 | `session next` | `run create` |
|---|---|---|
| 触发者 | 编排器（Ralph/Coordinator） | 人类 / 独立脚本 |
| Chain 绑定 | 原子绑定到下一个 pending step | 不绑定 chain（独立 Run） |
| Session 选择 | 必须指定 `--session` 或 resolve 唯一 running | topic matching 自动注册 |
| 输出 | 简要指针（run_id + step + queue） | Run 创建确认 |
| 后续 | executor 调 `run brief` 读正文 | 调 `run brief` 或直接执行 |
| 链推进 | 步骤状态 pending → running | 不影响 chain |

**独立 Run 注册**: `run create` 通过 topic matching 找到兼容 Session 后，Run 记录在 Session 的 runs/ 目录下，但**不绑定 chain step**。Session 的 `graph` 可以展示这些独立 Run 作为"附加执行记录"。

---

## 七、实施任务清单

### Phase 1: 提升 `maestro session` 为主命令面

- [ ] **1.1** 取消 `session` 命令的 `hidden: true`
- [ ] **1.2** 将 `run start` 逻辑合入 `session create`（`run start` 保留为 alias）
- [ ] **1.3** 将 `run next` 注册为 `session next`（`run next` 保留为 alias）
- [ ] **1.4** 将 `run done` 注册为 `session done`（`run done` 保留为 alias）
- [ ] **1.5** 将 `run decide` 注册为 `session decide`（`run decide` 保留为 alias）
- [ ] **1.6** 将 `run seal-session` 合入 `session seal`（`run seal-session` 保留为 alias）
- [ ] **1.7** 将 `run status` 合入 `session status`（`run status` 保留为 alias）
- [ ] **1.8** 将 `run recover` 合入 `session recover`（`run recover` 保留为 alias）
- [ ] **1.9** 将 `run edit` 合入 `session chain edit`（`run edit` 保留为 alias）

### Phase 2: 新增 `session graph`

- [ ] **2.1** 新建 `src/run/graph.ts`
- [ ] **2.2** 注册 `session graph` 子命令
- [ ] **2.3** 支持 `--json` 和人类可读两种输出

### Phase 3: 精简 `maestro run` 为执行器命令面

- [ ] **3.1** `run` 命令保留: brief, check, create, prepare, skill, complete, rebind, accept-reuse, recall
- [ ] **3.2** `run` 命令移除（改为 alias）: start, next, status, done, decide, seal-session, recover, edit, mutations
- [ ] **3.3** 所有 alias 输出 stderr deprecation 警告

### Phase 4: 更新 SKILL.md + Agent 定义

- [ ] **4.1** `maestro-ralph SKILL.md` 全部改为 `maestro session ...` 调用
- [ ] **4.2** `run-executor.md` 确认只使用 `maestro run brief/check`
- [ ] **4.3** `orchestrator-run-loop.md` 更新命令引用
- [ ] **4.4** 删除 `maestro ralph` 全部私有 CLI

### Phase 5: 清理

- [ ] **5.1** 删除 `src/ralph/` 目录（有效代码已合入 run/）
- [ ] **5.2** 删除 `src/commands/ralph.ts`
- [ ] **5.3** 清理 hooks 中 ralph 特殊分支
- [ ] **5.4** 性能优化（resolveStepContent 缓存、handoff 遍历合并）

### 依赖图

```
Phase 1 (session 提升) ──→ Phase 3 (run 精简) ──→ Phase 5 (清理)
       │                                              ↑
       └──→ Phase 2 (graph) ──→ Phase 4 (SKILL.md) ──┘
```

---

## 八、设计决策记录

| 决策 | 选择 | 理由 |
|---|---|---|
| Session vs Run 命名空间 | Session = 编排器面，Run = 执行器面 | 职责分离，减少 god command |
| `session next` 是否创建 Run | 是，原子创建 | 避免竞态；与当前 `run next` 行为一致 |
| `session done` vs `run done` | `session done` 是主命令 | 完成 Run 步骤 + 链推进 + continuation 是 Session 级 |
| `run complete` 保留位置 | 留在 `run`（底层） | `session done` 内部调用它；executor 不直接调 |
| 独立 Run 注册 | topic matching 自动注册 | 无需显式命令；`run create` 已实现 |
| `run prepare` 定位 | 预读/规划（pre-Run, stateless） | 与 `run brief`（post-Run, 执行正文）分离 |
| 兼容别名保留 | 2-3 个版本 | 外部脚本/CI 平滑迁移 |
| `session graph` vs `session status` | 互补：graph = 逐步骤链视图，status = 概览 | 编排器需要链全景 |
