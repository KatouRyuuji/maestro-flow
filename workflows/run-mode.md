<!-- session-mode: inherited -->
# Canonical Run Mode

This file is the single Session/Execution/Run contract for every command, workflow, and stateful skill that declares `session-mode: run`.

Canonical lifecycle: **negotiate -> resolve/create Session identity -> start/attach Execution -> create/next Run -> brief/check/complete -> seal Execution**.

New-runtime mutation uses the Execution-aware `maestro execution ...` and `maestro run ...` machine protocol. Session lifecycle aliases are retained only in the clearly labeled `session/1.x` compatibility branch below.

## Authority and Reuse

- A Session is a durable **topic grouping/index**. Under `session/2.0` it has identity/activity revisions and archive metadata, but no permanent running/paused/sealed lifecycle. Sealing one unit of work never seals the Session identity.
- An Execution is one bounded generation inside a Session. It exclusively owns the current chain, decisions, gates, active Run, revision, lifecycle (`active|paused|sealed`), and core lease. At most one Execution per Session is non-sealed.
- A Run is one immutable execution attempt bound to the exact `session_id + execution_id + generation`. Its sealed outputs remain immutable and may be consumed by later Runs in the **same Session** through the canonical `upstream`/Artifact Registry map.
- Reuse references eligible sealed outputs in place. Normal routing does not fork, import, copy, resume, or resolve Sessions to obtain prior work.
- Historical similarity is read-only evidence. It may explain potentially related work, but it never selects a Session, binds an output, creates a Run, or becomes a next action.
- Machine callers MUST pass the exact Session and Execution locator returned by Runtime. Never rely on an active-session fallback, a unique-directory scan, topic similarity, or a Session-wide status to choose mutation authority.

## New Runtime Capability Gate

1. Before the first lifecycle mutation, run `maestro capabilities --json` and parse the exact `maestro-capabilities/1.0` response.
2. The canonical branch requires `session_schema_writes` containing `session/2.0`, `execution_schema_writes` containing `execution/1.0`, `run_response_writes` containing `run-response/1.1`, and `features.session_statusless=true`, `features.execution_generation=true`, and `features.core_execution_lease=true`.
3. If any required capability is absent or malformed, fail closed for new-runtime mutation. Do not silently fall back to a host-only lock or Session lifecycle alias. Enter the labeled legacy branch only when the caller explicitly selected an old CLI/schema compatibility workflow.
4. Every successful new-runtime mutation emits exactly one `run-response/1.1` envelope. Retain its exact `locator.session_id`, `locator.execution_id`, `locator.generation`, and `locator.run_id`, plus `fence.session_identity_revision`, `fence.session_activity_revision`, `fence.execution_revision`, and `fence.lease_epoch`.
5. Acquisition also returns the private core Execution lease claim: owner ID, owner kind, epoch, and `lease_id`. Keep it in coordinator-private memory or a mode-0600 claim file; never write the raw token to `report.md`, team state, logs, prompts, receipts, or artifacts. Status/read responses expose only the redacted claim/hash.
6. Use a stable unique `--request-id` per transition. After every mutation, replace the cached revisions with the returned fence before issuing another command. A partial locator, stale revision, changed generation, lost claim, or uncertain write result requires canonical status/recovery; never guess missing fields or retry under a new request ID.

## Prepare (optional, read-only)

- `maestro run prepare <step>` resolves what a step would consume and produce without side effects.
- `maestro run prepare <step> --session <id>` also returns read-only guidance, prior artifacts, and knowledge context. Treat any Session lifecycle wording from a legacy projection as compatibility data, not new-runtime mutation authority.
- Read-only and idempotent - it never allocates a Session or creates directories.
- Use it to preview upstream availability and the derived artifact contract before committing to a Run.

## Start or Continue a Run

