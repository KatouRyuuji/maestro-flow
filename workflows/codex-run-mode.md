<!-- session-mode: inherited -->

# Codex Run Adapter

This adapter extends `@~/.maestro/workflows/run-mode.md` for Codex skills. The canonical Run contract remains authoritative.

## Codex Execution Surfaces

- Preserve Codex-native tools and orchestration: direct execution, collaboration agents, `spawn_agents_on_csv`, `request_user_input`, goal APIs, and structured tool schemas.
- **CSV Wave is optional, never the default compliance shape.** Select the smallest execution surface that matches the task:
  - Direct execution for one bounded task that does not benefit from delegation.
  - `spawn_agent` + `wait_agent` for heterogeneous, iterative, or low-count independent work. Every spawned agent must be joined; continue waiting when the first wait times out.
  - `spawn_agents_on_csv` for homogeneous row-oriented batches with a stable input/output schema and enough items to justify CSV orchestration. Set `max_runtime_seconds: 3600` explicitly.
- Do not create `tasks.csv`, waves, or CSV state solely to satisfy an authoring template.
- When CSV Wave is selected, master state, wave inputs, and intermediate results are temporary computation. Store them under `{run_dir}/work/csv-wave/`.
- All formal artifacts (including evidence-role outputs) MUST be stored at their declared `{run_dir}/outputs/...` paths.
- Informal worker traces and cross-worker discoveries may use `{run_dir}/evidence/` (lazily created, not gate-checked).
- Human-readable synthesis and handoff belong in `{run_dir}/report.md`.

## Authority and Completion

- The skill frontmatter `contract` is the output schema and alias authority. Domain examples in the body MUST NOT create a second artifact registry or output root.
- Never edit `.workflow/state.json`, Session identity, Execution, or Run protocol JSON. Resolve inputs only from the canonical `upstream` map returned by `maestro run create`, `maestro run next`, or `maestro run brief`.
- When CSV Wave is selected, every CSV worker MUST call `report_agent_job_result` exactly once. Workers do not mutate protocol files or orchestrator-owned CSV files.
- Finish domain work with `maestro run check {run_id} --session {session_id}`. An executor without the private core lease claim returns to the dispatching coordinator and MUST NOT complete, advance, recover, or seal. A self-started claim-holding coordinator follows canonical `run-mode.md`: complete with Execution-aware `maestro run complete ... --execution {execution_id} --generation {generation} --expected-execution-revision {execution_revision} ... --json`, then finish the bounded generation with `maestro execution seal ... --json`. Every mutation consumes `run-response/1.1` and refreshes the exact locator/fence; Session lifecycle aliases are legacy compatibility only. Read the completion receipt and apply the Review Presentation Protocol. Sealed Runs and Execution snapshots are immutable.
