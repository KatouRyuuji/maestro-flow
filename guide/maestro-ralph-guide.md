---
title: "Maestro Ralph 闭环编排策略指南"
---

Closed-loop orchestration policy — 在 canonical Session/Run 链上评价 Skill 输出、proposal、budget、confidence、escalation 与停止条件。

---

## 定位

Maestro Ralph 是 Maestro Flow 的**闭环推进入口**：

1. 读取项目状态，自动推断当前生命周期位置
2. 创建或继续任意 compatible Session，并复用同 Session 的 sealed Runs/Artifacts
3. 执行普通 Skill 或声明 `orchestration.chain_effects` 的 Skill
4. 对 typed chain proposal 应用 budget、confidence、escalation 与停止策略

Session 与 chain 不区分 static/adaptive。链是否变化由当前 Skill 的 contract 和本次 Run 输出决定。与 [Maestro](./maestro-coordinator-guide.md) 的区别只在 orchestration policy：

| | Maestro | Maestro Ralph |
|---|---------|---------------|
| **Session/Run 协议** | canonical | canonical（可直接继续 Maestro Session） |
| **初始策略** | 组合 initial chain，偏交互确认 | closed loop，偏 budget/confidence/escalation |
| **链变化来源** | Skill proposal | Skill proposal |
| **停止条件** | chain 耗尽或用户停止 | goal/gate 满足、预算耗尽、阻塞或用户停止 |

---

## 使用方式

```bash
/maestro-ralph "实现用户认证系统"     # 新会话
/maestro-ralph continue              # 恢复执行
/maestro-ralph -y "implement auth"   # 全自动模式
/maestro-ralph status                # 查看进度
```

### Canonical CLI

Ralph 与 Maestro 共享通用 CLI；`maestro ralph ...` 只保留 deprecated compatibility aliases：

```bash
maestro session status <session-id>
maestro session check <session-id>
maestro session evidence <session-id>
maestro skills --platform codex --steps
maestro run next --session <session-id>
maestro run complete --session <session-id> --verdict done \
  --chain-proposal outputs/chain-proposal.json
```

| 子命令 | 功能 | 使用场景 |
|--------|------|----------|
| `session status/check/evidence` | 查询任意 compatible Session、链一致性和 Evidence Registry | 状态与证据 |
| `skills` | 扫描 `.claude/commands/`、各平台 Skills 与 Run-resolvable steps | 建链预检 |
| `run next` | 分配并绑定下一条 chain Run | 唯一普通 chain allocator |
| `run check/complete` | 校验并原子 seal 当前 Run；可同时应用 accepted proposal | lifecycle 收口 |

### 双平台 Skill 支持（v0.4.17+）

Ralph 支持扫描两个平台的 skill 目录：

| 平台 | Skill 目录 | Session 标识 |
|------|-----------|-------------|
| Claude | `.claude/commands/` | `platform: "claude"` |
| Codex | `.codex/skills/` | `platform: "codex"` |

`maestro skills --platform codex` 可过滤只显示 Codex 平台 Skill。Session 的 executor metadata 标识来源平台，但不改变 Session 或 chain 类型。

### Skill Defaults 注入（v0.4.17+）

`maestro run next` 分配 step Run，`maestro run brief` 加载 Skill 正文与 contract；平台默认参数仍可从 `skill-config.json` 注入。用户无需每次手动指定常用 flag：

```json
// .workflow/skill-config.json
{
  "execute": { "auto_commit": true },
  "review": { "dims": "bugs,security" }
}
```

### Emit 格式（v0.4.16+）

`A_EXEC_STEP` 输出精简为纯指令格式，不再包含冗余解释性说明。ralph-execute 输出 step 结果时使用统一的 emit 格式，便于下游消费和 session 恢复。

---

## 三种节点类型

| 类型 | 执行方式 | 说明 |
|------|----------|------|
| **skill** | `Skill()` 同步调用 | 实际命令执行（plan、execute、verify 等） |
| **cli** | `maestro delegate` 后台 | CLI 委派执行 |
| **decision** | Ralph 重新评估 | 读取执行结果，决定继续或插入修复循环 |

---

## 生命周期阶段

<details>
<summary>完整流程图</summary>

```
brainstorm → init → roadmap → analyze → plan → execute
    (0→1)                                        ↓
                                              verify
                                                ↓
                                        ◆ post-verify
                                                ↓
                                      business-test (full)
                                                ↓
                                      ◆ post-business-test
                                                ↓
                                            review
                                                ↓
                                        ◆ post-review
                                                ↓
                                          test-gen + test
                                                ↓
                                          ◆ post-test
                                                ↓
                                        milestone-audit
                                                ↓
                                      milestone-complete
                                                ↓
                                      ◆ post-milestone
                                          ↓        ↓
                                    下一个 M     全部完成
```

