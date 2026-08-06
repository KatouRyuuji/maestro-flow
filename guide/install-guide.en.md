---
title: "Installation Guide"
---

Maestro-Flow installation is a two-step process: global CLI install and project initialization.

---

## Quick Install

```bash
# 1. Install the global CLI
npm install -g maestro-flow

# 2. Initialize in your project root
maestro install
```

**Prerequisites**:
- Node.js ≥ 18
- Claude Code CLI (required)
- Codex CLI / Gemini CLI (optional, for multi-agent workflows)

---

## Install Flow

`maestro install` performs these steps:

1. **Detect project state** — empty project / existing code / existing .workflow/
2. **Select components** — interactive component selection UI
3. **Choose install mode** — global (~/.maestro/) or project-level (.workflow/)
4. **Copy files** — copy to target location per component definition
5. **Generate manifest** — record installed components for incremental updates

> **Pi Agent note**: Maestro no longer installs the Pi platform directly (it does not copy
> skills/agents into `~/.pi/`). To integrate with Pi, install the official Maestro Flow pi plugin:
>
> ```bash
> pi install https://github.com/catlog22/pi-maestro-flow
> ```

---

## Component Groups

Since v0.5.32, install components have been consolidated from 53 individual entries into 25 groups for a simpler selection experience.

### Core Components (selected by default)

| Group | Description | File Count |
|-------|-------------|------------|
| **commands** | Core slash commands | ~30 |
| **hooks** | Automation hooks | ~5 |
| **workflows** | Workflow scripts | ~10 |
| **specs** | Specification templates | 7 |

### Optional Skill Packs

| Group | Included Skills | Description |
|-------|----------------|-------------|
| **skills-scholar** | scholar-ideation, scholar-writing, scholar-review, scholar-rebuttal-pro, etc. (10 skills) | Academic research skills (optional, not installed by default; sourced from `optional/skills/`) |
| **skills-extra-team** | — | Legacy no-op bundle, retained only for manifest-replay migration |
| **skills-meta** | — | Legacy no-op bundle (members moved into core `skills`), retained for migration |

> Since v0.5.61 the skill surface was sharply trimmed: 20 zero-usage team/helper
> skills were deleted and the 10 `scholar-*` skills became opt-in. Manage skills
> with `maestro install toggle`, e.g. `maestro install toggle --enable scholar-writing`.

### Built-in Team Skills (always installed)

The following 8 team skills are automatically installed with the core `skills-team` component:

- team-arch-opt
- team-coordinate
- team-issue
- team-lifecycle-v4
- team-perf-opt
- team-review
- team-swarm
- team-testing

Six additional core meta skills are always installed with the `skills` component:
maestro-help, skill-generator, skill-iter-tune, skill-simplify, skill-tuning,
workflow-skill-designer.

---

## Install Modes

### Global Mode (recommended)

Installs to `~/.maestro/`, shared across all projects:

```bash
maestro install --mode global
```

Best for: personal dev machines, multi-project shared configuration

### Project Mode

Installs to project directory `.workflow/`, only affects the current project:

```bash
maestro install --mode project
```

Best for: team collaboration, project-specific configuration

---

## Subcommands

`maestro install` provides the following subcommands for direct access to specific install steps:

| Subcommand | Description |
|------------|-------------|
| `maestro install components` | Install file components (interactive component selection) |
| `maestro install hooks` | Install hooks (interactive level selection) |
| `maestro install mcp` | Register MCP server (interactive tool selection) |
| `maestro install toggle` | Enable/disable installed commands, skills, and agents |
| `maestro install fonts` | Install font resources |
| `maestro install wizard` | Launch full interactive TUI wizard (legacy) |

Each subcommand supports `--global` or `--path <dir>` to specify the install scope.

---

## Toggle — Enable/Disable Management

`maestro install toggle` provides both an interactive TUI and non-interactive CLI flags to manage the enabled state of installed commands, skills, and agents.

### Three-State Model

Each item has three possible states:

| State | Icon | Meaning |
|-------|------|---------|
| **on** | ✓ | Installed and enabled |
| **off** | ✗ | Installed but disabled (file renamed to `.md.disabled`) |
| **available** | · | Present in source directory, not yet installed to target |

Disable mechanism: renames `.md` to `.md.disabled`; enable reverses the rename. For skills, disables `SKILL.md` → `SKILL.md.disabled`.

### Interactive TUI

```bash
# Toggle global installation items
maestro install toggle

# Toggle project installation items
maestro install toggle --path ./my-project
```

The ToggleView interface provides three tabs:

| Tab | Content |
|-----|---------|
| **Commands** | All `.claude/commands/*.md` command files |
| **Skills** | All `.claude/skills/*/SKILL.md` skill directories |
| **Agents** | All `.claude/agents/*.md` agent files |

