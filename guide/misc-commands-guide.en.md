---
title: "Miscellaneous Commands Guide"
---

Auxiliary commands for maintenance and spec management in Maestro workflows.

---

## 1. maestro-overlay --amend — Incremental Patching

Signal-driven Overlay generator. Collects workflow defect signals from multiple sources, diagnoses which commands need amendments, and batch-generates targeted Overlay patches. All modifications go through the Overlay system (`~/.maestro/overlays/*.json`) — no changes to original command files, idempotent and persists across reinstalls.

Unlike `/maestro-overlay` (explicit single creation), `/maestro-overlay --amend` automatically **discovers** what needs fixing by analyzing workflow artifacts.

### Use Cases

- `execute` step built-in verification gate (E2.7) exposed missing command steps
- `review` step identified process-level deficiencies
- Workflow execution deviations traced to incomplete command definitions
- Issue tracking shows recurring problems rooted in command design

### Signal Sources

| Flag | Source | What It Collects |
|------|--------|-----------------|
| `--from-verify <dir>` | verification.json | Workflow gaps from verification failures |
| `--from-review <dir>` | review.json | Process defects from code review |
| `--from-session <id>` | Session artifacts | Issues encountered during execution |
| `--from-issues ISS-xxx,...` | issues.jsonl | Issues traced to command defects |
| `--scan` | Auto-scan .workflow/ | All workflow-related signals |
| _(Positional text)_ | User description | Direct observations |

### Workflow

```
Collect Signals → Diagnose & Classify → Group & Plan → Preview & Confirm → Generate Overlay → Install
```

1. **Collect Signals**: Extract and classify as "command defect" or "code bug"
2. **Diagnose & Map**: Determine target command, section, and patch mode
3. **Group & Plan**: Group by command + section, display injection points
4. **Preview & Confirm**: User confirms or edits the injection point map
5. **Generate & Install**: Generate Overlay JSON files and install via `maestro overlay add`

### Common Usage

```bash
/maestro-overlay --amend --from-verify .workflow/phases/1    # Discover gaps from verification
/maestro-overlay --amend --from-review .workflow/phases/2    # Extract process improvements
/maestro-overlay --amend --scan                             # Auto-scan all signals
/maestro-overlay --amend "execute step missing CLI verification"  # Describe directly
/maestro-overlay --amend --dry-run                          # Preview mode (no install)
/maestro-overlay --amend -y                                 # Skip confirmation
```

---

## 2. maestro-update — Update Check

Detects `.workflow/` schema version, displays available migration plans, and executes upgrades step by step. Supports incremental chain upgrades (e.g., 1.0 → 2.0 → 3.0).

### Flags

| Flag | Description |
|------|-------------|
| `--dry-run` | Preview migration plan only |
| `--force` | Skip confirmation, apply all pending migrations |

### Execution Flow

```
Detect Version → Preview Plan → Step-by-Step Confirm → Execute Migration → Summary Report
```

### Common Usage

```bash
/maestro-update --dry-run   # Check for pending migrations
/maestro-update             # Interactive step-by-step upgrade
/maestro-update --force     # One-command full upgrade
```

### Notes

- Skipping a step may break the version chain (system warns)
- Backup created before each migration: `.workflow/state.json.backup-v{from}-{timestamp}`
- Manual restore: `cp .workflow/state.json.backup-v{from}-{ts} .workflow/state.json`

---

## 3. specs-remove — Spec Removal

Removes a specified `<spec-entry>` from specs files. The symmetric counterpart to `/maestro-spec` (recording), `specs-remove` is an orchestrator-dispatched step that uses `maestro wiki remove-entry` for atomic deletion with automatic index updates.

### Entry ID Format

```
spec-{file-stem}-{NNN}  (e.g., spec-learnings-003)
```

### Common Usage

```bash
maestro wiki list --type spec --json    # List all spec entries
maestro spec load --keyword auth        # Search by keyword (CLI)
specs-remove spec-learnings-003         # Remove specific entry (step, orchestrator-dispatched)
```

### Notes

- Requires `.workflow/specs/` initialized via `maestro spec init`
- Entry ID must be a spec type child node
- Removal is irreversible (preview with `maestro spec load` first)