每个 `◆` 是一个 decision 节点。非 `-y` 模式下暂停等待 `continue`。

</details>

---

## Decision 节点详解

| 节点 | 类型 | 读取文件 | 通过 | 失败处理 |
|------|------|----------|------|----------|
| **post-execute** | quality-gate | `verification.json` | 继续 | 对应 verify/repair Skill 可提出 scoped proposal |
| **post-business-test** | quality-gate | `.tests/auto-test/report.json` | 继续 | 对应 test/repair Skill 可提出 proposal |
| **post-review** | quality-gate | `review.json` | PASS/WARN 继续 | BLOCK → review/repair Skill 提出 proposal |
| **post-test** | quality-gate | `uat.md` + `test-results.json` | 全部通过 | test Skill 可提议重跑未通过质量门 |
| **post-frontend-verify** | quality-gate | `e2e-results.json` | 继续 | frontend repair Skill 可提出 proposal |
| **post-goal-audit** | goal-gate | `task_decomposition` + evidence | `all_met` + `INTENT_ALIGNED=true` | unmet goal 由 audit/planning Skill 提出 scoped proposal；漂移仍可触发暂停 |
| **post-analyze-scope** | scope-gate | `conclusions.json` | `scope_verdict` 确定 → 路由链路 | `unknown` → AskUserQuestion 或默认 standalone |
| **post-milestone** | structural | `state.json` | 有下一个 M → 插入完整链 | 全部完成 → session 结束 |
| **post-debug-escalate** | structural | — | — | 达到最大重试，暂停等人工介入 |
| **post-reground** | reground-gate | 完成 steps + boundary_contract | `aligned` → 继续 | `drifted` + `confidence >= 60` → 漂移熔断 HALT |

### Decision 节点类型分组

Ralph 的 decision 节点按评估委托方式分为 5 组：

| 分组 | 包含节点 | 评估委托 |
|------|----------|----------|
| **quality-gate** | post-execute, post-business-test, post-review, post-test, post-frontend-verify | `A_DELEGATE_EVALUATE` — 委托 analyze 读取质量产物 |
| **goal-gate** | post-goal-audit | `A_GOAL_AUDIT_EVALUATE` — 审计子目标完成度 + 意图保真 |
| **scope-gate** | post-analyze-scope | `A_SCOPE_EVALUATE` — 读 macro analyze 结论路由链路 |
| **structural** | post-milestone, post-debug-escalate | `A_STRUCTURAL_EVALUATE` — 结构性判断（里程碑推进/升级） |
| **reground-gate** | post-reground | `A_REGROUND_EVALUATE` — 意图保真检查（漂移检测） |

---

## Session 文件

存储位置：`.workflow/.maestro/ralph-{YYYYMMDD-HHmmss}/status.json`

<details>
<summary>JSON Schema 示例</summary>

```json
{
  "session_id": "ralph-20260503-143022",
  "source": "ralph",
  "intent": "implement user auth",
  "status": "running",
  "chain_name": "ralph-lifecycle",
  "task_type": "lifecycle",
  "phase": 1,
  "milestone": "MVP",
  "auto_mode": false,
  "quality_mode": "standard",
  "passed_gates": ["verify"],
  "lifecycle_position": "plan",
  "target": "milestone-complete",
  "steps": [
    { "index": 0, "type": "skill", "skill": "plan", "args": "1", "status": "completed" },
    { "index": 1, "type": "skill", "skill": "execute", "args": "1", "status": "completed" },
    { "index": 2, "type": "decision", "skill": "maestro-ralph", "args": "{\"decision\":\"post-verify\",\"retry_count\":0,\"max_retries\":2}", "status": "running" },
    { "index": 3, "type": "skill", "skill": "review", "args": "1", "status": "pending" }
  ],
  "current_step": 3
}
```

**Step types**：`"skill"` 实际命令 / `"cli"` CLI delegate / `"decision"` Ralph 决策评估（Ralph 独有）

</details>

---

## 生命周期位置推断

| 条件 | 推断位置 |
|------|----------|
| 无 `.workflow/` | `brainstorm`（空项目）或 `init`（有代码） |
| 有 state.json，无 milestones | `roadmap` |
| 有 milestones，无 artifacts | `analyze` |
| 最新 artifact type == analyze | `plan` |
| 最新 artifact type == plan | `execute` |
| 最新 artifact type == execute | `verify` |
| verify 通过 | `post-verify`（按 quality_mode 决定后续） |
| verify 失败 | `verify-failed`（插入 fix 循环） |

---

## 最大重试与升级

