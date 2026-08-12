<!-- session-mode: inherited -->

<required_reading>
@~/.maestro/workflows/run-mode.md
@~/.maestro/workflows/orchestrator-run-loop.md
</required_reading>
# Execution Goal Amendment Flow

The filename is retained for compatibility. Under `session/2.0`, goal/boundary/decomposition and pending-tail changes belong to the exact current Execution, not durable Session identity.

## 1. Capability and Snapshot

1. Run `maestro capabilities --json`; require the canonical `session/2.0 + execution/1.0 + core_execution_lease + run-response/1.1` contract or fail closed.
2. Resolve exactly one compatible Session through read-only recall, then read `maestro execution status --session {session_id} --execution {execution_id} --json`.
3. Retain exact `session_id + execution_id + generation`, Session identity/activity revisions, `--expected-execution-revision`, and the private `--owner-id + --owner-kind + --lease-epoch + --lease-id` claim. Never infer current authority from Session status.
4. Snapshot current Execution goals, boundary contract, sealed Run handoffs, pending chain, gates, and revision. A sealed Execution is immutable; amend a new higher generation instead. An archived Session cannot start one.

## 2. Parse and Assess

Use remaining `--amend` text as `change_request`; ask when empty. Classify `modify|add|remove|boundary` and derive affected goals, invalidated steps, new gaps, boundary additions, risk, reason, and evidence.

Assessment is read-only. Completed Run evidence remains immutable. High risk always requires explicit confirmation; `-y` cannot bypass it.

## 3. Build One Typed Proposal

Construct the complete replacement decomposition plus pending-tail changes in memory:

- Append one `CHG-NNN` entry with before/after goals, reason, risk, and evidence.
- Supersede only unfinished affected goals; completed goals remain immutable evidence.
- Give modified goals versioned IDs and added goals the next `G{n}` ID.
- Add boundaries without deleting historical constraints.
- Preserve all required `execution_criteria`, `goals`, and `changelog` keys.

Do not edit protocol JSON or issue direct chain mutations. Dispatch a planning Skill inside the same exact Execution through fenced `maestro run next` (or an Execution-aware `maestro run create` only when the current Execution contract explicitly permits an ad-hoc amendment Run). The Skill writes one typed proposal allowed by its Execution contract, then runs `maestro run check`.

## 4. Commit Inside the Current Execution

After confirmation, accept exactly one valid proposal by adding `--apply-proposal` to the exact fenced completion call:

`maestro run complete {run_id} --session {session_id} --execution {execution_id} --generation {generation} --request-id {request_id} --expected-execution-revision {execution_revision} --owner-id {owner_id} --owner-kind {owner_kind} --lease-epoch {lease_epoch} --lease-id {lease_id} --verdict done --apply-proposal --json`

Runtime must atomically validate and update the current Execution decomposition/chain/gates and return `run-response/1.1`. Consume its fresh locator/fence before continuing. Reject by omitting `--apply-proposal` and recording a concern; revise by reattaching the same Run.

If the installed Runtime cannot express the complete goal/decomposition replacement as an Execution-owned typed proposal, stop with a capability blocker. Do not silently call a Session metadata command in the canonical branch.

## 5. Continue

Display amendment ID, risk, superseded/added goal counts, and proposal disposition. Re-read exact `maestro execution status`, then continue through fenced `maestro run next`. Recovery remains `maestro execution resolve` -> `maestro execution resume`; final completion remains `maestro execution seal`.

## Legacy `session/1.x` Compatibility Branch

Only an explicitly selected old CLI/schema may use `maestro session status`, `maestro session meta update --decomposition-file`, `maestro session next --inline-brief`, ad-hoc legacy `maestro run create`, and `maestro session done --apply-proposal`. These Session lifecycle/revision commands are compatibility authority only and must never replace a lost or stale new-runtime Execution claim.
