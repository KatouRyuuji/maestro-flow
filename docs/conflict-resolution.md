# 五份文档冲突分析与统一决议

## 文档清单

| 编号 | 文档 | 简称 |
|---|---|---|
| D1 | `ralph-to-run-migration.md` | 迁移清单 |
| D2 | `ralph-lifecycle-gap-analysis.md` | Gap 分析 |
| D3 | `session-run-architecture.md` | 职责分离 |
| D4 | `flow-efficiency-optimizations.md` | 效率优化 |
| D5 | `flow-corrections.md` | 流程修正 |

---

## 冲突 1: 命令命名空间 — `run` vs `session` 🔴

| 文档 | 步进命令 | 完成命令 | 图命令 | 决策命令 | 关闭命令 |
|---|---|---|---|---|---|
| D1 迁移 | `run next` | `run done` | — | `run decide` | `run seal-session` |
| D2 Gap | `run next` | `run done` | `run graph` | `run decide` | `run seal-session` |
| D3 职责 | **`session next`** | **`session done`** | **`session graph`** | **`session decide`** | **`session seal`** |
| D5 修正 | **`session next`** | **`session done`** | — | — | — |

**冲突**: D1/D2 将所有命令放在 `maestro run` 下；D3/D5 将 Session 级操作移到 `maestro session` 下。

**决议**: ✅ **采用 D3 方案**（Session/Run 职责分离）

理由：D3 是后续文档，明确分析了 `maestro run` 作为 God Command 的问题，
将 Session 级操作（next/done/decide/seal/graph）归入 `maestro session`，
Run 级操作（brief/check/create/prepare）留在 `maestro run`。

**需修正**:
- D1 中所有 `maestro run next/done/decide/seal-session` → `maestro session next/done/decide/seal`
- D2 中 `run graph` → `session graph`
- D1 P5-1 中 "A_EXECUTE 循环：run next → run done" → "session next → session done"

---

## 冲突 2: Brief 在正常流程中的定位 🔴

| 文档 | Brief 定位 | 正常流程含 brief? |
|---|---|---|
| D1 迁移 P5-2 | "入口：收到 session_id + run_id → **maestro run brief**" | ✅ 是 |
| D2 Gap | "agent 只读正文（**brief**），正文单源" | ✅ 是 |
| D3 职责 | "run brief = **执行正文（唯一注入点）**" | ✅ 是 |
| D4 效率 O2 | 提议 `--inline-brief` 避免单独调 brief | ⚠️ 可选 |
| D5 修正 | "**brief 是回溯工具，非正常流程**" | ❌ 否 |

**冲突**: D1/D2/D3 将 brief 定位为正常流程的唯一正文源；D5 将 brief 降级为回溯工具，正常流程由 `session next --inline-brief` 内联正文。

**决议**: ✅ **采用 D5 方案**（brief = 回溯工具）

理由：
- 正常前向流程中，`session next --inline-brief` 已包含完整正文，无需额外 CLI 调用
- brief 的核心价值是 **re-attach**（executor 崩溃/上下文丢失后重新加载）
- 将 brief 从正常路径移除，每步减少 1 次 CLI 往返

**但保留 D3 的定义**: brief 仍然是"执行正文的权威数据源"——inline-brief 的数据
**来自** briefRun() 函数，只是内联到 next 的返回中，不需要单独调用。

**需修正**:
- D1 P5-2: "入口：run brief" → "入口：从 dispatch prompt 的 inline brief 数据执行；回溯时调 run brief"
- D2 目标流程: 删除 executor 调 brief 的步骤
- D3 Run 生命周期: "create → brief → execute → check → done" → "create(next) → execute → check → done；brief 仅回溯"

---

## 冲突 3: 每步 CLI 调用次数 🟡

| 文档 | CLI 次数/步 | 组成 |
|---|---|---|
| D1 迁移 | 1-2 | "1（inline-brief）或 2（next + brief）" |
| D2 Gap | 4→2 | 当前 4（next+brief+check+done），目标 2（next+done） |
| D4 效率 | 3 | next + brief + done（check 合入 done） |
| D5 修正 | **3** | **next + check + done**（brief 移除，check 保留） |

**冲突**: 各文档对"每步几次 CLI"说法不一，因为对 brief 和 check 的取舍不同。

**决议**: ✅ **采用 D5 方案：3 次 CLI/步**

```
session next --inline-brief --json   ← 1（指针 + 正文）
run check {run_id}                   ← 2（gate 检查 + finish 注入）
session done {run_id} --verdict      ← 3（完成 + continuation，跳过重扫）
```

