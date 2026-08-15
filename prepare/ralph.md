---
name: ralph
description: Closed-loop policy over the canonical Session/Run chain — retry, confidence, drift, goal-audit and stopping policy
argument-hint: <intent> [-y] [-c] [--amend]
contract:
  consumes: []
  produces: []
  contract_version: 2.1
refs:
- path: workflows/ralph-amend-goal.md
  when: --amend flag is present
goal: true
---

# Prepare: Ralph

Ralph 是闭环编排策略层。本文件定义 **命令选择**（Stage Mapping）和 **建链规则**（Build Rules）。
执行循环行为见 `workflows/orchestrator-run-loop.md`；生命周期契约见 `workflows/run-mode.md`。

## Execution Authority Invariants

1. 首次 mutation 前执行 `maestro capabilities --json`，只接受 v3 六键 exact capability contract：`features.session_run_minimal_v3=true`、`features.entity_revision_cas=true`、`features.participant_identity=true`、`features.request_receipts_v2=true`、`features.execution_lease=false`、`features.operation_registry=false`；`session_schema_writes` 含 `session/3.0`、`execution_schema_writes` 为空、`run_response_writes` 含 `run-response/1.2`；不完整则 fail closed。
2. Ralph 全程保留 exact `session_id + orchestration_revision`（run-target mutation 另含 `run_revision`），以及 `--participant + --actor` identity。每个 mutation 使用 stable unique `--request-id` + 当前 `--expected-orchestration-revision`，receipt（`run-response/1.2`）后刷新 fence，禁止按 Session status 或目录扫描猜 authority。
3. chain/gate/decision 只能在 Session chain 内 mutation：dispatch 用 fenced `maestro run next`（birth packet 含 `run_dir`/`upstream`/`guidance`/`knowledge_context`/`brief.command`/`run_already_created=true`），重挂用 `maestro run brief`（`brief-result/3.0` Resume Packet 含 `orchestration_revision`），completion 用 fenced `maestro run complete ... --advance`（verdict `done`/`done_with_concerns`），决策用 `maestro run decide`（`proceed`/`fix`/`escalate`），链调整用 `session chain insert|replace|skip`，冲突先读 `maestro session status`，最终只走 `maestro session complete`。Run 封存后不可变，retry 经 `run next` 重新派发 pending step；无 Execution、无 lease、无 paused。

## Stage Mapping

从 `lifecycle_position` 到 `session-complete` 的完整命令目录。每个 chain step 由 Skill 执行；decision step 由只读 evaluator 评估。Session（`session/3.0`）提供 durable topic identity 与 chain；所有节点、gate 和终结条件都属于 Session chain。

| Stage | Skill 命令 | Decision after | quality_mode |
|-------|-----------|----------------|--------------|
| grill | `grill "{intent}"` | — | all（`-y` 时透传 `-y` 到 grill args） |
| brainstorm | `brainstorm "{intent}" [--from grill:{grill_id}]` | — | all |
| blueprint | `blueprint "{intent}"` | — | all |
| init | `init` | — | all |
| specs-setup | `specs-setup` | — | all（仅当 `.workflow/specs/` 不存在时插入） |
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
| session-complete | *(decision-only)* | `post-execution` | all |
| debug-escalate | *(decision-only)* | `post-debug-escalate` | all（仅当 debug step 升级时插入） |

## Build Rules（按顺序应用）

0.5. **specs 预检**：`lifecycle_position ∉ {grill, brainstorm, blueprint, init}` 且 `.workflow/specs/` 不存在 → 链路最前面插入 `specs-setup`（step 名是复数 `specs-setup`，对应 `workflows/specs-setup.md`；`spec-setup` 不是可解析 step 名）。
1. **起点**：从 `lifecycle_position` 开始。
2. **跳过已完成**：跳过当前 session 下已有 completed artifact 的 stage。
3. **quality_mode 过滤**：按 `quality_mode` 排除不匹配 stage。
3.5. **grill -y 透传**：`-y` 时为 grill args 追加 `-y`；保留 grill stage 与 brainstorm 的 `--from grill:*`。
3.6. **frontend-verify UI 门控**：仅当交付前端（检出 `dashboard/` 或 UI 关键词）时保留；纯后端删除。
4. **决策节点**：每个 Decision after 非空的 stage 后插入 decision step（`decision_ref: "<gate>"`）+ 对应 `decision_points` 条目。
5. **goal-audit 插入**：有 `task_decomposition` 时，在最后一个 evidence-producing stage 后、`session-complete` 前插入 `post-goal-audit`。
5.5. **re-grounding 插入**：有 decomposition 且执行 step ≥3 → 从第 3 个执行 step 起每隔 3 个插入 `post-reground`（不与已有 quality-gate 相邻）。
6. **终点硬约束**：当前 Session 的 chain 以 `session-complete`(decision:post-execution) 结尾；standalone read-only 分析以最后一个质量门结尾。`maestro session complete` 完成 Session 身份，不销毁它（可 `unarchive` 再扩展）。
7. **goal_ref 传播**：有 decomposition 时，每个 step 按 `stage ∈ goal.lifecycle` 匹配 `goal_ref`。
8. **占位符**：`{session}` `{intent}` 由运行时替换。
9. **skill 名预校验**：先把当前 host 映射为 Skill scanner 接受的 `target_platform`（`claude|codex|agent|agy|pi`），再通过 `maestro skills --steps --json --platform {target_platform}` 拉取该平台的 commands + skills + steps 注册表并匹配 step 名；未命中 → 报错 E005，阻断建链。不得省略 `--platform`，也不得为非 Claude host 回退到 `claude`。`pi` 的 Skill 来源是已安装 `pi-maestro-flow` npm 包中 `package.json#pi.skills` 声明的目录，不是用户主目录下的裸 `.pi/skills`。
10. **step 形态**：Session chain step 仅 `command/args?/stage?/goal_ref?/retry_max?/decision_ref?`。chain definition 是 `session/3.0` 状态的一部分（`session open --chain` / `session chain insert`），不得作为任何独立 Execution/lifecycle 状态持久化。
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
| structural | post-execution | A_STRUCTURAL_EVALUATE | 全量核验（exact Session、Runs sealed + chain terminal） |
| structural | post-debug-escalate | A_PAUSE_ESCALATE | —（始终 escalate，阻止链推进；无 paused 状态） |

