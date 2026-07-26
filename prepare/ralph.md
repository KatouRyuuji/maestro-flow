---
name: ralph
description: "Closed-loop policy over the canonical Session/Run chain — retry, confidence, drift, goal-audit and stopping policy"
goal: true
argument-hint: "<intent> [-y] [-c] [--amend]"
contract:
  consumes: []
  produces: []
refs:
  - { path: workflows/ralph-amend-goal.md, when: "--amend flag is present" }
---

# Prepare: Ralph

Ralph 是闭环编排策略层。本文件定义 **命令选择**（Stage Mapping）和 **建链规则**（Build Rules）。
执行循环行为见 `workflows/orchestrator-run-loop.md`；生命周期契约见 `workflows/run-mode.md`。

## Stage Mapping

从 `lifecycle_position` 到 `session-seal` 的完整命令目录。每个 execution step 由 Skill 执行；decision step 由只读 evaluator 评估。

| Stage | Skill 命令 | Decision after | quality_mode |
|-------|-----------|----------------|--------------|
| grill | `grill "{intent}"` | — | all（`-y` 时透传 `-y` 到 grill args） |
| brainstorm | `brainstorm "{intent}" [--from grill:{grill_id}]` | — | all |
| blueprint | `blueprint "{intent}"` | — | all |
| init | `maestro-init` | — | all |
| specs-setup | `maestro-spec setup` | — | all（仅当 `.workflow/specs/` 不存在时插入） |
| analyze-macro | `analyze "{intent}"` | `post-analyze-scope` | all |
| roadmap | `roadmap --from analyze:{analyze_macro_id}` | — | all（仅 scope_verdict=large + wants_roadmap） |
| analyze | `analyze --session {session}` | — | all |
| plan | `plan --session {session}` 或 `plan --from analyze:{id}` 或 `plan --from blueprint:{id}` | — | all |
| execute | `execute --session {session}` | `post-execute` | all |
| business-test | `auto-test --session {session}` | `post-business-test` | full only |
| review | `review --session {session} [--tier quick]` | `post-review` | all（quick 模式追加 `--tier quick`） |
| test-gen | `auto-test --session {session}` | — | full / standard if coverage<80% |
| test | `test --session {session}` | `post-test` | full, standard |
| frontend-verify | `test --session {session} --frontend-verify` | `post-frontend-verify` | all（仅当交付 UI 时插入） |
| goal-audit | *(decision-only)* | `post-goal-audit` | all（仅当有 decomposition 时） |
| session-seal | *(decision-only)* | `post-session` | all |
| debug-escalate | *(decision-only)* | `post-debug-escalate` | all（仅当 debug step 升级时插入） |

## Build Rules（按顺序应用）

