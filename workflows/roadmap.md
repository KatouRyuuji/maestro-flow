---
name: roadmap
prepare: roadmap
commands: [maestro-roadmap]
session-mode: inherited
---

# Workflow: Roadmap

Shared logic lives in `roadmap-common.md` (also consumed by `spec-generate.md`). This workflow owns only the roadmap-specific decomposition flow, write gates, and routing.

## Worktree Guard

MANDATORY: execute ~/.maestro/workflows/roadmap-common.md "Worktree Guard"; REQUIRED produce: main-worktree confirmed; BLOCKED if `.workflow/worktree-scope.json` exists.

---

## Load Project Context

MANDATORY: execute ~/.maestro/workflows/roadmap-common.md "Load Project Context"; REQUIRED produce: `project_context` (already_sealed, current_scope, planned_sessions, locked_decisions, learnings, project_history).

---

## Codebase Exploration (conditional)

MANDATORY: execute ~/.maestro/workflows/roadmap-common.md "Codebase Exploration"; REQUIRED produce: relevant files, patterns, tech stack, feature_audit.

---

## External Research — API & Technology Details (Optional)

MANDATORY: execute ~/.maestro/workflows/roadmap-common.md "External Research — API & Technology Details"; REQUIRED produce: `apiResearchContext` (or `null` + flag roadmap as [LOW CONFIDENCE] when no topics found or research fails).

---

## Session Decomposition Principle

MANDATORY: apply ~/.maestro/workflows/roadmap-common.md "Session Decomposition Principle"; REQUIRED produce: session DAG honouring the default-1-session rule, the three hard-dependency split conditions, the 5-task minimum, the progressive/direct mode shapes, the canonical Session format, and full requirements traceability.

`prepare/roadmap.md` Boundaries carries the condensed pre-flight form of these rules; `roadmap-common.md` is the canonical wording.

---

## Decomposition Flow

### Create mode (default)

Build the session DAG from the requirement (or upstream context loaded via `--from`).

1. **Parse requirement** into goal, constraints, stakeholders. BLOCKED if no parsed requirement — cannot decompose.
2. **Decompose** into sessions with intent, scope, success criteria. Define DAG edges with `depends_on`. Every Active requirement from project.md maps to exactly one session. No circular dependencies (E003 if detected). **GATE: dag-valid**
3. **Refine** against the sizing checklist. Present the DAG for approval (auto-approved with `-y`).

### Revise mode (`--revise`)

Read the `current-roadmap` artifact. Apply the requested changes. Preserve any session whose `status` is already `sealed` — E005 if a revision would modify one (warn user, ask to confirm or adjust). E004 if `current-roadmap` artifact not found.

### Review mode (`--review`)

Read-only health assessment of the session DAG: dependency validity, requirement coverage, session sizing. No writes. E004 if `current-roadmap` artifact not found.

---

## Roadmap Write Logic

### Output Files

Write to `{run_dir}/outputs/`:

1. **`roadmap.json`** — Machine-readable session DAG
2. **`roadmap.md`** — Human-readable session summary using the roadmap template (see `ref/roadmap-template.md`)

Do NOT write to `.workflow/roadmap.md` — roadmap is a Run artifact, not a project-level file.

### Session Registration

MANDATORY: apply ~/.maestro/workflows/roadmap-common.md "state.json Session Registration"; REQUIRED produce: state.json updated.

Artifact registration and state updates (session DAG registration, activation) are handled by `maestro session done`. **GATE: sessions-registered** — every session written to `state.json.sessions[]` with `roadmap_artifact_id` and `seed_ref`.

---

## Root Session Activation

After outputs are written, confirm which root session to activate via `AskUserQuestion`:
- Activate the recommended root session (first root in the DAG)
- Choose a different session from the DAG
- Defer activation (keep all sessions `planned`)

Skip in auto mode (`-y`) — select the first root session automatically. The chosen activation is applied by the runtime via `maestro session done`.

---

## Success Criteria

- [ ] Requirement parsed with goal, constraints, stakeholders
- [ ] Sessions defined with intent, scope, success criteria, and seed data
- [ ] Decomposition strategy selected (progressive or direct)
- [ ] DAG edges defined with `depends_on` relationships
- [ ] Every Active requirement from project.md mapped to exactly one session
- [ ] No circular dependencies in session DAG
- [ ] User approved session DAG (or auto-approved with -y)
- [ ] `outputs/roadmap.json` written with session DAG
- [ ] `outputs/roadmap.md` written with session summary and frontmatter `kind: roadmap`
- [ ] Sessions registered in `state.json.sessions[]` with `roadmap_artifact_id` and `seed_ref`
- [ ] Root session activation confirmed via AskUserQuestion

---

## Completion

Report session count, root sessions, strategy, and output path. Verdict `done` on normal completion, `done-with-concerns` if concerns surfaced (e.g. unmapped requirement, low-confidence research).

## Error Codes

| Code | Condition | Recovery |
|------|-----------|----------|
| E001 | Requirement/idea text or @file required | Prompt user for input |
| E002 | Context source not found (`--from` / `--from-brainstorm`) | Show available sessions/sources |
| E003 | Circular dependency detected in session DAG | Prompt user to re-decompose |
| E004 | current-roadmap artifact not found (`--revise`/`--review`) | Run roadmap create first |
| E005 | Revision would modify a sealed session | Warn user, ask to confirm or adjust |
| W001 | CLI analysis failed, using fallback | Continue with available data |
| W002 | Max refinement rounds (5) reached | Force proceed with current DAG |
| W005 | External research agent failed | Continue without apiResearchContext |

### Next-step routing

| Condition | Suggestion |
|-----------|-----------|
| Session activated, need analysis | `analyze --session {active-session-slug}` |
| Simple project, ready to plan | `plan --session {active-session-slug}` |
| Need UI design first | `impeccable build` |
| Need formal spec documents | `blueprint` |
