<!-- session-mode: inherited -->
# Canonical Orchestrator Run Loop

Canonical lifecycle reference: `@~/.maestro/workflows/run-mode.md`.

Maestro and Ralph share this loop. Session is durable topic identity; the current Execution owns chain, decisions, gates, lifecycle, revision, active Run, and the core lease; each Run is an immutable attempt. Runtime alone writes protocol records.

## Public flags

- `-y`: auto-confirm bounded low-risk choices; never bypass high risk, low confidence, ambiguity, failed gates, recovery, or drift halt.
- `-c`: continue the unique compatible Session's exact current Execution. Multiple candidates require selection; a paused Execution enters audited recovery.
- `--amend`: amend the current Execution goal through the audited proposal flow.

All other text is intent. Roadmap, quality, executor, platform, reuse, parallelism, and adversarial strategy derive from intent, Session identity, current Execution state, Skill contract, and host Runtime.

## Capability and Authority Gate

1. Before any mutation, call `maestro capabilities --json`. Canonical mutation requires exact `maestro-capabilities/1.0` support for `session/2.0`, `execution/1.0`, `run-response/1.1`, `session_statusless`, `execution_generation`, and `core_execution_lease`.
2. If negotiation is absent, malformed, or incomplete, fail closed. Never downgrade to a host-only lease or a Session lifecycle alias. The explicit legacy branch is the only old-schema fallback.
3. Keep one private authority record for the loop:

   `session_id + execution_id + generation + run_id? + session_identity_revision + session_activity_revision + execution_revision + lease_epoch + owner_id + owner_kind + lease_id`

4. Every new-runtime mutation uses a stable unique `--request-id`, the exact locator, current `--expected-execution-revision`, and the current core claim where required. Execution acquisition and Session pointer changes also use the exact `--expected-identity-revision` and `--expected-activity-revision`. Parse exactly one `run-response/1.1` envelope, verify the locator/generation is unchanged, and replace cached revisions from its fence before the next mutation.
5. Never persist raw `lease_id` in prompt text, task/team state, report, log, artifact, or receipt. If a write result is uncertain, discard unverified authority and recover from canonical Execution status instead of guessing or replaying with changed inputs.

## Authority

- Session identity and Session-global artifact lineage remain durable across Execution generations. A Session has no permanent running/paused/sealed authority in `session/2.0`.
- Execution is the only authority for chain, goal/decision state, gates, active Run, pause/resume, revision, and lease.
- Run owns its immutable input/output/handoff/proposal and is sealed exactly once. Retry creates a new Run in the same Execution.
- Skill produces domain results and optional `chain-proposal/1.0`; orchestrator accepts/rejects/revises; Runtime applies allowed mutations atomically inside the current Execution.
- Historical similarity is read-only. Same-Session sealed outputs enter only through the canonical `upstream` map.

## Continuation Router

For new-runtime responses, `run-response/1.1` locator/fence is authoritative. Consume `continuation` or `result.next` only after rebuilding any mutation command with the freshly returned locator, revision, and claim; never execute a stale command string copied from an older receipt. Legacy `run-response/1.0` routing applies only in the compatibility branch.

`suggest_only` means the CLI is passive, not that confirmed chain work needs another user prompt:

- `authority=automatic`: if preconditions match the current Execution and claim, execute one action, parse its receipt, and loop.
- `authority=auto_mode_only`: execute only when current Execution policy enables auto mode and the action is in the `-y` whitelist.
- `authority=user_required`: stop and report the exact blocker, hashes/revisions, reason code, and evidence needed.

**Turn 终止不变量**: while the current Execution is `active`, its claim is valid, and a satisfiable `automatic` action exists, do not end the turn or report overall completion. Re-read authority after every action; never predict multiple transitions from one receipt.

| continuation.action | Canonical prompt behavior |
|---|---|
| `load_run` | Load the same exact `run_id` with `run brief`; never create a duplicate Run |
| `execute_run` | Execute its Resume Packet, then check; executor never completes |
| `repair_run` | Reattach the same Run, repair gates, then check again |
| `dispatch_next` | Invoke fenced `maestro run next ... --json` once |
| `evaluate_decision` | Read one decision card, dispatch a read-only evaluator, then invoke fenced `maestro run decide` |
| `accept_reuse` | Apply REVIEW rules below without changing the Execution anchor |
| `recover_execution` / legacy `recover_session` | Use `maestro execution resolve` then `maestro execution resume` |
| `seal_execution` / legacy `seal_session` | Revalidate Execution terminal gates, then use `maestro execution seal` |
| `offer_recommendations` | Show chain-external suggestions only; never allocate a Run implicitly |
| `repair_chain` / `stop` | Stop and report structured reasons; never bypass authority |

