<!-- session-mode: inherited -->
# Run Mode Lite

Lightweight Session/Execution/Run lifecycle for team skills. Canonical actions are **negotiate -> start/attach Execution -> create/complete Run -> seal Execution**. There is no prepare/workflow loading requirement. Old Session start/done aliases appear only in the labeled compatibility branch.

## New Runtime Authority

1. Before the first mutation, run `maestro capabilities --json`. Require exact `maestro-capabilities/1.0` support for `session/2.0`, `execution/1.0`, `run-response/1.1`, `session_statusless`, `execution_generation`, and `core_execution_lease`; otherwise fail closed unless the caller explicitly selected the legacy branch.
2. Session is durable topic identity. The bounded Execution owns chain/gates/lifecycle/revision/core lease; every Run is immutable and bound to exact `session_id + execution_id + generation`.
3. Retain every `run-response/1.1` locator and fence: `session_id`, `execution_id`, `generation`, `run_id`, Session identity/activity revisions, `execution_revision`, and `lease_epoch`. Retain the private owner/kind/epoch/`lease_id` claim only in coordinator-private memory or a mode-0600 claim file.
4. Every mutation uses a stable unique `--request-id`, the exact locator, `--expected-execution-revision`, and the current full claim (`--owner-id`, `--owner-kind`, `--lease-epoch`, `--lease-id`). Execution acquisition also retains and supplies the exact `--expected-identity-revision` and `--expected-activity-revision` from the Session identity response. Refresh revisions after every receipt. Never infer a current Session/Execution, reuse a stale claim, or fall back to a host-only lock.

## Create

> **Dispatched by an orchestrator?** If the birth packet already carries exact `session_id` / `execution_id` / `generation` / `run_id` / `run_dir`, store the public locator in `team-session.json` and do **NOT** call `maestro run create`. The dispatching orchestrator owns completion and keeps the private core lease claim out of team state.

For a self-started team Run:

1. Compose an ASCII-only Session slug `YYYYMMDD-<skill>-<topic>` (<=64 characters), create or explicitly resolve the Session identity, then acquire its next bounded generation with:
   `maestro execution start --session {session_id} --request-id {request_id} --expected-identity-revision {identity_revision} --expected-activity-revision {activity_revision} --expected-lease-epoch 0 --execution-owner {owner_id} --owner-kind {owner_kind} --actor {actor} --reason "{reason}" --evidence {evidence} --json`.
2. Create the Run with:

   `maestro run create <skill-name> --session {session_id} --execution {execution_id} --generation {generation} --request-id {request_id} --expected-execution-revision {execution_revision} --owner-id {owner_id} --owner-kind {owner_kind} --lease-epoch {lease_epoch} --lease-id {lease_id} --intent "<short goal>" [--arg <value> ...] --json`

   `--intent` is Session metadata only. Required command inputs use repeatable `--arg <value>`; raw compatibility callers may pass `-- <args...>`.
3. Retain `run_id` and `run_dir`. Merge the public locator into `{run_dir}/work/team/team-session.json` under `"run"`; never persist `lease_id`.

### Team State Authority

- `{run_dir}/work/team/team-session.json` is the single coordinator-owned state file. It contains coordination state and the public `run` locator used by the team-worker fallback.
- Every state update is a merge-write: coordination updates MUST preserve `run`; Run updates MUST preserve coordination fields. Do not create a sibling `team-state.json`.
- Workers may read `team-session.json` to resolve `run.run_dir`, but only the coordinator writes it.

## Artifact Boundary

- Formal deliverables go under `{run_dir}/outputs/` (filename stem = artifact kind).
- Every new formal JSON deliverable MUST contain a complete top-level `_meta` object. `kind` and `schema` are required together; `role` and `alias` are optional. Use `{"_meta":{"kind":"<kind>","schema":"<kind>/1.0"},...}`.
- A legacy JSON deliverable with no `_meta` remains readable through filename inference. Never write a partial, null, or non-object `_meta`; strict validation blocks completion.
- Team coordination files stay in `{run_dir}/work/team/`, not formal artifacts, and do not carry artifact `_meta`.
- Resolve the actual `{run_dir}` before joining an `outputs/` path; never write a literal `{run_dir}` placeholder.

