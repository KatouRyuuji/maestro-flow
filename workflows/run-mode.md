<!-- session-mode: inherited -->
# Canonical Run Mode

This file is the single Session/Run lifecycle contract for every command, workflow, and stateful skill that declares `session-mode: run`.

Lifecycle verbs: **prepare → start/create → brief → check → done/complete**.

Human-facing usage should prefer `session create`, `session done`, and `session meta update`. The lower-level `run create` / `run complete` verbs remain the stable machine protocol and advanced compatibility surface.

## Authority and Reuse

- A Session is a durable **topic grouping/index**. It groups related Runs; it is not an execution result and historical similarity never grants Session mutation authority.
- A Run is one execution attempt. Its sealed outputs remain immutable and may be consumed by later Runs in the **same Session** through the canonical `upstream`/Artifact Registry map.
- Reuse references eligible sealed outputs in place. Normal routing does not fork, import, copy, resume, or resolve Sessions to obtain prior work.
- Historical similarity is read-only evidence. It may explain potentially related work, but it never selects a Session, binds an output, creates a Run, or becomes a next action.
- Explicit `--session` is the norm for Session lifecycle calls — `session status|check|evidence|seal` take positional `{session_id}`; `session next|done|decide|meta update` take `--session {session_id}`. Omitting it silently falls back to `active_session_id` or the unique running Session; machine callers MUST pass it explicitly, because fallback resolution MAY select a sealed or unrelated Session.

## Prepare (optional, read-only)

- `maestro run prepare <step>` resolves what a step would consume and produce without side effects.
- `maestro run prepare <step> --session <id>` also returns read-only `session_guidance`: current chain step, next pending step, open decisions, the knowledge candidate backlog, reminders, and the suggested next command.
- Read-only and idempotent — it never allocates a Session or creates directories.
- Use it to preview upstream availability and the derived artifact contract before committing to a Run.

## Start or Continue a Run

> **Dispatched by an orchestrator?** When `maestro session next` invokes you (especially with `--inline-brief`), the Run is already created and its `run_id` / `run_dir` / `upstream` / guidance are injected in the birth packet — use them directly and do **NOT** call `maestro run create` (a second create mints an empty duplicate Run). The steps below apply only to a command starting a Run on its own.
>
> **Inline brief**: `maestro session next --inline-brief --json` includes the full Resume Packet inline — guidance, execution contract, and continuity context. The executor uses this data directly in the normal forward flow. `maestro run brief <run_id>` remains available for **re-attach/backtracking** only (executor crash recovery, context overflow, or manual inspection).

1. Read the caller frontmatter `name` as `<command-name>`.
2. **Compose a session slug** — `YYYYMMDD-{command}-{topic}` where `{topic}` is a 1–3 word ASCII-only slug derived from the intent (e.g. `20260715-odyssey-jwt-auth`). NEVER let the runtime auto-generate from a Chinese or long intent string.
3. Run `maestro session start "<short intent phrase>" --chain <command-name> --session <slug> [--arg "<command input>"]` before domain work.
   - `--session`: the slug from step 2 (explicit, ASCII-only, ≤64 chars).
   - Intent text is **Session metadata only** — a short human-readable phrase (1 sentence) describing the goal. It may contain Chinese, is NOT used as the session ID, does not enter `Run input.args`, and does not satisfy the command contract or `argument-hint`.
   - Command inputs: when the command contract or `argument-hint` requires them, pass each value with repeatable `--arg <value>`. If a legacy caller needs raw positional passthrough after `--`, use the lower-level `maestro run create <command-name> ... -- <args...>` compatibility verb.
4. The runtime resolves the Session in this order: an explicit compatible `--session`, an unambiguous canonical topic match, otherwise a newly allocated topic Session. Paused or historical similarity is read-only and never authorizes selection, resume, or mutation.
5. Retain the returned `session_id`, `run_id`, `run_dir`, and `upstream`. Do not locate Sessions or artifacts with glob, mtime, directory ordering, or hidden command folders.
6. `maestro run brief <run_id>` returns the `brief-result/1.1` Resume Packet — same-Session sealed artifacts, the authoritative upstream map, open decisions, and a compact `knowledge_context` reconciliation card — for continuing an existing Run. Protocol readers retain `brief-result/1.0` compatibility.

