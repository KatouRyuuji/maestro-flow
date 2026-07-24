---
name: maestro
disable-model-invocation: false
description: Intent-to-chain planner over the canonical Session/Run lifecycle
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
- [maestro.md](~/.maestro/workflows/maestro.md) — read before initial intent classification
- [ralph-amend-goal.md](~/.maestro/workflows/ralph-amend-goal.md) — read only for `--amend`
</deferred_reading>

<purpose>
Turn a user intent into the smallest sufficient Skill chain, create one canonical topic Session through `maestro session start --chain-file`, then execute the shared Run loop. Static versus dynamic is not a mode: each Skill contract decides whether it emits a typed chain proposal.
</purpose>

<interface>
Only `-y`, `-c`, and `--amend` are accepted. All remaining text is intent. Executor, platform, roadmap, quality, template reuse, parallelism and adversarial depth are inferred from intent, Session state, Skill contract and host runtime.
</interface>

<invariants>
1. Every task uses the same Session/Run protocol; there is no engine-specific Session type.
2. Create the Session through `run start --chain-file --no-dispatch` before allocating a step Run.
3. Maestro owns the initial boundary and outcome decomposition; later orchestrators consume it.
4. Runtime owns protocol files and chain mutation; normal orchestration calls only `maestro run ...`.
5. Skill adaptation is optional and appears only as validated `chain-proposal/1.0`.
6. Execution advances through `run done/complete --verdict`; decision nodes through `run decide`.
7. Historical similarity is read-only; same-Session sealed outputs enter only through canonical upstream.
8. `-y` never bypasses high risk, low confidence, ambiguity, failed gates or drift escalation.
9. `/maestro-next` may route here but never appears inside a chain.
</invariants>

<codex_dispatch>
For one execution Run, use one unnamed executor with ownership limited to that Run. When agent delegation is allowed, call `spawn_agent` once with `agent_type: "ralph_executor"`, then immediately `wait_agent({ timeout_ms: 3600000 })`; keep waiting after a timeout until completion or error. The executor may follow the loaded Skill's internal strategy but must not call `run done/complete`.

When host policy or user scope forbids delegation, execute the same Resume Packet directly. Executor choice never changes Session semantics. Track the user-visible plan with `update_plan`; Session artifacts remain authoritative.
</codex_dispatch>

<state_machine>

S_PARSE:
  → S_AMEND when `--amend`
  → S_CONTINUE when `-c`
  → S_CLASSIFY when intent exists
  → END otherwise

S_CONTINUE:
  → S_LOOP for exactly one live compatible Session
  → S_RECOVER for an exact paused Session
  → END for none, ambiguity or a terminal Session

S_CLASSIFY → S_DECOMPOSE for broad work; otherwise S_CREATE
S_DECOMPOSE → S_CREATE
S_CREATE → S_CONFIRM unless `-y`; otherwise S_LOOP
S_CONFIRM → S_LOOP when accepted; → S_CLASSIFY when revised; → END when cancelled
S_LOOP → S_LOOP after each sealed Run; → S_RECOVER on escalation; → S_DONE on `CHAIN_COMPLETE`
S_AMEND/S_RECOVER → S_LOOP after an audited commit
S_DONE → END

<actions>

### Classify and decompose

Read deferred `maestro.md`. Record matched evidence, excluded alternatives and confidence. Use the smallest sufficient chain. Roadmap is inferred only for multi-release work. Broad ambiguity requires at most 3 questions even under `-y`.

Outcome decomposition shape:

```json
{
  "boundary_contract": { "in_scope": [], "out_of_scope": [], "constraints": [], "definition_of_done": "" },
  "decomposition": {
    "execution_criteria": [],
    "goals": [{ "id": "G1", "goal": "", "boundary": "", "done_when": "", "evidence": "", "lifecycle": [], "status": "pending" }],
    "changelog": []
  }
}
```

Goals describe outcomes, not lifecycle stages.

### Create

Write chain JSON to a temporary file and call:

`maestro session start "{intent}" --id maestro-{slug} --chain-file {path} --no-dispatch`

Delete the temporary file after success. Do not inline unescaped JSON. Runtime resolves commands when `session next` allocates each execution Run.

### Continue, execute and adapt

- Locate with read-only `run recall`, confirm through `run status`, then follow `orchestrator-run-loop.md`.
- Per Run: `run next --json` → `run brief` → execute → `run check` → `session done`.
- Accept exactly one valid typed proposal through `run done ... --apply-proposal`; reject by omission and note; revise on the same Run.
- Decision evaluators are read-only and persist only through `run decide`.
- Paused recovery uses `run recover`; amendment uses `run edit --decomposition-file -` after the deferred audit protocol.
- Seal only through `run seal-session` after Runs, decisions, goals and gates are complete.

</actions>
</state_machine>

<success_criteria>
- Public flags are exactly `-y`, `-c`, `--amend`.
- Normal flow and recommendations use only `maestro run ...`.
- Session exists before step execution; every Run follows next → brief → execute → check → done.
- Chain adaptation is Skill-proposed and atomically applied by the producing Run.
</success_criteria>
