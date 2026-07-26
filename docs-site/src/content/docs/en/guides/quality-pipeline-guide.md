---
title: "Quality Pipeline Guide"
icon: "✅"
---

Complete reference for the Maestro quality pipeline, organized around a **"Review → Test → Debug → Refactor → Retrospective"** closed loop. Since v0.5.56, quality gates are inserted into the canonical Session/Run chain by the Ralph policy as **decision nodes** (`post-execute` / `post-business-test` / `post-review` / `post-test` / `post-frontend-verify`), evaluated by a read-only evaluator that submits a verdict via `maestro session decide --verdict`.

---

## Command Overview

| Command | Purpose | Core Question | Artifact ID |
|---------|---------|---------------|-------------|
| `review` (Skill chain step) | Layered code review | Does code quality meet standards? | `REV-{NNN}` |
| `test` (Skill chain step) | Conversational UAT | Does it work from the user's perspective? | `TST-{NNN}` |
| `auto-test` (Skill chain step) | Unified automated testing | Do coverage and regression pass? | `TST-{NNN}` |
| `/maestro-odyssey --mode debug` | Hypothesis-driven debugging | What is the root cause? | `DBG-{NNN}` |
| `/maestro-odyssey --mode improve` | Reflection-driven refactoring | Is technical debt converging? | `WBR-{NNN}` |
| `maestro kg index` | Documentation synchronization | Are docs consistent with code? | — |
| `retrospective` (`/maestro "复盘 phase N"`) | Phase retrospective | What insights are reusable? | `INS-{8hex}` |

> Bare command names (`review`, `test`, `auto-test`) are Skill chain steps, routed by `/maestro` or executed via `maestro session start --chain ...` within a canonical Session; quality gates (`post-*`) are decision nodes inserted by the Ralph policy.

---

## review — Layered Code Review (◆post-review)

```bash
/maestro "review phase N"              # route the review chain step via /maestro
review --session {session} [--tier quick]   # in-chain Skill command (append --tier quick in quick mode)
```

| Parameter | Description |
|-----------|-------------|
| `{phase}` / `--session {session}` | Phase number or Session binding |
| `--tier quick` | Quick review tier (auto-appended when quality_mode=quick) |

**Review tiers**: Quick (inline review for small changes) → Standard (parallel Agents review by dimension, with automatic deep-dive) → Deep (multi-round aggregation), inferred from quality_mode and observable risk.

Artifact path: `runs/{run-id}/outputs/review.json` (or `scratch/{YYYYMMDD}-review-P{N}-{slug}/review.json`)

After review, the **`post-review` decision gate** evaluates (a read-only evaluator reads review.json):

| Verdict | Meaning | Next Step |
|---------|---------|-----------|
| `proceed` (PASS/WARN) | Passed or non-critical issues | `session decide --verdict proceed` → continue to testing |
| `fix` (BLOCK) | Critical issues, must fix | repair Skill produces `chain-proposal/1.0` → `plan --gaps → execute` |
| `escalate` | Out-of-scope escalation | Hand off to audited recovery |

---

## test — Conversational UAT (◆post-test)

```bash
/maestro "test phase N" [--smoke] [--auto-fix]
test --session {session} [--frontend-verify]   # in-chain Skill command
```

| Parameter | Description |
|-----------|-------------|
| `--smoke` | Inject smoke tests before UAT |
| `--auto-fix` | Auto gap-fix loop (plan--gaps→execute→re-verify, max 2 rounds) |
| `--frontend-verify` | Insert the frontend-verify gate (e2e) when delivering UI |

**Flow**: Extract scenarios from `verification.json` → per-scenario interaction → auto-infer severity (blocker/major/minor/cosmetic) → issues debugged in parallel per gap cluster

Artifact path: `runs/{run-id}/outputs/` (uat.md, test-plan.json, test-results.json)

