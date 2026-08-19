<!-- session-mode: inherited -->

<required_reading>
@~/.maestro/workflows/run-mode.md
</required_reading>

# Workflow: Odyssey Defensive (Codex)

Codex-adapted: uses `spawn_agents_on_csv`, `request_user_input`, `update_plan`.

Core judgment (§19):

> Defensive Code + Failure Suppression + Semantic Transformation + Critical Propagation = Defensive Programming Risk

## State Chain

```
S_INTAKE → S_ANCHOR → S_SLICE → S_SCAN → S_PROPAGATE → S_REPORT → [back-half]
```

Back-half: `S_GENERALIZE → S_DISCOVER → S_RECORD → END` (see odyssey-base-codex.md).

**No S_FIX / S_CONFIRM** — this mode is read-only. Findings route to `--mode improve` (fix defensive defect) or `--mode debug` (root-cause).

---

## Boundary

**In scope:** Business-anchor identification → local business-flow recovery → backward slicing → 8-pattern defensive-node scan → failure→value transformation identification → forward propagation to business sinks → constraint/default consistency check → exception semantic classification → risk scoring → severity matrix with full propagation chains → generalize defensive patterns.
**Out of scope:** Fixing defensive defects → `--mode improve` | Root-cause debug → `--mode debug` | Multi-dimensional general review → `--mode review` | Security vulnerability audit → `--mode security` | UI visual optimization → `--mode ui`. Read-only invariant applies: NEVER modify source code.

---

## Target Resolution

| Input | Resolution |
|-------|-----------|
| File/dir path | Audit those files |
| `HEAD` / `staged` | `git diff HEAD` / `git diff --staged` — defensive patterns introduced/modified in diff |
| Phase number | state.json → changed files for that phase |
| PR number | `git diff main...HEAD` |

---

## Session Fields

```json
{ "target": "", "tier": "standard", "sink_depth": "all",
  "anchors": {"critical_vars": [], "sink_layers": {"level_1": [], "level_2": [], "level_3": []}},
  "scan_result": {"by_pattern": {}, "candidates": []},
  "propagation": {"confirmed_chains": [], "risky_sinks": [], "q4_hidden": 0},
  "audit_result": {"findings": [], "risk_matrix": {}},
  "findings_count": {},
  "generalization_stats": null }
```

---

## evidence.ndjson Phases

`anchor|slice|scan|propagate|report|discovery|decision|self-iteration`

Phase-specific extension fields:

- `anchor`: `category` (critical_var|business_sink|data_flow), `var_name`, `importance` (high|medium|low)
- `slice`: `anchor_var`, `source_chain`, `passes_default` (bool), `passes_except` (bool), `auto_corrected` (bool), `multiple_sources` (bool)
- `scan`: `pattern` (broad_catch|exception_swallow|default|null_fallback|auto_correct|silent_convert|dup_constraint|dup_default), `file`, `line`, `original_failure_type`, `snippet`
- `propagate`: `finding_ref`, `state_transform` (Exception→None|Exception→Empty|Exception→Numeric|Missing→Default|Invalid→Corrected|MultiErr→SingleState), `sink_layer` (1|2|3), `sink_name`, `reaches_critical_sink` (bool), `q4_downstream_aware` (bool), `scores` {S, P, B, H}, `risk_level` (Critical|High|Medium|Low), `exception_class` (A|B|C|D)
- `report`: `finding_ref`, `risk_level`, `remediation`

---

## phase_goals[]

| ID | Goal | done_when | phase | skip_when |
|----|------|-----------|-------|-----------|
| G1 | Anchors identified | critical_vars ≥1 AND sink_layers.level_1 ≥1 | S_ANCHOR | — |
| G2 | Slice completed | every critical_var has a source_chain | S_SLICE | — |
| G3 | Scan completed (all tier patterns) | all tier-required patterns scanned | S_SCAN | — |
| G4 | Propagation verified | every candidate has reaches_critical_sink + scores + exception_class | S_PROPAGATE | — |
| G5 | Report produced | risk_matrix with full propagation chains + scores | S_REPORT | — |
| G6 | Pattern generalized | patterns[] ≥1 | S_GENERALIZE | skip_generalize |
| G7 | Discoveries triaged | all hits classified | S_DISCOVER | skip_generalize |
| G8 | Learnings persisted | spec entries or no actionable | S_RECORD | — |

