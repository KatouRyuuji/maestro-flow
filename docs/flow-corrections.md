# 流程修正：Finish 注入时机 / Brief 定位 / 多 Session 并行

> ✅ **本文档的三项修正已被 [conflict-resolution.md](./conflict-resolution.md) 全部采纳为最终决议。**
> 对 flow-efficiency-optimizations.md 的三项关键修正。

---

## 修正 1: check→done 不可合并 — Finish Work 注入时机

### 问题

O1 提议合并 check 和 done，但忽略了 **finish checklist 的注入时机**。

### 当前 Finish 注入流程

```
executor 执行 skill 完毕
  │
  ▼
maestro run check {run_id}
  ├─ scanOutputs() → 扫描 outputs/
  ├─ evaluateRunGates() → 评估 entry/exit gates
  │
  ├─ gates 有 blocking?
  │   YES → 返回 { gates, errors, next: "repair then re-check" }
  │         executor 修复 → 重新 check（最多 2 轮）
  │
  │   NO → 返回 { gates: clean, finish: [...] }  ← ⚡ finish checklist 注入点
  │         ┌─────────────────────────────────────────────────┐
  │         │  Finish Checklist 内容:                          │
  │         │  1. report.md handoff frontmatter 是否为空       │
  │         │  2. 知识沉淀提醒（spec add / knowhow capture）    │
  │         │  3. 矛盾 spec 标记提醒                           │
  │         │  4. verdict 选择提醒（done vs done-with-concerns）│
  │         │  5. workflow frontmatter finish: 自定义行         │
  │         └─────────────────────────────────────────────────┘
  │
  ▼
executor 执行 finish work（写 report.md、沉淀知识、选择 verdict）
  │
  ▼
maestro session done {run_id} --verdict done --json
  ├─ completeRun() → 内部再次 scanOutputs + evaluateRunGates  ← 重复！
  ├─ deriveHandoff() → 从 report.md frontmatter 派生 handoff
  ├─ chain 推进
  └─ 返回 continuation
```

### 修正方案

**check 和 done 保持分离**，但消除 done 内部的重复扫描：

```
run check（保留，是 finish work 的注入点）
  → gates clean → 返回 finish checklist
  → 写入 .check_clean 标记文件（含时间戳 + gate revision）

session done（优化，跳过重扫）
  → 读取 .check_clean 标记
  → 如果标记存在 && outputs/ 无新修改（mtime 对比）
    → 跳过 scanOutputs + evaluateRunGates
    → 直接 deriveHandoff + chain 推进 + continuation
  → 如果标记不存在 || outputs/ 有变更
    → 正常重扫（安全回退）
```

### 正确的每步流程

```
session next --inline-brief --json     ← 1. 拿指针 + 正文
  执行 skill                           ← 2. 执行
run check {run_id}                     ← 3. gate 检查 + finish checklist 注入
  执行 finish work                     ← 4. 写 report / 沉淀知识
session done {run_id} --verdict done   ← 5. 完成（跳过重扫）+ continuation
```

**每步 3 次 CLI**（next + check + done），不是 2 次。check 不可省略。

---

## 修正 2: Brief 定位为回溯工具，非正常流程

### 问题

O2 提议 `session next --inline-brief`，但将 `run brief` 定位为正常流程的一部分。
实际上 **brief 是回溯/重附加工具**，正常前向流程不应经过它。

### Brief 的正确使用场景

| 场景 | 是否用 brief | 说明 |
|---|---|---|
| 正常前向执行 | ❌ | `session next --inline-brief` 已包含正文 |
| executor 崩溃/重启后重附着 | ✅ | 上下文丢失，需要重新加载 |
| 人类手动介入某个 Run | ✅ | 需要看当前 Run 的完整状态 |
| 调试/检查某个 Run | ✅ | 需要看 contract/gates/upstream |
| 跨 turn 恢复（agent 上下文窗口溢出） | ✅ | 重新注入执行上下文 |

### 修正后的正常流程

```
正常流程（无 brief）:
  session next --inline-brief --json
    → { run_id, step, queue, brief: { guidance, contract, continuity } }
  dispatch executor(session_id, run_id, brief_data)
    → executor 直接从 brief_data 执行，不调任何 CLI 读正文
    → 执行完 → run check → finish work → 返回
  session done --verdict done --json
    → continuation

回溯流程（用 brief）:
  executor 崩溃 / 上下文丢失
    → maestro run brief {run_id} --session {id} --json
    → 重新获取完整执行上下文
    → 继续执行
```