每个 decision 节点携带 `retry_count` 和 `max_retries`（默认 2）：

- **retry 0**：首次评估 → 失败 → 插入 fix 循环
- **retry 1**：第二次评估 → 仍失败 → 再次 fix
- **retry 2**：达到上限 → 升级到 `post-debug-escalate` → 暂停

升级后 session 状态变为 `paused`，用户处理后 `continue` 恢复。

---

## Session Anchor 机制（v0.5.36+）

Session Anchor 是 Ralph 在每个 step 执行前自动注入的只读上下文块，确保执行中的 skill 始终感知当前 session 的意图、边界和进度。

### 注入时机

由 `maestro run next` / `maestro run brief` 在加载 step 时生成 canonical Resume Packet，嵌入 Skill prompt：

```xml
<session_anchor>
## Session Anchor — ralph-20260612-143022

**Intent**: implement user auth with JWT
**Scope**: large | Phase 2 | Milestone: MVP

**Boundary Contract**:
- In scope: src/auth/, src/middleware/, tests/auth/
- Out of scope: src/legacy/, third-party SSO
- Constraints: backward-compatible API, no breaking changes
- Done when: all auth tests green + JWT refresh works + middleware blocks unauthorized

**Execution Progress**:
- [0] analyze (analyze): Completed macro analysis, scope=large
- [1] plan (plan): Generated 12-task plan for phase 2
  ⚠️ Some tasks depend on external API mock
- Progress: 2 done, 8 pending

**Goals Overview**:
- [✓] G1: JWT token issuance — done_when: /api/auth/login returns valid JWT
- [○] G2: Token refresh — done_when: /api/auth/refresh extends expiry
- [○] G3: Middleware guard — done_when: 401 on invalid token
- Course corrections: 1 applied

**Current Goal** (G2):
- Goal: Implement token refresh endpoint
- Boundary: Only refresh logic, no new token format
- Done when: POST /api/auth/refresh with valid refresh_token returns new JWT
- Origin: CHG-001

**Execution Criteria**: backward-compat; test-coverage>=80%; incremental-commit

**⚠️ Accumulated Signals**:
- Caveats: External API mock needed for refresh; legacy auth still active
- Deferred work: SSO integration postponed to phase 3
- **Before proceeding, verify these signals do not conflict with your current task.**

<!-- session_anchor: read-only grounding. Honor Intent + Boundary Contract before acting. -->
</session_anchor>
```

### Anchor 组成部分

| 部分 | 来源字段 | 说明 |
|------|----------|------|
| **Intent** | `session.intent` | 截断 1200 字符 |
| **Scope** | `scope_verdict` + `phase` + `milestone` | 一行概览 |
| **Boundary Contract** | `session.boundary_contract` | in_scope / out_of_scope / constraints / definition_of_done，列表截断 8 项 |
| **Execution Progress** | 最近 5 个已完成 step 的 `completion_summary` + `completion_caveats` | 滑动窗口 |
| **Goals Overview** | `task_decomposition` 中 `status != "superseded"` 的目标 | ✓/○ 标记 + goal_changelog 计数 |
| **Current Goal** | `step.goal_ref` 匹配的子目标 | goal / boundary / done_when / origin |
| **Execution Criteria** | `session.execution_criteria` | 截断 5 项 |
| **Accumulated Signals** | 聚合所有已完成 step 的 caveats + deferred | 最近 3 caveats + 最近 5 deferred |

### 关键约束

- **只读**：skill 不得回写或回显 anchor 字段
- **漂移防护**：anchor 底部注释提醒 — 若工作超出 `in_scope` 或触碰 `out_of_scope`，应 `BLOCKED` 而非继续
- **冲突检测**：若 Accumulated Signals 与当前任务冲突，应 `BLOCKED` 报告

---

## Re-grounding 漂移断路器（v0.5.36+）

Re-grounding 是 Ralph 的**意图保真安全门**，周期性检查累积执行是否偏离原始意图。

### 触发规则

在 `A_BUILD_STEPS` 阶段按以下规则插入 `post-reground` decision 节点：

| 条件 | 行为 |
|------|------|
| `task_decomposition` 存在 | 启用 re-grounding |
| 执行 step（不含 decision）≥ 3 | 从第 3 个执行 step 起，每隔 3 个插入 |
| 最后一个执行 step | 不插入（由 goal-audit 覆盖） |
| 与已有 quality-gate decision 相邻 | 顺延到下一个 3-step 边界 |
| accepted Skill proposal 插入的 step | 纳入计数（从插入点起重新计算间隔） |

### 评估流程（A_REGROUND_EVALUATE）