0.5. **specs 预检**：`lifecycle_position ∉ {grill, brainstorm, blueprint, init}` 且 `.workflow/specs/` 不存在 → 链路最前面插入 `specs-setup`（step 名是复数 `specs-setup`，对应 `workflows/specs-setup.md`；`spec-setup` 不是可解析 step 名）。
1. **起点**：从 `lifecycle_position` 开始。
2. **跳过已完成**：跳过当前 session 下已有 completed artifact 的 stage。
3. **quality_mode 过滤**：按 `quality_mode` 排除不匹配 stage。
3.5. **grill -y 透传**：`-y` 时为 grill args 追加 `-y`；保留 grill stage 与 brainstorm 的 `--from grill:*`。
3.6. **frontend-verify UI 门控**：仅当交付前端（检出 `dashboard/` 或 UI 关键词）时保留；纯后端删除。
4. **决策节点**：每个 Decision after 非空的 stage 后插入 decision step（`decision_ref: "<gate>"`）+ 对应 `decision_points` 条目。
5. **goal-audit 插入**：有 `task_decomposition` 时，在最后一个 evidence-producing stage 后、`session-seal` 前插入 `post-goal-audit`。
5.5. **re-grounding 插入**：有 decomposition 且执行 step ≥3 → 从第 3 个执行 step 起每隔 3 个插入 `post-reground`（不与已有 quality-gate 相邻）。
6. **终点硬约束**：有 `session_id` → chain 以 `session-seal`(decision:post-session) 结尾；standalone → 以最后一个质量门结尾。
7. **goal_ref 传播**：有 decomposition 时，每个 step 按 `stage ∈ goal.lifecycle` 匹配 `goal_ref`。
8. **占位符**：`{session}` `{intent}` 由运行时替换。
9. **skill 名预校验**：通过 `maestro skills --steps --json --platform claude` 拉取可用 commands + skills + steps 注册表，匹配 skill 名；未命中 → 报错不进 chain。省略 `--platform` 会返回全平台混合结果，必须显式指定。
10. **step 形态**：chain-file step 仅 `command/args?/stage?/goal_ref?/retry_max?/decision_ref?`。
11. **scope_verdict gating**（起点 = analyze-macro 时）：
    - `large` + `wants_roadmap` → 保留 roadmap + analyze；plan 用 `--session`
    - 其余 → 跳过 roadmap + analyze；plan 用 `--from analyze:{id}`
    - `unknown` → 默认 standalone，由 `post-analyze-scope` 决策纠正
12. **--from 自动注入**：
    - `analyze_macro_id` + roadmap → `--from analyze:{id}`
    - `analyze_macro_id` + standalone plan → `--from analyze:{id}`
    - `blueprint_id` + plan → `--from blueprint:{id}`（优先级低于 `--session`）
    - Session 内来源由 Run upstream 审计，不复制到 args
13. **动态插入步骤**同样应用规则 7-12。

## Decision Gate 分类与评估

每个 decision step 按 `decision_ref` 分为 5 类，各类由不同的评估方法处理：

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

解析失败 → `fix`, confidence=low, `parse_failed=true`。

### Goal Audit 详细流程（post-goal-audit）

1. 读取 `orchestration.decomposition.goals` 中 status≠done 的子目标
2. 打开 evidence 产物，对照 `done_when` 严格判定 met/unmet
3. 对照 intent + definition_of_done 判定意图保真
4. 结果路由：
   - `has_unmet` → **fix loop**：按 `target_stage` 插入修复 step（由 Skill proposal 产生）
   - `all_met` + `INTENT_ALIGNED=true` → proceed → seal
   - `all_met` + `INTENT_ALIGNED=false` → **REGROUND_HALT**（即使 -y）

### Reground 详细流程（post-reground）

1. 读取 intent + boundary_contract + 已完成 steps 的 handoff + 已 done goals
2. 判定累积产出是否仍服务 intent
3. 结果路由：
   - `aligned` → proceed
   - `drifted` + confidence ≥ 60 → **REGROUND_HALT**（-y 不跳过）
   - `drifted` + confidence < 60 → proceed（标记 LOW CONFIDENCE）

### Scope Verdict 应用（post-analyze-scope）

1. 读取 macro analyze 的 `conclusions.scope_verdict`（large/medium/small/unknown）
2. 写入 session.scope_verdict + analyze_macro_id
3. 路由：
   - `large` + wants_roadmap → 保留 roadmap + analyze；plan 用 `--session`
   - 其余 → 跳过 roadmap + analyze；plan 用 `--from analyze:{id}`
   - `unknown` → 默认 standalone，询问用户（-y 不猜测）

### Post-Session Preflight（post-session）

1. 只读核验：所有 execution Run 已 sealed、无 claimed request、session gates clean、goal audit 已通过
2. preflight clean → verdict=proceed → `session decide` 然后 `session seal`
3. preflight blocking → verdict=fix + 精确 blocker；Session 保持 running

## Chain Definition 格式

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

创建命令：`maestro session create "{intent}" --id {slug} --chain-file {path}`
