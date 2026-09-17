<!-- grok-agent-override:start section="prompt-input" -->
### 1. Parse Prompt Input

Extract these fields from the spawn prompt. In Grok the `spawn_subagent` prompt is the complete assignment — there is no task board to poll:

| Field | Required | Description |
|-------|----------|-------------|
| `role` | Yes | Role name (e.g., analyst, writer, planner, executor, reviewer) |
| `role_spec` | Yes | Path to role-spec .md file containing execution instructions |
| `session` | Yes | Session folder path (e.g., `.workflow/.team/TLS-xxx-2026-01-01`) |
| `session_id` | Yes | Session ID (folder name) for message bus operations |
| `team_name` | Yes | Team name carried in the assignment payload for coordinator routing |
| `requirement` | Yes | Original task/requirement description |
| `inner_loop` | Yes | `true` or `false` -- whether the assignment covers multiple same-prefix work items |
| `run_dir` | No | Run directory; formal deliverables go under `{run_dir}/outputs/`. If absent, resolve from `<session>/team-session.json` `run.run_dir`; coordinators MUST keep the Run mapping in that single state file. Sessions without a Run write deliverables directly to `<session>/artifacts/` (no `outputs/` suffix) |
<!-- grok-agent-override:end section="prompt-input" -->

<!-- grok-agent-override:start section="assignment-lifecycle" -->
### 3. Assigned Work Lifecycle

Grok workers receive one concrete assignment in the initial `spawn_subagent` prompt. The coordinator and Session/team artifacts remain authoritative for dependency readiness, ownership, and completion.

1. Treat the spawn prompt as the complete work assignment; do not discover pending work from a tool — Grok exposes no task board.
2. Validate that the assignment matches the role prefix declared by `role_spec`. If it does not, report the mismatch to the coordinator via `team_msg` (`operation="log"`, `to="coordinator"`, `type="blocker"`) and stop.
3. With `inner_loop=true`, the assignment enumerates every same-prefix work item up front; process them in order within this single spawn.

**Resume check**: Before executing, inspect the assignment's declared output paths. If a complete artifact already exists, verify it and proceed to reporting without rewriting it blindly.
<!-- grok-agent-override:end section="assignment-lifecycle" -->

<!-- grok-agent-override:start section="execute-role-logic" -->
### 5. Execute Role-Specific Logic

Follow the instructions loaded from the role_spec body. This contains the domain-specific execution phases for the role. Key rules:

- Team workers run at subagent depth 1 and cannot call `spawn_subagent` — a nested spawn fails on the Grok depth limit
- Use CLI tools (`maestro delegate` via `run_terminal_command`) or direct tools (`read_file`, `grep`, `list_dir`) for analysis — see @~/.maestro/templates/search-tools.md for tool selection
- If agent delegation is needed, request it from the coordinator via `team_msg` (`operation="log"`, `to="coordinator"`, `type="blocker"`)
<!-- grok-agent-override:end section="execute-role-logic" -->

<!-- grok-agent-override:start section="milestone-protocol" -->
### Progress Milestone Protocol

Report progress via `team_msg` at natural phase boundaries. This enables coordinator status dashboards and timeout forensics.

**Milestone Reporting** — at each phase boundary:

```javascript
team_msg({
  operation: "log",
  session_id: "<session_id>",
  from: "<task_id>",
  to: "coordinator",
  type: "progress",
  summary: "[<task_id>] <brief phase description> (<pct>%)",
  data: {
    task_id: "<task_id>",
    role: "<role>",
    status: "in_progress",
    progress_pct: <0-100>,
    phase: "<what just completed>",
    key_info: "<most important finding or decision>"
  }
})
```

**Role-Specific Milestones**:

| Role | ~30% | ~60% | ~90% |
|------|------|------|------|
| analyst/researcher | Context loaded | Core analysis done | Verification complete |
| writer/drafter | Sources gathered | Draft written | Self-review done |
| planner | Requirements parsed | Plan structured | Dependencies validated |
| executor/implementer | Context loaded | Core changes done | Tests passing |
| reviewer/tester | Scope mapped | Reviews/tests done | Report compiled |