**Session slug examples:**
```
# ✅ correct — mode-qualified command name resolves the mode's own contract
maestro session start "完成 session-run-todo-goal 集成计划" --chain odyssey-planex --session 20260715-odyssey-planex-todo-integration --arg "完成 session-run-todo-goal 集成计划"
maestro session start "理解认证流程" --chain learn --session 20260715-learn-auth-flow --arg "follow src/auth/"
maestro session start "修复 README 拼写" --chain companion --session 20260715-companion-fix-readme --arg "修复 README 拼写"

# ❌ wrong — no --session, Chinese intent generates unreadable ID
maestro run create odyssey-planex --intent "完成 docs/session-run-todo-goal-integration-plan.md 的 P0-P6" --arg "完成 docs/session-run-todo-goal-integration-plan.md 的 P0-P6"
# ❌ wrong — --intent is metadata and does not satisfy learn's required command arguments
maestro run create learn --session 20260715-learn-auth-flow --intent "follow src/auth/"
# ❌ wrong — mode-less command name (empty contract, ambiguous workflow resolution)
maestro run create odyssey --session 20260715-odyssey-planex-todo -- --mode planex
```

## Artifact Boundary

- Every formal artifact (including evidence-role artifacts declared in the prepare contract) MUST be written under `{run_dir}/outputs/`.
- A Run may validly produce no formal artifact. Only contract v2/v2.1 outputs declared with `required: true`, or an explicit required+blocking exit gate, make an artifact mandatory. Legacy v1 `produces` entries and `required: false` outputs are descriptive/optional and MUST NOT block completion when absent.
- Every new formal JSON artifact MUST contain a complete top-level `_meta` object: `{"_meta":{"kind":"<stable-kind>","schema":"<stable-kind>/1.0"},...}`. `kind` and `schema` are required together; `role` and `alias` are optional.
- A legacy JSON artifact with no `_meta` remains readable through contract/filename inference. Never write a partial, null, or non-object `_meta`; strict validation rejects the artifact and blocks Run completion.
- Human-readable synthesis and handoff MUST be written to `{run_dir}/report.md`.
- report.md frontmatter keys are a fixed whitelist (`verdict`, `summary`, `constraints`, `decisions`, `concerns`, `next`, `details`); every risk, caveat, or open question MUST go into `concerns`. Keys outside the whitelist are silently dropped and never reach the handoff, the next brief's signals, or a `done-with-concerns` verdict.
- report.md frontmatter `verdict` uses the report-layer vocabulary `ready|ready_with_concerns|blocked|failed` (default `ready`) — write these canonical tokens. The chain-advance tokens (`done|done-with-concerns|needs-retry`) are also accepted and mapped internally (done→ready, done-with-concerns→ready_with_concerns, needs-retry→failed), so a `verdict: done` line never hard-fails the frontmatter; prefer the canonical vocabulary anyway. This mirrors the reverse mapping on the chain side: `session done` / `run complete --verdict` take `done|done-with-concerns|needs-retry|blocked` and additionally accept the ready-vocabulary tokens as aliases (ready→done, ready_with_concerns→done-with-concerns, failed→needs-retry).
- `constraints`/`decisions` items are `{ text, status }` objects — `id` is optional and auto-derived by the runtime (`C-001`/`D-001`…), never write it yourself. `next` items are `{ command, reason, needs }` (reason/needs optional). Block-style YAML is preferred; quote text values containing commas:

```yaml
---
verdict: ready
summary: "one-line outcome"
constraints:
  - text: "adopted constraint"
    status: locked
decisions:
  - text: "accepted decision"
    status: accepted
concerns:
  - "risk or caveat"
next:
  - command: <next-command>
    reason: "why next"
    needs: [<artifact-ref>]
details: {}
---
```
- Informal worker traces and intermediate logs may use `{run_dir}/evidence/` (lazily created, not gate-checked).
- Temporary computation may use `{run_dir}/work/`; it is never an artifact and is never indexed.
- `.workflow/sessions/{session_id}/` is the only Session authority. Do not create private command Session directories or a second status/manifest truth source. Team message buses may exist only as transient coordination and never contain formal artifacts.
- Protocol files (`sessions/<sid>/session.json`, `run.json`, `artifacts.json`) are runtime-owned and MUST NOT be edited directly. Do not confuse the protocol `sessions/<sid>/session.json` with a workflow artifact named `outputs/session.json` (e.g. odyssey modes) — the latter is a workflow-owned formal artifact registered by `session done`.
- Consume upstream only from the `upstream` map returned by `maestro session start` / `maestro session create`.

