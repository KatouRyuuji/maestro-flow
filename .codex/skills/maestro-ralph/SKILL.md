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
  - request_user_input
  - spawn_agent
  - update_plan
  - wait_agent
session-mode: run
contract:
  discovery: self-described
  consumes: []
  produces: []
version: 0.5.55
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
Apply retry, confidence, drift, goal-audit and stopping policy over any compatible canonical Session. Ralph owns no CLI driver or private state: normal execution calls only `maestro run ...` and follows the shared Run loop.
</purpose>

<interface>
Only `-y`, `-c`, and `--amend` are accepted. All remaining text is intent. Executor, platform, roadmap, quality, parallelism and adversarial strategy are inferred from intent, Session state, Skill contract and host runtime.
</interface>

<invariants>
1. Session is a topic grouping/index; execution and immutable outputs belong to Runs.
2. `session.json.orchestration` is the only chain/goal/decision authority; never edit protocol files directly.
3. Each execution step allocates one Run via `session next`, loads it via `run brief`, executes and checks it, then the orchestrator completes it.
4. Skill proposes `chain-proposal/1.0`; Ralph evaluates; Runtime applies it atomically with the producing Run.
5. Same-Session sealed outputs enter only through the canonical upstream map.
6. Decision evaluation is read-only and lands only through `run decide`.
7. `-y` cannot bypass high risk, low confidence, ambiguity, failed gates, escalation or drift halt.
8. No legacy Ralph driver, Session administration, private Session type, manual fix template or second progress store.
9. Sealed/archived Sessions are terminal and return `CHAIN_COMPLETE`.
</invariants>

<codex_dispatch>
For an execution Run, call `spawn_agent` once with `agent_type: "ralph_executor"`, explicit Session locator and ownership limited to that Run. Immediately call `wait_agent({ timeout_ms: 3600000 })`; continue waiting after timeouts until completed or errored. The executor may use nested unnamed agents according to the loaded Skill, but it must not call `run done/complete`.

Decision, goal-audit, reground and amend-impact workers are read-only default agents. Do not spawn agents when the active host policy or user scope forbids delegation; execute the same Resume Packet directly instead. Executor choice never changes Session semantics.
</codex_dispatch>

<state_machine>

S_PARSE:
  → S_AMEND when `--amend`
  → S_RESOLVE when `-c` or intent exists
  → END otherwise

S_RESOLVE:
  → S_RECOVER for an exact paused Session under `-c`
  → S_LOOP for an exact running compatible Session
  → S_BUILD when no live Session and intent exists
  → END for ambiguity or terminal incompatibility

S_BUILD → S_CREATE → S_CONFIRM unless `-y` → S_LOOP

S_LOOP:
  → S_EVALUATE for a decision node
  → S_FAIL for retry/blocker
  → S_DONE for `CHAIN_COMPLETE`
  → S_LOOP after a sealed Run with pending work

S_EVALUATE → S_LOOP for proceed/fix; → S_RECOVER for escalate
S_FAIL → S_LOOP while retry budget remains; → END after pause
S_AMEND/S_RECOVER → S_LOOP after audited commit
S_DONE → END

<actions>

### Resolve and create

Use `maestro run recall maestro-ralph --intent "{intent}" --json` only as read-only lookup. New Sessions derive boundary, observable goals and the smallest sufficient Skill chain. Roadmap is inferred only for multi-release work; execution strategy belongs to each Skill.

Write chain JSON to a temporary file and call:

`maestro session start "{intent}" --id {slug} --chain-file {path} --no-dispatch`

Delete the file after success.

### Execute one Run

Follow `orchestrator-run-loop.md`: `run status` → `run next --json` → `run brief` → execute → `run check` → drift/proposal policy → `session done`. Never allocate the next Run before the prior completion is sealed.

### Evaluate

Read-only evaluator returns `proceed|fix|escalate` plus `high|medium|low`. Parse failure becomes fix/low and records `parse_failed=true`. Confidence below 60 cannot proceed; retry budget exhaustion escalates. Apply through `run decide`.

### Proposal

`run check` discovers typed proposals. Accept exactly one valid proposal with `run done ... --apply-proposal`; reject by omitting it and recording a note; revise by reloading the same Run. Legacy proposal path flags are never used.

### Failure, recovery, amend, seal

- Repairable: `run done --verdict needs-retry`.
- Exhausted/external: `run done --verdict blocked --reason ...`.
- Explicit `-c` recovery: `run status` → `run recover` per blocker → `run recover --resume`.
- Amend: read deferred protocol, snapshot with `run status`, commit full decomposition with `run edit --decomposition-file -`, then accept any planning proposal through its Run.
- Terminal: `run seal-session {session_id} --summary "..."` after Runs, decisions, goals and gates are complete.

</actions>
</state_machine>

<success_criteria>
- Public flags are exactly `-y`, `-c`, `--amend`.
- Normal flow and recommendations use only `maestro run ...`.
- Run lifecycle is next → brief → execute → check → done; decisions use decide.
- Proposal mutation is pathless for Ralph and atomic with completion.
</success_criteria>
