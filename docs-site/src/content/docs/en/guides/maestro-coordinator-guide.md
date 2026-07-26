---
title: "Maestro Intent-to-Chain Planner Guide"
icon: "🤖"
---

Intent-to-chain planner — classifies user intent, selects the smallest sufficient command chain, creates a canonical Session, and enters the shared Run loop.

> **v0.5.56 architecture change**: Maestro and Ralph have merged into a **single Session chain protocol**. The distinction between "static chain selector vs adaptive engine" has been **dissolved** — there are no static/dynamic, Maestro/Ralph, or executor-specific Session types. `/maestro` is the **intent-to-chain planner**, responsible for intent classification, initial chain selection, and decomposition; `/maestro-ralph` is the **closed-loop policy layer** (Stage Mapping + decision gate). Both share the same execution loop (`orchestrator-run-loop.md`) and only invoke `maestro session ...` / `maestro run ...`.

---

## Positioning

`/maestro` is the **main entry point** and **intent-to-chain planner** of Maestro Flow:

1. Parses user intent and the three public flags (`-y` / `-c` / `--amend`)
2. Reads the deferred `workflows/maestro.md` to perform intent classification (intent → task_type → chain)
3. Selects the **smallest sufficient initial chain**
4. Creates a canonical Session via `maestro session create --chain-file`
5. Enters the shared Run loop for execution

**One chain, executor-neutral**: every task uses the same Session/Run protocol. Whether a chain expands dynamically is decided by whether each Skill contract produces a typed `chain-proposal/1.0`, not by the Session or command mode.

### Relationship between Maestro and Ralph

| | `/maestro` (intent-to-chain planner) | `/maestro-ralph` (closed-loop policy layer) |
|---|---------|---------------|
| **Core responsibility** | Intent classification → initial chain selection → decomposition | Stage Mapping → Build Rules → decision gate policy |
| **Chain construction** | Selects the smallest sufficient chain based on intent evidence | Full lifecycle chain + mandatory decision nodes |
| **decomposition** | Creates boundary_contract + goals (**owner**) | Consumes goals; goal-audit judges met/unmet |
| **Use case** | Broad intent routing, one-off tasks | Full milestone lifecycle progression |
| **Execution** | Shared Run loop | Shared Run loop + retry/drift/goal-audit policy |

> See the [Ralph closed-loop engine guide](./maestro-ralph-guide.md) for details.

---

## Usage

```bash
/maestro "实现用户认证功能"     # 意图分类 → 建链 → 执行
/maestro -y "添加 OAuth 支持"   # 自动确认低风险分类与 proposal
/maestro -c                     # 继续唯一 live 兼容 Session
/maestro --amend "改为支持 OAuth"  # 修改 live Session 目标
/maestro status                 # 项目仪表盘（route 到 maestro session status）
```

### Public Flags

| Flag | Behavior |
|------|------|
| `-y` | Auto-confirms low-risk classifications and proposals; **does not bypass** high-risk, low-confidence, boundary-ambiguity, or drift-circuit-breaker cases |
| `-c` | Continues the sole live compatible Session; multiple candidates require a prompt; paused enters audited recovery |
| `--amend` | Amends the goal of the sole live Session; remaining text is the change request |
| `--executor <agent\|direct>` | Selects the execution mode: `agent` (default) dispatches run-executor; `direct` executes inline in the main LLM. **Does not change** Session type or chain semantics |
| `--dry-run` | Shows the chain and exits without executing |

All remaining text is **treated entirely as intent**. Platform, roadmap, quality, template reuse, and parallel/adversarial strategies are inferred from intent, Session state, Skill contracts, and the host runtime.

> **Retired flags**: `--exec auto|cli|internal`, `--super`. The execution mode is selected via `--executor agent|direct`; quality depth is inferred from specs and observable risk.

---

## Intent Classification (A_CLASSIFY)

Reads the deferred `workflows/maestro.md` (Chain Catalog) and performs intent classification:

1. **Exact match**: `continue/next/go/继续` → `state_continue`; `status/状态` → `status`
2. **Semantic match**: LLM semantic understanding matches a task_type (see the chain catalog below)
3. **Selection priorities**: `issue_id` > team > UI/design > multi-step > single-step > companion fallback
4. **State validation (W003)**: execute without a plan → warn and prepend plan; test not yet executed → warn and prepend execute
5. **Classification evidence (required)**: record which pattern matched, which alternatives were excluded, and the confidence level. A classification without a record may not proceed to chain construction.

Output: `{ task_type, scope, issue_id, phase_ref, urgency }`

### Intent Routing Examples