```
1. 读取 status.json：
   - session.intent + boundary_contract
   - 已完成 steps 的 completion_evidence/summary/decisions/caveats
   - task_decomposition 中 status=="done" 的 goal/done_when

2. 委托 delegate（run_in_background）：
   PURPOSE: 意图保真检查 — 对照 intent 验证累积执行是否漂移
   TASK:
     1. 读取 intent + boundary_contract.definition_of_done
     2. 读取已完成 steps 的 completion_evidence + 已 done 子目标 done_when
     3. 判定累积产出是否仍服务 intent
     4. 输出 aligned / drifted + drift_description + corrective_action
   EXPECTED:
     STATUS=aligned|drifted
     CONFIDENCE_SCORE=0-100

3. 路由：
   aligned                              → A_APPLY_PROCEED（继续）
   drifted + confidence_score >= 60     → A_REGROUND_HALT（漂移熔断）
   drifted + confidence_score < 60      → A_APPLY_PROCEED（标 LOW CONFIDENCE）
```

### 漂移熔断（A_REGROUND_HALT）

**auto_confirm 不可跳过** — 这是安全门，即使 `-y` 模式也强制暂停。

触发后：

```
⚠️ Re-grounding 检测失败 — 执行已偏离 intent。
Intent: {session.intent}
Drift:  {drift_description}
建议回归: {corrective_action}
选项：1) /maestro-ralph continue 忽略漂移继续
      2) 手动修正后 continue
      3) /maestro-ralph status 查看后决定
```

Session 状态设为 `paused`，等待用户决策。

### 阈值设计

| confidence_score | 判定 | 行为 |
|------------------|------|------|
| ≥ 60（高置信漂移） | drifted | **HALT** — 漂移明确，强制暂停 |
| < 60（低置信漂移） | drifted | **PROCEED** + 标 LOW CONFIDENCE — 不确定，允许继续 |
| ≥ 80 且 aligned | aligned | **PROCEED** — 明确未漂移 |

---

## Decomposition 工作流（v0.5.36+）

Decomposition 将宽泛意图拆解为可观测的子目标清单，作为 planning/audit Skill 的输入；是否改变后续 chain 由 Skill proposal 决定。

### 触发条件

`A_DECOMPOSE_TASKS` 在 `S_BUILD_CHAIN` 之前执行，按意图宽度决定行为：

| 意图宽度 | 模式 | 示例 |
|----------|------|------|
| **broad** | MUST 澄清（忽略 auto_confirm） | "重构整个认证系统"、"全面迁移" |
| **medium** | 澄清（除非 auto_confirm） | "优化用户模块性能" |
| **narrow** | 自动推导，跳过提问 | "修复 login 400 错误" |

### 澄清流程（broad/medium）

最多 3 轮 `AskUserQuestion`，每轮预填从 intent + 代码扫描得出的建议：

| 轮次 | 问题 | 产出字段 |
|------|------|----------|
| **Scope** | 哪些目录/文件/层在范围内？明确排除什么？ | `boundary_contract.in_scope` / `out_of_scope` |
| **Constraints** | 必须向后兼容？API 冻结？测试门槛？ | `boundary_contract.constraints` + `execution_criteria` |
| **Done** | 什么可观测结果算"完成"？ | `boundary_contract.definition_of_done` |

### 子目标结构

每个子目标是一个 outcome-oriented 的可观测交付，**禁止复刻生命周期阶段**：

```json
{
  "id": "G1",
  "goal": "JWT token issuance endpoint",
  "boundary": "Only /api/auth/login, no refresh",
  "done_when": "POST /api/auth/login with valid creds returns JWT with 200",
  "evidence": "verification.json",
  "lifecycle": ["execute"],
  "status": "pending",
  "completion_confirmed": false,
  "completed_at": null
}
```

关键约束：
- `done_when` 必须客观可验证，引用 ralph 已产出的 artifact
- `evidence` 引用具体产物文件（verification.json / review.json / uat.md / e2e-results.json）
- 涉及前端的子目标，`done_when` 应引用 `e2e-results.json`，不得仅凭后端证据判定
- `lifecycle` 映射到产出 evidence 的生命周期 stage

### goal-audit mini-loop

`post-goal-audit` decision 节点在最后一个 evidence-producing stage 之后、`milestone-complete` 之前插入。评估每个未完成子目标的 evidence 产物，对照 `done_when` 判定 met / unmet：

```
STATUS=all_met|has_unmet
INTENT_ALIGNED=true|false
UNMET=[{id:G2, gap:'...', target_phase:execute}, ...]
```

- `has_unmet` → 对每个 unmet 子目标插入 scoped mini-loop（`plan --gaps` + `execute`），标记 `goal_ref`
- `all_met` + `INTENT_ALIGNED=true` → 标记全部完成，进入 milestone-complete
- `all_met` + `INTENT_ALIGNED=false` → **尾部漂移熔断**（A_REGROUND_HALT），auto_confirm 不跳过