### 对 run-executor agent 的影响

```markdown
# run-executor 修正

## 正常路径
收到 dispatch prompt 含 inline brief 数据 → 直接执行，不调 run brief

## 回溯路径
收到 dispatch prompt 仅含 session_id + run_id（无 brief 数据）
  → 调 run brief {run_id} --session {id} 加载正文
  → 然后执行
```

### inline-brief 的数据结构

`session next --inline-brief --json` 返回：

```json
{
  "run_id": "20250723-003-execute",
  "run_dir": ".workflow/sessions/X/runs/20250723-003-execute",
  "step": { "index": 2, "total": 5, "command": "execute", "step_id": "S003" },
  "queue": [
    { "index": 3, "command": "quality-gate", "is_decision": true },
    { "index": 4, "command": "review", "is_decision": false }
  ],
  "brief": {
    "guidance": {
      "prepare": { "path": "...", "content": "..." },
      "workflow": { "path": "...", "content": "..." },
      "run_mode": { "path": "...", "content": "..." },
      "refs": [{ "path": "...", "when": "..." }],
      "goal_mode": null
    },
    "execution_contract": {
      "inputs": [...],
      "outputs": { "declared": [...], "actual": [] },
      "gates": { "items": [...] }
    },
    "continuity": {
      "prev_handoff": { "run_id": "...", "summary": "...", "concerns": [] },
      "anchor": { "intent": "...", "boundary_contract": "...", "progress": "..." }
    }
  },
  "continuation": {
    "after_done": "maestro session done {run_id} --session X --verdict done --json"
  }
}
```

---

## 修正 3: 多 Session 并行开发

### 问题

O3 提议用 `state.json` 的 `active_session_id`（单数）做快速路径。
但开发者可能同时推进多个 Session（如：一个修 bug，一个做 feature）。

### 当前状态

```typescript
// state-schema.ts
interface StateJsonV2 {
  active_session_id?: string | null;  // ← 单数！
  sessions?: ProjectSessionEntry[];   // ← 已有 session 列表
}
```

`resolveSession` 的逻辑：
1. 显式 `--session <id>` → 直接使用
2. `state.active_session_id` → 快速路径（仅单个）
3. 扫描所有 running sessions → 如果唯一则使用，多个则报 ambiguous

### 修正方案

**不依赖 active_session_id 做唯一快速路径**，改为：

```typescript
// 解析优先级
function resolveSession(projectRoot, store, sessionId?) {
  // 1. 显式指定 → 最快
  if (sessionId) return directRead(sessionId);

  // 2. 环境变量（编排器注入）
  const envSession = process.env.MAESTRO_SESSION_ID;
  if (envSession && store.sessionExists(envSession)) return directRead(envSession);

  // 3. 最近活跃 session（按 activity_revision 排序，取最近的 running）
  const state = readStateJson(projectRoot);
  const recentRunning = (state.sessions ?? [])
    .filter(s => s.status === 'running')
    .sort((a, b) => (b.last_activity ?? 0) - (a.last_activity ?? 0));
  if (recentRunning.length === 1) return directRead(recentRunning[0].session_id);

  // 4. 多个 running → 要求显式指定（不猜测）
  if (recentRunning.length > 1) {
    return ambiguous(recentRunning);  // 列出候选，要求 --session
  }

  // 5. 全量扫描 fallback
  return scanAllSessions();
}
```

### 编排器适配

| 编排器 | Session 传递方式 |
|---|---|
| Ralph SKILL.md | 创建时拿到 session_id，后续所有命令显式传 `--session {id}` |
| Coordinator | graph-walker 持有 session_id，显式传递 |
| 人类（单 session） | 省略 `--session`，自动 resolve 唯一 running |
| 人类（多 session） | 必须传 `--session`，或用 `MAESTRO_SESSION_ID` 环境变量 |
| run-executor | dispatch prompt 含 session_id，所有命令显式传 |

### state.json 扩展

