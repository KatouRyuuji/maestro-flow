<!-- session-mode: inherited -->
# Run Mode Lite

Lightweight Session/Run lifecycle for team skills. Only two actions: **start** and **done**. `run create` / `run complete` remain compatibility spellings. No `prepare`, no `brief`, no workflow content loading.

## Create

> **Dispatched by an orchestrator?** If the dispatch context already carries `run_id` / `run_dir` (a birth packet from `maestro session next`), store them in `team-session.json` under `"run"` and do **NOT** call `maestro run create` — a second create mints an empty duplicate Run. The steps below apply only to a skill starting its own Run.

1. Compose a session slug: `YYYYMMDD-<skill>-<topic>` — ASCII-only, ≤64 characters. NEVER let the runtime auto-generate from a Chinese or long intent string.
2. Run `maestro session start "<short session goal>" --chain <skill-name> --session <slug> [--arg "<required command input>"]` before domain work.
   - The intent text is **Session metadata only**. It does not enter `Run input.args` and does not satisfy the skill's command contract or `argument-hint`.
   - When command inputs are required, pass them with repeatable `--arg <value>`. Runtime still validates every required command argument.
   - Compatibility spelling remains valid for older callers and raw positional passthrough: `maestro run create <skill-name> --session <slug> --intent "<short session goal>" --arg <value> -- <args...>`. `--intent` is Session metadata only.
3. Retain the returned `run_id`, `run_dir`. Merge them into `{run_dir}/work/team/team-session.json` under `"run": { "run_id": "<id>", "run_dir": "<path>" }`.

### Team State Authority

- `{run_dir}/work/team/team-session.json` is the single coordinator-owned state file. It contains both coordination state and the `run` block used by the team-worker fallback.
- Every state update is a merge-write: coordination updates MUST preserve `run`; Run updates MUST preserve coordination fields. Do not create a sibling `team-state.json`.
- Workers may read `team-session.json` to resolve `run.run_dir`, but only the coordinator writes it.

## Artifact Boundary

- Formal deliverables: write to `{run_dir}/outputs/` (filename stem = artifact kind).
- Every new formal JSON deliverable MUST contain a complete top-level `_meta` object. `kind` and `schema` are required together; `role` and `alias` are optional. Use `{"_meta":{"kind":"<kind>","schema":"<kind>/1.0"},...}` and keep `kind` stable across filename changes.
- A legacy JSON deliverable with no `_meta` remains readable through filename inference. Never write a partial, null, or non-object `_meta`; strict validation rejects the artifact and blocks Run completion.
- Team coordination files (session bus, role-specs, process logs): stay in `{run_dir}/work/team/`, not formal artifacts, and do not carry artifact `_meta`.
- `{run_dir}` MUST be resolved to the actual Run path before it is joined onto an `outputs/` path — never write a path that still contains the literal `{run_dir}` placeholder (such artifacts land outside the real Run and never reach the `session done` gate).

## Complete

> **Who completes?** When the Run was dispatched via a birth packet (an orchestrator already created it, see Create), `session done` belongs to the dispatching orchestrator — the skill only writes `outputs/` + `report.md` and does NOT self-complete. Only a self-started Run (the skill called `run create` itself) is completed by the skill via the steps below.

1. Optionally write `{run_dir}/report.md` with frontmatter (`verdict`, `summary`, `constraints`, `decisions`, `concerns`). Accepted decisions and locked constraints become pending knowledge candidates at completion; omitting report.md is legal.
2. Before completion, stage reusable recipes/pitfalls with `maestro knowledge stage knowhow "<title>" "<content>" --run <run_id>`. Search/injection is exposure only; use `maestro knowledge record <knowledge-id> --run <run_id> --signal cited|validated|contradicted` for explicit relations.
3. Run `maestro session done <run_id>`. The `check` step is optional — done includes the same evaluation through the completion engine. Completion returns candidate IDs but never promotes project knowledge.
4. Completion is fail-closed: if `session done` fails, fix the blocking gate (missing or malformed `outputs/` artifacts) and retry. While it keeps failing, do not archive/clean the team or claim success — keep the team active (status=paused) and surface the blocking gate to the user.
5. Review durable candidates and evidence with `maestro knowledge review <session_id>`; promote selected candidates explicitly. Session seal does not discard an unreviewed backlog.