### goal 修改（--amend）

运行中 session 可通过 `--amend` 标志热修改目标，5 步流程：

| 阶段 | 行为 | 产出 |
|------|------|------|
| 1. 快照 | 读 task_decomposition + boundary_contract + 已完成 steps | 显示目标列表 + 进度 |
| 2. 解析 | 解析 change_request 或 AskUserQuestion | change_type + change_request |
| 3. Mini Grill | delegate 评估影响 | RISK_LEVEL + AFFECTED_GOALS |
| 4. 确认 | AskUserQuestion | 用户选择 |
| 5. 应用 | 旧目标标 `superseded`，新目标写入 `origin: "CHG-xxx"` | goal_changelog + 重建链路 |

**RISK_LEVEL=high 时 auto_confirm 无效，必须 AskUserQuestion。**

---

## 完整状态机（16 个状态）

Ralph 的有限状态机（FSM）包含 16 个状态，控制 session 的完整生命周期：

| 状态 | 持久化 | 说明 |
|------|--------|------|
| **S_PARSE_ROUTE** | — | 解析参数、路由入口 |
| **S_STATUS** | — | 显示 session 进度 |
| **S_CONTINUE** | — | 恢复执行 |
| **S_RESOLVE_PHASE** | `phase`, `phase_is_new`, `milestone` | 解析 phase + D-007 milestone 反查 |
| **S_INFER** | `lifecycle_position`, `wants_roadmap` | 基于已解析 phase 推断生命周期位置 |
| **S_RESOLVE_SCOPE** | `scope_verdict`, `analyze_macro_id` | 读 macro analyze 结论 |
| **S_QUALITY_MODE** | `quality_mode` | 决定质量管线模式 |
| **S_PLANNING_MODE** | `planning_mode` | 决定统一/独立规划模式 |
| **S_DECOMPOSE** | `boundary_contract`, `execution_criteria`, `task_decomposition` | 边界澄清 + 子目标拆解 |
| **S_BUILD_CHAIN** | `steps[]` | 构建步骤链 |
| **S_CREATE_SESSION** | 全量 Session | 通过 CLI 写 canonical session.json |
| **S_CONFIRM** | — | 用户确认（非 auto_confirm 时） |
| **S_DISPATCH** | — | 派发 generic run-executor |
| **S_DECISION_EVAL** | — | 委托评估质量门 |
| **S_APPLY_VERDICT** | transition receipt | 评价 proposal；Runtime 原子应用 accepted operations |
| **S_AMEND_GOAL** | `task_decomposition`, `boundary_contract`, `goal_changelog`, `steps[]` | 修改运行中 session 目标 |
| **S_FALLBACK** | — | 请求用户输入 |

### 入口路由（S_PARSE_ROUTE）

```
intent == "status"                              → S_STATUS
intent == "continue"                            → S_CONTINUE
amend_mode == true AND running session exists   → S_AMEND_GOAL
amend_mode == true AND no running session       → S_FALLBACK
running session with decision step running      → S_DECISION_EVAL
intent is non-empty                             → S_RESOLVE_PHASE
no intent AND no running session                → S_FALLBACK
```

### 核心路径

```
S_PARSE_ROUTE → S_RESOLVE_PHASE → S_INFER → S_RESOLVE_SCOPE
    → S_QUALITY_MODE → S_PLANNING_MODE → S_DECOMPOSE
    → S_BUILD_CHAIN → S_CREATE_SESSION → S_CONFIRM → S_DISPATCH

执行中遇到 decision 节点：
    S_DECISION_EVAL → S_APPLY_VERDICT → S_DISPATCH（继续或修复）
```

---

## Grill Auto Mode（-y 标志）

当 `auto_confirm=true`（用户传入 `-y`）时，grill 阶段的行为：

| 方面 | 行为 |
|------|------|
| **stage 保留** | grill stage **不跳过**，仍插入链路 |
| **args 追加** | grill step 的 args 追加 `-y` |
| **grill 内部** | grill 以 Auto mode 运行（代码代答，非交互） |
| **产出** | 仍产出 grill-report / terminology / context-package |
| **brainstorm 依赖** | brainstorm 的 `--from grill:{grill_id}` 仍然有效 |

关键：`-y` 不等于"跳过 grill"。grill 的 Auto mode 使用代码自动回答问题，产出与交互模式相同。

---

## --from 注入机制（v0.5.36+）

`--from` 标志实现 artifact 间的因果链路注入，支持三种路径：

### 1. analyze:{id} 路径