## Complete

> **Who completes?** For an orchestrator-dispatched Run, the team writes `outputs/` + `report.md` and returns; only the claim-holding orchestrator completes it. A self-started team Run is completed and its Execution sealed by its coordinator.

1. Optionally write `{run_dir}/report.md` with the fixed frontmatter keys `verdict`, `summary`, `constraints`, `decisions`, `concerns`, `next`, `details`. Accepted decisions and locked constraints become pending knowledge candidates at completion.
2. Stage reusable recipes/pitfalls with `maestro knowledge stage knowhow "<title>" --content-file <path|-> --run <run_id>`; explicit relations use `--signal cited|validated|contradicted --signal-ids <comma-separated ids>`. For a session-source candidate without a Run, use `--session <session-id> --evidence <immutable-ref>`.
3. Complete through the current Execution with `maestro run complete <run_id> --session {session_id} --execution {execution_id} --generation {generation} --request-id {request_id} --expected-execution-revision {execution_revision} --owner-id {owner_id} --owner-kind {owner_kind} --lease-epoch {lease_epoch} --lease-id {lease_id} --verdict {verdict} --json`.
4. Completion is fail-closed. Repair blocking outputs/gates and retry with the same transition identity as directed; never claim success, discard the team, or invent a new Run while completion is blocked. A `blocked` verdict pauses the Execution and invalidates the old claim.
5. Recover a paused self-started Execution by first reading `maestro execution status --session {session_id} --execution {execution_id} --json`. Resolve each exact blocker with `maestro execution resolve --session {session_id} --execution {execution_id} --request-id {request_id} --expected-execution-revision {execution_revision} --actor {actor} --reason "{reason}" --evidence {evidence} (--decision {point}|--step {step}) --disposition {value} --json`, then reacquire with `maestro execution resume --session {session_id} --execution {execution_id} --request-id {request_id} --expected-execution-revision {execution_revision} --expected-activity-revision {activity_revision} --expected-lease-epoch {lease_epoch} --execution-owner {owner_id} --owner-kind {owner_kind} --actor {actor} --reason "{reason}" --evidence {evidence} --json`. Resume returns a new epoch/private claim, and the old claim remains invalid.
6. When the self-started Run and all Execution gates are terminal, finish with `maestro execution seal --session {session_id} --execution {execution_id} --request-id {request_id} --expected-execution-revision {execution_revision} --expected-activity-revision {activity_revision} --execution-owner {owner_id} --owner-kind {owner_kind} --owner-epoch {lease_epoch} --lease-id {lease_id} --actor {actor} --reason "{reason}" --evidence {evidence} --outcome {done|done_with_concerns|failed} --summary "{summary}" --json`. Verify `execution-seal-receipt/1.0`, then discard the claim. Session identity remains available for a later generation.
7. Review durable candidates with `maestro knowledge review <session_id>` and apply the Review Presentation Protocol. The happy-path adjudication entry is `maestro knowledge promote <session_id> --resolve <candidate-id> --as <choice> [--target <knowledge-id>] --reason "<reason>"`; `review --resolve` remains the compatibility fallback.
8. Run-source promotion requires sealed source Runs and fresh reconciliation. A `session/2.0` session-source candidate does **not** require Session seal: require immutable `candidate_version` + `content_hash`, exact `session_id` + `observed_activity_revision`, non-empty `evidence_roots` + `evidence_root_hash`, and a fresh session reconciliation receipt for the current `candidate_snapshot_hash` + `corpus_fingerprint`, revalidated at final commit.

## Legacy `session/1.x` Compatibility Branch

Use this branch only when an explicitly selected old CLI/schema lacks the negotiated Execution contract. Old callers may use `maestro session start`, `maestro session done`, `maestro session resolve/resume/seal`, or `maestro run create/complete` with `run-response/1.0`. Those aliases and permanent Session states are compatibility authority only and must never replace a lost or stale new-runtime Execution claim.
