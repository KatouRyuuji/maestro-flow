---
title: "Maestro Ralph Closed-Loop Orchestration Policy Guide"
---

Closed-loop orchestration policy over the canonical Session/Run chain. It evaluates Skill outputs and proposals under budget, confidence, escalation, and stop policies.

---

## Positioning

Maestro Ralph is the **closed-loop progression entry** of Maestro Flow:

1. Read project state and automatically infer the current lifecycle position
2. Create or continue any compatible Session and reuse its sealed Runs and Artifacts
3. Execute ordinary Skills or Skills that declare `orchestration.chain_effects`
4. Evaluate typed chain proposals under budget, confidence, escalation, and stop policies

Sessions and chains have no static/adaptive type. Whether the chain changes is decided by the current Skill contract and Run output. The difference from [Maestro](./maestro-coordinator-guide.en.md) is policy only:

| | Maestro | Maestro Ralph |
|---|---------|---------------|
| **Session/Run protocol** | Canonical | Canonical; directly continues Maestro Sessions |
| **Initial policy** | Initial chain composition and interactive confirmation | Closed-loop budget/confidence/escalation |
| **Chain change source** | Skill proposal | Skill proposal |
| **Stop condition** | Chain exhausted or user stops | Goal/gate satisfied, budget exhausted, blocked, or user stops |

---

## Usage

```bash
/maestro-ralph "implement user authentication system"  # New session
/maestro-ralph continue                                # Resume execution
/maestro-ralph -y "implement auth"                     # Fully automatic mode
/maestro-ralph status                                  # View progress
```

---

## Three Node Types

| Type | Execution Method | Description |
|------|------------------|-------------|
| **skill** | `Skill()` synchronous call | Actual command execution (plan, execute, verify, etc.) |
| **cli** | `maestro delegate` background | CLI delegate execution |
| **decision** | Ralph re-evaluation | Reads execution results, decides to continue or insert fix loop |

---

## Lifecycle Stages

<details>
<summary>Full Flow Diagram</summary>

```
brainstorm → init → roadmap → analyze → plan → execute
    (0→1)                                        ↓
                                              verify
                                                ↓
                                        ◆ post-verify
                                                ↓
                                      business-test (full)
                                                ↓
                                      ◆ post-business-test
                                                ↓
                                            review
                                                ↓
                                        ◆ post-review
                                                ↓
                                          test-gen + test
                                                ↓
                                          ◆ post-test
                                                ↓
                                        milestone-audit
                                                ↓
                                      milestone-complete
                                                ↓
                                      ◆ post-milestone
                                          ↓        ↓
                                    Next M     All Done
```

Each `◆` is a decision node. In non-`-y` mode, it pauses and waits for `continue`.

</details>

---

## Decision Nodes Explained

| Node | Reads File | Pass | Failure Handling |
|------|------------|------|------------------|
| **post-verify** | `verification.json` | Continue | Insert debug → plan --gaps → execute → verify loop |
| **post-review** | `review.json` | PASS/WARN continue | BLOCK → insert fix loop |
| **post-test** | `uat.md` + `test-results.json` | All passed | Lightweight retry of failed quality gates |
| **post-milestone** | `state.json` | Has next M → insert full chain | All complete → session ends |
| **post-debug-escalate** | — | — | Max retries reached, pause for manual intervention |

---

## Quality Pipeline Modes

| Mode | Quality Steps | Trigger Condition |
|------|---------------|-------------------|
| `full` | verify → business-test → review → test-gen → test | Has REQ-*.md and phase scope |
| `standard` | verify → review → test (test-gen based on coverage) | Default |
| `quick` | verify → CLI-review (skip business-test, test-gen, test) | User-specified |

`session.passed_gates[]` records passed quality gates. During retries: gates that passed with unchanged code are skipped; code modifications clear affected gates for re-execution.

---

## Session Files

Storage location: `.workflow/.maestro/ralph-{YYYYMMDD-HHmmss}/status.json`

<details>
<summary>JSON Schema Example</summary>

```json
{
  "session_id": "ralph-20260503-143022",
  "source": "ralph",
  "intent": "implement user auth",
  "status": "running",
  "chain_name": "ralph-lifecycle",
  "task_type": "lifecycle",
  "phase": 1,
  "milestone": "MVP",
  "auto_mode": false,
  "quality_mode": "standard",
  "passed_gates": ["verify"],
  "lifecycle_position": "plan",
  "target": "milestone-complete",
  "steps": [
    { "index": 0, "type": "skill", "skill": "plan", "args": "1", "status": "completed" },
    { "index": 1, "type": "skill", "skill": "execute", "args": "1", "status": "completed" },
    { "index": 2, "type": "decision", "skill": "maestro-ralph", "args": "{\"decision\":\"post-verify\",\"retry_count\":0,\"max_retries\":2}", "status": "running" },
    { "index": 3, "type": "skill", "skill": "review", "args": "1", "status": "pending" }
  ],
  "current_step": 3
}
```

**Step types**: `"skill"` actual command / `"cli"` CLI delegate / `"decision"` Ralph decision evaluation (Ralph-only)

</details>

---

## Execution Flow

| Mode | Flow |
|------|------|
| **New session** | Infer position → build initial chain → create canonical Session → execute Runs |
| **Resume** | Locate a compatible Session → read Runs/Artifacts → evaluate an optional proposal → continue |
| **`-y` automatic** | Execute → apply budget/confidence proposal policy → continue or pause |

---

## Lifecycle Position Inference

| Condition | Inferred Position |
|-----------|-------------------|
| No `.workflow/` | `brainstorm` (empty project) or `init` (has code) |
| Has state.json, no milestones | `roadmap` |
| Has milestones, no artifacts | `analyze` |
| Latest artifact type == analyze | `plan` |
| Latest artifact type == plan | `execute` |
| Latest artifact type == execute | `verify` |
| verify passed | `post-verify` (follow-up depends on quality_mode) |
| verify failed | `verify-failed` (insert fix loop) |

---

## Unified Executor

Maestro and Ralph share `run-executor` and the canonical Run lifecycle:

- **Skill step**: `run next/brief` loads and executes exactly one Run
- **proposal**: the executor returns Artifacts and an optional proposal; it never completes or mutates the chain
- **completion**: the outer policy calls `run complete [--chain-proposal]`; another explicit `run next` is still required

Sessions are not typed as Maestro or Ralph; decision/repair steps come from the initial chain or an accepted Skill proposal.

---

## Max Retries and Escalation

Each decision node carries `retry_count` and `max_retries` (default 2):

- **retry 0**: First evaluation → failed → insert fix loop
- **retry 1**: Second evaluation → still failed → fix again
- **retry 2**: Limit reached → escalate to `post-debug-escalate` → pause

After escalation, session status becomes `paused`. User handles it, then `continue` to resume.