**需修正**:
- D1 "CLI 往返/步: 1" → 3（check 不可省）
- D2 目标流程中删除 brief 步骤
- D4 O1 "合并 check + done" → 不合并，但 done 跳过重扫

---

## 冲突 4: O1 check→done 合并 🟡

| 文档 | 立场 |
|---|---|
| D4 效率 O1 | "合并 check + done 为一步" 或 "--check-clean 跳过重扫" |
| D5 修正 1 | "**check→done 不可合并** — finish checklist 需要 check 注入" |

**冲突**: D4 提议合并，D5 明确反对。

**决议**: ✅ **采用 D5 方案**（不合并，但 done 跳过重扫）

理由：`run check` 是 finish checklist 的唯一注入点（report.md 提醒、知识沉淀、verdict 选择）。
合并后 executor 失去 finish work 指导。

**折中**: done 内部通过 `.check_clean` 标记跳过 scanOutputs + evaluateRunGates，
但 check 命令本身保留在流程中。

**需修正**: D4 O1 删除"合并 check + done 为一步"的提议，保留"done 跳过重扫"。

---

## 冲突 5: active_session_id 单数 vs 多 Session 🟡

| 文档 | 立场 |
|---|---|
| D4 效率 O3 | "用 state.json 的 active_session_id 做快速路径" |
| D5 修正 3 | "active_session_id 需要支持多个 session 同时开发" |

**冲突**: D4 假设单 active session，D5 要求多 session 并行。

**决议**: ✅ **采用 D5 方案**（多 Session 支持）

解析优先级：
1. 显式 `--session X` → O(1)
2. `MAESTRO_SESSION_ID` 环境变量 → O(1)
3. 唯一 running session（从 state.json sessions 列表）→ O(1)
4. 多个 running → 报错，要求 `--session`
5. 全量扫描 fallback

**需修正**: D4 O3 删除"active_session_id 单数快速路径"，改为多 session 解析。

---

## 冲突 6: graph 命令注册位置 🟢

| 文档 | 位置 |
|---|---|
| D2 Gap | `src/commands/run.ts` 的 `run graph` |
| D3 职责 | `src/commands/session.ts` 的 `session graph` |

**决议**: ✅ **采用 D3**（`session graph`），与冲突 1 决议一致。

**需修正**: D2 中 `run graph` → `session graph`，实现从 `src/commands/run.ts` 改到 `src/commands/session.ts`。

---

## 冲突 7: D3 Run 生命周期描述 🟢

| D3 原文 | D5 修正 |
|---|---|
| "Run 生命周期: create → **brief** → execute → check → done" | "create(next) → execute → check → done；**brief 仅回溯**" |

**决议**: ✅ 采用 D5。D3 的生命周期描述需更新。

---

## 冲突 8: D1 P0-1 编排循环命令 🟢

| D1 原文 | 应改为 |
|---|---|
| "编排循环改为 `maestro run next --session {id} --json`" | "`maestro session next --session {id} --inline-brief --json`" |
| "改为 `maestro run done {run_id} --session {id} --verdict ...`" | "`maestro session done {run_id} --session {id} --verdict ...`" |

**决议**: 与冲突 1 一致，采用 session 命名空间。

---

## 无冲突项（各文档一致）

| 主题 | 一致结论 |
|---|---|
| 删除 ralph 私有 CLI | D1/D2/D3 一致：全部删除 |
| 删除 src/ralph/ | D1/D2 一致：有效代码合入 run/，目录删除 |
| session-adapter 合入 | D1/D2 一致：effectivePosition/Decomposition/Lease 合入 run/ |
| ralph-meta sunset | D1/D2/D3 一致：保留 read fallback，不写新文件 |
| resolveStepContent 缓存 | D1/D4 一致：进程级 Map 缓存 |
| prepare 定位 | D2/D4 一致：预读/规划（pre-Run），workflow 改为 summary |
| Coordinator 双轨问题 | D1/D4 一致：长期迁移到 Session/Run |
| verdict 格式统一 | D4/D5 一致：小写连字符 |
| 链预验证 | D4 提出，无冲突 |
| Hook 优化 | D4 提出，无冲突 |

---

## 统一后的权威流程（最终版）