| Input | task_type | Command chain |
|------|------|--------|
| `"修正 README 拼写"` | companion | `/maestro-companion "修正 README 拼写"` |
| `"plan phase 2"` | plan | `plan 2` |
| `"debug auth crash"` | debug | `debug "auth crash"` |
| `"fix issue ISS-abc-001"` | issue_execute | issue-full：analyze --gaps → plan --gaps → execute → review → close |
| `"brainstorm notifications"` | brainstorm-driven | brainstorm → plan → execute → harvest |
| `"分析完直接改"` | analyze-plan-execute | analyze -q → plan --dir → execute --dir |
| `"ui design landing"` | impeccable_build | `maestro-impeccable --chain build` |
| `"continue"` | state_continue | Auto-inferred from project state |

---

## Chain Catalog (task_type → chain)

### Single-Step Chains

| Chain name | Command |
|------|------|
| `analyze` | `analyze {phase}` |
| `plan` | `plan {phase}` |
| `execute` | `execute {phase}` |
| `review` | `review {phase}` |
| `test` | `test {phase}` |
| `test_gen` | `auto-test {phase}` |
| `debug` | `debug "{description}"` |
| `refactor` | `analyze -q → plan --dir → execute --dir` (chain) |
| `retrospective` | `retrospective {phase}` |
| `init` | `maestro-init` |
| `grill` | `grill "{description}"` |
| `blueprint` | `blueprint "{description}"` |
| `analyze-macro` | `analyze "{description}"` |
| `companion` | `/maestro-companion "{description}"` |
| `status` | `maestro session status` |
| `milestone_close` | `maestro-session-seal` |

### Multi-Step Chains

| Chain name | Steps | Scenario |
|------|------|------|
| `full-lifecycle` | plan → execute → review → test → session-seal → harvest | Complete milestone |
| `spec-driven` | init → roadmap --mode full → plan → execute → harvest | Starting from requirements (heavy) |
| `roadmap-driven` | init → roadmap → plan → execute → harvest | Starting from requirements (light) |
| `blueprint-driven` | init → blueprint → plan → execute → harvest | Starting from an idea/spec |
| `brainstorm-driven` | brainstorm → plan → execute → harvest | Starting from exploration |
| `grill-driven` | grill → brainstorm --from grill → plan → execute → harvest | After stress testing |
| `analyze-plan-execute` | analyze -q → plan --dir → execute --dir → harvest | Fast track (adhoc) |
| `quality-loop` | review → auto-test → test → debug → plan --gaps → execute | Quality remediation |
| `review-fix` | plan --gaps → execute → review | Fix review issues |
| `issue-full` | analyze --gaps → plan --gaps → execute → review → close → harvest | Issue closed-loop |
| `next-milestone` | roadmap → plan → execute | Next milestone |
| `milestone-close` | session-seal | Close a milestone |

> The full chain catalog and chainMap are in `workflows/maestro.md`. Bare command names (`plan`, `execute`…) are first-tier Skill steps; `maestro-*` are standalone command names; `team-*` and `maestro-odyssey` are manual user entrypoints, excluded from chain routing.

### Minimum Chain Rules

| Intent evidence | Initial chain |
|---------|--------|
| Narrow fix/change | analyze → plan → execute → review/test (as needed) |
| Broad rewrite/migration | analyze-macro → scope decision → plan/roadmap |
| Brainstorm/exploration | brainstorm → Skill-proposed continuation only |
| Stress test/grill | grill → Skill-proposed continuation only |
| Formal spec | blueprint → plan |
| Existing compatible Session | Do not recreate; enter the shared loop |

Roadmap is inferred only when there is multi-release evidence. Quality is based on specs and observable risk, not user flags.

---

## resolvePhase Priority

1. `intent_analysis.phase_ref` (structured extraction)
2. Regex match for "phase N" or a bare number
3. Project state inference: in-progress execute → first incomplete phase → latest artifact phase
4. `analyze-plan-execute` chain → null (use `{run_dir}`)
5. All commands are phase-independent → null
6. Ask the user

---

## Decomposition Protocol (A_DECOMPOSE)

Set `decomposition_owner = "maestro"`. Downstream ralph only consumes and does not re-ask.

1. Classify intent breadth: narrow / single-step / {status, init} chains → skip decomposition
2. broad/medium → ask at most 3 rounds: Scope / Constraints / Definition of Done (`-y` does not skip broad ambiguity)
3. Derive `execution_criteria` + `goals` (each containing `done_when` + `evidence` + `lifecycle`)
4. `boundary_contract` is built in with `session create`; goals are placed into the `decomposition` block of the chain-file

```json
{
  "boundary_contract": { "in_scope": [], "out_of_scope": [], "constraints": [], "definition_of_done": "" },
  "decomposition": {
    "execution_criteria": [],
    "goals": [{ "id": "G1", "goal": "", "done_when": "", "evidence": "", "lifecycle": [], "status": "pending" }]
  }
}
```

> Goals describe **outcomes**, not lifecycle stages. After decomposition completes, output a `/goal` binding prompt (non-blocking).

---

## Chain Construction Protocol (A_CREATE)

