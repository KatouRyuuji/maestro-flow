---
title: "Ralph 闭环引擎与协调器指南"
icon: "🤖"
---

闭环编排策略层 — 在 canonical Session/Run 链之上施加 retry、confidence、drift、goal-audit 与 stopping policy；decision 节点动态扩展/收缩链。

> **v0.5.56 架构变更**：Maestro 与 Ralph 已合并为**单一 Session 链协议**。Ralph 不再拥有独立 CLI 驱动、私有 Session 类型或第二状态源——它只调用 `maestro session ...` / `maestro run ...`，与 Maestro 共享同一执行循环（`orchestrator-run-loop.md`）。独立的 `maestro ralph` CLI 子命令族（session/skills/next/check/complete）与 `--engine swarm --script wf-*` 语法已**全部退役**。

---

## 定位

Ralph 是 Maestro Flow 的**闭环编排策略层**。它在任意兼容的 canonical Session 上施加策略，而不是一种独立的执行引擎：

1. 从 intent 与同 Session sealed outputs 推断生命周期起点（**Stage Mapping**）
2. 按 **Build Rules** 构建从起点到 `session-seal` 的完整 Skill 链
3. 在关键检查点插入 **decision 节点**（quality / goal / scope / reground / structural），动态调整链
4. 失败时按 retry budget 重试，越限升级（escalate）暂停等人工

**活链**：链在执行过程中可由 Skill 通过 `chain-proposal/1.0` 增长/收缩，经 Ralph 评估后由 Runtime 原子应用。

### Maestro 与 Ralph 的关系

二者共享同一 Session/Run 协议与执行循环，区别在于**职责分工**而非 Session 分型：

| | `/maestro`（意图到链规划器） | `/maestro-ralph`（闭环策略层） |
|---|---------|---------------|
| **核心职责** | 意图分类 → 初始链选择 → decomposition | Stage Mapping → Build Rules → decision gate 策略 |
| **链构建** | 按意图证据选最小充分链 | 完整生命周期链 + 强制 decision 节点 |
| **Decision 节点** | 按需（Ralph policy 决定） | 每条链至少一个 quality/goal/scope decision；长链含周期性 reground |
| **闭环** | 共享 Run loop | retry / confidence / drift / goal-audit / stopping policy |
| **decomposition** | 创建 boundary_contract + goals（owner） | 消费 goals，goal-audit 判定 met/unmet |
| **适用场景** | 广泛意图路由、单次任务 | 完整 milestone 生命周期推进 |

> **One chain, executor-neutral**：不存在 static/dynamic、Maestro/Ralph 或 executor 专属的 Session 类型。每个任务都用同一 Session/Run 协议；`--executor agent|direct` 只选择执行方式，不产生 Session 分型。

---

## 使用方式

```bash
/maestro-ralph "实现用户认证系统"     # 新会话：分类 → 建链 → 执行闭环
/maestro-ralph -y "implement auth"   # 自动确认低风险策略决策
/maestro-ralph -c                    # 继续唯一 live 兼容 Session（paused 进入 audited recovery）
/maestro-ralph --amend "把目标改为支持 OAuth"   # 修改 live Session 目标
```

### 公共 Flags（仅此三个）

| Flag | 行为 |
|------|------|
| `-y` | 自动确认低风险策略决策；**不越**高风险、confidence<60、边界歧义、escalation、失败 gate 或 reground halt |
| `-c` | 继续唯一 live 兼容 Session；多候选必须询问；paused 进入 audited recovery；继承 `orchestration.auto_mode` |
| `--amend` | 修改唯一 live Session 的目标；剩余文本为 change request |

其余文本**全部视为 intent**。不解析任何 engine / roadmap / script / depth / role / tier / platform / resume / dry-run flag——这些选择属于 Skill contract 与 Runtime。

> **已退役**：`maestro ralph session/skills/next/check/complete` CLI 子命令族、`/maestro-ralph --engine swarm --script wf-*`、`/maestro-ralph --roadmap`、`/maestro-ralph continue`（继续语义由 `-c` 承接）。skill 发现改用 `maestro skills [--platform] [--steps]`。

---

## 三种节点类型