当 `analyze_macro_id` 存在时：

| 场景 | 注入规则 |
|------|----------|
| `roadmap` step | args 改为 `--from analyze:{analyze_macro_id}` |
| `plan` step（standalone 列） | args 改为 `--from analyze:{analyze_macro_id}`，不带 `{phase}` |
| `plan` step（phase 列） | 运行时由 A_RESOLVE_ARGS 注入 `--from analyze:{phase_analyze_id}` |

### 2. blueprint:{id} 路径

当 `blueprint_id` 存在且当前 step 是 `plan` 时：
- args 改为 `--from blueprint:{blueprint_id}`
- 优先级低于 phase 数字参数

### 3. Phase-level deferred chaining

独立模式下，含 `{phase}` 占位符的 step 在 build 阶段无法预知 Artifact ID，由 `run next/brief` 从 canonical upstream/Artifact Registry 解析并注入：

| Step | 运行时注入 | 写入字段 |
|------|-----------|----------|
| `plan` | `--from analyze:{phase_analyze_id}` | `source_artifact_ref` |
| `execute` | `--dir {plan_path}` | `source_artifact_ref = "plan:{id}"` |

### 溯源审计

每个被注入 `--from` 的 step 都写入 `step.source_artifact_ref`（如 `"analyze:ANL-042"`），便于审计和恢复。

---

## Roadmap Opt-in（v0.5.36+）

Roadmap（多发布路线图）**默认关闭**，仅在显式激活时启用：

### 激活条件

```
wants_roadmap = (--roadmap 标志)
             OR (intent 含多发布信号: 多发布|多版本|分阶段交付|按里程碑发布|v1.*v2|multi-release|roadmap)
             OR (.workflow/roadmap.md 已存在)   ← 向后兼容
```

默认 `false` → large 项目走单一多波次 `plan --from analyze`，不引入 roadmap 横切层。

### 路由影响

| scope_verdict | wants_roadmap | 链路 |
|---------------|---------------|------|
| `large` | true | analyze-macro → **roadmap** → analyze → plan(带 phase) → execute → ... |
| `large`（默认） | false | analyze-macro → plan --from analyze:{id}（跳过 roadmap + analyze） |
| `medium` / `small` | 任意 | analyze-macro → plan --from analyze:{id}（跳过 roadmap + analyze） |

---

## milestone=null Standalone 行为

当 `session.milestone` 为 null 时（standalone 模式，无里程碑上下文），Ralph 的行为差异：

| 方面 | milestone 存在 | milestone=null |
|------|----------------|----------------|
| **终点** | `milestone-complete` | 最后一个质量门 stage |
| **milestone-audit** | 插入 | **跳过** |
| **milestone-complete** | 插入 | **跳过** |
| **post-milestone** | 插入 | **跳过** |
| **goal-audit** | 插入（若 decomposed） | 仍插入（若 decomposed） |
| **session 完成** | post-milestone 判定全部完成 | 最后质量门通过后标记 completed |
| **post-execute refine** | 检查 milestone-audit 条件 | 检查到 uat.md 全通过即标 completed |

Standalone 模式适用于单次任务、独立功能开发等无需里程碑追踪的场景。

---

## 完整 Session Schema（v0.5.36+）

Session JSON 包含 35+ 字段，以下为完整结构：