> **Dispatched by an orchestrator?** When `maestro run next` invokes you, the Run is already created and its exact `session_id` / `execution_id` / `generation` / `run_id` / `run_dir` / `upstream` / guidance are injected in the birth packet. Use them directly and do **NOT** call `maestro run create` (a second create mints an empty duplicate Run). The dispatching coordinator retains mutation authority; an executor without the private core lease claim writes outputs and runs read-only checks but does not complete or advance the Execution.
>
> **Resume Packet**: use birth-packet guidance directly in normal forward flow. `maestro run brief <run_id> --session <session_id>` remains available for read-only **re-attach/backtracking** (executor crash recovery, context overflow, or manual inspection).

1. Read the caller frontmatter `name` as `<command-name>`.
2. **Compose a session slug** - `YYYYMMDD-{command}-{topic}` where `{topic}` is a 1-3 word ASCII-only slug derived from the intent (for example, `20260715-odyssey-jwt-auth`). NEVER let the runtime auto-generate from a Chinese or long intent string.
3. Negotiate capabilities. Resolve an existing compatible Session identity explicitly, or create an identity-only Session with `maestro session create "<short intent phrase>" --id <slug> --json`.
   - `<slug>` is explicit, ASCII-only, and <=64 chars.
   - Intent text is **Session metadata only** - a short human-readable phrase describing the goal. It may contain Chinese, is NOT used as the Session ID, does not enter `Run input.args`, and does not satisfy the command contract or `argument-hint`.
4. Start the next bounded generation and acquire its core lease:

   `maestro execution start --session {session_id} --request-id {request_id} --expected-identity-revision {identity_revision} --expected-activity-revision {activity_revision} --expected-lease-epoch 0 --execution-owner {owner_id} --owner-kind {owner_kind} --actor {actor} --reason "{reason}" --evidence {evidence} --json`

5. Create the self-started Run inside that exact Execution:

   `maestro run create <command-name> --session {session_id} --execution {execution_id} --generation {generation} --request-id {request_id} --expected-execution-revision {execution_revision} --owner-id {owner_id} --owner-kind {owner_kind} --lease-epoch {lease_epoch} --lease-id {lease_id} --intent "<short intent phrase>" [--arg <value> ...] --json`

   Command inputs use repeatable `--arg <value>`; raw positional passthrough after `-- <args...>` is accepted only when the command contract requires it. `--intent` remains Session metadata only.
6. Retain the returned exact locator, refreshed revisions, private claim, `run_id`, `run_dir`, and `upstream`. Do not locate Sessions, Executions, Runs, or artifacts with glob, mtime, directory ordering, or hidden command folders.
7. `maestro run brief <run_id> --session <session_id>` returns the `brief-result/1.1` Resume Packet - same-Session sealed artifacts, the authoritative upstream map, open decisions, and a compact `knowledge_context` reconciliation card - for continuing an existing Run. Protocol readers retain `brief-result/1.0` compatibility for read-only historical data; new-runtime mutations never downgrade from `run-response/1.1`.

**Session slug examples:**
```text
# Correct: use the complete `maestro execution start` and `maestro run create`
# option sets shown above; command input uses --arg.

# Wrong: no explicit Session/Execution locator.
maestro run create odyssey-planex --intent "complete the integration plan" --arg "complete the integration plan"
# Wrong: --intent is metadata and does not satisfy learn's required command arguments.
maestro run create learn --session 20260715-learn-auth-flow --intent "follow src/auth/"
# Wrong: mode-less command name (empty contract, ambiguous workflow resolution).
maestro run create odyssey --session 20260715-odyssey-planex-todo -- --mode planex
```

## Artifact Boundary

