---
title: "Maestro Coordinator Guide"
---

Generic chain composer/runner — analyzes intent, selects an initial chain, and executes ordinary or chain-effect Skills on the canonical Session/Run protocol.

---

## Positioning

Maestro is the **main entry point** of Maestro Flow:

1. Parse user intent (action + object + scope)
2. Read project state (`.workflow/state.json`)
3. Select an initial chain from the command catalog
4. Create or continue a Session and execute each Run through `run-executor` or the direct executor

Sessions and chains have no static/adaptive type. Ordinary Skills leave the chain unchanged; a Skill declaring `orchestration.chain_effects` may emit a typed proposal that Maestro confirms and the Runtime applies atomically.

Difference from [Maestro Ralph](./maestro-ralph-guide.en.md):

| | Maestro | Maestro Ralph |
|---|---------|---------------|
| **Positioning** | Initial chain composer/runner | Closed-loop proposal policy |
| **Session/Run protocol** | Canonical | Canonical; directly continues Maestro Sessions |
| **Chain change source** | Skill proposal | Skill proposal |
| **Policy focus** | Interactive confirmation, stop when chain is exhausted | Budget, confidence, escalation, goal/gate stop |
| **Executor** | `run-executor` or direct | `run-executor` |

---

## Usage

```bash
/maestro "implement user authentication"  # Intent-driven
/maestro continue                          # Auto-advance based on state
/maestro status                            # View project dashboard
```

### Flags

| Flag | Description |
|------|-------------|
| `-y` | Auto mode: skip confirmations, auto-propagate to downstream commands |
| `-c` | Resume mode: continue from the last interrupted session |
| `--dry-run` | Show the planned chain without executing |
| `--exec auto\|cli\|internal` | Force execution engine |
| `--super` | Super mode: fully automated delivery |

---

## Intent Routing

Maestro uses an `action x object` matrix for semantic routing:

| action | Trigger Semantics |
|--------|-------------------|
| `create` | Build new features, components, specs |
| `fix` | Fix bugs, resolve errors |
| `analyze` | Analyze, evaluate, investigate |
| `plan` | Design approach, plan, decompose |
| `execute` | Implement, develop, code |
| `review` | Code review |
| `test` | Run/create tests |
| `debug` | Diagnose, troubleshoot |
| `refactor` | Restructure, clean up tech debt |
| `explore` | Brainstorm, diverge |
| `manage` | CRUD / lifecycle management |
| `continue` | Resume, continue |

### Routing Examples

| Input | Route | Command Chain |
|-------|-------|---------------|
| `"Add API endpoint"` | companion | `/maestro-companion "Add API endpoint"` |
| `"plan phase 2"` | plan | step `plan 2` |
| `"debug auth crash"` | debug | step `debug "auth crash"` |
| `"fix issue ISS-abc-001"` | issue-full | analyze → plan → execute → review → close |
| `"brainstorm notifications"` | brainstorm-driven | brainstorm → plan → execute → verify |
| `"continue"` | state_continue | Auto-infer from project state |

---

## Command Chains

### Single-Step Chains

| Chain Name | Step (dispatched inside the Session chain) |
|------------|---------|
| `analyze` | `analyze {phase}` |
| `plan` | `plan {phase}` |
| `execute` | `execute {phase}` |
| `review` | `review {phase}` |
| `test` | `test {phase}` |
| `debug` | `debug "{description}"` |

### Multi-Step Chains

| Chain Name | Steps | Use Case |
|------------|-------|----------|
| `full-lifecycle` | plan → execute → review → test → session-seal → harvest | Complete milestone |
| `roadmap-driven` | init → roadmap → plan → execute | Starting from requirements |
| `brainstorm-driven` | brainstorm → plan → execute | Starting from exploration |
| `execute-review` | execute → review | Resume after planning |
| `review-fix` | plan --gaps → execute → review | Fix review issues |
| `issue-full` | analyze → plan → execute → review → close | Issue closed-loop |
| `milestone-close` | session-seal | Close milestone |

---

## Session Files

Storage location: `.workflow/.maestro/maestro-{YYYYMMDD-HHMMSS}/status.json`

<details>
<summary>JSON Schema Example</summary>

```json
{
  "session_id": "maestro-20260503-143022",
  "source": "maestro",
  "intent": "implement user auth",
  "status": "running",
  "chain_name": "full-lifecycle",
  "task_type": "execute",
  "phase": 1,
  "milestone": "MVP",
  "auto_mode": false,
  "exec_mode": "auto",
  "steps": [
    {
      "index": 0,
      "type": "skill",
      "skill": "plan",
      "args": "1",
      "status": "pending"
    }
  ],
  "current_step": 0
}
```

**Step type**: `"skill"` in-session call (lightweight) / `"cli"` CLI delegate background execution (heavyweight)

New chains prefer executable Skill steps. Whether a decision or repair step is added comes from the relevant Skill proposal, not a Maestro/Ralph Session type.

</details>

---

## Execution Flow

```
User Input → Intent Parsing → Initial Chain → Canonical Session → run-executor/direct → check/proposal/complete
```

1. **Intent Parsing**: Extract action, object, scope, phase_ref
2. **State Reading**: Read `.workflow/state.json`
3. **Chain Selection**: Select command chain from chainMap
4. **Type Selection**: Pre-compute step type (auto: heavyweight → cli, lightweight → skill)
5. **Session Creation**: Persist canonical `session.json` through `session create --chain-file`
6. **Execution Dispatch**: Explicit `run next`, then the selected executor

### State Inference (continue mode)

| Current State | Inferred Chain |
|---------------|----------------|
| Not initialized | `init` |
| Has roadmap, target phase has no artifacts | `analyze` |
| Latest artifact is analyze | `plan` |
| Latest is plan | `execute` |
| Execute completed (verification built-in), no review | `review` |
| UAT passed | `milestone-close` |
| All phases complete | `milestone-close` |

---

## `-y` Auto Mode Propagation

When `-y` is enabled, Maestro propagates the auto flag to downstream commands:

| Command | Flag | Effect |
|---------|------|--------|
| maestro-init | `-y` | Skip interactive questioning |
| analyze | `-y` | Skip interactive scoping |
| plan | `-y` | Skip confirmations and clarification |
| execute | `-y` | Skip confirmations, auto-continue on blocked |
| test | `-y --auto-fix` | Auto-trigger gap-fix loop |
| maestro-session-seal | `-y` | Skip confirmations (auto mode) |

---

## Resume Execution

```bash
/maestro -c    # Resume from the most recent session
```

Resume mode skips intent parsing and chain selection, continuing directly from the next pending step in status.json.
