---
name: ralph
prepare: ralph
commands: [maestro-ralph]
session-mode: inherited
finish:
  - Confirm every decision node has a terminal verdict before session complete.
  - Confirm every goal's done_when is evidenced before goal-audit pass.
---

# Workflow: Ralph

Closed-loop policy over the canonical Session/Run chain. Ralph 拥有策略循环（retry、confidence、drift、goal-audit、stopping）；执行循环与 mutation authority 遵循 `orchestrator-run-loop.md`。

## State Persistence

状态与迁移由 `maestro-ralph.md` `<state_machine>` 独占定义（状态名以该处为准）。本节只声明每个状态的持久化产物：

| State | 持久化 |
|-------|--------|
| S_RESOLVE | session_id + orchestration_revision（public locator） |
| S_INFER | Session chain position, phase |
| S_DECOMPOSE | Session objective/boundary_contract, goals |
| S_BUILD | Session chain definition（仅内存，经 `session chain insert` 落链） |
| S_CREATE | `session/3.0` Session open receipt |
| S_EVALUATE | decision receipt（`run decide`） |
| S_FAIL | chain step.status / decision gate status |
| S_RECOVER | `session status` / `run transition` / `run cancel` / `run next` receipt + fresh revision |
| S_AMEND | chain-aware proposal receipt |
| S_DONE | `session complete` transition receipt |

S_PARSE / S_CONFIRM / S_RUN_LOOP 无自有持久化产物。

## Lifecycle Inference（S_INFER）

从 intent + 同 Session 的 sealed Run/chain snapshots 推断起点：

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

MANDATORY: execute ~/.maestro/workflows/orchestrator-run-loop.md "4. Decision step"; REQUIRED produce: verdict submitted via fenced `maestro run decide ... --json` + fresh `run-response/1.2` continuation/fence read. Evaluator 输出格式见 `prepare/ralph.md`；Ralph 策略阈值见 `maestro-ralph.md` A_EVALUATE。

## Boundary

**In scope**: Session chain lifecycle policy - decompose, build chain, dispatch, evaluate, drift-check, amend, recover, complete current Session.
**Out of scope**: Step execution (belongs to Skills), permanent Session lifecycle mutation beyond `session complete` (no paused/archived lifecycle inside a run loop), CLI administration.

## Legacy `session/1.x/2.x` Compatibility Branch

旧运行时（`session/2.0 + execution/1.0 + core_execution_lease + run-response/1.1`）的状态产物以 bounded Execution 为中心：S_CREATE 为 identity-only Session + `execution start` + private core claim；S_FAIL 记录 Execution step.status / paused status；S_RECOVER 走 `execution resolve` -> `execution resume` 并保留新 claim；S_DONE 验证 `execution-seal-receipt/1.0`。这些仅对显式选择旧 CLI/schema 的调用者生效，deprecated/legacy-only。
