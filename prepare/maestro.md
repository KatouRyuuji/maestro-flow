---
name: maestro
description: Intent-to-chain planner over the canonical Session/Run lifecycle
argument-hint: <intent> [-y] [-c] [--amend]
contract:
  consumes: []
  produces: []
  contract_version: 2.1
refs:
- path: workflows/maestro.md
  when: initial intent classification (A_CLASSIFY)
- path: workflows/ralph-amend-goal.md
  when: --amend flag is present
goal: true
---

# Prepare: Maestro

Maestro 是意图到链的规划器。本文件定义 **公共接口**、**分类协议**、**建链协议** 和 **分解协议**。
意图分类目录见 `workflows/maestro.md`（deferred reading）；执行循环见 `orchestrator-run-loop.md`。

## Public Flags

| Flag | 行为 |
|------|------|
| `-y` | 自动确认低风险分类和 proposal；不越高风险、低置信度、边界歧义、drift 熔断 |
| `-c` | 继续唯一 live compatible Session（`session/3.0`）；多候选必须询问；有 open decision gate 时进入 audited recovery |
| `--amend` | 修改唯一 live Session 的目标；剩余文本为 change request |

其余文本全部视为 intent。Platform、roadmap、quality、模板复用、并行与对抗策略由 intent、Session state、Skill contract 和 host runtime 推断。

## Classification Protocol（A_CLASSIFY）

读取 deferred `workflows/maestro.md`，执行意图分类：

1. **Exact match**：`continue/next/go/继续` → state_continue
2. **Semantic match**：LLM 语义理解匹配 task_type（见 maestro.md Chain Catalog）
3. **Selection priorities**：issue_id > team > UI/design > multi-step > single-step > companion fallback
4. **State validation（W003）**：execute 无 plan → 警告并前置 plan；test 未执行 → 警告并前置 execute
5. **Classification evidence（必须）**：记录匹配了哪个 pattern、排除了哪些备选、confidence level。无记录的分类不可进入 A_CREATE

输出：`{ task_type, scope, issue_id, phase_ref, urgency }`

## Chain Creation Protocol（A_CREATE）

### 1. Specs 预检

chain 包含 analyze/plan/execute 等执行 stage 且 `.workflow/specs/` 不存在 → 在 steps 最前面插入 `specs-setup`（step 名是复数，对应 `workflows/specs-setup.md`；`spec-setup` 不是可解析 step 名）。chain ∈ {grill, brainstorm, blueprint, init} 时跳过。

### 2. Skill 名预校验

先把当前 host 映射为 Skill scanner 接受的 `target_platform`（`claude|codex|agent|agy|pi`），再通过 `maestro skills --steps --json --platform {target_platform}` 预校验所有 step 名（project 覆盖 global）。不得省略 `--platform`，也不得为非 Claude host 回退到 `claude`；未命中 → 报错 E005，阻断建链。`pi` 的 Skill 来源是已安装 `pi-maestro-flow` npm 包中 `package.json#pi.skills` 声明的目录。

### 3. 组装 chain 定义

```json
{
  "intent": "<intent>",
  "engine": "coordinator",
  "quality_mode": "standard",
  "auto_mode": false,
  "boundary_contract": {
    "in_scope": [], "out_of_scope": [], "constraints": [], "definition_of_done": ""
  },
  "steps": [
    { "command": "analyze", "args": "--session {session}", "stage": "analyze", "goal_ref": "G1", "retry_max": 2 },
    { "command": "execute", "args": "--session {session}", "stage": "execute", "goal_ref": "G1", "retry_max": 2 },
    { "command": "review", "args": "--session {session}", "stage": "review", "retry_max": 2 }
  ],
  "decision_points": [],
  "decomposition": {
    "execution_criteria": [],
    "goals": [
      { "id": "G1", "goal": "...", "done_when": "...", "lifecycle": ["execute", "review"], "status": "pending" }
    ],
    "changelog": []
  }
}
```

- `engine: coordinator` 是兼容持久化字段，不是 Session 类型或策略
- `{session}` `{intent}` 占位符由运行时替换
- `decision_points` 只为读取/继续 legacy Session 保留；新链使用可执行 Skill step