| 类型 | 执行方式 | 说明 |
|------|----------|------|
| **execution step** | 派发一个 unnamed `run-executor` | 实际命令执行（analyze、plan、execute、review…）；只声明 `command/args/stage/goal_ref/retry_max` |
| **decision step** | 派发一个**只读** generic evaluator | 读取 Run artifacts 与 goal evidence，输出 verdict；声明 `decision_ref`，不创建 Run |
| **（执行策略）** | 由 Skill 自身 contract 决定 | 串行/并行/对抗实现属于 Skill，Ralph 不通过 flag 干预 |

---

## Stage Mapping（生命周期阶段目录）

从 `lifecycle_position` 到 `session-seal` 的完整命令目录。每个 execution step 由 Skill 执行；decision step 由只读 evaluator 评估。

| Stage | Skill 命令 | Decision after | quality_mode |
|-------|-----------|----------------|--------------|
| grill | `grill "{intent}"` | — | all（`-y` 时透传 `-y`） |
| brainstorm | `brainstorm "{intent}" [--from grill:{grill_id}]` | — | all |
| blueprint | `blueprint "{intent}"` | — | all |
| init | `maestro-init` | — | all |
| specs-setup | `maestro-spec setup` | — | all（仅当 `.workflow/specs/` 不存在时插入） |
| analyze-macro | `analyze "{intent}"` | `post-analyze-scope` | all |
| roadmap | `roadmap --from analyze:{analyze_macro_id}` | — | all（仅 scope_verdict=large + wants_roadmap） |
| analyze | `analyze --session {session}` | — | all |
| plan | `plan --session {session}` / `--from analyze:{id}` / `--from blueprint:{id}` | — | all |
| execute | `execute --session {session}` | `post-execute` | all |
| business-test | `auto-test --session {session}` | `post-business-test` | full only |
| review | `review --session {session} [--tier quick]` | `post-review` | all（quick 模式追加 `--tier quick`） |
| test-gen | `auto-test --session {session}` | — | full / standard if coverage<80% |
| test | `test --session {session}` | `post-test` | full, standard |
| frontend-verify | `test --session {session} --frontend-verify` | `post-frontend-verify` | all（仅当交付 UI 时插入） |
| goal-audit | *(decision-only)* | `post-goal-audit` | all（仅当有 decomposition 时） |
| session-seal | *(decision-only)* | `post-session` | all |
| debug-escalate | *(decision-only)* | `post-debug-escalate` | all（仅当 debug step 升级时插入） |

<details>
<summary>完整流程图（standard 模式）</summary>

```
analyze-macro → ◆ post-analyze-scope → (roadmap) → analyze → plan
                                                              ↓
                                                          execute
                                                              ↓
                                                     ◆ post-execute
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
                                              (frontend-verify → ◆)
                                                              ↓
                                                  ◆ post-goal-audit
                                                              ↓
                                                      ◆ post-session
                                                              ↓
                                                          session seal
```

每个 `◆` 是一个 decision 节点，由只读 evaluator 评估并通过 `session decide` 提交 verdict。

</details>

---

## Build Rules（建链规则，按顺序应用）