### Evaluator 输出格式（quality-gate / goal-gate / reground）

```text
---VERDICT---
STATUS: proceed|fix|escalate|PASS|FAIL|PARTIAL|BLOCKED|aligned|drifted|all_met|has_unmet
REASON: <一句话原因>
CONFIDENCE: high|medium|low
CONFIDENCE_SCORE: 0-100
---END---
```

### Goal Audit 详细流程（post-goal-audit）

1. 读取 `orchestration.decomposition.goals` 中 status≠done 的子目标
2. 打开 evidence 产物，对照 `done_when` 严格判定 met/unmet
3. 对照 intent + definition_of_done 判定意图保真
4. 结果路由：
   - `has_unmet` → **fix loop**：按 `target_stage` 插入修复 step（由 Skill proposal 产生）
   - `all_met` + `INTENT_ALIGNED=true` → proceed → session complete
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
2. 写入当前 Session 的 scope_verdict + analyze_macro_id
3. 路由：
   - `large` + wants_roadmap → 保留 roadmap + analyze；plan 用 `--session`
   - 其余 → 跳过 roadmap + analyze；plan 用 `--from analyze:{id}`
   - `unknown` → 默认 standalone，询问用户（-y 不猜测）

### Post-Execution Preflight（post-execution）

1. 只读核验 exact `session_id + orchestration_revision`：所有 Run 已 sealed、chain terminal（completed/skipped with evidence）、无 open decision gate、goal audit 已通过。
2. preflight clean -> verdict=proceed -> 通过当前 locator/revision 调用 `maestro run decide <post-execution> ... --verdict proceed --json`，消费新的 `run-response/1.2` fence，然后调用 `maestro session complete ... --json`。
3. preflight blocking -> verdict=fix + 精确 blocker；Session 保持 open，不得完成 Session 或报告整体完成。

## Chain Definition 格式

该定义属于将要创建的 `session/3.0` Session chain。进入创建前必须先执行 `maestro capabilities --json`，要求 v3 六键 exact contract（`session_run_minimal_v3`/`entity_revision_cas`/`participant_identity`/`request_receipts_v2` 全 true，`execution_lease`/`operation_registry` 全 false；`session_schema_writes` 含 `session/3.0`、`execution_schema_writes` 空、`run_response_writes` 含 `run-response/1.2`）；创建/解析后必须保留 exact `session_id + orchestration_revision` 与 `--participant + --actor` identity。

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

新运行时创建顺序：`maestro session open "{intent}" --id {slug} [--definition-of-done ...] [--chain <commands...>] --participant ... --actor ... --request-id ... --reason ... --json` -> `session chain insert` 补齐 step 元数据（goal_ref/stage/decision_ref）-> `maestro run next` 派发首个 step。chain 是 `session/3.0` 状态的一部分，不存在独立的 Execution bootstrap surface。

## Legacy `session/1.x/2.x` Compatibility Branch

旧 CLI/schema（v2 契约：`session/2.0 + execution/1.0 + core_execution_lease + run-response/1.1`）可继续用 `maestro session create "{intent}" --id {slug} --chain-file {path}`，并以 `maestro execution start`（`--expected-identity-revision`/`--expected-activity-revision`/`--expected-lease-epoch 0`/`--execution-owner`/`--owner-kind`）获取 bounded Execution 与 private core claim（`--owner-id/--owner-kind/--lease-epoch/--lease-id`），chain/gates/decision/lifecycle 在 Execution 内 mutation，paused recovery 走 `maestro execution resolve` -> `maestro execution resume`，最终 `maestro execution seal` 并验证 `execution-seal-receipt/1.0`。这些命令不是 `session/3.0` canonical authority，也不能用于替代丢失的 `orchestration_revision`。