### 4. 创建

`maestro session open "{intent}" --id maestro-{slug} [--definition-of-done "<text>"] [--chain <commands...>] --participant {participant_id} --actor {actor_id} --request-id {request_id} --reason "<reason>" [--evidence <ref> ...] --json`

chain 随 `session open --chain` 建入（或随后用 `session chain insert` 补齐 step 元数据），无临时 chain-file。随后进入共享执行循环（orchestrator-run-loop.md）。

## Decomposition Protocol（A_DECOMPOSE）

设 `decomposition_owner = "maestro"`。下游 ralph 只消费不二次提问。

1. 分类意图广度：narrow / 单步 / {init} 链 → 跳过分解
2. broad/medium → 最多问 3 轮：Scope / Constraints / Definition of Done（`-y` 不跳过广泛歧义）
3. 派生 `execution_criteria` + `goals`（每个含 `done_when` + `evidence` + `lifecycle`）
4. `boundary_contract` 随 `session open` 建入；goals 装入 chain 的 `decomposition` 元数据
5. 需要终结目标审计时，追加 audit/verify Skill step（拥有 Run，可按 contract 产出 proposal）

### Goal 绑定提示

分解完成后输出 `/goal` 绑定提示词（不阻塞）：

```
📋 任务分解完成。可随时设定目标：
/goal 完成以下子目标：
- G1: {goal} — 完成条件: {done_when}
- G2: ...
达成条件: session.json 中 goals[*].status == "done" 且 chain[*].status ∈ {completed,skipped}
```

## Minimum Chain Rules

| 意图证据 | 初始链 |
|---------|--------|
| 窄修复/变更 | analyze → plan → execute → review/test（按需） |
| 广泛重写/迁移 | analyze-macro → scope decision → plan/roadmap |
| 头脑风暴/探索 | brainstorm → 仅 Skill-proposed continuation |
| 压力测试/grill | grill → 仅 Skill-proposed continuation |
| 正式规格 | blueprint → plan |
| 已有 compatible Session | 不重建；进入共享循环 |

Roadmap 仅在多 release 证据时推断。Quality 基于 specs 和可观测风险，非用户 flag。

## resolvePhase 优先级

1. `intent_analysis.phase_ref`（结构化提取）
2. 正则匹配 "phase N" 或裸数字
3. 项目状态推断：in-progress execute → 首个未完成 phase → 最新 artifact phase
4. `analyze-plan-execute` 链 → null（用 `{run_dir}`）
5. 所有命令均 phase-independent → null
6. 询问用户

## Invariants（Maestro 特有）

1. **One chain, executor-neutral** — 执行始终派发 run-executor（默认行为），不产生 Session 分型
2. **Session before execution** — session.json 经 `session open --chain` 创建后才执行（`orchestration_revision` CAS 保护所有 mutation）
3. **Creator owns decomposition** — Maestro 创建 boundary_contract + goals；后续 orchestrator 只消费不覆盖
4. **Classification evidence** — 分类必须留痕（匹配 pattern、排除备选、confidence）
5. **Verdict 驱动链推进** — 由 fenced `maestro run complete ... --advance --verdict done|done_with_concerns` 驱动 chain step 完成；链终结后 `session complete`
6. **禁止以上下文消耗为由中断执行** — harness 自动处理 context compression
7. **控制权优先级** — Maestro 拥有 initial chain 选择 + proposal disposition；Skill 拥有领域判断；Runtime 独占 mutation authority

## Legacy `session/1.x/2.x` Compatibility Branch

deprecated/legacy-only（旧 CLI/schema，v2 契约 `session/2.0 + execution/1.0 + core_execution_lease + run-response/1.1`）：

- 创建：`maestro session create "{intent}" --id maestro-{slug} --chain-file {path}`（删除临时 chain-file 后进入共享循环）。
- chain 推进：`session done --verdict` 驱动 chain step 完成；`-c` 对 paused Execution 进入 audited recovery。
- chain 终结条件：session.json 中 chain[*].status ∈ {completed,sealed,skipped}。
- `engine: coordinator` 是兼容持久化字段（v2 保留），不是 Session 类型或策略。
