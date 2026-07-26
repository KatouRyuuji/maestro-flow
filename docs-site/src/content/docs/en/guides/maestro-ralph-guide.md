---
title: "Ralph Closed-Loop Engine and Coordinator Guide"
icon: "🤖"
---

Closed-loop orchestration policy layer — applies retry, confidence, drift, goal-audit, and stopping policy on top of the canonical Session/Run chain; decision nodes dynamically expand/shrink the chain.

> **v0.5.56 architecture change**: Maestro and Ralph have merged into a **single Session chain protocol**. Ralph no longer has its own CLI driver, private Session type, or second state source — it only invokes `maestro session ...` / `maestro run ...`, sharing the same execution loop as Maestro (`orchestrator-run-loop.md`). The standalone `maestro ralph` CLI subcommand family (session/skills/next/check/complete) and the `--engine swarm --script wf-*` syntax have **all been retired**.

---

## Positioning

Ralph is the **closed-loop orchestration policy layer** of Maestro Flow. It applies policy on top of any compatible canonical Session, rather than being a separate execution engine:

1. Infers the lifecycle starting point from intent and the same Session's sealed outputs (**Stage Mapping**)
2. Builds the complete Skill chain from the starting point to `session-seal` according to the **Build Rules**
3. Inserts **decision nodes** at key checkpoints (quality / goal / scope / reground / structural), dynamically adjusting the chain
4. On failure, retries according to the retry budget; on exceeding the limit, escalates (escalate) and pauses for manual handling

**Live chain**: During execution the chain can grow/shrink via a Skill through `chain-proposal/1.0`, which Ralph evaluates and the Runtime applies atomically.

### The Relationship Between Maestro and Ralph

The two share the same Session/Run protocol and execution loop; the difference lies in **division of responsibility**, not Session subtypes:

| | `/maestro` (intent-to-chain planner) | `/maestro-ralph` (closed-loop policy layer) |
|---|---------|---------------|
| **Core responsibility** | Intent classification → initial chain selection → decomposition | Stage Mapping → Build Rules → decision gate policy |
| **Chain building** | Selects the minimal sufficient chain based on intent evidence | Complete lifecycle chain + mandatory decision nodes |
| **Decision nodes** | On demand (decided by Ralph policy) | At least one quality/goal/scope decision per chain; long chains include periodic reground |
| **Closed loop** | Shared Run loop | retry / confidence / drift / goal-audit / stopping policy |
| **decomposition** | Creates boundary_contract + goals (owner) | Consumes goals; goal-audit determines met/unmet |
| **Applicable scenario** | Broad intent routing, one-off tasks | Full milestone lifecycle progression |

> **One chain, executor-neutral**: There are no static/dynamic, Maestro/Ralph, or executor-specific Session types. Every task uses the same Session/Run protocol; `--executor agent|direct` only selects the execution method and does not produce a Session subtype.

---

## Usage

```bash
/maestro-ralph "实现用户认证系统"     # 新会话：分类 → 建链 → 执行闭环
/maestro-ralph -y "implement auth"   # 自动确认低风险策略决策
/maestro-ralph -c                    # 继续唯一 live 兼容 Session（paused 进入 audited recovery）
/maestro-ralph --amend "把目标改为支持 OAuth"   # 修改 live Session 目标
```

### Public Flags (only these three)

| Flag | Behavior |
|------|------|
| `-y` | Auto-confirms low-risk policy decisions; **does not override** high-risk, confidence<60, boundary ambiguity, escalation, failed gate, or reground halt |
| `-c` | Continues the single live compatible Session; multiple candidates must be asked; paused enters audited recovery; inherits `orchestration.auto_mode` |
| `--amend` | Modifies the goal of the single live Session; remaining text is the change request |

All other text is **treated entirely as intent**. No engine / roadmap / script / depth / role / tier / platform / resume / dry-run flags are parsed — those choices belong to the Skill contract and the Runtime.

> **Retired**: the `maestro ralph session/skills/next/check/complete` CLI subcommand family, `/maestro-ralph --engine swarm --script wf-*`, `/maestro-ralph --roadmap`, `/maestro-ralph continue` (continue semantics are now carried by `-c`). Skill discovery now uses `maestro skills [--platform] [--steps]`.

---

## Three Node Types

| Type | Execution Method | Description |
|------|----------|------|
| **execution step** | Dispatches one unnamed `run-executor` | Actual command execution (analyze, plan, execute, review…); only declares `command/args/stage/goal_ref/retry_max` |
| **decision step** | Dispatches a **read-only** generic evaluator | Reads Run artifacts and goal evidence, outputs a verdict; declares `decision_ref`, does not create a Run |
| **(execution policy)** | Determined by the Skill's own contract | Serial/parallel/adversarial implementation belongs to the Skill; Ralph does not intervene via flags |