## Knowledge Reconciliation

- Search results and automatic prompt injection are **exposure only**. They may increase global impression statistics, but they never prove that a Run read, cited, validated, or contradicted an entry.
- Explicit `maestro load` / wiki loads are recorded as `consumed` through tiered routing: the unique active Run, then an unambiguous Session identity (host lease / single live hook channel), else the global usage ledger with a warning — attribution never blocks loading. Attribute search hits explicitly with `maestro knowledge record <knowledge-ids...> --signal consumed|cited|validated|contradicted --source search|load|manual [--run {run_id} | --session <session-id> | --channel <name>]` — pure ledger attribution that never stages a candidate (use `stage --signal` only when a candidate is intended). Record stronger relations by stable ID with `maestro knowledge stage <target> "<title>" --content-file <path|-> --run {run_id} --signal cited|validated|contradicted --signal-ids <comma-separated ids>`. Knowledge IDs are validated against the wiki index; unknown IDs are rejected unless `--allow-unknown`.
- Put accepted decisions and locked constraints in `report.md` frontmatter. Only reusable, prescriptive content belongs there — rules future work must follow. NEVER write execution-state narration as decisions/constraints (read-only declarations, worktree or audit-process observations, missing-file notes, routing memos such as "Read-only audit; preserve the existing dirty worktree" or "Debug investigation remained read-only"); seal auto-stages every accepted decision / locked constraint as a corpus candidate, so state narration pollutes the knowledge base. `session done` converts them into pending spec candidates in the Run's `knowledge-delta.json`; it does not write project specs. Session-origin candidates (staged with `--session`) live in the Session-level `knowledge-delta.json`, and sealing the Session refreshes the session reconciliation receipt automatically (best-effort). Cross-origin candidates sharing one ID are represented by the run-source copy in the promotion plan, with completion written back to both ledgers.
- **Staging Quality Bar** — stage content only if future work can directly reuse it and at least one holds: (a) a pitfall warning ("when doing X, watch out for Y because Z" — non-obvious failure mode plus prevention); (b) a failure lesson (what failed, root cause, what worked instead); (c) a non-trivial trade-off (why A over B, with the constraints/context); (d) a newly established prescriptive constraint (spec). NEVER stage: process notes ("did X", "produced document Y"); re-descriptions of existing project patterns that code/config already documents; trivial or obvious operations; raw traces (tool outputs, log or error fragments) — distill traces into a lesson first, discard when nothing reusable can be distilled. **Zero candidates is a legitimate outcome** — never manufacture candidates to justify the pipeline.
- Stage reusable recipes, pitfalls, or other explicit candidates before completion with `maestro knowledge stage spec|knowhow "<title>" --content-file <path|-> --run {run_id} [--category <category>]`; write content to a temp file (or stdin `-`) — never inline as a positional argument: special sequences misparse and shift later arguments. Inside a Run always pass `--run {run_id}` explicitly (identity tiers — channel/lease/narrowed scan/synthetic Session — are for callers without a Run). Routine Run completion MUST NOT call `maestro spec add` or `maestro knowhow add` directly.
- `maestro run check` reconciles every staged/report-derived candidate against active Spec and Knowhow through three bounded lanes: exact identity, diversified semantic neighborhood, and recorded/KG association. The receipt classifies `unique`, duplicates, extension/relation, conflict, and supersession; search exposure/popularity never changes its relevance or canonical choice.
- Completion requires a fresh `knowledge-reconciliation/1.0` fence for both the candidate snapshot and project corpus. Exact same-store duplicates are automatically suppressed. Semantic duplicates, extensions, conflicts, and supersession candidates remain reviewable and may be sealed, but cannot be promoted until explicitly resolved with `maestro knowledge review {session_id} --resolve <candidate-id> --as <choice> [--target <knowledge-id>] --reason "<reason>"`.
- Completion returns a `knowledge-candidate-receipt/1.0` with the exact staged candidate IDs and reconciliation summary. Use `maestro knowledge review {session_id}` for evidence-backed matches and copyable next commands; add `--refresh` only for missing/stale receipts. `--json` additionally reports per-source totals (`input_totals_by_source`) and knowledge-id detail (`inputs`) for the Session — use them to verify what was searched, loaded, and staged. Before promoting, refresh receipts with `maestro knowledge review {session_id} --refresh` (TOCTOU fence). Promotion gates are dual-source and equally strong: run-source candidates require their source Runs sealed with fresh receipts; session-source candidates require the Session sealed + a fresh session receipt + non-empty `--evidence` given at stage. Promote selected IDs with repeatable `maestro knowledge promote {session_id} --candidate <candidate-id>`. `--all` promotes all eligible pending candidates (observed-only emits a warning); it skips unresolved and suppressed candidates. A confirmed `supersede` resolution lets promotion create the successor and link the evolution chain atomically.
- Knowledge pruning is separate maintenance: `maestro knowledge audit --prune` emits a deterministic plan, and `--apply` backs up files before soft deprecation/supersession. Usage frequency alone never prunes, and the workflow never physically deletes knowledge.
- Promotion and sealing: run-source candidates require only their source Runs sealed — the whole Session need not be sealed; **session-source candidates require the Session itself sealed** (corpus writes presuppose immutable deltas). A stale Session left running/paused blocks promotion of its session-source candidates — seal the Session to release that backlog. Seal never silently promotes or discards a backlog; pending items stay visible in prepare/seal guidance and remain durable after seal.