| # | 规则 |
|---|------|
| 0.5 | **specs 预检**：起点 ∉ {grill, brainstorm, blueprint, init} 且 `.workflow/specs/` 不存在 → 链最前面插入 `specs-setup` |
| 1 | **起点**：从 `lifecycle_position` 开始 |
| 2 | **跳过已完成**：跳过当前 session 下已有 completed artifact 的 stage |
| 3 | **quality_mode 过滤**：按 `quality_mode` 排除不匹配 stage |
| 3.5 | **grill -y 透传**：`-y` 时为 grill args 追加 `-y`；保留 grill stage 与 brainstorm 的 `--from grill:*` |
| 3.6 | **frontend-verify UI 门控**：仅当交付前端（检出 `dashboard/` 或 UI 关键词）时保留；纯后端删除 |
| 4 | **决策节点**：每个 Decision after 非空的 stage 后插入 decision step（`decision_ref`）+ 对应 `decision_points` 条目 |
| 5 | **goal-audit 插入**：有 decomposition 时，在最后一个 evidence-producing stage 后、`session-seal` 前插入 `post-goal-audit` |
| 5.5 | **re-grounding 插入**：有 decomposition 且执行 step ≥3 → 从第 3 个执行 step 起每隔 3 个插入 `post-reground`（不与已有 quality-gate 相邻） |
| 6 | **终点硬约束**：有 `session_id` → chain 以 `session-seal`(decision:post-session) 结尾；standalone → 以最后一个质量门结尾 |
| 7 | **goal_ref 传播**：有 decomposition 时，每个 step 按 `stage ∈ goal.lifecycle` 匹配 `goal_ref` |
| 8 | **占位符**：`{session}` `{intent}` 由运行时替换 |
| 9 | **skill 名预校验**：通过 `maestro skills --steps --json` 拉取注册表匹配 skill 名；未命中 → 报错不进 chain |
| 10 | **step 形态**：chain-file step 仅 `command/args?/stage?/goal_ref?/retry_max?/decision_ref?` |
| 11 | **scope_verdict gating**（起点=analyze-macro）：`large`+wants_roadmap → 保留 roadmap+analyze，plan 用 `--session`；其余 → 跳过 roadmap+analyze，plan 用 `--from analyze:{id}`；`unknown` → 默认 standalone，由 `post-analyze-scope` 决策纠正 |
| 12 | **--from 自动注入**：`analyze_macro_id`+roadmap/standalone plan → `--from analyze:{id}`；`blueprint_id`+plan → `--from blueprint:{id}`（优先级低于 `--session`）；Session 内来源由 Run upstream 审计，不复制到 args |
| 13 | **动态插入步骤**同样应用规则 7-12 |

---

## Decision Gate 分类与评估

每个 decision step 按 `decision_ref` 分为 5 类，各类由不同评估方法处理：

| 类型 | decision_ref | 评估方法 | 读取文件 |
|------|-------------|---------|----------|
| quality-gate | post-execute | A_AGENT_EVALUATE | verification.json |
| quality-gate | post-business-test | A_AGENT_EVALUATE | .tests/auto-test/report.json |
| quality-gate | post-review | A_AGENT_EVALUATE | review.json |
| quality-gate | post-test | A_AGENT_EVALUATE | uat.md, .tests/test-results.json |
| quality-gate | post-frontend-verify | A_AGENT_EVALUATE | e2e-results.json |
| goal-gate | post-goal-audit | A_AGENT_GOAL_AUDIT | session.json goals + evidence |
| scope-gate | post-analyze-scope | A_SCOPE_EVALUATE | analyze conclusions.scope_verdict |
| reground-gate | post-reground | A_AGENT_REGROUND | intent + handoffs + goals |
| structural | post-session | A_STRUCTURAL_EVALUATE | 全量核验（runs sealed + gates clean） |
| structural | post-debug-escalate | A_PAUSE_ESCALATE | —（始终暂停） |

### Evaluator 输出格式（quality-gate / goal-gate / reground）

```text
---VERDICT---
STATUS: proceed|fix|escalate|PASS|FAIL|PARTIAL|BLOCKED|aligned|drifted|all_met|has_unmet
REASON: <一句话原因>
CONFIDENCE: high|medium|low
CONFIDENCE_SCORE: 0-100
---END---
```

解析失败 → `fix`，confidence=low，`parse_failed=true`。Ralph 策略阈值：**confidence < 60 不可 proceed**；retry budget 耗尽 → escalate。

### Goal Audit 详细流程（post-goal-audit）

1. 读取 `orchestration.decomposition.goals` 中 status≠done 的子目标
2. 打开 evidence 产物，对照 `done_when` 严格判定 met/unmet（缺证据视为 unmet）
3. 对照 intent + definition_of_done 判定意图保真
4. 结果路由：
   - `has_unmet` → **fix loop**：按 `target_stage` 插入修复 step（由 Skill proposal 产生）
   - `all_met` + `INTENT_ALIGNED=true` → proceed → seal
   - `all_met` + `INTENT_ALIGNED=false` → **REGROUND_HALT**（即使 `-y`）

### Reground 详细流程（post-reground）