---

## Stage Mapping (Lifecycle Stage Catalog)

The complete command catalog from `lifecycle_position` to `session-seal`. Each execution step is executed by a Skill; each decision step is evaluated by a read-only evaluator.

| Stage | Skill Command | Decision after | quality_mode |
|-------|-----------|----------------|--------------|
| grill | `grill "{intent}"` | — | all (passes through `-y` when `-y`) |
| brainstorm | `brainstorm "{intent}" [--from grill:{grill_id}]` | — | all |
| blueprint | `blueprint "{intent}"` | — | all |
| init | `maestro-init` | — | all |
| specs-setup | `maestro-spec setup` | — | all (inserted only when `.workflow/specs/` does not exist) |
| analyze-macro | `analyze "{intent}"` | `post-analyze-scope` | all |
| roadmap | `roadmap --from analyze:{analyze_macro_id}` | — | all (only scope_verdict=large + wants_roadmap) |
| analyze | `analyze --session {session}` | — | all |
| plan | `plan --session {session}` / `--from analyze:{id}` / `--from blueprint:{id}` | — | all |
| execute | `execute --session {session}` | `post-execute` | all |
| business-test | `auto-test --session {session}` | `post-business-test` | full only |
| review | `review --session {session} [--tier quick]` | `post-review` | all (quick mode appends `--tier quick`) |
| test-gen | `auto-test --session {session}` | — | full / standard if coverage<80% |
| test | `test --session {session}` | `post-test` | full, standard |
| frontend-verify | `test --session {session} --frontend-verify` | `post-frontend-verify` | all (inserted only when delivering UI) |
| goal-audit | *(decision-only)* | `post-goal-audit` | all (only when there is a decomposition) |
| session-seal | *(decision-only)* | `post-session` | all |
| debug-escalate | *(decision-only)* | `post-debug-escalate` | all (inserted only when a debug step escalates) |

<details>
<summary>Full flow diagram (standard mode)</summary>

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

Each `◆` is a decision node, evaluated by a read-only evaluator and submitting its verdict via `session decide`.

</details>

---

## Build Rules (chain-building rules, applied in order)

| # | Rule |
|---|------|
| 0.5 | **specs pre-check**: starting point ∉ {grill, brainstorm, blueprint, init} and `.workflow/specs/` does not exist → insert `specs-setup` at the very front of the chain |
| 1 | **Starting point**: start from `lifecycle_position` |
| 2 | **Skip completed**: skip stages that already have a completed artifact under the current session |
| 3 | **quality_mode filter**: exclude non-matching stages according to `quality_mode` |
| 3.5 | **grill -y passthrough**: when `-y`, append `-y` to grill args; preserve the grill stage and brainstorm's `--from grill:*` |
| 3.6 | **frontend-verify UI gating**: keep only when delivering frontend (detecting `dashboard/` or UI keywords); remove for pure backend |
| 4 | **Decision nodes**: after each stage whose Decision after is non-empty, insert a decision step (`decision_ref`) + the corresponding `decision_points` entry |
| 5 | **goal-audit insertion**: when there is a decomposition, insert `post-goal-audit` after the last evidence-producing stage and before `session-seal` |
| 5.5 | **re-grounding insertion**: when there is a decomposition and execution steps ≥3 → starting from the 3rd execution step, insert `post-reground` every 3 steps (not adjacent to an existing quality-gate) |
| 6 | **Terminal hard constraint**: has `session_id` → chain ends with `session-seal`(decision:post-session); standalone → ends with the last quality gate |
| 7 | **goal_ref propagation**: when there is a decomposition, each step matches `goal_ref` by `stage ∈ goal.lifecycle` |
| 8 | **Placeholders**: `{session}` `{intent}` are replaced by the runtime |
| 9 | **skill name pre-validation**: fetch the registry via `maestro skills --steps --json` to match skill names; no match → error, do not enter the chain |
| 10 | **step shape**: a chain-file step has only `command/args?/stage?/goal_ref?/retry_max?/decision_ref?` |
| 11 | **scope_verdict gating** (starting point=analyze-macro): `large`+wants_roadmap → keep roadmap+analyze, plan uses `--session`; otherwise → skip roadmap+analyze, plan uses `--from analyze:{id}`; `unknown` → default to standalone, corrected by the `post-analyze-scope` decision |
| 12 | **--from auto-injection**: `analyze_macro_id`+roadmap/standalone plan → `--from analyze:{id}`; `blueprint_id`+plan → `--from blueprint:{id}` (lower priority than `--session`); in-Session sources are audited by Run upstream and not copied into args |
| 13 | **Dynamically inserted steps** also apply rules 7-12 |