- Every formal artifact (including evidence-role artifacts declared in the prepare contract) MUST be written under `{run_dir}/outputs/`.
- A Run may validly produce no formal artifact. Only contract v2/v2.1 outputs declared with `required: true`, or an explicit required+blocking exit gate, make an artifact mandatory. Legacy v1 `produces` entries and `required: false` outputs are descriptive/optional and MUST NOT block completion when absent.
- Every new formal JSON artifact MUST contain a complete top-level `_meta` object: `{"_meta":{"kind":"<stable-kind>","schema":"<stable-kind>/1.0"},...}`. `kind` and `schema` are required together; `role` and `alias` are optional.
- A legacy JSON artifact with no `_meta` remains readable through contract/filename inference. Never write a partial, null, or non-object `_meta`; strict validation rejects the artifact and blocks Run completion.
- Human-readable synthesis and handoff MUST be written to `{run_dir}/report.md`.
- report.md frontmatter keys are a fixed whitelist (`verdict`, `summary`, `constraints`, `decisions`, `concerns`, `next`, `details`); every risk, caveat, or open question MUST go into `concerns`. Keys outside the whitelist are silently dropped and never reach the handoff, the next brief's signals, or a `done-with-concerns` verdict.
- report.md frontmatter `verdict` uses the report-layer vocabulary `ready|ready_with_concerns|blocked|failed` (default `ready`) - write these canonical tokens. The chain-advance tokens (`done|done-with-concerns|needs-retry`) are also accepted and mapped internally (done->ready, done-with-concerns->ready_with_concerns, needs-retry->failed). `maestro run complete --verdict` takes `done|done-with-concerns|needs-retry|blocked` and accepts the ready-vocabulary aliases. `session done` is a legacy compatibility alias, not the canonical new-runtime authority.
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
- `.workflow/sessions/{session_id}/` is the only durable Session identity and lineage authority. Execution and Run records beneath it are Runtime-owned; do not create private command Session/Execution directories or a second status/manifest truth source. Team message buses may exist only as transient coordination and never contain formal artifacts.
- Protocol files (`sessions/<sid>/session.json`, Execution records, `run.json`, `artifacts.json`) are Runtime-owned and MUST NOT be edited directly. Do not confuse protocol `session.json` with a workflow artifact named `outputs/session.json`; the latter is a workflow-owned formal artifact registered by Run completion.
- Consume upstream only from the canonical `upstream` map returned by `maestro run create`, `maestro run next`, or `maestro run brief`.

## Knowledge Reconciliation