### REVIEW Reuse

`REUSE` consumes canonical upstream directly; `REJECT` and `CONFLICT` are never accepted. `REVIEW` opens a required consume gate only after an exact acceptance receipt. The current Runtime must supply an Execution-aware acceptance mutation or the orchestrator pauses/fails closed; it must not use a Session-only mutation inside the canonical branch. After acceptance, reload the same exact Run. Treat `assessment.acceptance_status=accepted` as processed even if `assessment.decision=REVIEW` remains the original assessment.

### `-y` Policy

Normal confirmed-chain continuation does not depend on `-y`. It only expands low-risk discretion:

- May automate: validated pending-tail proposal; same-Session `QUALITY_MEDIUM` REVIEW with sealed producer/artifact, exact Execution anchor, current hash/fence, and evidence.
- Must stop: `QUALITY_LOW`, `REJECT`, `CONFLICT`, hash/freshness/supersession uncertainty, boundary change, high risk, low confidence, retry exhaustion, paused recovery, or external blocker.
- handoff `next[]` remains chain-external recommendation. Automatic same-Execution continuation requires an accepted typed proposal.

### `complete` / `decide` 闭环

- After successful fenced `maestro run complete ... --json` or `maestro run decide ... --json`, consume the fresh fence and immediately execute a satisfiable automatic next action.
- A decision node does not create a Run. `reason_code=DECISION_CARD_READY` means evaluate the card and call `run decide`; do not call `run next` again first.
- A birth packet with `run_already_created=true` is strict: use that exact `run_id`/locator and never call `run create` again.
- `proceed` may route to another Run, another decision, or Execution seal. `escalate` pauses the Execution. `fix` requires new repair evidence before another decision.

## Lifecycle

### 1. Resolve or Create Identity and Execution

1. Negotiate capabilities first. For `-c` / `--amend`, use read-only recall to identify the Session, then resolve its exact current Execution and call `maestro execution status --session {session_id} --execution {execution_id} --json`.
2. For new intent, classify and validate a chain definition. Each execution step declares `command/args/stage/goal_ref/retry_max`; each decision step declares `decision_ref`. Prevalidate names with `maestro skills --steps --json --platform {target_platform}` where platform is `claude|codex|agent|agy|pi`.
3. Create only the durable identity with `maestro session create "{intent}" --id {slug} --json`, then start/acquire a bounded generation with `maestro execution start --session {session_id} --request-id {request_id} --expected-identity-revision {identity_revision} --expected-activity-revision {activity_revision} --expected-lease-epoch 0 --execution-owner {owner_id} --owner-kind {owner_kind} --actor {actor} --reason "{reason}" --evidence {evidence} --json`. Chain/engine/quality/auto belong to the Execution, never permanent Session state. Supply the validated chain through the host/Runtime's negotiated Execution bootstrap surface; if that surface is unavailable, fail closed rather than silently storing a new-runtime chain on Session.
4. Retain the exact returned locator/fence/claim. A later Execution in the same Session must have a greater generation and cannot mutate sealed prior generations.

### 2. Allocate and Execute One Run

1. Read canonical Execution status. For an execution step invoke:

   `maestro run next --session {session_id} --execution {execution_id} --generation {generation} --request-id {request_id} --expected-execution-revision {execution_revision} --owner-id {owner_id} --owner-kind {owner_kind} --lease-epoch {lease_epoch} --lease-id {lease_id} --json`

2. Parse the `run-response/1.1` birth packet and refreshed fence. For normal forward flow use its guidance; otherwise load exact `maestro run brief {run_id} --session {session_id}`.
3. Dispatch one unnamed `run-executor`. It writes formal artifacts to `{run_dir}/outputs/`, handoff to `{run_dir}/report.md`, and calls `maestro run check {run_id} --session {session_id} --json`. It never completes the Run and never receives the private claim.

### 3. Analyze, Gate, and Complete

Extract `summary`, evidence paths, non-obvious decisions, and concerns. Map drift to verdict:

| Result | Verdict |
|---|---|
| aligned | `done` |
| minor drift | `done-with-concerns` |
| major drift with retry left | `needs-retry` |
| major drift exhausted | `done-with-concerns` with explicit concern |
| external blocker | `blocked` |

Complete with the exact locator/fence/claim:

`maestro run complete {run_id} --session {session_id} --execution {execution_id} --generation {generation} --request-id {request_id} --expected-execution-revision {execution_revision} --owner-id {owner_id} --owner-kind {owner_kind} --lease-epoch {lease_epoch} --lease-id {lease_id} --verdict {verdict} --summary "{summary}" [--evidence ...] [--decision ...] [--note ...] [--apply-proposal] --json`

A blocking result repairs the same Run. A sealed Run is immutable. `needs-retry` allocates a new Run only after Runtime returns the step to pending; `blocked` pauses the Execution and releases the lease.

### 4. Decision Step

1. Dispatch a read-only evaluator over canonical artifacts and goal evidence.
2. Parse `proceed|fix|escalate`; parse failure becomes `fix` with low confidence.
3. Submit through current Execution:

   `maestro run decide {point_id} --session {session_id} --execution {execution_id} --generation {generation} --request-id {request_id} --expected-execution-revision {execution_revision} --owner-id {owner_id} --owner-kind {owner_kind} --lease-epoch {lease_epoch} --lease-id {lease_id} --verdict {verdict} --confidence {high|medium|low} [--summary "..."] [--evidence ...] --json`

4. Parse the new fence and remain in the same loop. Pending-tail changes come from a repair Skill proposal, never direct prompt mutation.

### 5. Recovery and Amend

Paused recovery is explicit:

1. Read `maestro execution status` for exact blockers, locator, revisions, and redacted lease state.
2. Resolve each blocker with `maestro execution resolve --session {session_id} --execution {execution_id} --request-id {request_id} --expected-execution-revision {execution_revision} --actor {actor} --reason "{reason}" --evidence {evidence} (--decision {point}|--step {step}) --disposition {value} --json`.
3. After blockers clear, reacquire with `maestro execution resume --session {session_id} --execution {execution_id} --request-id {request_id} --expected-execution-revision {execution_revision} --expected-activity-revision {activity_revision} --expected-lease-epoch {lease_epoch} --execution-owner {owner_id} --owner-kind {owner_kind} --actor {actor} --reason "{reason}" --evidence {evidence} --json`.
4. Retain the new epoch/claim. Resume restores only the same Execution; the next Run still requires fenced `run next`.

Goal amendment snapshots the current Execution, performs impact analysis and confirmation, then uses an Execution-owned typed proposal. The old `session meta update` flow is compatibility-only for `session/1.x`.

### 6. Seal

After all Runs are sealed, chain/decisions terminal, no request claimed, goals satisfied, and Execution gates clean:

`maestro execution seal --session {session_id} --execution {execution_id} --request-id {request_id} --expected-execution-revision {execution_revision} --expected-activity-revision {activity_revision} --execution-owner {owner_id} --owner-kind {owner_kind} --owner-epoch {lease_epoch} --lease-id {lease_id} --actor {actor} --reason "{reason}" --evidence {evidence} --outcome {done|done_with_concerns|failed} --summary "{summary}" --json`

Verify `execution-seal-receipt/1.0`, stop heartbeat, and discard the claim. The sealed Execution stays immutable; Session identity can later host a higher generation.

## Failure Rules

- Blocking `run check`: repair the same Run; do not report success or allocate another.
- Null/failed executor: complete the attempt honestly; retry only through Runtime transition.
- Revision/lease/generation conflict or uncertain write: stop, discard unverified authority, reread `execution status`, and recover explicitly. Never force.
- A sealed Execution is terminal for that generation; a later generation requires `execution start`, not resume. An archived Session identity cannot start an Execution.

## Legacy `session/1.x` Compatibility Branch

Use this branch only for an explicitly selected old CLI/schema lacking the negotiated Execution contract. Old Runtime may use `maestro session create --chain-file`, `session next --inline-brief`, `session done`, `session decide --json`, `session resolve/resume`, and `session seal`, with Session running/paused/sealed state and `run-response/1.0`. These aliases are not canonical authority for `session/2.0`, must not be used to recover a lost core claim, and must remain visibly labeled as legacy compatibility.