---

## Decision Gate Classification and Evaluation

Each decision step is divided into 5 categories by `decision_ref`, each handled by a different evaluation method:

| Type | decision_ref | Evaluation Method | Files Read |
|------|-------------|---------|----------|
| quality-gate | post-execute | A_AGENT_EVALUATE | verification.json |
| quality-gate | post-business-test | A_AGENT_EVALUATE | .tests/auto-test/report.json |
| quality-gate | post-review | A_AGENT_EVALUATE | review.json |
| quality-gate | post-test | A_AGENT_EVALUATE | uat.md, .tests/test-results.json |
| quality-gate | post-frontend-verify | A_AGENT_EVALUATE | e2e-results.json |
| goal-gate | post-goal-audit | A_AGENT_GOAL_AUDIT | session.json goals + evidence |
| scope-gate | post-analyze-scope | A_SCOPE_EVALUATE | analyze conclusions.scope_verdict |
| reground-gate | post-reground | A_AGENT_REGROUND | intent + handoffs + goals |
| structural | post-session | A_STRUCTURAL_EVALUATE | full verification (runs sealed + gates clean) |
| structural | post-debug-escalate | A_PAUSE_ESCALATE | — (always pauses) |

### Evaluator Output Format (quality-gate / goal-gate / reground)

```text
---VERDICT---
STATUS: proceed|fix|escalate|PASS|FAIL|PARTIAL|BLOCKED|aligned|drifted|all_met|has_unmet
REASON: <一句话原因>
CONFIDENCE: high|medium|low
CONFIDENCE_SCORE: 0-100
---END---
```

Parse failure → `fix`, confidence=low, `parse_failed=true`. Ralph policy threshold: **confidence < 60 cannot proceed**; retry budget exhausted → escalate.

### Goal Audit Detailed Flow (post-goal-audit)

1. Read sub-goals in `orchestration.decomposition.goals` whose status≠done
2. Open the evidence artifacts and strictly determine met/unmet against `done_when` (missing evidence is treated as unmet)
3. Determine intent fidelity against intent + definition_of_done
4. Result routing:
   - `has_unmet` → **fix loop**: insert a repair step according to `target_stage` (produced by a Skill proposal)
   - `all_met` + `INTENT_ALIGNED=true` → proceed → seal
   - `all_met` + `INTENT_ALIGNED=false` → **REGROUND_HALT** (even with `-y`)

### Reground Detailed Flow (post-reground)

1. Read intent + boundary_contract + handoffs of completed steps + done goals
2. Determine whether the accumulated output still serves the intent
3. Result routing:
   - `aligned` → proceed
   - `drifted` + confidence ≥ 60 → **REGROUND_HALT** (`-y` does not skip)
   - `drifted` + confidence < 60 → proceed (marked LOW CONFIDENCE)

### Scope Verdict Application (post-analyze-scope)

1. Read the macro analyze's `conclusions.scope_verdict` (large/medium/small/unknown)
2. Write session.scope_verdict + analyze_macro_id
3. Routing: `large`+wants_roadmap → keep roadmap+analyze, plan uses `--session`; otherwise → skip roadmap+analyze, plan uses `--from analyze:{id}`; `unknown` → default to standalone, ask the user (`-y` does not guess)

### Post-Session Preflight (post-session)

1. Read-only verification: all execution Runs are sealed, no claimed request, session gates clean, goal audit has passed
2. preflight clean → verdict=proceed → `session decide` then `session seal`
3. preflight blocking → verdict=fix + precise blocker; Session stays running

---

## Quality Pipeline Modes

| Mode | Quality Steps | Trigger Condition |
|------|----------|----------|
| `full` | execute → business-test → review → test-gen → test → (frontend-verify) | Has REQ-*.md and phase scope |
| `standard` | execute → review → test (test-gen conditional on coverage) | Default |
| `quick` | execute → review `--tier quick` (skip business-test, test-gen, test) | User-specified |

quality_mode is inferred from specs and observable risk, **not a user flag**. Gates that have passed with unchanged code are skipped on retry; after code modifications, affected gates are cleared and re-executed.

---

## Session File (session.json)

Since v0.5.56, Session state is stored uniformly in `.workflow/sessions/{session-id}/session.json` (schema `session/1.3`). `session.json.orchestration` is the **single source of truth** for chain / goal / decision; a Run's outputs/handoff/gate/proposal belong to each Run directory.

