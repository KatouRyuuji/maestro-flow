---
name: odyssey-defensive
description: Odyssey defensive mode — read-only defensive-programming risk audit driven by business anchors: identify critical business sinks, backward-slice to defensive nodes, scan 8 defensive patterns (broad catch, exception swallowing, defaults, null fallback, auto-correction/clamp, silent conversion, duplicate constraints, duplicate defaults), forward-propagate to business sinks, classify exception semantics, and score risk R=S×P×B×H. Produces severity matrix report with full propagation chains. No fix loop.
argument-hint: '<target: file|dir|HEAD|staged|phase#|PR#> [--tier quick|standard|deep] [--sink-depth <list>] [--skip-generalize] [-y] [-c]'
contract:
  consumes:
  - kind: defensive-audit-result
    alias: defensive-session
    required: false
    schema: defensive-audit-result/1.0
    role: primary
  produces:
  - path: outputs/session.json
    kind: defensive-audit-result
    alias: defensive-session
    role: primary
    required: true
    schema: defensive-audit-result/1.0
  - path: outputs/evidence.ndjson
    kind: evidence
    alias: defensive-evidence
    role: evidence
    required: false
    schema: evidence/1.0
  - path: outputs/anchors.json
    kind: defensive-anchors
    alias: defensive-anchors
    role: evidence
    required: false
    schema: defensive-anchors/1.0
  - path: outputs/understanding.md
    kind: defensive-report
    alias: defensive-understanding
    role: primary
    required: false
    schema: defensive-report/1.0
  gates:
    exit:
    - anchor-identified
    - scan-complete
    - propagation-verified
    - report-produced
  contract_version: 2.1
refs:
- path: workflows/odyssey-base.md
  when: Shared back-half (GENERALIZE → DISCOVER → RECORD → END) needed
- path: ref/cli-supplementary.md
  when: CLI-assisted survey or verification is needed
goal: true
---

# Pre-task Thinking: odyssey-defensive

## Purpose

Odyssey defensive performs a systematic read-only audit of defensive-programming risk in a target module or project. Its core question is NOT "does defensive code exist", but:

> Does defensive logic transform an exception state, illegal state, or system error into an apparently-normal business state that then influences a critical business result?

The audit follows the canonical investigation path — **business-anchor driven + local program slicing + bidirectional propagation**:

```
业务关键结果 → 业务流恢复 → 反向数据追踪 → 识别防御性代码
            → 识别状态转换 → 正向传播分析 → 业务影响判断 → 风险分级与定位
```

It covers 8 defensive patterns (broad exception catch, exception swallowing, defaults, null fallback, auto-correction/clamp, silent conversion, duplicate constraints, duplicate defaults), 6 failure→value state transformations, exception semantic classification (A/B/C/D), and risk scoring `R = S × P × B × H`. Unlike other Odyssey modes, defensive is strictly read-only: it produces a severity matrix report with full propagation chains and remediation suggestions, but NEVER modifies source code. Before starting, establish the target scope, audit tier, and business anchors (critical variables + sink layering).

## Input Interpretation

Target resolution determines what gets audited:

| Input | Resolution |
|-------|-----------|
| File/dir path | Audit those files |
| `--scope <path>` | Limit scan to directory |
| `HEAD` / `staged` | Review changes in diff for defensive patterns introduced/modified |
| Phase number | state.json → changed files for that phase |
| PR number | `git diff main...HEAD` |
| Project root (default) | Full project scan |
| continuation (`-c`) | Resume latest session, jump to `current_state` |

Tier selection (default: `standard`):

| Tier | ANCHOR | SLICE | SCAN | PROPAGATE | 一致性检查 | 异常分类 |
|------|--------|-------|------|-----------|-----------|---------|
| quick | ✓ (top sinks) | ✓ (shallow) | 4 类核心 (P1-P4) | ✓ (sink only) | — | — |
| standard | ✓ | ✓ | 全 8 类 (P1-P8) | ✓ | ✓ | ✓ (A/B/C/D) |
| deep | ✓ (全量) | ✓ (deep) | 全 8 类 + 历史考古 | ✓ + cross-module | ✓ + 单位校验 | ✓ 全 4 类 |

`--sink-depth <list>` explicitly constrains propagation analysis to given sink layers (1|2|3|all). Default `all` — full three-tier sink analysis.

## Required Context

Context injection (optional, may continue if missing):

- Architecture doc: `.workflow/codebase/ARCHITECTURE.md` → module boundaries, business-semantic layer, ownership
- Wiki: `maestro search "<target keywords>"` → prior defensive audits, known failure→value patterns
- Specs: `maestro load --type spec --category coding` → known defensive-programming patterns and standards
- Coding specs: `maestro load --type spec --category review` → recurring review standards (e.g. degradation/fallback rules)
- Role knowledge: `maestro search --category coding` → pick relevant items → `maestro load --type knowhow --id`