```json
{
  // === 标识 ===
  "session_id": "ralph-20260612-143022",
  "source": "ralph", "status": "running",
  "ralph_protocol_version": "2",
  "active_step_index": 2,
  "cli_tool": "claude", "platform": "claude",

  // === 意图与位置 ===
  "intent": "implement user auth with JWT",
  "lifecycle_position": "plan",
  "phase": 2, "phase_is_new": false,
  "milestone": "MVP",

  // === 模式控制 ===
  "auto_mode": false,
  "decomposition_owner": "ralph",
  "quality_mode": "standard",
  "planning_mode": "independent",
  "scope_verdict": "large",
  "wants_roadmap": false,
  "analyze_macro_id": "ANL-042",
  "blueprint_id": null,
  "passed_gates": ["verify"],

  // === 上下文 ===
  "context": { "issue_id": null, "scratch_dir": null, "plan_dir": null,
    "analysis_dir": null, "brainstorm_dir": null, "blueprint_dir": null },

  // === 步骤（3 个示例：completed 执行 step、completed decision、running 执行 step）===
  "steps": [
    {
      "index": 0, "skill": "analyze", "args": "\"implement auth\" 2",
      "stage": "analyze", "scope": "phase", "decision": null,
      "command_scope": "project", "command_path": "D:/project/prepare/analyze.md",
      "milestone_id": "MVP", "source_artifact_ref": null,
      "status": "completed", "goal_ref": null,
      "completion_confirmed": true, "completion_status": "DONE",
      "completion_evidence": ".workflow/scratch/ANL-042/",
      "completion_summary": "Completed phase 2 analysis, 12 tasks identified",
      "completion_decisions": ["Split auth into JWT + middleware + refresh"],
      "completion_caveats": "External API mock needed for refresh flow",
      "completion_deferred": ["SSO integration postponed to phase 3"],
      "completed_at": "2026-06-12T15:00:00Z",
      "deferred_reads": ["~/.maestro/workflows/analyze-guide.md"],
      "load": { "loaded_at": "2026-06-12T14:45:00Z", "required_files": ["..."], "deferred_files": ["..."], "resolve_version": "1" }
    },
    {
      "index": 1, "skill": "", "args": "{\"decision\":\"post-reground\",\"retry_count\":0,\"max_retries\":0}",
      "stage": "", "scope": null, "decision": "post-reground",
      "command_scope": null, "command_path": null,
      "status": "completed", "goal_ref": null,
      "completion_confirmed": true, "completed_at": "2026-06-12T15:05:00Z",
      "deferred_reads": [], "load": null
    },
    {
      "index": 2, "skill": "plan", "args": "\"implement auth\" 2",
      "stage": "plan", "scope": "phase", "decision": null,
      "command_scope": "project", "command_path": "D:/project/prepare/plan.md",
      "milestone_id": "MVP", "source_artifact_ref": "analyze:ANL-042",
      "status": "running", "goal_ref": null,
      "completion_confirmed": false, "completed_at": null,
      "deferred_reads": [],
      "load": { "loaded_at": "2026-06-12T15:10:00Z", "required_files": ["..."], "deferred_files": [], "resolve_version": "1" }
    }
  ],
  "waves": [], "current_step": 2,

  // === 分解块 ===
  "boundary_contract": {
    "in_scope": ["src/auth/", "src/middleware/", "tests/auth/"],
    "out_of_scope": ["src/legacy/", "third-party SSO"],
    "constraints": ["backward-compatible API", "no breaking changes"],
    "definition_of_done": "all auth tests green + JWT refresh works + middleware blocks unauthorized"
  },
  "execution_criteria": ["backward-compat", "test-coverage>=80%", "incremental-commit", "fix-don't-hide"],
  "task_decomposition": [
    { "id": "G1", "goal": "JWT token issuance", "done_when": "POST /api/auth/login returns JWT with 200",
      "evidence": "verification.json", "lifecycle": ["execute"],
      "status": "done", "completion_confirmed": true, "completed_at": "2026-06-12T16:00:00Z" },
    { "id": "G2", "goal": "Token refresh", "done_when": "POST /api/auth/refresh returns new JWT",
      "evidence": "verification.json", "lifecycle": ["execute"],
      "status": "pending", "completion_confirmed": false },
    { "id": "G3", "goal": "Middleware guard", "done_when": "401 on invalid token",
      "evidence": "e2e-results.json", "lifecycle": ["execute", "test"],
      "status": "pending", "completion_confirmed": false }
  ],
  "task_decomposition_all_done": false,

  // === 目标变更日志 ===
  "goal_changelog": [
    { "id": "CHG-001", "timestamp": "2026-06-12T15:30:00Z", "change_type": "modify",
      "reason": "Split single auth goal into JWT + refresh + middleware",
      "impact_assessment": { "risk_level": "low", "invalidated_steps": [], "new_steps_inserted": 0 },
      "before": { "goals": [{"id":"G1","goal":"Complete auth system","done_when":"all auth works"}] },
      "after":  { "goals": [{"id":"G1","goal":"JWT issuance","done_when":"login returns JWT"},
                             {"id":"G2","goal":"Refresh","done_when":"refresh returns new JWT"},
                             {"id":"G3","goal":"Guard","done_when":"401 on invalid token"}] } }
  ]
}
```

### 字段分类

| 类别 | 字段数 | 关键字段 |
|------|--------|----------|
| **标识** | 5 | `session_id`, `source`, `status`, `ralph_protocol_version`, `cli_tool`, `platform` |
| **意图与位置** | 5 | `intent`, `lifecycle_position`, `phase`, `phase_is_new`, `milestone` |
| **模式控制** | 5 | `auto_mode`, `quality_mode`, `planning_mode`, `scope_verdict`, `wants_roadmap` |
| **引用** | 4 | `analyze_macro_id`, `blueprint_id`, `decomposition_owner`, `active_step_index` |
| **步骤** | 1 | `steps[]`（每步 25+ 字段） |
| **分解** | 5 | `boundary_contract`, `execution_criteria`, `task_decomposition`, `task_decomposition_all_done`, `goal_changelog` |
| **上下文** | 2 | `context`, `passed_gates` |

