---
name: verify
description: Independently verify current-execution's requirement coverage, behavioral correctness, and anti-pattern risk against current-plan
argument-hint: '[scope] [--strict] [--skip-tests] [--skip-antipattern]'
contract:
  consumes:
  - kind: plan
    alias: current-plan
    required: true
    schema: plan/1.0
    role: primary
  - kind: artifact
    alias: current-execution
    required: true
    schema: artifacts/1.0
    role: primary
  produces:
  - path: outputs/verification.json
    kind: verification
    alias: latest-verification
    role: primary
    required: true
    schema: verification/1.0
  - path: outputs/requirement-coverage.json
    kind: requirement-coverage
    role: evidence
    required: false
    schema: requirement-coverage/1.0
  - path: outputs/antipattern-report.json
    kind: antipattern-report
    role: evidence
    required: false
    schema: antipattern-report/1.0
  gates:
    exit:
    - goal-backward-verified
    - nyquist-covered
  contract_version: 2.1
refs:
- path: ref/finish-work.md
  when: Wrapping up and archiving the verification
---

# Pre-task Thinking: verify

## Purpose

verify is the iron-gate of an independent run; the output is a verification conclusion where "every criterion has an objective pass/fail/blocked + evidence," not "it looks fine." Establish verification discipline before you start.

## Iron law: no conclusion without grounded evidence

Before any "pass/done" declaration: IDENTIFY (which narrowest command proves it) → EVIDENCE (a live run this round, or a still-valid live-run result produced for the same revision) → READ (read the full output, check the exit code, count failures) → VERIFY (does the output truly support the claim) → only then conclude and inline the evidence.

A prior result is still-valid only when it was actually executed (never a claim or memory), its target and outcome are recorded, and no material invalidator occurred since: a change to code the target exercises, its tests, test data, configuration, dependencies, lockfile, or generated inputs. Elapsed time, phase or gate transitions, agent switches, and unrelated edits are not invalidators — name the specific invalidator before rerunning. When a criterion lacks still-valid evidence, run the narrowest target that proves it (a single test file or narrowed suite first); repository-wide scope is reserved for criteria that themselves demand repository-wide coverage.

Forbidden phrasings: `should run now` / `probably passes` / `looks right` / `I'm confident` / `based on my review this is done` — all replaced with evidence: `Tests pass: 42/42 green (exit 0)` / `All 5 truths VERIFIED, with file:line`.

## Input Interpretation

- The verification sources are the two typed artifacts `current-plan` and `current-execution`, with their paths injected by create — extract criteria/requirements from plan, implementation scope from execution/change-manifest.
- `--strict`: raise the judgment bar; UNCERTAIN does not pass; boundary/error paths must be explicitly verified.
- `--skip-tests`: skip Nyquist test coverage, do only goal-backward structural verification.
- `--skip-antipattern`: skip the anti-pattern scan.

## Boundaries and Invariants

- This run **reads source only** by default — gaps found are not fixed here; fixing belongs to the plan→execute loop.
- No conclusion without grounded evidence: a live run this round or a still-valid live-run result under the Iron law; self-check from execute is supporting evidence only, never the final verdict.
- Verification scope follows the criteria: run the narrowest targets covering each criterion; do not rerun unchanged passing targets or sweep unrelated suites to be safe.

## Red-flag thinking — stop the moment one appears and run verification first

The moment you catch any of these thoughts, stop, run the verification command and read the output before reporting:

- "The code I just wrote surely runs"
- "The change is too small to break"
- "I already verified this earlier"
- "It was tested before, so it'll pass now"
- "You can tell it's correct just by reading the code"
- "Mark it done and move on first"

Table of invalid reasons: a one-line change most easily buries an insidious bug; once the code changes, historical results are stale; reading ≠ running; build success ≠ functional correctness; happy path passing ≠ boundary/error path passing; an agent's self-report is a claim, not evidence. Red flags forbid concluding from memory or claims; they do not forbid citing a still-valid live-run result per the Iron law.

## Required Context

- `current-plan`: for a structured Maestro Plan, success_criteria is the primary contract and convergence.criteria is the per-task basis. For `source_format: pi-markdown`, the `markdown` body is the complete authoritative contract: enumerate every stated acceptance check, boundary, and risk as explicit verification items before testing. Never require absent `task_ids`/`wave_ids` and never silently omit prose criteria.
- `current-execution` + change-manifest: take the implementation scope and changed-files list as the target surface for verification scanning.
- Review specs (review category): `maestro load --type spec --category review` as quality standards; when it contains tech-stack constraints, do a constraint-compliance pre-check first.
- UAT human findings (if any): merge into gaps, marked `human_verified_failure`.

## Risk Checklist

- Does every criterion have a method + status + evidence? method is one of test/grep/review/manual; "close enough" is forbidden.
- Did you reuse execute's self-check as the final conclusion? self-check can only be supporting evidence; the final verdict must be independently recomputed this run.
- Did you check all three layers of existence/substance/wiring? Expected file exists (L1), has real implementation not a stub (L2), is imported and used not an orphan (L3).
- Is the anti-pattern scan complete? TODO/FIXME/HACK, placeholder, empty returns, log-only functions, hardcoded test data, disabled tests.
- Is regression risk covered? Are the changed files' direct importers affected, are existing tests still green?
- Does coverage have a silent omission? Every requirement must be explicitly marked covered/partial/uncovered; missing one means verification is incomplete.

## Gate Intent

- `goal-backward-verified`: every success criterion and per-task convergence.criterion is checked across the three layers (existence L1, substance L2, wiring L3), each with method + status + grounded evidence (live run this round or still-valid live-run result); every failure has an actionable gap and coverage has no silent omission.
- `nyquist-covered`: test coverage is computed from a live run of the suites covering the changed surface this round (skipped only under `--skip-tests`); regression risk on changed files' direct importers is assessed.
- verdict mapping: pass → all VERIFIED with no blocker; warn → only medium/low gaps; fail/blocked → has a critical gap or a key path unverified.

## Legacy `session/1.x/2.x` Compatibility Branch

deprecated/legacy-only：v2 运行时以 `kind: execution / schema: execution/1.0`（alias `current-execution`）消费当前 Execution 状态记录（implementation scope / change manifest）；v3 下不存在 Execution 记录，等价消费为 Session artifact registry（`artifacts/1.0`）。
