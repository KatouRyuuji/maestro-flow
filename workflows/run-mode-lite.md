<!-- session-mode: inherited -->
# Run Mode Lite

Lightweight Session/Run lifecycle for team skills. Canonical actions are **negotiate -> open/attach Session (`session/3.0`) -> create/next Run -> complete `--advance` -> `session complete`**. There is no prepare/workflow loading requirement. Old Session start/done aliases and the Execution-era surface appear only in the labeled compatibility branch.

## New Runtime Authority

1. Before the first mutation, run `maestro capabilities --json`. Require the exact v3 capability contract: `features.session_run_minimal_v3=true`, `features.entity_revision_cas=true`, `features.participant_identity=true`, `features.request_receipts_v2=true`, `features.execution_lease=false`, `features.operation_registry=false`; `session_schema_writes` containing `session/3.0`; `execution_schema_writes` empty; `run_response_writes` containing `run-response/1.2`; otherwise fail closed unless the caller explicitly selected the legacy branch.
2. Session is durable topic identity owning the chain and artifact registry. Every Run is immutable and bound to exact `session_id + run_id`; the Session `orchestration_revision` is the only mutation fence.
3. Retain every `run-response/1.2` locator and fence: `session_id`, `run_id`, and the returned `orchestration_revision` (plus `run_revision` for run-target mutations). Every mutation supplies `--participant <id>` and `--actor <id>` with `--reason` and repeatable `--evidence <ref>`.
4. Every mutation uses a stable unique `--request-id`, the exact locator, and the current `--expected-orchestration-revision` (run-target mutations also use `--expected-run-revision`). Refresh revisions after every receipt. Never infer a current Session, reuse a stale revision, or fall back to a host-only lock.

## Create

> **Dispatched by an orchestrator?** If the birth packet already carries exact `session_id` / `run_id` / `run_dir` / `step_id`, store the public locator in `team-session.json` and do **NOT** call `maestro run create`. The dispatching orchestrator owns completion and keeps mutation authority out of team state.

For a self-started team Run:

1. Compose an ASCII-only Session slug `YYYYMMDD-<skill>-<topic>` (<=64 characters), then open the Session with a single-step chain:
   `maestro session open "<objective>" --id {session_id} [--chain <skill-name>] --participant {participant_id} --actor {actor_id} --request-id {request_id} --reason "<reason>" [--evidence <ref> ...] --json`.
2. Create the Run against the chain step with:

   `maestro run create <skill-name> [args...] --session {session_id} --run <run_id> --step <step_id> [--goal "<goal>"] [--input <ref> ...] --participant {participant_id} --actor {actor_id} --request-id {request_id} --reason "<reason>" [--evidence <ref> ...] --expected-orchestration-revision {orchestration_revision} --json`

   `--goal` is Run metadata; required command inputs use positional args; raw compatibility callers may pass `-- <args...>` (v2 `--intent` remains Session metadata only).
3. Retain `run_id` and `run_dir`. Merge the public locator into `{run_dir}/work/team/team-session.json` under `"run"`; never persist participant/actor authority there.

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

> **Who completes?** For an orchestrator-dispatched Run, the team writes `outputs/` + `report.md` and returns; only the coordinator completes it. A self-started team Run is completed and its Session completed by its coordinator.

1. Optionally write `{run_dir}/report.md` with the fixed frontmatter keys `verdict`, `summary`, `constraints`, `decisions`, `concerns`, `next`, `details`. Accepted decisions and locked constraints become pending knowledge candidates at completion.
2. Stage reusable recipes/pitfalls with `maestro knowledge stage knowhow "<title>" --content-file <path|-> --run <run_id>`; explicit relations use `--signal cited|validated|contradicted --signal-ids <comma-separated ids>`. For a session-source candidate without a Run, use `--session <session-id> --evidence <immutable-ref>`.
3. Complete through the current Session with `maestro run complete <run_id> --session {session_id} --participant {participant_id} --actor {actor_id} --request-id {request_id} --reason "<reason>" [--evidence <ref> ...] --expected-orchestration-revision {orchestration_revision} --expected-run-revision {run_revision} --verdict {done|done_with_concerns} [--summary "<summary>"] --advance --json`.
4. Completion is fail-closed. Repair blocking outputs/gates and retry with the same transition identity as directed; never claim success, discard the team, or invent a new Run while completion is blocked. A blocked Run is transitioned (`maestro run transition <run_id> blocked ... --json`) or cancelled (`maestro run cancel <run_id> ... --json`) — there is no pause.
5. Recover a stuck self-started Run by first reading `maestro session status --session {session_id} --json` and `maestro run check <run_id> --session {session_id} --json`. Transition/cancel the stuck Run, resolve open gates with `maestro run decide <point_id> ... --verdict proceed|fix|escalate --json`, refresh the revision, then re-dispatch with `maestro run next ... --json` (or `run create` for the self-started step). Resume never restores a prior Run — every Run is a fresh fenced mutation.
6. When the self-started Run is sealed and the chain is terminal, finish with `maestro session complete --session {session_id} --participant {participant_id} --actor {actor_id} --request-id {request_id} --reason "<reason>" [--evidence <ref> ...] --expected-orchestration-revision {orchestration_revision} --json`. Verify the transition receipt. Session identity remains available for a later unarchive.
7. Review durable candidates with `maestro knowledge review <session_id>` and apply the Review Presentation Protocol. The happy-path adjudication entry is `maestro knowledge promote <session_id> --resolve <candidate-id> --as <choice> [--target <knowledge-id>] --reason "<reason>"`; `review --resolve` remains the compatibility fallback.
8. Run-source promotion requires sealed source Runs and fresh reconciliation. A `session/3.0` session-source candidate does **not** require Session completion: require immutable `candidate_version` + `content_hash`, exact `session_id` + `orchestration_revision`, non-empty `evidence_roots` + `evidence_root_hash`, and a fresh session reconciliation receipt for the current `candidate_snapshot_hash` + `corpus_fingerprint`, revalidated at final commit.

## Legacy `session/1.x/2.x` Compatibility Branch

Use this branch only when an explicitly selected old CLI/schema lacks the negotiated `session/3.0` contract. Old callers may use `maestro session start`, `maestro session done`, `maestro session resolve/resume/seal`, `maestro run create/complete` with `run-response/1.0`/`1.1`, or the Execution-era surface (`execution start/resume/seal` with identity/activity/execution revisions and the private core lease claim). Those aliases and permanent Session/Execution states are compatibility authority only and must never replace a lost or stale new-runtime revision.