- Search results and automatic prompt injection are **exposure only**. They may increase global impression statistics, but they never prove that a Run read, cited, validated, or contradicted an entry.
- Explicit `maestro load` / wiki loads are recorded as `consumed` through tiered routing: the unique active Run, then an unambiguous Session identity (host lease / single live hook channel), else the global usage ledger with a warning — attribution never blocks loading. Attribute search hits explicitly with `maestro knowledge record <knowledge-ids...> --signal consumed|cited|validated|contradicted --source search|load|manual [--run {run_id} | --session <session-id> | --channel <name>]` — pure ledger attribution that never stages a candidate (use `stage --signal` only when a candidate is intended). Record stronger relations by stable ID with `maestro knowledge stage <target> "<title>" --content-file <path|-> --run {run_id} --signal cited|validated|contradicted --signal-ids <comma-separated ids>`. Knowledge IDs are validated against the wiki index; unknown IDs are rejected unless `--allow-unknown`.
- Put accepted decisions and locked constraints in `report.md` frontmatter. Only reusable, prescriptive content belongs there - rules future work must follow. NEVER write execution-state narration as decisions/constraints (read-only declarations, worktree or audit-process observations, missing-file notes, or routing memos); Run completion auto-stages every accepted decision / locked constraint as a pending corpus candidate, so state narration pollutes the knowledge base. Session-origin candidates staged with `--session` live in the Session-level `knowledge-delta.json` and are governed by their immutable source snapshot, not Session lifecycle. Cross-origin candidates sharing one ID are represented by the run-source copy in the promotion plan, with completion written back to both ledgers.
- **Staging Quality Bar** — stage content only if future work can directly reuse it and at least one holds: (a) a pitfall warning ("when doing X, watch out for Y because Z" — non-obvious failure mode plus prevention); (b) a failure lesson (what failed, root cause, what worked instead); (c) a non-trivial trade-off (why A over B, with the constraints/context); (d) a newly established prescriptive constraint (spec). NEVER stage: process notes ("did X", "produced document Y"); re-descriptions of existing project patterns that code/config already documents; trivial or obvious operations; raw traces (tool outputs, log or error fragments) — distill traces into a lesson first, discard when nothing reusable can be distilled. **Zero candidates is a legitimate outcome** — never manufacture candidates to justify the pipeline.
- Stage reusable recipes, pitfalls, or other explicit candidates before completion with `maestro knowledge stage spec|knowhow "<title>" --content-file <path|-> --run {run_id} [--category <category>]`; write content to a temp file (or stdin `-`) — never inline as a positional argument: special sequences misparse and shift later arguments. Inside a Run always pass `--run {run_id}` explicitly (identity tiers — channel/lease/narrowed scan/synthetic Session — are for callers without a Run). Routine Run completion MUST NOT call `maestro spec add` or `maestro knowhow add` directly.
- Window transcripts can back staged candidates: pass `--transcript-quote <descriptor.json>` (`{host_kind, host_session_id, entry_id, quote}`) to snapshot the quoted fragment as untrusted evidence (K13). Transcript-only candidates are auto-gated to `review_required` (K17): `--all` never promotes them — resolve explicitly with `maestro knowledge promote {session_id} --resolve <candidate-id> --as unique --reason "<human review>"`. Snapshot contents never enter candidate content, review output, corpus, or search (iron rule 10): review renders only a `[untrusted]` state; never copy quote text into prompts or knowledge content.
- `maestro run check` reconciles every staged/report-derived candidate against active Spec and Knowhow through three bounded lanes: exact identity, diversified semantic neighborhood, and recorded/KG association. The receipt classifies `unique`, duplicates, extension/relation, conflict, and supersession; search exposure/popularity never changes its relevance or canonical choice.
- Completion requires a fresh `knowledge-reconciliation/1.0` fence for both the candidate snapshot and project corpus. Exact same-store duplicates are automatically suppressed. Semantic duplicates, extensions, conflicts, and supersession candidates remain reviewable and may be sealed, but cannot be promoted until explicitly resolved with `maestro knowledge review {session_id} --resolve <candidate-id> --as <choice> [--target <knowledge-id>] --reason "<reason>"`.
- Completion returns a `knowledge-candidate-receipt/1.0` with the exact staged candidate IDs and reconciliation summary. Use `maestro knowledge review {session_id}` for evidence-backed matches and copyable next commands; add `--refresh` for missing/stale receipts. Before promotion, refresh receipts with `maestro knowledge review {session_id} --refresh` as the TOCTOU fence. Promotion has two source-specific gates:
  - Run-source candidates require every source Run sealed and a fresh reconciliation receipt.
  - A `session/2.0` session-source candidate does **not** require Session seal. At stage time it must bind immutable `candidate_version` + `content_hash`, the exact `session_id` + `observed_activity_revision`, and non-empty immutable `evidence_roots` + `evidence_root_hash`. Review/promotion must revalidate those candidate/evidence roots, the `candidate_snapshot_hash`, and a fresh session-level reconciliation receipt for the current `corpus_fingerprint`; final commit repeats the reconciliation/corpus check. Later unrelated Session activity does not invalidate the candidate unless its bound candidate content or evidence roots changed.
  Promote selected IDs with repeatable `maestro knowledge promote {session_id} --candidate <candidate-id>`. `--all` promotes all eligible pending candidates (observed-only emits a warning); it skips unresolved and suppressed candidates. A confirmed `supersede` resolution lets promotion create the successor and link the evolution chain atomically. Neither Run completion nor Execution seal implicitly promotes or discards a backlog.
- Knowledge pruning is separate maintenance: `maestro knowledge audit --prune` emits a deterministic plan, and `--apply` backs up files before soft deprecation/supersession. Usage frequency alone never prunes, and the workflow never physically deletes knowledge.

## Chain Effects and Proposals

