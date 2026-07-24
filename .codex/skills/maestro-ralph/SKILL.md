---
name: maestro-ralph
disable-model-invocation: false
description: Closed-loop policy over the canonical Session/Run chain
argument-hint: <intent> [-y] [-c] [--amend]
allowed-tools:
  - Bash
  - Edit
  - Glob
  - Grep
  - Read
  - Write
  - followup_task
  - interrupt_agent
  - list_agents
  - request_user_input
  - send_message
  - spawn_agent
  - spawn_agents_on_csv
  - update_plan
  - wait_agent
session-mode: run
contract:
  discovery: self-described
  consumes: []
  produces: []
version: 0.5.56
---

<required_reading>
@~/.maestro/workflows/run-mode.md
@~/.maestro/workflows/orchestrator-run-loop.md
@~/.maestro/workflows/codex-run-mode.md
</required_reading>

<deferred_reading>
- [ralph-amend-goal.md](~/.maestro/workflows/ralph-amend-goal.md) — read only for `--amend`
</deferred_reading>

<purpose>
Apply retry, confidence, drift, goal-audit and stopping policy over any compatible canonical Session. Ralph does not own a CLI driver, private Session type or second state store; it calls only `maestro run ...` and follows the shared Run loop.
</purpose>

<interface>
Only these user flags are accepted:

- `-y` — auto-confirm low-risk policy decisions.
- `-c` — continue the unique live compatible Session; paused state enters audited recovery.
- `--amend` — amend the live Session goal; remaining text is the change request.

All remaining text is intent. No engine, roadmap, script, depth, role, tier, platform, resume or dry-run flags are parsed. Those choices belong to Skill contracts and Runtime.
</interface>

<invariants>
1. **Ralph owns the policy loop** — locate → allocate → brief → dispatch → check → drift/proposal evaluation → done/decide → next → seal.
2. **One executor per Run** — dispatch one unnamed `run-executor`; nested execution strategy belongs to the Skill.
3. **Thin executor** — executor executes and checks one Run but never completes it.
4. **Sessions are topic grouping/indexes** — execution, handoff, anchor and immutable outputs belong to Runs.
5. **canonical upstream map** — same-Session sealed outputs enter only through birth/brief; no manual context reconstruction.
6. **Runtime mutation authority** — session.json/run.json are never written directly; normal flow uses only `maestro run ...`.
7. **Proposal governance** — Skill proposes, Ralph evaluates budget/confidence/intent, Runtime applies atomically with the producing Run.
8. **No prompt fix templates** — fix/review/goal gaps dispatch a Skill that may emit a proposal.
9. **Decision receipts are single-source** — decisions land through `session decide`, never direct append.
10. **Auto is bounded** — `-y` cannot bypass high risk, confidence <60, ambiguity, escalation, failed gates or reground halt.
11. **Compatibility commands are out of band** — no Ralph/Session CLI is called or recommended.
12. **Terminal means terminal** — sealed/archived returns `CHAIN_COMPLETE`, never resume.
13. **Decision is mandatory** — every Ralph-created chain contains at least one formal decision node before Session seal; Run completion never substitutes for `session decide`.
14. **Completion and decision both continue** — after successful `session done --json` or `session decide --json`, immediately execute any satisfiable `continuation.authority=automatic` action in the same turn.
</invariants>

<state_machine>

<states>
S_PARSE — parse intent and the three public flags
S_RESOLVE — locate or create a compatible Session
S_DECOMPOSE — derive boundary and observable goals for a new Session
S_BUILD — build initial Skill chain
S_CREATE — `session create --chain-file --no-dispatch`
S_CONFIRM — confirm unless `-y`
S_LOOP — shared Run lifecycle
S_EVALUATE — quality/goal/scope/reground decision
S_AMEND — audited goal amendment
S_RECOVER — audited paused recovery
S_FAIL — retry or pause
S_DONE — seal Session
</states>

<transitions>
S_PARSE:
  → S_AMEND WHEN: `--amend`
  → S_RESOLVE WHEN: `-c` or intent present
  → S_FAIL OTHERWISE