`update_plan({ plan: [{ step: "G1: anchor", status: "pending" }, { step: "G2: slice", status: "pending" }, { step: "G3: scan", status: "pending" }, { step: "G4: propagate", status: "pending" }, { step: "G5: report", status: "pending" }, { step: "G6: generalize", status: "pending" }, { step: "G7: discover", status: "pending" }, { step: "G8: record", status: "pending" }] })`（按上方 gate 表初始化 G1-G8 步骤清单）

---

## understanding.md — 9 Sections

1. Target & Scope & Tier
2. Business Anchors (critical-variable table + sink layering)
3. Local Business Flow (three-layer map: business-semantic ↔ software-component ↔ code-implementation)
4. Defensive Nodes (8-pattern scan results, bucketed by pattern)
5. Failure→Value Transformations (§7 six transformation types)
6. Propagation Chains (forward chains + sink-hit verdicts + Q4 signals)
7. Constraint & Default Consistency (§10 cross-module aggregation)
8. Risk Matrix & Exception Classification (R=S×P×B×H scores + A/B/C/D + §14 standard report entries)
9. Generalization & Discoveries & Learnings

Specs: `maestro load --type spec --category coding` (defensive-programming patterns).

---

## State Machine — Transitions

```
S_ANCHOR     → S_SLICE       : complete (anchors identified)
S_SLICE      → S_SCAN        : complete (source chains traced)
S_SCAN       → S_PROPAGATE   : all tier patterns scanned
S_PROPAGATE  → S_REPORT      : all candidates scored + sink verdict
S_REPORT     → S_GENERALIZE  : report produced, !skip_generalize
S_REPORT     → S_RECORD      : report produced, skip_generalize
```

Discover routes: sibling module with same defensive anti-pattern → S_SCAN (re-scan expanded scope, loops < max_loops); newly discovered critical propagation chain → evidence phase=decision, recommend `--mode improve`.

---

## Actions

### A_INTAKE extra

Tier resolution: parse `--tier` (default: standard) and `--sink-depth` (default: all). Record tier + applicable scan patterns + sink-layer focus to `session.json`.

### A_ANCHOR

(§3 step — determine business-critical anchors.)

Generate `anchors.csv` with one row per candidate critical variable (discovered via architecture doc + entry-point scan):

```csv
id,variable,meaning,source,usage_location,importance,sink_layer,target,deps,status,findings_json,error
"1","objective","优化目标","仿真结果","optimizer","high","1","{target}","","","",""
"2","mass","质量","仿真结果","objective/constraint","high","1","{target}","","","",""
"3","log_path","日志路径","配置","logging","low","3","{target}","","","",""
```

```javascript
spawn_agents_on_csv({
  csv_path: `${sessionFolder}/anchors.csv`,
  id_column: "id",
  instruction: "You are identifying business-critical anchors for a defensive-programming audit. Read 'variable', 'meaning', 'source', 'usage_location' columns. Classify 'importance' (high|medium|low) by whether an error in this variable would change the final decision. Assign 'sink_layer' (1=business decision/objective/constraint/control/financial/security; 2=computation result/report/API response/cache; 3=log/UI/temp/debug). Return findings_json as JSON: [{variable, importance, sink_layer, justification}].",
  max_concurrency: 4,
  max_runtime_seconds: 3600,
  output_csv_path: `${sessionFolder}/anchors-results.csv`,
  output_schema: { id, status: ["completed"|"failed"], findings_json, error }
})
```

Aggregate results → build critical-variable table + sink layering (§8 three-tier):
- **Level 1 (high risk):** business decision / control command / objective function / constraint check / model training / optimization algorithm / core DB state / financial amount / security permission.
- **Level 2 (medium risk):** computation result / report output / intermediate model / API response / cache.
- **Level 3 (low risk):** log / UI display / temp file / debug info.

Write `anchors.json` (critical_vars + sink_layers) + evidence phase=anchor. Update §2. Mark G1. `update_plan`（G1 → completed）

