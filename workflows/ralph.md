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

Closed-loop policy over the canonical Session/Run chain. Ralph 拥有策略循环（retry、confidence、drift、goal-audit、stopping）；执行循环行为遵循 `orchestrator-run-loop.md`。

## State Machine

```
S_PARSE → S_RESOLVE → S_INFER → S_DECOMPOSE → S_BUILD → S_CREATE → S_CONFIRM → S_LOOP → S_DONE
                                                                                   ↕
                                                                            S_EVALUATE (decision)
                                                                            S_FAIL (retry/pause)
                                                                            S_RECOVER (paused resume)
                                                                            S_AMEND (goal hot-modify)
```

### States

| State | 职责 | 持久化 |
|-------|------|--------|
| S_PARSE | 解析 intent + flags（-y, -c, --amend） | — |
| S_RESOLVE | 定位或创建 compatible Session | session_id |
| S_INFER | 推断 lifecycle_position + wants_roadmap | position, phase |
| S_DECOMPOSE | 边界澄清 + 执行准则 + 子目标清单 | boundary_contract, goals |
| S_BUILD | 构建步骤链（prepare/ralph.md Build Rules 0-13） | chain definition（内存） |
| S_CREATE | `session create --chain-file --no-dispatch` | session（CLI 建） |
| S_CONFIRM | 用户确认（-y 跳过） | — |
| S_LOOP | 共享 Run 执行循环（orchestrator-run-loop.md） | — |
| S_EVALUATE | 质量/目标/范围/reground 决策评估 | decision receipt |
| S_FAIL | retry 或 pause | step.status |
| S_RECOVER | audited paused recovery（仅 -c） | session resume |
| S_AMEND | 目标热修改（ralph-amend-goal.md） | session meta update |
| S_DONE | seal Session | session.status |

### Transitions

```
S_PARSE:
  → S_AMEND     WHEN: --amend
  → S_RECOVER   WHEN: -c AND paused session
  → S_LOOP      WHEN: -c AND running session
  → S_RESOLVE   WHEN: intent present
  → END         OTHERWISE

S_RESOLVE:
  → S_LOOP      WHEN: existing session with chain
  → S_INFER     WHEN: new session
  → END         WHEN: multiple candidates or incompatible terminal

S_INFER → S_DECOMPOSE → S_BUILD → S_CREATE
S_CREATE → S_LOOP WHEN: -y
S_CREATE → S_CONFIRM OTHERWISE
S_CONFIRM → S_LOOP WHEN: confirmed
S_CONFIRM → S_BUILD WHEN: revised
S_CONFIRM → END WHEN: cancelled

S_LOOP:
  → S_EVALUATE  WHEN: next node is decision
  → S_FAIL      WHEN: executor/check/drift reports retry or blocker
  → S_DONE      WHEN: CHAIN_COMPLETE
  → S_LOOP      WHEN: Run sealed and another pending step exists

S_EVALUATE:
  → S_LOOP      WHEN: proceed or accepted fix proposal
  → S_RECOVER   WHEN: escalate pauses Session
  → S_LOOP      WHEN: post-goal-audit + has_unmet → fix loop（按 target_stage 插入修复 step）
  → S_DONE      WHEN: post-goal-audit + all_met + INTENT_ALIGNED=true
  → END         WHEN: post-goal-audit + all_met + INTENT_ALIGNED=false → REGROUND_HALT
  → S_LOOP      WHEN: post-analyze-scope → 应用 scope_verdict 调整链路径
  → S_DONE      WHEN: post-session + preflight passed → decide 然后 seal
  → S_LOOP      WHEN: post-session + preflight failed → fix loop
  → END         WHEN: post-debug-escalate → 始终暂停
  → END         WHEN: post-reground + drifted + confidence ≥ 60 → REGROUND_HALT（-y 不跳过）
  → S_LOOP      WHEN: post-reground + aligned → proceed
  → S_LOOP      WHEN: post-reground + drifted + confidence < 60 → proceed（标记 LOW CONFIDENCE）

S_FAIL:
  → S_LOOP      WHEN: retry budget remains
  → END         WHEN: Session paused or user aborts

S_AMEND → S_LOOP WHEN: amend committed
S_RECOVER → S_LOOP WHEN: blockers resolved + resume committed
S_DONE → END
```

## Lifecycle Inference（S_INFER）

从 intent + 同 Session sealed outputs 推断起点：

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

派发一个只读 generic evaluator。严格解析 `proceed|fix|escalate`：

| 结果 | 行为 |
|------|------|
| proceed | 继续下一 Run / decision / seal |
| fix | 需要新 repair evidence；由 repair Skill 产生 proposal |
| escalate | 进入 audited recovery |
| parse failure | 降级为 fix, confidence=low, `parse_failed=true` |

**Ralph 策略阈值**：confidence < 60 不可 proceed；retry 耗尽 → escalate；goal audit 缺证据 → unmet；reground 确认 drift → halt（即使 -y）。

通过 `session decide --json` 提交，遵循 orchestrator-run-loop.md Continuation Router。

## Boundary

**In scope**: Session lifecycle policy — decompose, build chain, dispatch, evaluate, drift-check, amend, seal.
**Out of scope**: Step execution (belongs to Skills), CLI administration (belongs to `maestro session/run` commands).