1. **Specs pre-check**: the chain contains an execution stage and `.workflow/specs/` does not exist → insert `specs-setup` at the very front of steps
2. **Skill name pre-validation**: the skill names of all steps are pre-validated via `maestro skills --steps --json`; no match → raise error E005 and block chain construction
3. **Assemble the chain-file** (an execution step has only `command/args?/stage?/goal_ref?/retry_max?`; a decision step declares `decision_ref`)
4. **Create**:

```bash
maestro session create "{intent}" --id maestro-{slug} --chain-file {path}
```

After deleting temporary files, enter the shared execution loop (`orchestrator-run-loop.md`).

---

## Session File (session.json)

Storage location: `.workflow/sessions/{session-id}/session.json` (schema `session/1.3`). `session.json.orchestration` is the single source of truth for chain / goal / decision.

```json
{
  "schema": "session/1.3",
  "session_id": "maestro-fix-login",
  "intent": "implement user auth",
  "status": "running",
  "orchestration": {
    "engine": "coordinator",
    "quality_mode": "standard",
    "auto_mode": false,
    "chain": [
      { "command": "analyze", "args": "--session {session}", "stage": "analyze", "goal_ref": "G1", "status": "pending" }
    ],
    "decomposition": { "goals": [{ "id": "G1", "goal": "...", "done_when": "...", "status": "pending" }] }
  },
  "boundary_contract": { "in_scope": [], "out_of_scope": [], "constraints": [], "definition_of_done": "" }
}
```

- `engine: coordinator` is a compatibility persistence field, not a Session type or policy
- The `{session}` `{intent}` placeholders are replaced at runtime
- Chain advancement is **verdict-driven**: execution steps use `session done --verdict`, decision steps use `session decide --verdict`

> **Legacy migration**: old `.workflow/.maestro/maestro-*/status.json` files are folded into `sessions/{id}/session.json` via `maestro session migrate` (idempotent).

---

## Execution Flow

```
用户输入 → 意图分类 → chain 选择 → session create --chain-file → 共享 Run 循环
```

Shared Run loop (identical to Ralph):

```
session next --inline-brief --json   ← 分配下一 Run（birth packet 内联 Resume Packet）
        ↓
派发一个 unnamed run-executor（只执行该 Run）
        ↓
maestro run check {run_id}           ← 扫描输出、评估 gate、校验 chain-proposal/1.0
        ↓
maestro session done {run_id} --verdict ...   ← verdict 驱动链推进
        ↓
读取 continuation：dispatch_next / evaluate_decision / seal_session
```

See the [execution loop section of the Ralph guide](./maestro-ralph-guide.md) for details.

### State Inference (continue / state_continue mode)

| Current state | Inferred chain |
|----------|--------|
| Not initialized | `init` |
| Has roadmap, target phase has no artifact | `analyze` |
| Latest artifact is analyze | `plan` |
| Latest is plan | `execute` |
| execute complete, no review | `review` |
| UAT passed | `milestone-close` |
| All phases complete | `milestone-close` |

---

## `-y` Auto Mode

`-y` only expands low-risk discretion; normal lifecycle continuation does not depend on `-y`:

- **May auto-confirm**: proposals within the pending-tail that are verified and intent-aligned; low-risk classification decisions
- **Must stop**: high-risk, low-confidence, boundary ambiguity, failed gates, drift circuit-breaker, paused recovery

`-c` inherits `session.orchestration.auto_mode` and does not require the user to re-enter `-y`.

---

## Resume Execution (-c)

```bash
/maestro -c    # 继续唯一 live 兼容 Session
```

1. Use read-only `maestro run recall` + `session status` to locate the sole live Session
2. Multiple live candidates require explicit selection; historical similarity is read-only and grants no authority
3. Paused Sessions go through the shared `session recover` (audited recovery)
4. Sealed/archived Sessions are terminal states and cannot be resumed

---

## Invariants (Maestro-specific)

1. **One chain, executor-neutral** — `agent|direct` only selects the executor; it does not produce Session subtypes
2. **Session before execution** — session.json is created via `session create --chain-file` before execution
3. **Creator owns decomposition** — Maestro creates boundary_contract + goals; downstream orchestrators only consume and never overwrite
4. **Classification evidence** — classification must leave a trail (matched pattern, excluded alternatives, confidence)
5. **Verdict-driven chain advancement** — chain step completion is driven by `session done --verdict`
6. **Runtime owns mutation** — prompts do not write session.json/run.json and do not automatically use admin chain commands
7. **Control priority** — Maestro owns initial chain selection + proposal disposition; Skills own domain judgment; Runtime exclusively owns mutation authority

---

## Related Guides

- [Ralph closed-loop engine and coordinator](./maestro-ralph-guide.md) — the closed-loop policy layer
- [All commands and workflows](./command-usage-guide.md) — slash commands and chain catalog
- [CLI terminal command reference](./cli-commands-guide.md) — `maestro session` / `maestro run`
- [Artifact directory structure](./workflow-structure-guide.md) — session.json Schema