**GATE: anchor-identified** — critical_vars ≥1 AND sink_layers.level_1 ≥1. Evidence phase=anchor logged. §2 updated. BLOCKED if no critical vars / no level-1 sink (E002).

Commit: `"odyssey-defensive({slug}): ANCHOR — {N} anchors, {M} level-1 sinks"`

### A_SLICE

(§4-§5 — recover local business flow + backward slice from critical results.)

`maestro delegate --role analyze --mode analysis` (`run_in_background: true`):
- PURPOSE: for each critical_var, recover the three-layer business-flow map (business-semantic ↔ software-component ↔ code-implementation) and backward-slice its source, answering the 7 questions (origin / default / type conversion / exception handling / auto-correction / multiple sources / intermediate-state substitution).
- EXPECTED: JSON `{critical_var, three_layer_map, source_chain: [{step, passes_default, passes_except, auto_corrected, multiple_sources}], answers_to_7_questions}`

Write evidence phase=slice (one source_chain per anchor) + §3 three-layer map. Mark G2. `update_plan`（G2 → completed）

**GATE: slice-complete** — every critical_var has a source_chain; §3 three-layer map written. Slice failure logged as W (tool unavailable) does NOT BLOCK — SCAN results may back-fill the chain.

Commit: `"odyssey-defensive({slug}): SLICE — {N} chains traced"`

### A_SCAN

(§6 — scan defensive-code nodes. Full 8-pattern parallel agents; quick tier covers P1-P4 only.)

Generate `defensive-patterns.csv` with 8 pattern rows:

```csv
id,pattern,focus,scan_signals,target,deps,status,findings_json,error
"1","broad_catch","Broad/bare exception clauses that collapse multiple failure types into one handler","except: ; except Exception:","{target}","","","",""
"2","exception_swallow","Exception handlers that discard the error and return a normal-looking value (pass/None/{}/0)","except ...: pass ; except ...: return None ; except ...: return {} ; except ...: return 0","{target}","","","",""
"3","default","Default-value accessors that mask missing data as a valid value",".get(k, v) ; getattr(o, x, d) ; v or default","{target}","","","",""
"4","null_fallback","None-check early returns that propagate None/empty downstream","if x is None: return None ; if x is None: return {}","{target}","","","",""
"5","auto_correct","Clamp/min-max auto-correction that converts invalid values into plausible ones","max(x, lo) ; min(x, hi) ; min(max(x, lo), hi)","{target}","","","",""
"6","silent_convert","Try/except type conversion that falls back to a numeric on failure","try: x = float(x) except: x = 0","{target}","","","",""
"7","dup_constraint","Cross-module same variable with divergent constraints","grep same var name across modules ; compare < <= >= > thresholds","{target}","","","",""
"8","dup_default","Cross-module same config with divergent defaults","grep same config key across modules ; compare default values (e.g. temperature=25/20/293.15)","{target}","","","",""
```

```javascript
spawn_agents_on_csv({
  csv_path: `${sessionFolder}/defensive-patterns.csv`,
  id_column: "id",
  instruction: "You are scanning code for a specific defensive-programming pattern. Read 'pattern' and 'scan_signals' columns for your detection target. Read 'target' for the files to scan. Use AST analysis (preferred) or Grep (fallback) with the scan_signals. For P7/P8, aggregate cross-module: grep the same variable/config name across the whole repo and compare constraints/defaults. Return findings_json as a JSON array: [{pattern, file, line, original_failure_type, snippet, surrounding_context}]. For broad_catch/exception_swallow, infer original_failure_type from the try-body. For dup_constraint/dup_default, list every divergent location.",
  max_concurrency: 8,
  max_runtime_seconds: 3600,
  output_csv_path: `${sessionFolder}/defensive-patterns-results.csv`,
  output_schema: { id, status: ["completed"|"failed"], findings_json, error }
})
```

For quick tier, run only rows 1-4 (P1-P4).

Merge all findings → evidence phase=scan. Write `scan_result.by_pattern` + `scan_result.candidates`. Update §4 (per-pattern buckets) + §7 (consistency). Mark G3. `update_plan`（G3 → completed）

