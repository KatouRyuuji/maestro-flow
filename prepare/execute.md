---
name: execute
description: Implement code changes following the DAG and waves of current-plan, producing implementation results and a local smoke self-check
argument-hint: '[scope] [-y] [--task TASK-ID] [--method agent|cli|auto] [--executor <tool>] [--auto-commit]'
contract:
  consumes:
  - kind: plan
    alias: current-plan
    required: false
    schema: plan/1.0
    role: primary
  - kind: review-findings
    alias: latest-review
    required: false
    schema: review-findings/1.0
    role: primary
  - kind: fix-directions
    alias: latest-fix-directions
    required: false
    schema: fix-directions/1.0
    role: attachment
  - kind: diagnosis
    alias: latest-debug
    required: false
    schema: diagnosis/1.0
    role: primary
  - kind: priors
    alias: session-priors
    required: false
    schema: priors/1.0
    role: evidence
  produces:
  - path: outputs/execution.json
    kind: artifact
    alias: current-execution
    role: primary
    required: true
    schema: artifacts/1.0
  - path: outputs/task-results.json
    kind: task-results
    role: attachment
    required: false
    schema: task-results/1.0
  - path: outputs/self-check.json
    kind: self-check
    role: evidence
    required: false
    schema: self-check/1.0
  - path: outputs/change-manifest.json
    kind: change-manifest
    role: evidence
    required: false
    schema: change-manifest/1.0
  gates:
    exit:
    - execution-complete
    - self-check-passed
  contract_version: 2.1
refs:
- path: ref/finish-work.md
  when: Wrapping up
  archiving: null
  and extracting incremental learnings: null
---

# Pre-task Thinking: execute

## Purpose

The output of execute is "an implementation consistent with the real diff + traceable per-task evidence," not "it looks like it ran." Think through the execution boundaries and failure handling before you start.

## Degradation Routing (no plan)

When `current-plan` is absent (entry gate skipped, not failed), execute enters **degradation mode**. Assess the upstream that IS available and route:

| Available upstream | Scope | Route |
|---|---|---|
| `latest-review` (review-findings) | ≤3 findings, each ≤2 files | **Companion**: seal this run as `needs-retry` with verdict note "degraded to companion", then `/maestro-companion` with the finding list as intent |
| `latest-review` (review-findings) | >3 findings or cross-module | **Odyssey planex**: seal this run as `needs-retry`, then `/odyssey-planex` with the review findings as requirement |
| `latest-debug` (diagnosis + fix-directions) | fix-directions present | **Companion** if ≤2 files; **Odyssey planex** otherwise |
| No upstream at all | — | **Abort**: report E001 "No plan and no alternative upstream; run plan first" |

Degradation close: complete the Run honestly with `maestro run complete <run_id> ... --verdict done_with_concerns --advance --json`（report.md `concerns` 记录 degradation reason 与 target command），或 `maestro run cancel <run_id> ... --json` 后重新派发目标命令。这保留 run 记录而不伪造 plan。（v2 的 `maestro session done <run_id> --verdict needs-retry` 为 deprecated/legacy-only。）

**Never fabricate a plan artifact to satisfy the gate.** The degradation path is the compliant escape.

## Input Interpretation

- When `current-plan` is present: its path is injected by create — work only from this plan. Do not step outside the waves and task scope declared in the plan to add ad-hoc work.
- A `plan/1.0` artifact with `source_format: pi-markdown` is the approved external-Plan variant: treat `markdown` as the complete authoritative plan body. Derive the execution task order, dependencies, boundaries, risks, and acceptance checks explicitly from that Markdown before dispatch; do not require structured `task_ids` or `wave_ids`, and do not invent work absent from the Markdown.
- When `current-plan` is absent: follow the Degradation Routing table above. Do NOT proceed to Step 1+ without a plan.
- How is the execution method decided? `--method` specifies explicitly (agent / cli / auto), or auto-routes by domain (frontend / backend / general each go to their own executor). When the user names a tool, use `--executor` — don't guess.
- `--task TASK-ID` runs only a single task; without args, execute the full DAG/waves. Already-completed tasks resume from checkpoint and are not re-executed.
- `-y` auto mode skips all interactive questions (executor choice, inter-wave confirmation, blocked prompts); non-auto mode must stop and ask the user retry / skip / abort when a wave is blocked.

## Required Context

