---
name: ralph
prepare: ralph
commands: [maestro-ralph]
session-mode: inherited
finish:
  - Confirm every decision node has a terminal verdict before sealing.
  - Confirm every goal's done_when is evidenced before goal-audit pass.
---

# Workflow: Ralph

Closed-loop policy over the canonical Session/Execution/Run chain. Ralph 拥有策略循环（retry、confidence、drift、goal-audit、stopping）；执行循环与 mutation authority 遵循 `orchestrator-run-loop.md`。

## State Persistence

状态与迁移由 `maestro-ralph.md` `<state_machine>` 独占定义（状态名以该处为准）。本节只声明每个状态的持久化产物：

| State | 持久化 |
|-------|--------|
| S_RESOLVE | session_id + execution_id + generation（public locator） |
| S_INFER | Execution position, phase |
| S_DECOMPOSE | Execution boundary_contract, goals |
| S_BUILD | Execution chain definition（仅内存，交给 negotiated bootstrap） |
| S_CREATE | identity-only Session + bounded Execution + private core claim |
| S_EVALUATE | Execution decision receipt |
| S_FAIL | Execution step.status / paused status |
| S_RECOVER | execution resolve/resume receipt + new claim |
| S_AMEND | Execution-owned proposal receipt |
| S_DONE | execution-seal-receipt/1.0 |

S_PARSE / S_CONFIRM / S_RUN_LOOP 无自有持久化产物。

## Lifecycle Inference（S_INFER）

从 intent + 同 Session 的 sealed Run/Execution snapshots 推断起点：

| 证据 | lifecycle_position |
|------|-------------------|
| 无 prior artifacts | `analyze`（默认）或 `grill`/`brainstorm`/`blueprint`（intent 显式要求） |
| 有 grill-report | `brainstorm` |
| 有 brainstorm + context-package | `blueprint` 或 `analyze` |
| 有 blueprint | `plan` |
| 有 analyze conclusions | `plan` |
| 有 plan tasks | `execute` |
| 有 execute outputs | `review` |
| 多 release 证据 | wants_roadmap = true → `analyze-macro` |

Roadmap 仅在多 release 证据时推断。Quality = quick/standard/full 基于 specs 和可观测风险，非用户 flag。

## Decomposition（S_DECOMPOSE）

广泛 intent 时最多问 3 个问题（scope、constraints、observable done criteria）；`-y` 不跳过广泛歧义。

产出：
- `boundary_contract`：in_scope / out_of_scope / constraints / definition_of_done
- `goals`：outcome-oriented 子目标（非 lifecycle 复刻），每个含 `done_when` + `evidence` + `lifecycle` 映射
- `execution_criteria`：可观测执行准则

## Decision Evaluation（S_EVALUATE）

MANDATORY: execute ~/.maestro/workflows/orchestrator-run-loop.md "4. Decision step"; REQUIRED produce: verdict submitted via fenced `maestro run decide ... --json` + fresh `run-response/1.1` continuation/fence read. Evaluator 输出格式见 `prepare/ralph.md`；Ralph 策略阈值见 `maestro-ralph.md` A_EVALUATE。

## Boundary

**In scope**: Execution lifecycle policy - decompose, build chain, dispatch, evaluate, drift-check, amend, recover, seal current generation.
**Out of scope**: Step execution (belongs to Skills), permanent Session lifecycle mutation (not present in `session/2.0`), CLI administration.
