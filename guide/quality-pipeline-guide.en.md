---
title: "Quality Pipeline Guide"
---

Complete reference for the Maestro quality pipeline: seven stages organized around a **"Review → Test → Debug → Refactor → Retrospective"** closed loop. `review` / `test` / `auto-test` / `debug` / `retrospective` are **first-tier steps** dispatched by the orchestrator via the session chain (not standalone slash commands — you cannot type `/quality-*` directly); `refactor` is folded into `/maestro-odyssey --mode improve`, and `sync` is handled by `maestro kg index`. The user entry points are `/maestro "<intent>"` (the coordinator classifies and builds the chain) or `/maestro-next`. Each stage's parameter block below documents its step interface for pass-through when the chain is built.

---

## Command Overview

| Command | Purpose | Core Question | Artifact ID |
|----------|---------|---------------|-------------|
| `review` | Multi-level code review | Does code quality meet standards? | `REV-{NNN}` |
| `test` | Conversational UAT | Does it work from the user's perspective? | `TST-{NNN}` |
| `auto-test` | Unified automated testing | Do coverage and regression checks pass? | `TST-{NNN}` |
| `debug` | Hypothesis-driven debugging | What is the root cause? | `DBG-{NNN}` |
| `/maestro-odyssey --mode improve` | Reflection-driven refactoring | Is technical debt converging? | `WBR-{NNN}` |
| `maestro kg index` | Documentation synchronization | Are docs consistent with code? | -- |
| `retrospective` | Phase retrospective | What insights are reusable? | `INS-{8hex}` |

---

## review — Multi-Level Code Review

```bash
review <phase> [--level quick|standard|deep] [--dimensions security,architecture,...] [--skip-specs]
```

| Parameter | Description |
|-----------|-------------|
| `<phase>` | Required. Phase number or slug |
| `--level` | Review level: `quick` / `standard` / `deep`. Default: auto-detected |
| `--dimensions` | Comma-separated review dimensions. Overrides level defaults |

**Three levels**: Quick (inline for small changes) → Standard (parallel agents per dimension, auto deep-dive) → Deep (multi-round aggregation)

Artifact path: `scratch/{YYYYMMDD}-review-P{N}-{slug}/review.json`

| Verdict | Meaning | Next Step |
|---------|---------|-----------|
| `PASS` | All dimensions passed | `test {phase}` |
| `WARN` | Non-critical issues, can proceed | `test {phase}` |
| `BLOCK` | Critical issues, must fix | `plan {phase} --gaps` |

---

## test — Conversational UAT

```bash
test [phase] [--smoke] [--auto-fix]
```

| Parameter | Description |
|-----------|-------------|
| `--smoke` | Inject smoke tests before UAT |
| `--auto-fix` | Auto gap-fix loop (verify→plan--gaps→execute→re-verify, max 2 rounds) |

**Flow**: Extract scenarios from `verification.json` → per-scenario interaction → auto-infer severity (blocker/major/minor/cosmetic) → parallel debug per gap cluster

Artifact path: `scratch/{YYYYMMDD}-test-P{N}-{slug}/` (uat.md, test-plan.json, test-results.json)

| Condition | Next Step |
|-----------|-----------|
| All passed | `/maestro-session-seal` |
| `--auto-fix` succeeded | `review {phase}` |
| Issues remain | `debug --from-uat {phase}` |
| Insufficient coverage | `auto-test {phase}` |

---

## auto-test — Unified Automated Testing

```bash
auto-test <phase> [--max-iter N] [--layer L0-L3] [--strategy name] [--dry-run] [--re-run] [-y]
```

| Parameter | Description |
|-----------|-------------|
| `--max-iter N` | Max iteration count (default 5) |
| `--layer L` | Specify layer (L0/L1/L2/L3) |
| `--dry-run` | Generate plan only, no execution |
| `--re-run` | Re-run failed scenarios only |

**Smart routing**:

| Priority | Condition | Route |
|----------|-----------|-------|
| 1 | Active session exists | Resume session |
| 2 | `--re-run` + previous failures | Re-run failed |
| 3 | REQ-*.md exists | Spec route |
| 4 | Coverage gaps exist | Gap route |
| 5 | Default | Code route |

**Level waves**: L0→L1→L2→L3 sequential, CSV parallel writes + CSV parallel diagnosis

Artifact path: `scratch/{YYYYMMDD}-auto-test-P{N}-{slug}/` (test-plan.json, scenarios.csv, report.json)

| Condition | Next Step |
|-----------|-----------|
| Converged (≥95%) | `test {phase}` |
| Bugs found | `debug --from-uat {phase}` |
| Max iterations, >80% | `test {phase}` |
| Max iterations, <80% | `debug {phase}` |

---

## debug — Hypothesis-Driven Debugging

```bash
debug [issue description] [--from-uat <phase>] [--parallel]
```

| Mode | Trigger | Symptom Source |
|------|---------|----------------|
| Standalone | Provide issue description directly | Interactive collection |
| UAT handoff | `--from-uat` | Loaded from `uat.md` gaps |
| Parallel | `--parallel` | Independent agent per gap cluster |