- With `current-plan`: for a structured Maestro Plan, read waves, dependency graph, collision report, and each task's convergence.criteria. For `source_format: pi-markdown`, use the derived task/dependency view from the authoritative `markdown` body and preserve every stated acceptance check as convergence criteria.
- With `session-priors` (injected by upstream): its spec / doc-index / wiki hits are already resolved from a prior run — reuse them as the coding-convention context instead of repeating the load/search. Absent priors, collect fresh below.
- Project specs (coding category): unless `session-priors` already carries the coding specs, `maestro load --type spec --category coding` is **mandatory and cannot be replaced by manual Read/Grep** — pass it to each executor as coding conventions.
- UI specs (conditional load): when a task involves frontend/UI (component/page/style/layout/CSS/HTML keywords, or focus_paths falling in a UI directory), append `--category ui`.
- The architecture doc `.workflow/codebase/ARCHITECTURE.md` and wiki search results: injected as shared context into the executor; reuse the `session-priors` copy when present, else search; may continue if missing (record a warning).

## Boundaries and Invariants

### Artifact Compatibility Recovery

For an incompatible sealed input, the exact order is **blocked consumer attempt -> needs-retry/cancel -> artifact inspect -> semantic republish -> explicit retry/next**. Close the attempted execute Run with the current mode's fenced `needs-retry` completion or `run cancel`, confirm the execute step is pending with no allocated/active Run, run read-only `maestro artifact inspect` for the exact Artifact/consumer/alias, and use `maestro artifact republish` only for `classification=semantic_republish_required` with the unchanged assessment hash and returned Artifact/Session revisions. Re-read the immutable republish receipt, then explicitly allocate the retry with fenced `maestro run next`; neither atomic complete-and-seal nor republish advances implicitly.

Migration must preserve the sealed source bytes and raw registry role/alias semantics. Never repair this boundary with chain skip, Run rebind, direct Artifact Registry edits/rewrites, or source Artifact mutation; semantic republish creates a derived compatibility Artifact and receipt instead.

- self-check is only a scoped build/test smoke over this run's changes (narrowest suites covering changed behavior; never a repository-wide matrix), **not** an acceptance conclusion — formal acceptance is in a separate verify run; never overstep to issue a verdict here.
- Write only source-code changes and this run's domain artifacts; protocol state (run completion, artifact registration) is handled by the CLI — do not manually edit state.
- After each task completes, do knowledge extraction per trigger conditions: deviations → arch constraints; retry_count ≥ 2 → debug fix mode; design_rationale → learning knowhow.
- Full knowledge extraction (constraints/decisions/terminology) and archiving go uniformly through `ref/finish-work.md`; execute only does incremental learnings.
- When a task carries `issue_id`, sync the issue status after completion (all task_refs done → resolved, any failure → in_progress); in non-auto mode, confirm before writing back.

## Risk Checklist

- Are there write conflicts within the same wave? Follow task deps and the collision report — only parallelize tasks with no write conflict; conflicting ones go to different waves.
- Does each task have real evidence? Files changed, commands/tests executed, and per-criterion pass/fail must all be recorded; do not mark done based on the executor's self-report alone.
- Has a single task exhausted 3 chances? Normal execution → focused retry → degraded execution; still failing records blocked and writes a checkpoint. Never fabricate completion.
- What about downstream of a blocked task? Propagate blocked along dependencies; downstream tasks with unmet dependencies are marked `upstream_blocked` — don't pretend they can run.
- Are changes out of bounds? Write only source-code changes and this run's domain artifacts; protocol state (run completion, artifact registration) is handled by the CLI — do not manually edit state.
- Are tech-stack constraints followed? The specs' allowed_languages / disallowed_imports must be scanned once after changes; a hit is critical.

## Gate Intent

- `execution-complete`: every task in the plan reaches a terminal state (done / blocked with checkpoint); `execution.json` is written and completed tasks carry a summary + status.
- `self-check-passed`: the gate fails only when the scoped build/test smoke over this run's changes was not run this round or an unhandled critical tech-stack violation (allowed_languages / disallowed_imports) remains. A self-check result of `gaps_found` does **not** block run completion — gaps are recorded as concerns in the report for the separate verify run to consume (formal acceptance lives in verify, not here).

## Legacy `session/1.x/2.x` Compatibility Branch

deprecated/legacy-only：v2 运行时以 `kind: execution / schema: execution/1.0` 产出 `outputs/execution.json`（alias `current-execution`）作为 Execution 状态记录；v3 下 Execution 记录由 Runtime 独占、不存在独立 Execution schema，等价产出为写入 Session artifact registry（`artifacts/1.0`）的 `outputs/execution.json` 域工件。