**Blocker Reporting** — immediately on errors (don't wait for next milestone):

```javascript
team_msg({
  operation: "log",
  session_id: "<session_id>",
  from: "<task_id>",
  to: "coordinator",
  type: "blocker",
  summary: "[<task_id>] BLOCKED: <brief description>",
  data: {
    task_id: "<task_id>",
    role: "<role>",
    blocker_detail: "<what is blocking>",
    severity: "high|medium",
    attempted: "<what was tried>"
  }
})
```

**Completion Report** — together with the final spawn return value:

```javascript
team_msg({
  operation: "log",
  session_id: "<session_id>",
  from: "<task_id>",
  to: "coordinator",
  type: "task_complete",
  summary: "[<task_id>] Complete: <one-line result>",
  data: {
    task_id: "<task_id>",
    role: "<role>",
    status: "completed",
    progress_pct: 100,
    artifact: "<artifact_path>",
    files_modified: []
  }
})
```

**Overhead Rule**: Max 3-4 milestone messages per task. Each summary < 200 chars. Only report at natural phase boundaries, not every minor step.
<!-- grok-agent-override:end section="milestone-protocol" -->

<!-- grok-agent-override:start section="report-and-advance" -->
### 7. Report and Return

1. Publish the required deliverable and log the final `state_update` through `team_msg` (include `tech_profile` if codebase signals were detected during execution).
2. Log the final report to the coordinator via `team_msg` (`operation="log"`, `to="coordinator"`, `type="task_complete"`): completed scope, artifact paths, files modified, verification, decisions, and warnings.
3. Return the final result as the spawn return value — this is the completion signal the parent session collects with `get_command_or_subagent_output`. The coordinator records authoritative completion in Session/team artifacts.
4. Do not self-discover or claim another assignment. With `inner_loop=true`, continue only with the work items enumerated in the original spawn prompt.
5. If follow-up work requires a different worker or a checkpoint, request that dispatch from the coordinator via `team_msg` (`to="coordinator"`). Workers cannot spawn successors — the Grok depth limit is 1.
<!-- grok-agent-override:end section="report-and-advance" -->

<!-- grok-agent-override:start section="input" -->
## Input
- Initial `spawn_subagent` prompt with the assignment fields (role, role_spec, session, session_id, team_name, requirement, inner_loop, optional run_dir)
- Role spec file containing frontmatter metadata and execution instructions
- Session folder with wisdom files and upstream artifacts
<!-- grok-agent-override:end section="input" -->

<!-- grok-agent-override:start section="output" -->
## Output
- Completed artifacts in `{run_dir}/outputs/` (or `<session>/artifacts/` when the session has no Run)
- Wisdom contributions under `<session>/wisdom/`
- State updates through the message bus (`team_msg` with type `state_update`)
- Final report logged to the coordinator and returned to the parent session as the spawn result
<!-- grok-agent-override:end section="output" -->

<!-- grok-agent-override:start section="constraints" -->
## Constraints
- Only process work matching your role's prefix -- never touch other roles' assignments
- Communicate only with the coordinator via `team_msg` (`to="coordinator"`) -- no direct worker-to-worker messaging
- Cannot call `spawn_subagent` (Grok depth limit 1) -- request delegation from the coordinator instead
- Cannot create or reassign work for other roles
- Do not modify resources outside your own scope
- `team-session.json` is read-only for workers — the coordinator is its sole writer
- Formal JSON artifacts under `{run_dir}/outputs/` must contain complete `_meta.kind` and `_meta.schema`; legacy artifacts are read-only compatibility inputs, not templates for new writes
- All output lines must be prefixed with `[<role>]` tag for coordinator message routing
- Cumulative errors >= 3: report to the coordinator via `team_msg` (`type="blocker"`) and STOP
- If role spec file is not found: report the error via `team_msg` (`type="blocker"`) and STOP
<!-- grok-agent-override:end section="constraints" -->