1. 读取 intent + boundary_contract + 已完成 steps 的 handoff + 已 done goals
2. 判定累积产出是否仍服务 intent
3. 结果路由：
   - `aligned` → proceed
   - `drifted` + confidence ≥ 60 → **REGROUND_HALT**（`-y` 不跳过）
   - `drifted` + confidence < 60 → proceed（标记 LOW CONFIDENCE）

### Scope Verdict 应用（post-analyze-scope）

1. 读取 macro analyze 的 `conclusions.scope_verdict`（large/medium/small/unknown）
2. 写入 session.scope_verdict + analyze_macro_id
3. 路由：`large`+wants_roadmap → 保留 roadmap+analyze，plan 用 `--session`；其余 → 跳过 roadmap+analyze，plan 用 `--from analyze:{id}`；`unknown` → 默认 standalone，询问用户（`-y` 不猜测）

### Post-Session Preflight（post-session）

1. 只读核验：所有 execution Run 已 sealed、无 claimed request、session gates clean、goal audit 已通过
2. preflight clean → verdict=proceed → `session decide` 然后 `session seal`
3. preflight blocking → verdict=fix + 精确 blocker；Session 保持 running

---

## 质量管线模式

| 模式 | 质量步骤 | 触发条件 |
|------|----------|----------|
| `full` | execute → business-test → review → test-gen → test → (frontend-verify) | 有 REQ-*.md 且 phase scope |
| `standard` | execute → review → test（test-gen 按覆盖率条件） | 默认 |
| `quick` | execute → review `--tier quick`（跳过 business-test、test-gen、test） | 用户指定 |

quality_mode 由 specs 与可观测风险推断，**不是用户 flag**。已通过且代码未变的 gate 在重试时跳过，代码修改后清除受影响的 gate 重新执行。

---

## Session 文件（session.json）

v0.5.56 起，Session 状态统一存储于 `.workflow/sessions/{session-id}/session.json`（schema `session/1.3`）。`session.json.orchestration` 是 chain / goal / decision 的**唯一真相源**；Run 的 outputs/handoff/gate/proposal 归各 Run 目录。

<details>
<summary>chain-file / session.json 核心结构</summary>

```json
{
  "intent": "<intent>",
  "engine": "ralph",
  "quality_mode": "standard",
  "auto_mode": false,
  "boundary_contract": {
    "in_scope": [], "out_of_scope": [], "constraints": [], "definition_of_done": ""
  },
  "steps": [
    { "command": "analyze", "args": "--session {session}", "stage": "analyze", "goal_ref": "G1", "retry_max": 1 },
    { "command": "post-execute", "stage": "execute", "decision_ref": "post-execute" },
    { "command": "execute", "args": "--session {session}", "stage": "execute", "goal_ref": "G1", "retry_max": 2 }
  ],
  "decision_points": [
    { "point_id": "post-execute", "max_retries": 2 }
  ],
  "decomposition": {
    "goals": [
      { "id": "G1", "goal": "...", "done_when": "...", "lifecycle": ["execute", "review"], "status": "pending" }
    ]
  }
}
```

- `engine: ralph|coordinator|manual` 是兼容持久化字段，不是 Session 类型或策略
- `{session}` `{intent}` 占位符由运行时替换
- execution step 仅 `command/args?/stage?/goal_ref?/retry_max?`；decision step 声明 `decision_ref`
- goals 描述**结果**而非生命周期阶段

</details>

创建命令（编排器/skill 标准建链方式）：

```bash
maestro session create "{intent}" --id {slug} --chain-file {path}
```

> **legacy 迁移**：旧的 `.workflow/.maestro/ralph-*/status.json` 与 `ralph-meta.json` 通过 `maestro session migrate` 折叠进 `session.json` 并打 `session/1.3` 标记（幂等）。

---

## 执行循环（共享 Run Loop）

Maestro 与 Ralph 共享 `orchestrator-run-loop.md` 定义的执行循环。编排层调用 `maestro session ...`，执行层调用 `maestro run ...`，协议文件始终由 Runtime 写入。