```
┌─────────────────────────────────────────────────────────────────┐
│  编排器（Ralph / Coordinator / 人类）                             │
│                                                                  │
│  创建:                                                           │
│    maestro session create "{intent}" --chain-file {path}         │
│                                                                  │
│  全局视图（可选）:                                                │
│    maestro session graph --session {id} --json                   │
│                                                                  │
│  步进循环:                                                       │
│    ┌─────────────────────────────────────────────────────────┐   │
│    │  1. maestro session next --session {id}                  │   │
│    │       --inline-brief --json                              │   │
│    │     → { run_id, step, queue, brief: {guidance,          │   │
│    │         contract, continuity} }                          │   │
│    │     → Run 已原子创建，正文已内联                           │   │
│    │                                                         │   │
│    │  2. dispatch run-executor(session_id, run_id, brief)    │   │
│    │     ┌───────────────────────────────────────────────┐   │   │
│    │     │  从 brief 数据直接执行（正常路径不调 brief）     │   │   │
│    │     │                                               │   │   │
│    │     │  3. maestro run check {run_id} --session {id} │   │   │
│    │     │     → gates clean → finish checklist 注入     │   │   │
│    │     │     → gates blocking → 修复 → 重新 check      │   │   │
│    │     │                                               │   │   │
│    │     │  4. 执行 finish work                          │   │   │
│    │     │     → report.md / 知识沉淀 / verdict 选择     │   │   │
│    │     │                                               │   │   │
│    │     │  返回: { run_id, status, summary, artifacts } │   │   │
│    │     └───────────────────────────────────────────────┘   │   │
│    │                                                         │   │
│    │  5. maestro session done {run_id} --session {id}        │   │
│    │       --verdict done --summary "..." --json             │   │
│    │     → 检测 .check_clean → 跳过重扫                      │   │
│    │     → { continuation: { action, command, next_step } }  │   │
│    │                                                         │   │
│    │  continuation.action:                                   │   │
│    │    "next"   → 回到 1                                    │   │
│    │    "decide" → session decide {point_id} → continuation  │   │
│    │    "seal"   → session seal {id}                         │   │
│    └─────────────────────────────────────────────────────────┘   │
│                                                                  │
│  回溯（executor 崩溃/上下文丢失）:                                 │
│    maestro run brief {run_id} --session {id} --json              │
│    → 重新获取完整执行上下文                                       │
│                                                                  │
│  关闭:                                                           │
│    maestro session seal {id} --summary "..."                     │
└─────────────────────────────────────────────────────────────────┘
```

### 命令归属（最终版）

| 命令 | 命名空间 | 调用者 | 正常/回溯 |
|---|---|---|---|
| `session create` | Session | 编排器 | 正常 |
| `session next --inline-brief` | Session | 编排器 | 正常 |
| `session graph` | Session | 编排器/人类 | 正常（可选） |
| `session done` | Session | 编排器 | 正常 |
| `session decide` | Session | 编排器 | 正常 |
| `session seal` | Session | 编排器 | 正常 |
| `session status` | Session | 编排器/人类 | 正常 |
| `session chain insert/skip/replace` | Session | 编排器 | 正常 |
| `session recover` | Session | 编排器/人类 | 恢复 |
| `run check` | Run | executor | 正常 |
| `run brief` | Run | executor | **仅回溯** |
| `run prepare` | Run | 编排器/人类 | 预读 |
| `run create` | Run | 人类/脚本 | 独立 Run |
| `run skill` | Run | 人类 | 一次性 |

### 每步指标（最终版）

| 指标 | 当前 | 最终 |
|---|---|---|
| CLI 调用/步 | 4（ralph next + brief + check + done） | **3**（next + check + done） |
| 正文注入 | 双源（ralph prompt + brief） | **单源**（inline-brief） |
| outputs 扫描/步 | 2（check + done） | **1**（check；done 跳过） |
| .md 解析/步 | 4 | **1**（缓存） |
| prompt tokens/步 | ~4-6K | **~2-3K** |
| 矛盾指令 | 4 处 | **0** |
| brief 调用/步 | 1（正常） | **0**（仅回溯） |

---

## 文档处置建议

| 文档 | 处置 |
|---|---|
| D1 迁移清单 | ⚠️ 需修正：命令命名空间 run→session，brief 定位，CLI 次数 |
| D2 Gap 分析 | ⚠️ 需修正：run graph→session graph，brief 从正常流程移除 |
| D3 职责分离 | ⚠️ 需修正：Run 生命周期描述删除 brief，采用 inline-brief |
| D4 效率优化 | ⚠️ 需修正：O1 不合并 check，O3 多 session，目标链路更新 |
| D5 流程修正 | ✅ 最新决议，作为权威修正 |
| **本文档** | ✅ 统一决议，作为最终参考 |

**建议**: 将本文档（conflict-resolution.md）作为权威参考，
其他文档标注"已被 conflict-resolution.md 修正"。
实施时以本文档的"统一后权威流程"为准。