Controls:
- **Tab** — switch tabs (Shift+Tab for reverse)
- **Space** — toggle current item state (available→on, on→off, off→on)
- **Up/Down arrows** — move cursor
- **Enter** — save and exit (updates disabledItems in manifest)
- **Escape** — exit (auto-saves if there are unsaved changes)

Viewport window: when items exceed 20, scroll indicators appear (↑ N more / ↓ N more).

Use `--type` to restrict to a single tab:

```bash
# Only show the commands tab
maestro install toggle --type command
```

### Non-Interactive Operations

```bash
# List all items with their status
maestro install toggle --list

# Filter by type
maestro install toggle --list --type skill

# Batch enable
maestro install toggle --enable "maestro-ralph,maestro-search"

# Batch disable
maestro install toggle --disable "team-swarm,team-review"
```

---

## Config Profile — Export/Import

Install configuration can be exported as a JSON profile file for team sharing or CI environment reproduction.

### Export Profile

```bash
# Export from global install config
maestro install --export

# Export to a specific path
maestro install --export ./team-profile.json

# Export from project config
maestro install --path ./my-project --export
```

Exported profiles include: component selection, hook levels, MCP configuration, statusline theme, and all other install settings.

### Import Profile

```bash
# Non-interactive install from profile
maestro install --import ./team-profile.json
```

Import triggers a complete install flow automatically with no human intervention. Ideal for:
- Unified team development environments
- CI/CD environment quick setup
- Multi-machine configuration sync

### Profile Storage

Exported profiles are saved to `~/.maestro/install-profiles/` by default.

---

## Extra MCP Targets

In addition to Claude Code, `maestro install` supports registering the MCP server to the following IDEs/tools:

| Target ID | Config Path | Description |
|-----------|-------------|-------------|
| `cursor` | `.cursor/mcp.json` | Cursor IDE |
| `qoder` | Root `mcp.json` | Qoder |
| `trae` | `.mcp.json` | Trae IDE |
| `kiro` | `.kiro/settings/mcp.json` | Kiro IDE |
| `roo` | `.roo/mcp.json` | Roo Code (project-level only) |
| `vscode-copilot` | `.vscode/mcp.json` | VS Code Copilot |
| `gemini-cli` | `.gemini/settings.json` | Gemini CLI |

In the interactive install wizard, the Extra MCP step lets you select which targets to register. Each target supports both global and project scopes.

MCP tools (6): `write_file`, `edit_file`, `read_file`, `read_many_files`, `team_msg`, `store_knowhow`

---

## Migrating from Older Versions

### v0.5.32+ Auto-Migration

Legacy individual skill IDs are automatically mapped to new group IDs:

| Old ID | New ID |
|--------|--------|
| team-arch-opt / team-issue / team-perf-opt | skills-team (now built-in) |
| team-brainstorm and other deleted team skills | skills-extra-team (legacy no-op bundle) |
| prompt-generator / delegation-check | skills-meta (legacy no-op bundle) |
| scholar-ideation and other scholar-* | skills-scholar |
| ... | ... |

Migration runs automatically during install, no manual action needed.

### Manual Migration

To manually update:

```bash
# Force reinstall
maestro install --force
```

---

## Update

```bash
# Check for updates
maestro update

# Preview changes (no apply)
maestro update --dry-run

# Force overwrite
maestro update --force
```

---

## Uninstall

```bash
# Interactive uninstall
maestro uninstall

# Batch uninstall (skip confirmation)
maestro uninstall --yes
```

Uninstall will:
1. Remove installed component files
2. Clean up manifest records
3. Preserve project data in `.workflow/` (specs, knowhow, etc.)

---

## Network Proxy

To install through a proxy, configure in `~/.maestro/cli-tools.json`:

```json
{
  "proxy": {
    "enabled": true,
    "httpProxy": "http://127.0.0.1:7890",
    "noProxy": "127.0.0.1,localhost"
  }
}
```

---

## FAQ

### Install hangs

1. Check network connection
2. Try configuring a proxy (see above)
3. Use `--verbose` for detailed logs

### Missing components

```bash
# Force reinstall
maestro install --force
```

### Permission errors

Global install may require admin privileges:
```bash
# macOS/Linux
sudo npm install -g maestro-flow

# Windows (run as Administrator)
npm install -g maestro-flow
```

---

## Related Commands

```bash
# Install management
maestro install [--mode global|project] [--force]
maestro install [--export [path]] [--import <path>]
maestro uninstall [--yes]
maestro update [--dry-run] [--force]

# Subcommands
maestro install components [--global | --path <dir>]
maestro install hooks [--global | --project]
maestro install mcp [--global | --path <dir>]
maestro install toggle [--global | --path <dir>] [--type <type>] [--enable <names>] [--disable <names>] [--list]
maestro install fonts
maestro install wizard

# Version info
maestro --version
```