| Condition | Next Step |
|-----------|-----------|
| All passed | `post-test` decision gate proceed → `/maestro-session-seal` |
| `--auto-fix` succeeded | Verified via the decision gate |
| Issues remain | `/maestro-odyssey --mode debug "<from-uat {phase}>"` |
| Insufficient coverage | `auto-test {phase}` (test-gen) |

---

## auto-test — Unified Automated Testing (◆post-business-test)

```bash
/maestro "auto-test phase N"
auto-test --session {session}   # in-chain Skill command (business-test / test-gen)
```

**Smart routing**:

| Priority | Condition | Route |
|----------|-----------|-------|
| 1 | Active session exists | Resume session |
| 2 | Re-run + previous failures | Re-run failed |
| 3 | REQ-*.md exists | spec route |
| 4 | Coverage gaps exist | gap route |
| 5 | Default | code route |

**Level waves**: L0→L1→L2→L3 sequential execution, CSV parallel writes + CSV parallel diagnosis

Artifact path: `runs/{run-id}/outputs/` (test-plan.json, scenarios.csv, report.json)

| Condition | Next Step |
|-----------|-----------|
| Converged (≥95%) | `post-business-test` decision gate proceed |
| Bugs found | `/maestro-odyssey --mode debug "<from-uat {phase}>"` |
| Max iterations, >80% | `test {phase}` (UAT) |
| Max iterations, <80% | `/maestro-odyssey --mode debug "{phase}"` |

---

## maestro-odyssey --mode debug — Hypothesis-Driven Debugging

```bash
/maestro-odyssey --mode debug "<issue description>" [--from-uat <phase>] [--parallel]
```

| Mode | Trigger | Symptom Source |
|------|---------|----------------|
| Standalone | Provide issue description directly | Interactive collection |
| UAT handoff | `--from-uat` | Loaded from `uat.md` |
| Parallel | `--parallel` | Independent Agent per gap cluster |

**Debug loop**: Symptom collection → Hypothesis generation → Isolation verification → Root cause confirmation → Readiness gate → Stress testing

Artifact path: `scratch/{YYYYMMDD}-debug-P{N}-{slug}/` (understanding.md, evidence.ndjson)

| Condition | Next Step |
|-----------|-----------|
| Root cause found | `/maestro "plan {phase} --gaps"` (review-fix chain) |
| UAT handoff + auto-fix | `/maestro "test {phase}" --auto-fix` |
| Unclear conclusion | Resume debug session (`-c`) |

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

Detects changes via `git diff` → `doc-index.json` traces impact chains → updates `.workflow/codebase/` documents.

---

## retrospective — Phase Retrospective

```bash
/maestro "复盘 phase N"        # retrospective chain: 4 parallel Lenses (Technical / Process / Quality / Decision)
/maestro-knowhow "洞察"   # knowledge capture (knowhow)
```

> Since v0.5.56, the phase retrospective is handled by the `retrospective` Skill (routed via `/maestro "复盘 phase N"`); knowledge promotion/capture goes through `/maestro-knowhow` or `harvest`. The old `maestro-next --promote` has been retired (`/maestro-next` is now a pure router).

4 parallel Lenses (Technical / Process / Quality / Decision), insights auto-routed:

| Routing Target | Condition |
|----------------|-----------|
| Spec stub | Reusable patterns/constraints |
| Issue | Recurring gaps |
| Knowhow tip | Process notes/reminders |
| Learnings | All insights (always) |

---

## Quality Closed-Loop Flow