When prior defensive-audit sessions of the same target exist, check their findings first to avoid re-reporting already-documented defensive patterns.

## Boundaries and Invariants

- **Read-only** — NEVER modify source code, configuration, or dependencies during audit. Defensive audit produces reports only. All file writes target `{run_dir}/outputs/` exclusively. Fixes route to `--mode improve` or `--mode debug`.
- **Findings require a complete propagation chain** — every finding MUST reference a specific file:line, declare its trigger pattern (P1-P8), the original failure type, the failure→value state transformation, the full forward propagation chain, and the business impact. Vague or location-only findings are not actionable. The §14 standard report format is the mandatory template.
- **Risk scoring is mandatory** — every finding MUST carry the four-dimensional score `R = S × P × B × H` (S = defensive-code severity, P = propagation range, B = business criticality, H = error-hiding degree) and a final level (Critical/High/Medium/Low per §13 thresholds). Findings without a score are rejected.
- **8-pattern coverage is mandatory (standard+)** — all scan patterns required by the selected tier MUST complete. NEVER skip a tier-required pattern silently; failures are logged as W0xx warnings. quick tier covers only the 4 core patterns (P1-P4).
- **Exception semantic classification is mandatory (standard+)** — every swallowed exception MUST be classified as A (business illegal) / B (numerical/algorithm) / C (system environment) / D (program defect) per §9. Classifying all exceptions as "computation failure" is forbidden (it is the exact anti-pattern — 异常语义坍缩).
- **Q4 signal is mandatory** — for every finding, the §18 Q4 question ("can the downstream still know the upstream error occurred?") MUST be answered. Q4 = "不能" (cannot) is a high-risk signal and MUST be explicitly flagged in the report and the completion summary.
- **No fix loop** — this mode has NO S_FIX or S_CONFIRM states. Findings are reported with remediation suggestions; actual fixes route to `--mode improve` (fix defensive defect) or `--mode debug` (root-cause).
- **Local slicing, not full propagation graph** — per §2, do NOT construct a complete whole-repo propagation graph. A_SLICE is local to each critical_var; A_PROPAGATE forwards only along the sliced chain.
- **Evidence append-only** — evidence.ndjson entries are immutable observations; modifying or deleting them is forbidden.
- **Generalize is mandatory** unless `skip_generalize == true`; prior-phase convergence is NOT a valid skip reason.

## Risk Checklist

- Is every finding anchored to `file:line` with trigger pattern, original failure type, state transformation, full propagation chain, Q4 signal, and R=S×P×B×H score? Unanchored or unscored findings are not actionable.
- Were all tier-required scan patterns (P1-P8 for standard+) attempted? Missing patterns mean incomplete coverage.
- Was exception semantic classification (A/B/C/D) applied to every swallowed exception? Treating all exceptions as one class is the anti-pattern being audited for.
- Was the Q4 signal explicitly answered for every finding reaching a sink? "Cannot detect upstream error" must be flagged.
- Did the audit remain strictly read-only? Any source modification is a violation.
- Is every discovery hit individually classified with a reason? Blanket skips are forbidden.
- Are all 3 generalization layers (syntax/semantic/structural) attempted? A single-layer quick grep does NOT satisfy the thoroughness floor.
- Did A_SLICE stay local to critical_vars instead of building a whole-repo propagation graph? Over-broad slicing violates the §2 methodology.
- Was the §14 standard report format used for every finding? Ad-hoc formats lose the propagation-chain evidence trail.
- Are duplicate constraints/defaults (P7/P8) cross-module aggregated when the tier requires it? Local-only aggregation misses the §10 consistency check.

## Gate Intent

- `anchor-identified`: at least 1 critical variable identified AND at least 1 level-1 (business-critical) sink present in `sink_layers`. Evidence phase=anchor logged. Understanding.md §2 updated. Cannot audit without a business-critical result to protect — BLOCKED if no critical vars / no level-1 sink (E002).
- `scan-complete`: all tier-required scan patterns completed (P1-P4 for quick; P1-P8 for standard; + historical archaeology for deep). Evidence phase=scan logged per pattern. Findings merged into per-pattern buckets. Understanding.md §4 + §7 updated. Tier-required pattern not attempted is BLOCKED (W001/W002 partial from tool failure is a warning).
- `propagation-verified`: every scan candidate has a `reaches_critical_sink` verdict, a failure→value state transformation type, a Q4 signal, a four-dimensional score (S/P/B/H), a risk level, and an exception classification (A/B/C/D). No-score / no-sink-verdict candidate is BLOCKED (W003 per-item needs_review acceptable only when truly undecidable).
- `report-produced`: severity matrix with §14 standard report entries (DEF-NNN / risk / location / trigger pattern / original failure type / state transformation / full propagation chain / business impact / remediation) for every finding. Summary statistics computed. Understanding.md §8 written. Session.json `audit_result` populated. Read-only invariant verified (no source modifications in session).
