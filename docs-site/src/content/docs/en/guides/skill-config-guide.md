---
title: "Skill Parameter Configuration Guide"
---

Set default parameters for 51 commands/skills, auto-injected via Hook — no manual input needed each time.

---

## Overview

Maestro Skill Config solves a common pain point: manually typing `--auto-commit -y` every time you call `/maestro-ralph -c`.

```
User calls /maestro-ralph -c
       ↓
skill-context hook (UserPromptSubmit)
       ↓ Match skill → Load config → Compare existing params
       ↓
additionalContext injects defaults
       ↓
Equivalent to /maestro-ralph -c --auto-commit -y
```

---

## Prerequisites

Ensure `standard` level or above hooks are installed:

```bash
maestro hooks status              # Check status
maestro hooks install --level standard  # Install
```

---

## Configuration File

### Path and Priority

| Priority | Path | Description |
|----------|------|-------------|
| 1 (highest) | `{project}/.maestro/skill-config.json` | Project-level override |
| 2 | `~/.maestro/skill-config.json` | Global configuration |

<details>
<summary>File structure example</summary>

```json
{
  "version": "1.0.0",
  "skills": {
    "maestro-ralph": {
      "params": {
        "--auto-commit": true,
        "-y": true
      },
      "updated": "2026-05-01T12:00:00Z"
    },
    "maestro-next": {
      "params": {
        "--auto": true
      }
    }
  }
}
```

Merge strategy: Project-level overrides global, deep-merged at skill granularity (project takes priority).

</details>

---

## CLI Usage

```bash
maestro config skills list                        # List all configurable skills
maestro config skills set <skill> <param> <value> [-g]  # Set (-g for global)
maestro config skills show [skill]                # View configuration
maestro config skills show --json                 # JSON format
maestro config skills unset <skill> <param> [-g]  # Remove single parameter
maestro config skills reset [skill] [-g]          # Reset configuration
```

> Parameter names don't need the `--` prefix; CLI auto-completes.

---

## TUI Interactive Interface

```bash
maestro config skills                    # Launch dashboard
maestro config skills edit <skill>       # Edit specific skill
```

### Dashboard

```
╭─────────────────────────────────────╮
│ MAESTRO SKILL CONFIG                │
│ Commands discovered:    51          │
│ Skills with defaults:   3           │
│ Hook (skill-context):   installed   │
│                                     │
│ [1] Skills  [2] Config Sources      │
│   [q] Quit                          │
╰─────────────────────────────────────╯
```

### Parameter Editor

```
▸ --auto-commit    [x] true       (boolean)
  --method         auto           (agent|codex|gemini|cli|auto)
  --executor       <not set>      (string)
  -y               [ ] false      (boolean)

[↑↓] Navigate  [Space] Toggle/Cycle  [Enter] Edit  [d] Delete  [Esc] Back
```

Operations: Boolean → `Space` toggle / Enum → `Space` cycle / String → `Enter` edit / Save: `[g]` Global or `[p]` Project

---

## Hook Injection Mechanism

The `skill-context` hook triggers on `UserPromptSubmit`:

1. Match skill name (hardcoded patterns + generic regex fallback)
2. Load global + project-level config, deep-merge
3. Conflict detection: skip explicitly specified parameters
4. Inject via `additionalContext` (does not modify original input)

---

## Common Configuration Examples

```bash
# Development mode (auto-commit + skip confirmation)
maestro config skills set maestro-ralph auto-commit true -g
maestro config skills set maestro-ralph y true -g

# Review mode (deep review)
maestro config skills set maestro-ralph level deep -g

# Planning mode (auto + collaborative)
maestro config skills set maestro-next auto true -g
maestro config skills set maestro-next collab true

# Analysis mode (silent)
maestro config skills set maestro-ralph y true -g
maestro config skills set maestro-ralph c true -g
```

---

## Important Notes

1. **Hook must be installed** — Injection depends on `skill-context` hook
2. **Parameter name matching** — Must match `argument-hint`
3. **Positional parameters not configurable** — `[phase]`, `<path>` must be manually specified
4. **Project-level config not tracked** — `.maestro/skill-config.json` typically in `.gitignore`

---

## Command Reference

| Command | Description |
|---------|-------------|
| `maestro config skills` | TUI dashboard |
| `maestro config skills list` | List all configurable skills |
| `maestro config skills show [skill]` | View configuration |
| `maestro config skills set <skill> <param> <value> [-g]` | Set parameter default |
| `maestro config skills unset <skill> <param> [-g]` | Remove parameter default |
| `maestro config skills reset [skill] [-g]` | Reset configuration |
| `maestro config skills edit <skill>` | TUI edit specific skill |
| `maestro cfg ...` | Alias for `config` |