```
              ┌──────────────────────────────────────────────┐
              │        Phase execution complete (execute)     │
              └───────────────────┬──────────────────────────┘
                                  │
              ┌───────────────────▼──────────────────────────┐
        ┌─────┤   review → ◆post-review decision gate (review)│
        │     └───────────────────┬──────────────────────────┘
        │ fix                     │ proceed
        ▼                         ▼
┌───────────────────┐   ┌──────────────────────────────────────┐
│ plan --gaps        │   │  test / auto-test → ◆post-test (test) │
│ → execute (fix)    │   └───────────────────┬──────────────────┘
└────────┬──────────┘                       │
         │                                │ Issues found
         │ Apply fix                       ▼
         ▼                       ┌────────────────────────────┐
┌───────────────────┐            │ maestro-odyssey --mode debug │
│ execute → re-run   │◄──────────┤ (debugging)                  │
│ gate               │            └─────────────┬──────────────┘
└────────┬──────────┘                          │
         │                                     │
         │ Root cause found                    │
         ▼                                     │
┌───────────────────┐                          │
│ Re-run test loop  │◄─────────────────────────┘
└────────┬──────────┘
         │ All passed
         ▼
┌──────────────────────────────────────────────────┐
│  /maestro-odyssey --mode improve (optional, handle tech debt)    │
│  maestro kg index (sync docs)         │
│  /maestro "复盘 phase N" (retrospective, feedback) │
└──────────────────────────────────────────────────┘
```

> Quality gates are **decision nodes** inserted by the Ralph policy, evaluated by a read-only evaluator that submits a verdict via `maestro session decide --verdict proceed|fix|escalate`. A `fix` verdict causes the repair Skill to produce a `chain-proposal/1.0` that inserts a fix step.

<details>
<summary>Decision tree: when to use which command</summary>

```
Code just executed
  ├─ Need code quality assessment? ──> review "<phase>" (◆post-review decision gate)
  │    ├─ proceed ──> Continue to testing
  │    └─ fix ──> /maestro "plan <phase> --gaps" (review-fix chain)
  │
  ├─ Need user acceptance? ──> /maestro "test <phase>"
  │    ├─ All passed ──> /maestro-session-seal
  │    └─ Issues found ──> /maestro-odyssey --mode debug "<from-uat <phase>>"
  │
  ├─ Need automated testing? ──> auto-test "<phase>" (◆post-business-test)
  │    ├─ Converged ──> Passed the decision gate
  │    └─ Bugs found ──> /maestro-odyssey --mode debug "<from-uat <phase>>"
  │
  ├─ Known bugs? ──> /maestro-odyssey --mode debug "<issue>"
  │    ├─ Root cause clear ──> /maestro "plan <phase> --gaps"
  │    └─ Unclear ──> Continue debugging
  │
  ├─ Need to reduce tech debt? ──> /maestro-odyssey --mode improve <scope>
  │    ├─ Tests pass ──> maestro kg index
  │    └─ Tests fail ──> /maestro-odyssey --mode debug "<scope>"
  │
  ├─ Code changed but docs not updated? ──> maestro kg index
  │
  └─ Phase complete, need retrospective? ──> /maestro "复盘 phase N" (retrospective)
       ├─ Insights found ──> Auto-route to spec/issue/knowhow
       └─ Complete ──> maestro session status
```

</details>

---

## Integration with the Phase Pipeline

The `/maestro-ralph` closed-loop chain inserts quality gates as decision nodes, and is the standard entry point for quality commands:

```bash
/maestro-ralph "实现 X"    # execute → ◆post-execute → review → ◆post-review → test → ◆post-test → seal
/maestro "全面质量检查"     # quality-loop chain: review → auto-test → test → debug → plan --gaps → execute
```

`--gaps` is the core bridge between the quality pipeline and the Phase pipeline:

| Trigger Scenario | Command |
|------------------|---------|
| `post-review` decision gate verdicts fix | `/maestro "plan {phase} --gaps"` (review-fix chain) |
| `maestro-odyssey --mode debug` confirms root cause | `/maestro "plan {phase} --gaps"` |
| `test --auto-fix` | Auto-invokes `plan --gaps → execute → decision gate` |

**Pre-milestone-audit checkpoints**: All Phases have passed the decision gate → Critical Phases reviewed → Core functionality tested → Issues closed-loop → Retrospective completed

---

## Related Guides

- [Ralph Closed-Loop Engine and Orchestrator](./maestro-ralph-guide.md) — decision gate classification and evaluation
- [All Commands and Workflows](./command-usage-guide.md) — chain catalog
- [CLI Terminal Command Reference](./cli-commands-guide.md) — `maestro session decide`
