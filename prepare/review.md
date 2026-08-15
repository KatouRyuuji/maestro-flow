---
name: review
description: Perform layered multi-dimensional code review of executed changes, producing traceable review-findings
argument-hint: '[scope] [--level quick|standard|deep] [--dimensions <list>] [--skip-specs]'
contract:
  consumes:
  - kind: artifact
    alias: current-execution
    required: true
    schema: artifacts/1.0
    role: primary
  - kind: verification
    alias: latest-verification
    required: false
    schema: verification/1.0
    role: primary
  - kind: review-findings
    alias: latest-review
    required: false
    schema: review-findings/1.0
    role: primary
  produces:
  - path: outputs/review-findings.json
    kind: review-findings
    alias: latest-review
    role: primary
    required: true
    schema: review-findings/1.0
  - path: outputs/spec-conflicts.json
    kind: spec-conflicts
    role: evidence
    required: false
    schema: spec-conflicts/1.0
  - path: outputs/issue-candidates.json
    kind: issue-candidates
    role: attachment
    required: false
    schema: issue-candidates/1.0
  - path: outputs/chain-proposal.json
    kind: chain-proposal
    alias: chain-proposal
    role: attachment
    required: false
    schema: chain-proposal/1.0
  gates:
    exit:
    - dimension-coverage
    - severity-triaged
    - repair-routing
  orchestration:
    chain_effects:
    - insert
  contract_version: 2.1
refs:
- path: ref/spec-conflict.md
  when: A contradiction between code and a spec entry is found
- path: ref/cli-supplementary.md
  when: standard/deep needs CLI cross-validation
---

# Pre-task Thinking: review

## Purpose

Review is a read-only assessment of `current-execution`'s change manifest. Before starting, establish awareness of this round's scope and existing constraints.

## Input Interpretation

The review level determines dimension coverage and execution method, inferred automatically by changed-file count by default:

| Level | Trigger | Dimensions | Execution |
|-------|---------|------------|-----------|
| quick | `--level quick` or small scope | correctness, security | inline scan, no agents dispatched |
| standard | default | all 6 dimensions | parallel agents |
| deep | `--level deep` or large scope / critical session | all 6 dimensions | parallel agents + mandatory deep-dive |

The six dimensions: correctness, security, performance, architecture, maintainability, best-practices. `--dimensions <list>` can override the level default.

## Required Context

Context injection (optional, may continue if missing):

- Architecture doc: `.workflow/codebase/ARCHITECTURE.md` → component boundaries, layering rules
- Wiki constraints: `maestro search "architecture constraint" --json` → recorded decisions
- Review specs: `maestro load --type spec --category review` → review standards, checklist, discoverable knowhow tools
- Conflict state: `maestro spec conflict list` → spec entries currently marked as conflicting (prioritize during review)
- Role knowledge: `maestro search --category review` → pick relevant items → `maestro load --type knowhow --id`

## Boundaries and Invariants

### Artifact Compatibility Recovery

For an incompatible sealed `current-execution`, the exact order is **blocked consumer attempt -> needs-retry/cancel -> artifact inspect -> semantic republish -> explicit retry/next**. Close the attempted review Run with the current mode's fenced `needs-retry` completion or `run cancel`, confirm the review step is pending with no allocated/active Run, run read-only `maestro artifact inspect` for the exact Artifact/consumer/alias, and use `maestro artifact republish` only for `classification=semantic_republish_required` with the unchanged assessment hash and returned Artifact/Session revisions. Re-read the immutable republish receipt, then explicitly allocate the retry with fenced `maestro run next`; neither atomic complete-and-seal nor republish advances implicitly.

Migration must preserve the sealed source bytes and raw registry role/alias semantics. Never repair this boundary with chain skip, Run rebind, direct Artifact Registry edits/rewrites, or source Artifact mutation; semantic republish creates a derived compatibility Artifact and receipt instead.

- Review is read-only on source — problems found are not fixed in this run; source modification belongs to the debug→plan→execute loop.
- Every finding must be anchored to `file:line` and carry severity, evidence, impact, recommendation; vague conclusions without anchors are forbidden.
- The verdict is driven by findings data; do not change severity based on user preference without new evidence.
- Each dimension produces findings independently; one dimension's result must not suppress or override another's.
- When a same-session `prior-review` exists, do a delta comparison; do not re-report already-resolved findings as new problems.
- When code and a spec entry contradict: if the code is evolved practice (spec is outdated), suggest `maestro spec supersede`; if there's a genuine dispute, `maestro spec conflict mark`; never silently accept the contradiction or edit the spec in place.
- A BLOCK result never falls through to the pre-existing pending tail. When no formal decision node follows this review, emit the typed repair-loop proposal required by the workflow; when a decision node follows, leave routing to that decision.

## Risk Checklist

- Is every finding anchored to `file:line` with severity, evidence, impact, recommendation? A vague finding without an anchor is not actionable.
- Is the verdict driven by findings data, not preference? Severity must not be softened without new evidence.
- Are dimensions genuinely independent? One dimension suppressing or overriding another's findings undermines coverage.
- On a re-review, did you delta against `prior-review`? Re-reporting already-resolved findings as new is noise.
- Did a code/spec contradiction get routed correctly? Evolved practice → `spec supersede`; genuine dispute → `spec conflict mark`; never silently accept or edit the spec in place.

## Gate Intent

- `dimension-coverage`: the dimensions required by the level all produced findings (quick = correctness + security; standard/deep = all 6), and each finding is anchored to `file:line` with severity/evidence/impact/recommendation.
- `severity-triaged`: every finding has a triaged severity and there are no unhandled UNMET spec-compliance criteria; the PASS/WARN/BLOCK verdict is driven by finding data, not preference.
- `repair-routing`: BLOCK is followed by either a formal decision node or a validated `chain-proposal/1.0`; without either, complete the Run with a failure verdict instead of advancing the chain.

## Legacy `session/1.x/2.x` Compatibility Branch

deprecated/legacy-only：v2 运行时以 `kind: execution / schema: execution/1.0`（alias `current-execution`）消费当前 Execution 状态记录（change manifest 等）；v3 下不存在 Execution 记录，等价消费为 Session artifact registry（`artifacts/1.0`）。
