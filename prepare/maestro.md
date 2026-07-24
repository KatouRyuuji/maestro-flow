---
name: maestro
description: "Intent-to-chain planner over the canonical Session/Run lifecycle"
goal: true
argument-hint: "<intent> [-y] [-c] [--amend]"
contract:
  consumes: []
  produces: []
refs:
  - { path: workflows/maestro.md, when: "initial intent classification (A_CLASSIFY)" }
  - { path: workflows/ralph-amend-goal.md, when: "--amend flag is present" }
---

# Prepare: Maestro

Maestro 是意图到链的规划器。本文件定义 **公共接口** 和 **建链协议**。
意图分类目录见 `workflows/maestro.md`（deferred reading）；执行循环见 `orchestrator-run-loop.md`。

## Public Flags

| Flag | 行为 |
|------|------|
| `-y` | 自动确认低风险分类和 proposal；不越高风险、低置信度、边界歧义、drift 熔断 |
| `-c` | 继续唯一 live compatible Session；多候选必须询问；paused 进入 audited recovery |
| `--amend` | 修改唯一 live Session 的目标；剩余文本为 change request |

其余文本全部视为 intent。Executor、platform、roadmap、quality、模板复用、并行与对抗策略由 intent、Session state、Skill contract 和 host runtime 推断。

## Classification Protocol（A_CLASSIFY）

读取 deferred `workflows/maestro.md`，执行意图分类：

1. **Exact match**：`continue/next/go/继续` → state_continue；`status/状态` → status
2. **Semantic match**：LLM 语义理解匹配 task_type（见 maestro.md Chain Catalog）
3. **Selection priorities**：issue_id > team > UI/design > multi-step > single-step > companion fallback
4. **State validation**：execute 无 plan → 警告并前置 plan；test 未执行 → 警告并前置 execute

输出：`{ task_type, scope, issue_id, phase_ref, urgency }`

## Chain Creation Protocol（A_CREATE）

1. 从 `chainMap[task_type]` 获取步骤列表
2. 解析占位符：`{phase}` → resolvePhase()、`{description}` → intent、`{issue_id}` → resolveIssueId()
3. 写入临时 JSON chain-file
4. 调用 `maestro session create "{intent}" --id maestro-{slug} --chain-file {path} --no-dispatch`
5. 删除临时文件
6. 进入共享执行循环（orchestrator-run-loop.md）

### resolvePhase 优先级

1. `intent_analysis.phase_ref`（结构化提取）
2. 正则匹配 "phase N" 或裸数字
3. 项目状态推断：in-progress execute → 首个未完成 phase → 最新 artifact phase
4. `analyze-plan-execute` 链 → null（用 `{run_dir}`）
5. 所有命令均 phase-independent → null
6. 询问用户

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

## Decomposition（广泛 intent）

最多问 3 个问题（scope、constraints、observable done criteria）；`-y` 不跳过广泛歧义。

产出 `boundary_contract` + outcome-oriented `goals`（非 lifecycle 复刻）。