**Debug loop**: Symptom collection → Hypothesis generation → Isolation verification → Root cause confirmation → Readiness gate → Stress testing

Artifact path: `scratch/{YYYYMMDD}-debug-P{N}-{slug}/` (understanding.md, evidence.ndjson)

| Condition | Next Step |
|-----------|-----------|
| Root cause found | `plan {phase} --gaps` |
| UAT handoff + auto-fix | `test {phase} --auto-fix` |
| Unclear conclusion | Resume debug session |

---

## /maestro-odyssey --mode improve — Reflection-Driven Refactoring

```bash
/maestro-odyssey --mode improve [<scope>]    # scope: module path | feature area | all
```

Each round: **Analysis** (identify impact) → **Planning** (execute after confirmation) → **Reflection** (test verification + strategy adjustment)

Artifact path: `scratch/{YYYYMMDD}-refactor-{scope}/reflection-log.md`

---

## maestro kg index — Documentation Synchronization

```bash
maestro kg index [--full] [--since <commit|HEAD~N>] [--dry-run]
```

Detects changes via `git diff` → traces impact chains through `doc-index.json` → updates `.workflow/codebase/` documents.

---

## retrospective — Phase Retrospective

```bash
retrospective [phase|N..M] [--lens technical|process|quality|decision] [--all] [--no-route] [--compare N] [-y]
```

4 parallel Lenses (Technical / Process / Quality / Decision), insights auto-routed:

| Routing Target | Condition |
|----------------|-----------|
| Spec stub | Reusable patterns/constraints |
| Issue | Recurring gaps |
| Knowhow tip | Process notes/reminders |
| Learnings | All insights (always) |

---

## Quality Closed Loop

```
                ┌──────────────────────────┐
                │ Phase execution complete │
                └─────────────┬────────────┘
                              │
                ┌─────────────▼────────────┐
             ┌──┤ review                   │
             │  └─────────────┬────────────┘
             │ BLOCK          │ PASS/WARN
             │                ▼
    ┌────────▼────────┐ ┌─────▼────────────────┐
    │ plan            │ │ test / auto-test     │
    │ --gaps (fix)    │ │      (testing)       │
    └────────┬────────┘ └──────────┬───────────┘
             │ Apply fix           │ Issues found
             ▼                     ▼
    ┌─────────────────┐       ┌────────────────┐
    │ execute         │◄──────┤  debug         │
    └────────┬────────┘ debug └────────┬───────┘
             │ Root cause found        │
             │                         │
    ┌────────▼────────┐                │
    │ Re-run test loop│◄───────────────┘
    └────────┬────────┘
             │ All passed
             ▼
    ┌──────────────────────────────────────────────────────────┐
    │ /maestro-odyssey --mode improve (optional, tech debt)    │
    │ maestro kg index (re-index codebase)                     │
    │ retrospective step (retro, feedback)                     │
    └──────────────────────────────────────────────────────────┘
```

<details>
<summary>Decision tree: when to use which command</summary>

```
Code just executed
  ├─ Need code quality assessment? ──> review <phase>
  │    ├─ PASS/WARN ──> Continue to testing
  │    └─ BLOCK ──> plan <phase> --gaps
  │
  ├─ Need user acceptance? ──> test <phase>
  │    ├─ All passed ──> /maestro-session-seal
  │    └─ Issues found ──> debug --from-uat <phase>
  │
  ├─ Need automated testing? ──> auto-test <phase>
  │    ├─ Converged ──> test <phase>
  │    └─ Bugs found ──> debug --from-uat <phase>
  │
  ├─ Known bugs? ──> debug "<issue>"
  │    ├─ Root cause clear ──> plan <phase> --gaps
  │    └─ Unclear ──> Continue debugging
  │
  ├─ Need to reduce tech debt? ──> /maestro-odyssey --mode improve <scope>
  │    ├─ Tests pass ──> maestro kg index
  │    └─ Tests fail ──> debug <scope>
  │
  ├─ Code changed but docs not updated? ──> maestro kg index
  │
  └─ Phase complete, need retrospective? ──> retrospective <phase>
       ├─ Insights found ──> Auto-route to spec/issue/knowhow
       └─ Complete ──> maestro session status
```

</details>

---

## Integration with Phase Pipeline

After `execute` (with built-in verification gate E2.7) confirms Phase goals, quality commands are the standard entry point:

```bash
execute 1 → review 1 → auto-test 1 → test 1 → retrospective 1
```

`--gaps` is the core bridge between quality and Phase pipelines:

| Trigger Scenario | Command |
|-----------------|---------|
| `review` verdict BLOCK | `plan {phase} --gaps` |
| `debug` confirms root cause | `plan {phase} --gaps` |
| `test --auto-fix` | Auto-invokes `plan--gaps → execute → verify` |

**Pre-milestone-audit checkpoints**: All Phases verified → Critical Phases reviewed → Core functionality tested → Issues resolved → Retrospective completed
