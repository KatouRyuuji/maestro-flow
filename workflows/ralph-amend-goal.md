<!-- session-mode: inherited -->

<required_reading>
@~/.maestro/workflows/run-mode.md
@~/.maestro/workflows/orchestrator-run-loop.md
</required_reading>
# Session Goal Amendment Flow

This filename is retained for compatibility. Goal amendment uses only the canonical Run namespace and never edits protocol files or chain state directly.

## 1. Snapshot

1. Resolve exactly one live compatible Session through read-only `maestro run recall`, then call `maestro session status {session_id}`.
2. Read active goals, `boundary_contract`, completed Run handoffs, pending chain steps and current identity/activity revisions.
3. Present progress, active goals, boundary counts and changelog count. A sealed or archived Session is terminal; ambiguity requires user selection.

## 2. Parse and assess

Use the remaining `--amend` text as `change_request`; ask when it is empty. Classify the change as `modify|add|remove|boundary` and produce:

```json
{
  "affected_goals": [],
  "invalidated_steps": [],
  "new_gaps": [],
  "boundary_changes": { "in_scope_add": [], "out_of_scope_add": [], "constraints_add": [] },
  "risk_level": "low|medium|high",
  "risk_reason": ""
}
```

Assessment is read-only. It checks whether sealed Run evidence remains valid and whether the pending tail needs a planning proposal. High risk always requires explicit confirmation; `-y` cannot bypass it.

## 3. Build the replacement decomposition

Construct the entire next `decomposition` object in memory:

- Append one `CHG-NNN` changelog entry with before/after goals, reason, risk and evidence.
- Supersede only unfinished affected goals; done goals remain immutable evidence.
- Modified goals receive a versioned ID; added goals receive the next `G{n}` ID.
- Apply boundary additions without deleting historical constraints.
- Do not mark, insert, skip, replace or reindex chain steps here.

Validate the full object before persistence. Goals describe outcomes; lifecycle stages belong to chain steps.

## 4. Persist goal metadata

After confirmation, write the full JSON object to stdin or a temporary file and call:

`maestro session meta update --session {session_id} --decomposition-file - --request-id {request_id} --expected-identity-revision {n} --expected-activity-revision {n}`

The decomposition object must carry all three required keys — `execution_criteria`, `goals`, `changelog` — even when a list is empty. The `--decomposition-file` schema is strict and rejects a goals-only object.

Runtime performs the audited metadata update. Never write `session.json`, `status.json`, or any secondary goal store.

## 5. Adapt the pending tail

When `invalidated_steps` or `new_gaps` is non-empty, a planning Skill must run in the same Session and emit one typed `chain-proposal/1.0`:

1. Reuse an already pending planning Run when one exists; otherwise create an amendment planning Run through `maestro session start --chain plan --session {session_id} --arg "{change_request}"`.
2. Load it with `run brief`, execute the planning contract, and call `run check`.
3. Accept exactly one valid proposal with `session done ... --apply-proposal`; reject by omission and note; revise on the same Run.

The proposal may change only the pending tail and must respect the Run's declared chain effects. Amendment metadata and chain mutation therefore remain separate audited Runtime transitions.

## 6. Continue

Display the amendment ID, risk, superseded/added goal counts and proposal disposition. Resume the shared loop with `maestro session status`, then explicitly allocate through `maestro session next`.