- Every Execution uses one ordered chain. There is no static/dynamic Session type and no strategy promotion; whether a step leaves the remaining Execution chain unchanged or proposes adaptation is decided by that step's Skill contract and output.
- `execution_contract.orchestration.chain_effects` is the Run's complete mutation capability set. An empty set means the Skill cannot propose chain changes. Capability does not require a proposal on every Run.
- A capable Skill may write `outputs/chain-proposal.json` with `_meta.kind=chain-proposal` and `_meta.schema=chain-proposal/1.0`. It may only contain operations allowed by the execution contract. The executor writes the artifact, runs `run check`, and returns; it never edits Execution state or invokes chain mutation commands.
- The orchestrator owns proposal disposition after a clean `run check`: accept, reject, or request revision. Accept adds `--apply-proposal` to the fenced `maestro run complete ... --json` call, which applies the single discovered valid proposal atomically with completion inside the current Execution; reject omits it; revision re-attaches the same Run and asks the Skill to replace its proposal, then checks again. The path-based `--chain-proposal` option is legacy compatibility only.
- Interactive mode asks before accepting. Under an explicit user-provided `-y`, an orchestrator may auto-accept only validated `insert`/`replace`/`skip` operations that stay in the current Execution's pending tail, remain within its declared budget, and align with the Session intent. Decision escalation, ambiguous intent/boundary changes, or low-confidence proposals are rejected or pause the Execution for review; `-y` never invents authority.
- `maestro run complete` seals the immutable Run, applies the selected proposal, records the receipt, and advances the current Execution step in one transition. Its next action remains `suggest_only`; only an explicit fenced `maestro run next` allocates the following chain-bound Run.

## Completion

1. Run `maestro run check {run_id} --session {session_id} --json` and repair any blocking artifact or exit gate it reports. This read does not rotate or acquire the lease.
2. When every gate is clean, `run check` emits a `finish` checklist - handoff frontmatter, knowledge relation/candidate staging, reconciliation review/annotation, verdict choice, plus norms declared by the workflow. Work through it before completing; it is prompt-layer guidance, never a blocking gate. Unresolved reconciliation is visible in the receipt and blocks later promotion, not Run sealing.
3. Complete inside the current Execution with the exact cached authority:

   `maestro run complete {run_id} --session {session_id} --execution {execution_id} --generation {generation} --request-id {request_id} --expected-execution-revision {execution_revision} --owner-id {owner_id} --owner-kind {owner_kind} --lease-epoch {lease_epoch} --lease-id {lease_id} --verdict {verdict} --summary "{summary}" [--evidence ...] [--decision ...] [--note ...] [--apply-proposal] --json`

   Completion atomically registers `outputs/`, seals the Run, updates the current Execution chain/gates/revision, and stages handoff-derived knowledge candidates. It never promotes project knowledge, executes the suggested next action, creates another Run, or changes permanent Session lifecycle.
   - **Evidence path base**: `--evidence <path>` / `--artifact <path>` resolve relative paths against `{run_dir}`, not shell CWD, and must stay inside the Run directory.
   - `done` / `done-with-concerns` enforce required success artifacts and exit gates.
   - `needs-retry` / `blocked` close the failed attempt without requiring success artifacts. `blocked` pauses the Execution and releases its lease; do not keep using the old claim.
4. Parse the `run-response/1.1` result, verify the exact locator/generation did not change, and replace cached revisions with its returned fence. If the continuation is automatic and the Execution remains active with a valid claim, invoke:

   `maestro run next --session {session_id} --execution {execution_id} --generation {generation} --request-id {request_id} --expected-execution-revision {execution_revision} --owner-id {owner_id} --owner-kind {owner_kind} --lease-epoch {lease_epoch} --lease-id {lease_id} --json`

   `suggest_only` describes Runtime passivity; it is not an implicit user-confirmation gate. Re-read each receipt before the next mutation. Never copy an old command carrying stale revisions.
5. For a decision node, submit the evaluator result through the same current Execution:

   `maestro run decide {point_id} --session {session_id} --execution {execution_id} --generation {generation} --request-id {request_id} --expected-execution-revision {execution_revision} --owner-id {owner_id} --owner-kind {owner_kind} --lease-epoch {lease_epoch} --lease-id {lease_id} --verdict {verdict} --confidence {confidence} [--summary "..."] [--evidence ...] --json`