### Step 字段详解

| 字段 | 类型 | 说明 |
|------|------|------|
| `index` | number | 步骤序号 |
| `skill` | string | 执行 step 的 skill 名；decision 节点为空 |
| `args` | string | skill 参数 |
| `stage` | string | 生命周期阶段标识 |
| `scope` | string? | `"phase"` / `"standalone"` / `"milestone"` / null |
| `decision` | string? | 非空 → decision 节点（值为 gate 名）；null → 执行 step |
| `retry_count` | number | decision 节点重试计数 |
| `max_retries` | number | decision 节点最大重试（默认 2） |
| `command_scope` | string? | `"global"` / `"project"` / `"missing"` / null（decision 节点） |
| `command_path` | string? | Skill `.md` 绝对路径（由 `maestro skills` 预校验） |
| `milestone_id` | string? | D-007 反查注入的 milestone ID |
| `source_artifact_ref` | string? | `--from` 注入的源 artifact 引用 |
| `status` | string | `pending` / `running` / `completed` / `skipped` / `failed` |
| `goal_ref` | string? | 匹配的子目标 ID（如 `"G2"`） |
| `completion_confirmed` | boolean | 是否已确认完成（由 CLI 写入） |
| `completion_status` | string? | `DONE` / `DONE_WITH_CONCERNS` / `NEEDS_RETRY` / `BLOCKED` |
| `completion_evidence` | string? | 证据路径 |
| `completion_summary` | string? | 一句话总结（DONE 时 MUST） |
| `completion_decisions` | string[]? | 本步关键决策列表 |
| `completion_caveats` | string? | 后续需注意事项 |
| `completion_deferred` | string[]? | 推迟到后续的工作 |
| `completed_at` | string? | ISO 时间戳 |
| `deferred_reads` | string[] | `run brief` 解析的 deferred 文件 |
| `load` | object? | 加载记录（loaded_at, required_files, deferred_files, resolve_version） |

---

## 质量管线与 passed_gates

`session.passed_gates[]` 记录已通过的质量门，用于重试优化：

| 场景 | 行为 |
|------|------|
| 重试时已通过且代码未变 | 跳过该质量门 |
| 代码修改后 | 清除受影响的门，重新执行 |
| accepted repair proposal 插入 | 按 proposal 影响范围重新评估下游门 |

质量模式决定管线长度：

| 模式 | execute 之后的管线 |
|------|-------------------|
| `full` | business-test → review → test-gen → test → frontend-verify（若 UI） |
| `standard` | review → test-gen（coverage<80% 时） → test → frontend-verify（若 UI） |
| `quick` | review --tier quick |

---

## 统一执行器

Maestro 和 Ralph 共用 `run-executor` 与 canonical Run lifecycle：

- **Skill step**：`run next/brief` 加载并只执行一个 Run
- **proposal**：executor 返回 Artifact/proposal，不 complete、不直接改链
- **completion**：外层 policy 调 `run complete [--chain-proposal]`，下一步仍需显式 `run next`

Session 不按 Maestro/Ralph 分型；是否出现 decision/repair step 由 initial chain 或 Skill proposal 决定。

---

## 执行流程

| 模式 | 流程 |
|------|------|
| **新会话** | 推断位置 → 构建 initial chain → 创建 canonical Session → 执行 Run |
| **恢复** | 定位 compatible Session → 读取 Run/Artifact → 评价可选 proposal → 继续 |
| **`-y` 全自动** | 执行 → 按 budget/confidence policy 处置 proposal → 继续或暂停 |
| **`--amend`** | 修改运行中 Session 目标 → planning Skill 提出后续 proposal → 继续 |

---

## Error Codes

| Code | 严重性 | 说明 | 恢复 |
|------|--------|------|------|
| E001 | error | 无 intent 且无 running session | 提示输入 intent |
| E002 | error | 无法推断生命周期位置 | 显示原始状态，询问 |
| E003 | error | decision 所需 artifact 目录未找到 | 显示 glob 结果，询问 |
| E004 | error | delegate verdict 解析失败 | fallback: "fix" |
| E005 | error | delegate 执行失败 | fallback: "fix" |
| E006 | error | step 的 command_scope == "missing" | 列出缺失 skill，中止 build |
| E007 | error | required_reading 文件缺失 | 暂停 session，修复后继续 |
| W001 | warning | Decision 扩展了链 | 自动处理 |
| W002 | warning | 达到最大重试，升级 | 自动处理 |
| W003 | warning | 多个 running session | 使用最新的，警告 |
| W004 | warning | delegate 低置信度 | 显示警告 |