**GATE: scan-complete** — all tier-required scan patterns completed with structured findings, merged per-pattern. Evidence phase=scan logged per pattern. Tier-required pattern not attempted is BLOCKED (W001 AST unavailable / W002 cross-module aggregation failure are warnings, not blocks).

Commit: `"odyssey-defensive({slug}): SCAN — {tier} tier, {N} candidates across {M} patterns"`

### A_PROPAGATE

(§7-§10 — the core phase. Identify failure→value transformations → forward propagation → sink verdict → consistency → exception classification → risk scoring.)

Generate `propagation.csv` with one row per scan candidate:

```csv
id,finding_ref,defensive_node,state_transform_candidates,sink_candidates,sink_layers,target,deps,status,findings_json,error
"1","P2:simulation_adapter.py:128","except Exception → return {}","Exception→Empty;Exception→Numeric","objective();optimizer()","1","{target}","","","",""
"2","P3:result_parser.py:45","result.get('mass', 0)","Missing→Default","objective()","1","{target}","","","",""
```

```javascript
spawn_agents_on_csv({
  csv_path: `${sessionFolder}/propagation.csv`,
  id_column: "id",
  instruction: "You are propagating a defensive node forward to determine business impact. Read 'defensive_node', 'state_transform_candidates', 'sink_candidates', 'sink_layers'. For each: (1) identify the failure→value state transformation (Exception→None | Exception→Empty | Exception→Numeric | Missing→Default | Invalid→Corrected | MultiErr→SingleState). (2) forward-propagate: does it reach a Critical Business Sink? (3) answer Q4: can the downstream still know the upstream error occurred? (true/false). (4) classify the swallowed exception: A=business illegal, B=numerical/algorithm, C=system environment, D=program defect. (5) score R=S×P×B×H: S=defensive-code severity, P=propagation range, B=business criticality (level-1 sink=high), H=error-hiding degree (Q4 false=high). (6) assign risk_level: Critical=directly alters critical decision; High=hidden error enters core computation; Medium=limited unreasonable fallback; Low=near-zero critical impact. Only reaches_critical_sink=true may be High+. Return findings_json: [{finding_ref, state_transform, sink_layer, sink_name, reaches_critical_sink, q4_downstream_aware, scores:{S,P,B,H}, risk_level, exception_class}].",
  max_concurrency: 4,
  max_runtime_seconds: 3600,
  output_csv_path: `${sessionFolder}/propagation-results.csv`,
  output_schema: { id, status: ["completed"|"failed"], findings_json, error }
})
```

Cross-module constraint/default consistency check (§10): for P7/P8 candidates, verify units / business meaning / duplication / conflict across locations; flag `Constraint Inconsistency` / `Default Inconsistency`.

Exception semantic classification reference (§9):

| Class | Examples | Recommended |
|-------|----------|-------------|
| A — business illegal | design var out-of-bounds, illegal input, infeasible, rule conflict | reject / penalty / retry |
| B — numerical/algorithm | SolverConvergenceError, NumericalOverflow, SingularMatrix | retry / penalty / fallback solver |
| C — system environment | LicenseError, FileNotFoundError, PermissionError, OutOfMemory | NEVER silent degrade |
| D — program defect | TypeError, AttributeError, KeyError, IndexError | expose, do NOT convert to normal |

Risk-level mapping (§13): Critical = directly alters a critical business decision; High = hidden error enters core computation; Medium = limited unreasonable fallback/default/duplicate constraint; Low = near-zero critical impact (temp-file cleanup failure, log write failure). Risk-scoring rule: only `reaches_critical_sink == true` may be High+; findings reaching only level-3 sinks default to Low.

**Q4 signal** (§18): for every finding reaching a sink, answer "can the downstream still know the upstream error occurred?" — `不能` (cannot) = high-risk signal, MUST be flagged in the report and the completion summary `q4_hidden` count.

Write `propagation.confirmed_chains` + `propagation.risky_sinks` + `propagation.q4_hidden` count + evidence phase=propagate. Update §5 / §6 / §7 / §8. Mark G4. `update_plan`（G4 → completed）