6. Read the Run completion receipt. If it contains candidate IDs or reconciliation warnings, apply the **Review Presentation Protocol**: present each candidate needing a disposition with title, content summary, evidence anchors, evidence-backed matches, and recommended disposition plus rationale; collect the user's decisions, then execute the resolution.
   - Happy path: `maestro knowledge promote {session_id} --resolve <candidate-id> --as <choice> [--target <knowledge-id>] --reason "<reason>"`.
   - Compatibility fallback for missing/stale receipt repair, batch triage, or re-presentation: `maestro knowledge review {session_id} --resolve <candidate-id> --as <choice> [--target <knowledge-id>] --reason "<reason>"`.
7. Report Run success only after completion succeeds. A sealed Run and its artifacts are immutable; later Runs or later Execution generations reuse eligible sealed outputs through `upstream` rather than copying or reopening them.

## Execution Recovery and Seal

- On a revision/lease conflict or uncertain mutation, stop publishing, discard any unverified cached authority, and run `maestro execution status --session {session_id} --execution {execution_id} --json`. Do not force, infer a generation, or replay with changed inputs.
- A paused Execution is unleased. Resolve each exact blocker with `maestro execution resolve --session {session_id} --execution {execution_id} --request-id {request_id} --expected-execution-revision {execution_revision} --actor {actor} --reason "{reason}" --evidence {evidence} (--decision {point}|--step {step}) --disposition {value} --json`. Refresh the revision after every receipt.
- After all blockers are clear, reacquire authority with `maestro execution resume --session {session_id} --execution {execution_id} --request-id {request_id} --expected-execution-revision {execution_revision} --expected-activity-revision {activity_revision} --expected-lease-epoch {lease_epoch} --execution-owner {owner_id} --owner-kind {owner_kind} --actor {actor} --reason "{reason}" --evidence {evidence} --json`. Retain the newly returned claim and epoch; the pre-pause claim stays invalid.
- When every Run is sealed, every chain/decision step terminal, no request claimed, goals satisfied, and Execution gates clean, finish the bounded generation with:

  `maestro execution seal --session {session_id} --execution {execution_id} --request-id {request_id} --expected-execution-revision {execution_revision} --expected-activity-revision {activity_revision} --execution-owner {owner_id} --owner-kind {owner_kind} --owner-epoch {lease_epoch} --lease-id {lease_id} --actor {actor} --reason "{reason}" --evidence {evidence} --outcome {done|done_with_concerns|failed} --summary "{summary}" --json`

  Verify the returned `execution-seal-receipt/1.0`, stop heartbeat, and discard the claim. The Execution is immutable after seal; the durable Session identity remains available for a later higher generation.

## Legacy `session/1.x` Compatibility Branch

This branch exists only for an explicitly selected old CLI/schema that lacks the negotiated `session/2.0 + execution/1.0 + core_execution_lease + run-response/1.1` contract. It is not canonical authority for new runtimes.

- Old runtimes may use `maestro session start`, `maestro session next --inline-brief`, `maestro session done`, `maestro session decide`, `maestro session resolve`, `maestro session resume`, and `maestro session seal`, or their `maestro run ...` aliases, with `run-response/1.0` and Session revisions.
- A legacy Session may have durable running/paused/sealed state. Do not project those states onto `session/2.0`, and do not use this branch merely because a new-runtime claim was lost.
- `maestro session seal` and `maestro run seal-session` are deprecated bridges when an Execution exists; new-runtime completion always uses `maestro execution seal`.
- Historical `session/1.x` session-source promotion may retain its old sealed-Session rule. `session/2.0` promotion always uses the immutable candidate/evidence/corpus receipt gate above.

## Legacy/Admin Compatibility

`maestro run recall-confirm`, `run fork`, `run import`, `run new`, and `run rebind` are deprecated admin-only compatibility commands. They may remain callable while legacy records exist, but normal topic resolution, output reuse, recall recommendations, and next-action routing MUST NOT invoke or recommend them. They provide no force bypass; durability and recovery internals remain Runtime-owned.

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

`team-*` skills are independent user entry points - invoked directly by the user with `/team-*`, never dispatched as a step inside a `maestro run next` chain. They do not appear in any chain catalog or Stage Mapping.

A team skill owns its own Run lifecycle: its coordinator resolves and completes the Run under the `run-mode-lite.md` contract. The FSM chain contract above governs only lifecycle steps dispatched by the orchestrators.