## Chain Effects and Proposals

- Every Session uses the same ordered chain. There is no static/dynamic Session type and no strategy promotion; whether a step leaves the remaining chain unchanged or proposes adaptation is decided by that step's Skill contract and output.
- `execution_contract.orchestration.chain_effects` is the Run's complete mutation capability set. An empty set means the Skill cannot propose chain changes. Capability does not require a proposal on every Run.
- A capable Skill may write `outputs/chain-proposal.json` with `_meta.kind=chain-proposal` and `_meta.schema=chain-proposal/1.0`. It may only contain operations allowed by the execution contract. The executor writes the artifact, runs `run check`, and returns; it never edits Session state or invokes chain mutation commands.
- The orchestrator owns proposal disposition after a clean `run check`: accept, reject, or request revision. Accept calls `maestro session done ... --apply-proposal`, which applies the single discovered valid proposal atomically with completion; reject omits `--apply-proposal`; revision re-attaches the same Run and asks the Skill to replace its proposal, then checks again. The path-based `--chain-proposal` option is legacy compatibility only.
- Interactive mode asks before accepting. Under an explicit user-provided `-y`, an orchestrator may auto-accept only validated `insert`/`replace`/`skip` operations that stay in the pending tail, remain within its declared budget, and align with the Session intent. `decide`, escalation, ambiguous intent/boundary changes, or low-confidence proposals are rejected or paused for review according to the command policy; `-y` never invents authority.
- `session done` seals the Run, applies the selected proposal, records the receipt, and advances the current step in one transition. Its next action remains `suggest_only`; only an explicit `session next` allocates the following chain-bound Run.

## Completion

1. Run `maestro run check {run_id}` and repair any blocking artifact or exit gate it reports.
2. When every gate is clean, `run check` emits a `finish` checklist — handoff frontmatter, knowledge relation/candidate staging, reconciliation review/annotation, verdict choice, plus norms declared by the workflow. Work through it before completing; it is prompt-layer guidance, never a blocking gate. Unresolved reconciliation is visible in the receipt and blocks later promotion, not Run sealing.
3. Run `maestro session done {run_id} --session {session_id}`. The artifact gate is derived from the Run contract and evaluated automatically. Completion atomically seals the Run and stages handoff-derived knowledge candidates, returning their receipt; it never promotes project knowledge, executes the suggested next action, or creates another Run. `maestro run complete {run_id}` remains the machine-compatible spelling.
   - **Artifact registration and state updates are performed by `session done`** — it registers `outputs/` into `artifacts.json` and writes Session state. A workflow never registers artifacts itself and MUST NOT restate this; writing the files under `{run_dir}/outputs/` is the whole of its obligation.
   - `done` / `done-with-concerns` enforce required success artifacts and exit gates.
   - `needs-retry` / `blocked` close the failed attempt without requiring success artifacts; missing/invalid outputs remain diagnostic evidence, not a blocker to retrying or pausing the chain.