**GATE: propagation-verified** — every scan candidate has `reaches_critical_sink` verdict + failure→value transformation type + Q4 signal + four-dimensional score (S/P/B/H) + risk level + exception class (A/B/C/D). No-score / no-sink-verdict candidate is BLOCKED (W003 per-item `needs_review` acceptable only when truly undecidable, with a per-item reason).

Commit: `"odyssey-defensive({slug}): PROPAGATE — {N} chains, {M} reach critical sink, {K} Q4-hidden"`

### A_REPORT

(§12-§14 — risk scoring formalized + standard report format. Local aggregation, no parallel agents.)

1. Produce a finding per candidate using the **§14 standard report format**:

   ```
   DEF-NNN
   Risk level:        Critical | High | Medium | Low
   Defensive location: file:line
   Trigger pattern:   broad_catch | exception_swallow | default | ...
   Original failure:  SimulationSystemError
   State transform:  Exception → {} → mass = 0
   Full propagation:  solver.run() → except Exception → return {} → result.get("mass", 0) → objective() → optimizer
   Business impact:   simulation error converted to mass=0; optimizer may pick the failed design as optimal.
   Remediation:       distinguish DesignInfeasibleError (penalty) vs SimulationSystemError (raise).
   ```

2. Build the **severity matrix** (Critical / High / Medium / Low) with file:line references, full propagation chains, Q4 signals, and remediation for every finding.
3. Compute summary statistics: counts per level, per pattern, per exception class, Q4-hidden total.
4. Write §8 (risk matrix + exception classification + standard report entries) + `session.json.audit_result` + `session.json.findings_count`. Evidence phase=report. Mark G5. `update_plan`（G5 → completed）

**GATE: report-produced** — severity matrix with §14 standard report entries for every finding; summary statistics computed; §8 written; `audit_result` populated; read-only invariant verified (zero source modifications in session).

Commit: `"odyssey-defensive({slug}): REPORT — {C}C/{H}H/{M}M/{L}L matrix"`

---

## Generalize Source

Critical/High findings that propagate to a level-1 sink + cross-module duplicate defensive patterns (dup_constraint / dup_default) + recurring failure→value transformation signatures.

**Discover routing:** sibling module with the same defensive anti-pattern → S_SCAN (re-scan expanded scope); newly discovered critical propagation chain → evidence phase=decision, recommend `--mode improve`; needs root-cause → `--mode debug`.

---

## Knowledge Persistence (§9)

Follow-up = governed candidate staging, NEVER a direct corpus write: `maestro knowledge stage spec "<title>" --content-file <path|-> --run {run_id} --category <cat>` (stage BEFORE seal; promote only after seal with a fresh receipt).

| Category | Content | Follow-up |
|----------|---------|-----------|
| Failure→Value transformation pattern | transformation signature + trigger + detection pattern + fix template | `stage spec → coding` |
| 异常语义坍缩 (exception semantic collapse) | multi-exception → single-state signature + business consequence + detection | `stage spec → coding` |
| Constraint/default inconsistency | variable + per-location values + unit/meaning conflict + resolution | `stage spec → arch` |
| Critical propagation chain | sink + chain + hiding mechanism + remediation strategy | `stage spec → debug` |

---

## Completion Summary

```
--- DEFENSIVE ODYSSEY COMPLETE ---
Target:      {target}
Tier:        {tier}
Anchors:     {N} critical vars, {M} level-1 sinks
Patterns:    P1:{n1} P2:{n2} P3:{n3} P4:{n4} P5:{n5} P6:{n6} P7:{n7} P8:{n8}
Candidates:  {N} defensive nodes
Chains:      {N} propagated, {M} reach critical sink
Risk:        {C}C / {H}H / {M}M / {L}L
Q4-hidden:   {N} findings where downstream cannot detect upstream error
Exception:   A:{a} B:{b} C:{c} D:{d}
Patterns:    {count} ({by_layer})
Scan hits:   {total} ({cross_layer_confirmed} confirmed)
Issues:      {N} created
Decisions:   {N} resolved, {M} pending, {K} deferred
Learnings:   {N} persisted
Self-iter:   {N} rounds across {M} stages
Cross-loops: {N}
Goals:       {done}/{total} ({skipped} skipped)
---
```