S_RESOLVE:
  → S_RECOVER WHEN: exact compatible Session is paused and `-c`
  → S_LOOP WHEN: exact compatible Session is running with a chain
  → S_DECOMPOSE WHEN: no live Session and intent present
  → S_FAIL WHEN: multiple candidates or incompatible terminal Session

S_DECOMPOSE → S_BUILD → S_CREATE
S_CREATE → S_LOOP WHEN: `-y`
S_CREATE → S_CONFIRM OTHERWISE
S_CONFIRM → S_LOOP WHEN: confirmed
S_CONFIRM → S_BUILD WHEN: revised
S_CONFIRM → END WHEN: cancelled

S_LOOP:
  → S_EVALUATE WHEN: next node is a decision
  → S_FAIL WHEN: executor/check/drift reports retry or blocker
  → S_DONE WHEN: `CHAIN_COMPLETE`
  → S_LOOP WHEN: Run sealed and another pending step exists

S_EVALUATE:
  → S_LOOP WHEN: proceed or accepted fix proposal
  → S_RECOVER WHEN: escalate pauses Session

S_FAIL:
  → S_LOOP WHEN: retry budget remains
  → END WHEN: Session paused or user aborts

S_AMEND → S_LOOP WHEN: shared amend protocol committed
S_RECOVER → S_LOOP WHEN: blockers resolved and resume committed
S_DONE → END
</transitions>

<actions>

All command syntax and lifecycle mechanics follow `orchestrator-run-loop.md` and `run-mode.md`. The actions below define only Ralph-specific policy decisions.

### A_RESOLVE

Read-only lookup via `run recall`. Explicit birth `session_id/run_id` wins. Multiple live candidates require user selection; historical similarity never grants authority.

### A_BUILD

Infer lifecycle start from intent and same-Session sealed outputs. New Sessions start from analysis unless intent explicitly calls for grill, brainstorm or blueprint. Roadmap is inferred only for multi-release evidence. Quality is quick/standard/full based on specs and observable risk, not a user flag.

Build outcome-oriented decomposition. For broad work, boundary clarification remains mandatory even with `-y`. Every chain includes at least one final quality/goal/scope decision node before seal; long chains also include periodic reground decision nodes. Step execution strategy is defined by each Skill, never by Ralph flags.

### A_EXECUTE

Follow `orchestrator-run-loop.md` exactly. Display identity may use stage prefixes, but no private agent name or Ralph progress file is persisted. Task/Goal UI is projection only.

### A_EVALUATE

Dispatch one read-only generic evaluator. Expected result:

```text
---VERDICT---
STATUS: proceed|fix|escalate
REASON: <one line>
CONFIDENCE: high|medium|low
---END---
```

Ralph policy thresholds:
- Parse failure → `fix`, low confidence, `parse_failed=true`.
- Confidence below 60 → cannot proceed.
- Retry budget exhaustion → escalate.
- Goal audit: compare every pending goal's `done_when` against evidence; missing evidence means unmet.
- Reground: compare cumulative handoffs against intent and boundary; confident drift halts even under `-y`.

Apply through `session decide --json` and follow the Continuation Router in `orchestrator-run-loop.md`.

### A_FAIL

- Repairable failure → verdict `needs-retry`; re-dispatch only after Runtime returns the step to pending.
- External or exhausted blocker → verdict `blocked`; Session pauses.
- Never allocate a new Run while the previous Run is running or gate-blocked.

### A_RECOVER

Only explicit `-c` enters recovery. Follow `orchestrator-run-loop.md` §7 exactly.

### A_AMEND

Read `ralph-amend-goal.md`. High risk always asks. Pending-tail changes come from a planning Skill proposal, not direct edit.

### A_DONE

When every execution Run is sealed, every decision is terminal, every goal is done and Session gates are clean → seal.

</actions>

</state_machine>

<success_criteria>
- Public flags are exactly `-y`, `-c`, `--amend`.
- No legacy Ralph driver, private Session type, or independent Skills CLI appears in normal flow.
- Each Run follows `session next --inline-brief` → execute → `run check` → `session done`; backtracking uses `run brief`. Every decision uses `session decide`.
- Proposal acceptance is pathless from Ralph's perspective and atomic with Run completion.
- Retry, confidence, drift, goal audit, recovery and terminal semantics remain explicit.
</success_criteria>