```
session next --inline-brief --json   ← 分配下一 Run（birth packet 内联 Resume Packet）
        ↓
派发一个 unnamed run-executor（只执行该 Run，可按 Skill contract 串行/并行/对抗）
        ↓
executor 写 artifacts 到 {run_dir}/outputs/，handoff 写 {run_dir}/report.md
        ↓
maestro run check {run_id}           ← 扫描输出、评估 gate、发现并校验 chain-proposal/1.0
        ↓
maestro session done {run_id} --verdict ...   ← completion authority 属于 orchestrator
        ↓
读取 continuation：dispatch_next → 回到 session next；evaluate_decision → 转 decision；seal_session → 封存
```

**关键不变量**：

- `session next --inline-brief` 在 birth packet 内联完整 Resume Packet 与 Skill 正文，正常前向流程**无需**再调 `run brief`；`run brief` 仅用于回溯（崩溃恢复、上下文溢出、手动检查）。
- birth packet 的 `run_already_created=true` 是严格约束：立即加载该 exact `run_id` 的 brief，禁止再次 `run create`。
- executor **不调用** `session done/complete`；completion authority 属于 orchestrator。
- **Turn 终止不变量**：只要 Session 为 `running` 且存在可满足 preconditions 的 `automatic` continuation 动作，不得结束当前 turn 或仅把命令推荐给用户。

### Verdict 驱动链推进

执行步通过 `session done --verdict` 完成，决策步通过 `session decide --verdict` 完成：

| `session done --verdict` | 触发条件 |
|---|---|
| `done` | aligned |
| `done-with-concerns` | minor drift，或 major drift 已重试 |
| `needs-retry` | major drift，未重试 |
| `blocked` | external blocker |

`session decide --verdict`：`proceed`（继续）/ `fix`（需 repair Skill 产生 proposal）/ `escalate`（转 audited recovery）。`fix` 在获得新 repair evidence 前不得重复 decide。

---

## Chain Proposal（chain-proposal/1.0）

链的动态扩展/收缩通过 typed `chain-proposal/1.0` 完成：

- **Skill 提议**：execution Run 在 outputs 中产出 typed `chain-proposal/1.0`
- **Ralph 评估**：budget / confidence / intent-aligned / 是否越权
- **Runtime 原子应用**：accept 时调用 `session done ... --apply-proposal`，proposal 与 completion 在**同一事务**应用

`-y` 仅可自动接受：proposal valid、只修改 pending tail、未越 budget、intent aligned、无 escalate。reject 以 `--note` 记录理由；revise 则不 complete，用同一 `run_id` 重新 `run brief` 让原 Skill 修订后再 check。

> **No prompt fix templates**：fix/review/goal gaps 不直接复制 fix-loop 模板，而是派发一个可能产出 proposal 的 Skill。

---

## 最大重试与升级

每个 decision 节点携带 `retry_count` 和 `max_retries`（默认 2）：

- **retry 0/1**：评估失败 → 插入 fix 循环（由 Skill proposal 产生）
- **retry 2**：达到上限 → 升级到 `post-debug-escalate` → 暂停

升级后 Session 状态变为 `paused`。恢复仅由显式 `-c` 触发，走 audited recovery：

```bash
maestro session status <id>        # 读取 exact blocker 与 revisions
maestro session resolve --session <id> --decision <point> --disposition proceed   # 逐个解决 blocker
maestro session resume --session <id>        # blockers 清零后恢复（下一 Run 仍需显式 session next）
```

---

## Goal Amend（--amend）

读取 `ralph-amend-goal.md`，完成 snapshot → impact audit → confirmation → 通过 `maestro session meta update --session <id> --decomposition-file -` 整块更新 decomposition → planning Skill proposal。**高风险修改不受 `-y` 影响**，始终询问。

---

## Seal

所有 execution Runs sealed、decision steps terminal、goals done、Session gates clean 后：

```bash
maestro session seal {session_id} --summary "..."
```

sealed/archived 是**终态**：`session next` 返回 `CHAIN_COMPLETE`，不得 resume。

---

## 相关指南

- [CLI 终端命令参考](./cli-commands-guide.md) — `maestro session` / `maestro run` 完整命令
- [全部命令与工作流](./command-usage-guide.md) — slash 命令与工作流衔接
- [产物目录结构](./workflow-structure-guide.md) — `.workflow/sessions/` 布局与 session.json Schema