4. The caller explicitly invokes `maestro session next --session {session_id}` only after accepting the suggestion and its preconditions. `session next` is the sole normal allocator for the next chain-bound Run.
   - `suggest_only` describes Runtime passivity; it is not an implicit user-confirmation gate. For an already confirmed Session, the orchestrator accepts `continuation.authority=automatic` itself, executes the command in the same turn, and reads the next receipt.
5. Read the seal receipt returned by `session done` (or `run complete --json`). If it contains candidate IDs or reconciliation warnings, apply the **Review Presentation Protocol**: present each candidate that needs a disposition with its title, content summary, evidence anchors, evidence-backed matches (id + title), and your recommended disposition (unique/duplicate/related/conflict/supersede + target) with a one-line rationale; collect the user's per-candidate decisions, then execute the resolution with the user's reasons. The user decides; the agent reads, presents, and executes — never hand the user a raw command as the whole task. Do not rewrite the same facts directly into spec/knowhow.
   - **Happy path（裁决入口）**: `maestro knowledge promote {session_id} --resolve <candidate-id> --as <choice> [--target <knowledge-id>] --reason "<reason>"` — the TOCTOU freshness fence, candidate resolution, and promotion complete in one call. `promote` 内联 `--resolve` 是 happy path 裁决入口（promote inline `--resolve` is the happy-path adjudication entry）.
   - **Fallback（回退面）**: `maestro knowledge review {session_id} --resolve <candidate-id> --as <choice> [--target <knowledge-id>] --reason "<reason>"` remains the compatibility fallback for missing/stale receipt repair (`--refresh`), batch triage, and re-presentation. `review --resolve` 保留为兼容回退（review `--resolve` remains the compatibility fallback）.
   On sealing, the Pi host also surfaces a `run-knowledge` summary (Run attribution + staged candidates) and, at Session seal, a `session-knowledge` review prompt when a candidate backlog exists — treat those as the authoritative seal-time knowledge state and do not re-derive it manually.
6. Report success only when the Run is completed. Completed artifacts are immutable; later Runs in the same Session reuse eligible sealed outputs through `upstream` rather than copying them.

## Legacy/Admin Compatibility

`maestro run recall-confirm`, `run fork`, `run import`, `run new`, and `run rebind` are deprecated admin-only compatibility commands. They may remain callable while legacy records exist, but normal topic resolution, output reuse, recall recommendations, and next-action routing MUST NOT invoke or recommend them. They provide no force bypass; durability and recovery internals remain runtime-owned.

`maestro session resolve` followed by `maestro session resume` is the canonical audited recovery path for a paused Session: call `session resolve` once per exact escalated decision (`--decision <point-id>`) or failed step (`--step <step-id>`) with its `--disposition`, then call `session resume` after every blocker is cleared, then explicitly invoke `session next`. Both verbs require the full audit guard set (`--session --request-id --actor --reason --evidence --expected-identity-revision --expected-activity-revision`). Recovery is not normal topic resolution or artifact reuse.

**Workflow-specific finish norms**: declare a `finish:` list in the workflow file's YAML frontmatter; each entry is one norm line appended to the `run check` finish checklist.

```yaml
---
name: my-workflow
prepare: my-workflow
commands: [my-command]
finish:
  - Confirm every fix commit references its finding ID.
---
```

## Team Skills and FSM Chains

`team-*` skills are independent user entry points — invoked directly by the user with `/team-*`, never dispatched as a step inside a `maestro session next` chain. They do not appear in any chain catalog or Stage Mapping.

A team skill owns its own Run lifecycle: its coordinator resolves and completes the Run under the `run-mode-lite.md` contract. The FSM chain contract above governs only lifecycle steps dispatched by the orchestrators.