<details>
<summary>chain-file / session.json core structure</summary>

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

- `engine: ralph|coordinator|manual` is a compatibility persistence field, not a Session type or policy
- `{session}` `{intent}` placeholders are replaced by the runtime
- An execution step has only `command/args?/stage?/goal_ref?/retry_max?`; a decision step declares `decision_ref`
- goals describe **outcomes**, not lifecycle stages

</details>

Creation command (the standard chain-building method for orchestrator/skill):

```bash
maestro session create "{intent}" --id {slug} --chain-file {path}
```

> **legacy migration**: the old `.workflow/.maestro/ralph-*/status.json` and `ralph-meta.json` are folded into `session.json` via `maestro session migrate` and marked with `session/1.3` (idempotent).

---

## Execution Loop (Shared Run Loop)

Maestro and Ralph share the execution loop defined in `orchestrator-run-loop.md`. The orchestration layer invokes `maestro session ...`, the execution layer invokes `maestro run ...`, and the protocol files are always written by the Runtime.

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

**Key invariants**:

- `session next --inline-brief` inlines the full Resume Packet and Skill body inside the birth packet; the normal forward flow **does not need** to call `run brief` again; `run brief` is only used for backtracking (crash recovery, context overflow, manual inspection).
- The birth packet's `run_already_created=true` is a strict constraint: immediately load the brief for that exact `run_id`, and `run create` again is forbidden.
- The executor **does not call** `session done/complete`; completion authority belongs to the orchestrator.
- **Turn termination invariant**: as long as the Session is `running` and there exists an `automatic` continuation action whose preconditions can be satisfied, the current turn must not end or merely recommend the command to the user.

### Verdict-Driven Chain Progression

Execution steps complete via `session done --verdict`, and decision steps complete via `session decide --verdict`:

| `session done --verdict` | Trigger Condition |
|---|---|
| `done` | aligned |
| `done-with-concerns` | minor drift, or major drift already retried |
| `needs-retry` | major drift, not retried |
| `blocked` | external blocker |

`session decide --verdict`: `proceed` (continue) / `fix` (requires a repair Skill to produce a proposal) / `escalate` (transfer to audited recovery). `fix` must not repeat decide before obtaining new repair evidence.

---

## Chain Proposal (chain-proposal/1.0)

Dynamic expansion/shrinkage of the chain is done through a typed `chain-proposal/1.0`:

- **Skill proposes**: the execution Run produces a typed `chain-proposal/1.0` in outputs
- **Ralph evaluates**: budget / confidence / intent-aligned / whether it overreaches
- **Runtime applies atomically**: on accept, invoke `session done ... --apply-proposal`; the proposal and completion are applied in the **same transaction**

`-y` may only auto-accept when: the proposal is valid, only modifies the pending tail, does not exceed budget, is intent aligned, and has no escalate. reject records the reason with `--note`; revise does not complete, and re-uses the same `run_id` to `run brief` again so the original Skill revises before re-checking.

> **No prompt fix templates**: fix/review/goal gaps do not directly copy a fix-loop template, but instead dispatch a Skill that may produce a proposal.

---

## Max Retries and Escalation

Each decision node carries `retry_count` and `max_retries` (default 2):

- **retry 0/1**: evaluation fails → insert a fix loop (produced by a Skill proposal)
- **retry 2**: limit reached → escalate to `post-debug-escalate` → pause

After escalation, the Session state becomes `paused`. Recovery is triggered only by an explicit `-c`, going through audited recovery:

```bash
maestro session status <id>        # read exact blockers and revisions
maestro session resolve --session <id> --decision <point> --disposition proceed   # 逐个解决 blocker
maestro session resume --session <id>        # blockers 清零后恢复（下一 Run 仍需显式 session next）
```

---

## Goal Amend (--amend)

Read `ralph-amend-goal.md`, completing snapshot → impact audit → confirmation → update the decomposition as a whole block via `maestro session meta update --session <id> --decomposition-file -` → planning Skill proposal. **High-risk modifications are not affected by `-y`** and always ask.

---

## Seal

After all execution Runs are sealed, decision steps are terminal, goals are done, and Session gates are clean:

```bash
maestro session seal {session_id} --summary "..."
```

sealed/archived are **terminal states**: `session next` returns `CHAIN_COMPLETE`, and resume is not allowed.

---

## Related Guides

- [CLI Terminal Command Reference](./cli-commands-guide.md) — full commands for `maestro session` / `maestro run`
- [All Commands and Workflows](./command-usage-guide.md) — slash commands and workflow integration
- [Artifact Directory Structure](./workflow-structure-guide.md) — `.workflow/sessions/` layout and session.json Schema