```typescript
interface StateJsonV2 {
  // 保留（向后兼容），但不再作为唯一快速路径
  active_session_id?: string | null;

  // 已有，增加 last_activity 时间戳
  sessions?: Array<{
    session_id: string;
    intent: string;
    status: string;
    last_activity?: string;  // ← 新增：ISO 时间戳
    // ...
  }>;
}
```

每次 `session next` / `session done` 更新对应 session 的 `last_activity`。

### 快速路径优化（兼容多 session）

```
显式 --session X        → O(1) 直接读取           ~1ms
MAESTRO_SESSION_ID=X    → O(1) 直接读取           ~1ms
唯一 running session    → O(1) 从 state.json 读取  ~2ms
多个 running sessions   → 报错，要求 --session     ~0ms（不扫描）
无 running sessions     → 全量扫描 fallback        ~10ms
```

---

## 修正后的完整每步流程

```
┌─────────────────────────────────────────────────────────────────┐
│  编排器（Ralph / Coordinator / 人类）                             │
│                                                                  │
│  1. maestro session next --session X --inline-brief --json       │
│     → { run_id, step, queue, brief: { guidance, contract,       │
│         continuity } }                                           │
│     → Run 已原子创建，正文已内联                                   │
│                                                                  │
│  2. dispatch run-executor(session_id, run_id, brief_data)        │
│     ┌───────────────────────────────────────────────────────┐    │
│     │  executor 从 brief_data 直接执行（正常路径不调 brief）   │    │
│     │                                                       │    │
│     │  执行 skill 正文                                       │    │
│     │                                                       │    │
│     │  3. maestro run check {run_id} --session X            │    │
│     │     → gates clean → finish checklist 注入              │    │
│     │     → gates blocking → 修复 → 重新 check（≤2 轮）      │    │
│     │                                                       │    │
│     │  4. 执行 finish work                                   │    │
│     │     → 写 report.md handoff                            │    │
│     │     → 知识沉淀（spec/knowhow）                          │    │
│     │     → 选择 verdict                                     │    │
│     │                                                       │    │
│     │  返回: { run_id, status, summary, artifacts }          │    │
│     └───────────────────────────────────────────────────────┘    │
│                                                                  │
│  5. maestro session done {run_id} --session X                    │
│       --verdict done --summary "..." --json                      │
│     → 检测 .check_clean 标记 → 跳过重扫                          │
│     → deriveHandoff + chain 推进                                 │
│     → { continuation: { action, command, next_step } }           │
│                                                                  │
│  6. 根据 continuation 循环 / decide / seal                       │
│                                                                  │
│  回溯时（executor 崩溃/上下文丢失）:                               │
│     maestro run brief {run_id} --session X --json                │
│     → 重新获取完整执行上下文                                      │
└─────────────────────────────────────────────────────────────────┘
```

### 每步 CLI 调用

| 步骤 | 命令 | 调用者 | 必须? |
|---|---|---|---|
| 1 | `session next --inline-brief` | 编排器 | ✅ |
| 2 | （执行 skill） | executor | — |
| 3 | `run check` | executor | ✅（finish 注入点） |
| 4 | （finish work） | executor | — |
| 5 | `session done` | 编排器 | ✅ |
| 回溯 | `run brief` | executor | 仅回溯时 |

**正常流程: 3 次 CLI / 步**（next + check + done）
**回溯流程: +1 次**（brief）

---

## 更新后的优化优先级

| # | 优化项 | 修正 | 优先级 |
|---|---|---|---|
| O1 | ~~check→done 合并~~ → **done 跳过重扫**（check 保留） | check 是 finish 注入点，不可省 | **P0** |
| O2 | next --inline-brief（正常流程不含 brief） | brief 仅回溯用 | **P0** |
| O3 | ~~active_session_id 快速路径~~ → **多 session 解析** | 支持并行开发 | **P0** |
| O4 | resolveStepContent 缓存 | 不变 | **P0** |
| O5 | Continuation 富化 | 不变 | **P1** |
| O6 | Coordinator → Session/Run | 不变 | **P1** |
| O7 | Hook TTL 缓存 | 不变 | **P1** |
| O8 | prepare/brief 职责明确 | brief = 回溯工具 | **P2** |
| O9 | verdict 格式统一 | 不变 | **P2** |
| O10 | 链预验证 | 不变 | **P2** |