---

## `-y` Decision Points

| Decision Point | Normal | `-y` |
|---------------|--------|------|
| A_ANCHOR critical-variable importance | `request_user_input` | auto-classify by semantic layer |
| A_SCAN false-positive dismissal | `request_user_input` | auto-dismiss with evidence `deferred` |
| A_PROPAGATE sink-hit ambiguity | `request_user_input` | auto-mark worst-case High |
| A_REPORT risk-level downgrade | `request_user_input` | auto with documented rationale |
| A_DISCOVER routing | `request_user_input` | auto create issue + recommend improve |
| Ambiguous items | `request_user_input` | all `deferred` |

---

## Mode-Specific Phase Gates

- **Anchor gate** (S_ANCHOR): critical_vars ≥1 AND level-1 sink present. Evidence phase=anchor logged. §2 updated. BLOCKED if no critical vars / no level-1 sink.
- **Scan gate** (S_SCAN): all tier-required patterns completed. Per-pattern evidence logged. Findings merged per-pattern. Tier-required pattern missing is BLOCKED (W001/W002 partial allowed).
- **Propagation gate** (S_PROPAGATE): every candidate has reaches_critical_sink + four-dimensional score + state transformation + Q4 signal + exception class. No-score candidate = BLOCKED or per-item W003.
- **Report gate** (S_REPORT): severity matrix with §14 standard report entries + full propagation chains + remediation. §8 written. Read-only invariant verified (zero source modifications).

---

## Error Codes (defensive-specific)

| Code | Severity | Condition | Recovery |
|------|----------|-----------|----------|
| E001 | error | No target / scope provided | Provide target or -c |
| E002 | error | No critical vars / no level-1 sink found | Verify target has business-critical output |
| W001 | warning | AST tool unavailable | Fall back to Grep, note coverage gap |
| W002 | warning | Cross-module aggregation failed (no symbol table) | Local-only constraint/default check, note limitation |
| W003 | warning | Candidate undecidable for sink/score | Per-item `needs_review`, do not BLOCK |
| W004 | warning | Generalization 0 hits after full 3-layer scan | Advance to S_RECORD |
| W005 | warning | Pending decisions | Filter evidence phase=decision |

---

## Success Criteria (defensive-specific)

- [ ] Target resolved; tier + sink-depth determined; session + 4 output files + prior knowledge searched
- [ ] S_ANCHOR: critical-variable table + sink layering (§2) with ≥1 level-1 sink
- [ ] S_SLICE: per-critical-var source_chain + three-layer business-flow map (§3)
- [ ] S_SCAN: all tier-required 8 patterns scanned, bucketed per-pattern (§4/§7)
- [ ] S_PROPAGATE: every candidate has state transformation + sink verdict + Q4 signal + four-dimensional score + exception class (§5/§6/§8)
- [ ] S_REPORT: severity matrix + full propagation chains + remediation, in §14 standard report format (§8)
- [ ] understanding.md 9 sections written progressively (§1–§9)
- [ ] Read-only invariant maintained — zero source code modifications
- [ ] Multi-layer generalization + discovery triage (unless --skip-generalize)
- [ ] phase_goals derived, tracked, and hardened-audited; goal_mode injected via prepare goal:true
- [ ] Session resumable via -c; completion summary emitted

---

## Next Step Routing (defensive-specific)

| Condition | Next |
|-----------|------|
| Critical/High findings need fix | `$maestro-odyssey <finding> --mode improve` |
| Root-cause debug needed | `$maestro-odyssey <finding> --mode debug` |
| Deeper audit tier needed | `$maestro-odyssey <target> --mode defensive --tier deep` |
| Discovery issues created | `$maestro-issue list --source defensive-odyssey` |
| Document pattern | `$maestro-learn decompose <module>` |
| Second opinion | `$maestro-learn consult <understanding.md>` |
| Related question | `$maestro-learn investigate "<question>"` |
| Defensive pattern to persist | `stage spec → coding` |
| Pending decisions | Filter evidence phase=decision status=pending |
