// scripts/sync-docs-reference.mjs
// Regenerates docs-site/src/content/docs/commands/reference.md from
// inventory-v2.json + .claude/commands/*.md frontmatter.
//
// Usage:
//   node scripts/sync-docs-reference.mjs          # write reference.md
//   node scripts/sync-docs-reference.mjs --check   # fail if out of sync (CI)

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join, dirname, basename } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const docsSite = join(root, 'docs-site');
const claudeCommands = join(root, '.claude', 'commands');
const claudeSkills = join(root, '.claude', 'skills');
const inventoryPath = join(docsSite, 'src/client/data/inventory-v2.json');
const inventoryV1Path = join(docsSite, 'src/client/data/inventory.json');
const referencePath = join(docsSite, 'src/content/docs/commands/reference.md');

function parseFrontmatter(markdown) {
  const m = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { frontmatter: {}, content: markdown };
  const fm = {};
  let currentKey = null;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([a-zA-Z][\w-]*):\s*(.*)$/);
    if (kv) {
      currentKey = kv[1];
      let val = kv[2].trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      fm[currentKey] = val;
    }
  }
  return { frontmatter: fm, content: m[2] };
}

function loadCommandFrontmatter(file) {
  const path = join(claudeCommands, basename(file));
  if (!existsSync(path)) return {};
  const md = readFileSync(path, 'utf8');
  return parseFrontmatter(md).frontmatter;
}

function listSkills(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(f => {
      const p = join(dir, f);
      return statSync(p).isDirectory() && existsSync(join(p, 'SKILL.md'));
    })
    .map(name => {
      const skillMd = readFileSync(join(dir, name, 'SKILL.md'), 'utf8');
      const fm = parseFrontmatter(skillMd).frontmatter;
      return { name, description: fm.description || fm.title || '', manualOnly: fm['disable-model-invocation'] === 'true' };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function esc(s) {
  return String(s || '').replace(/`/g, '\\`');
}

function generateReference() {
  const inv = JSON.parse(readFileSync(inventoryPath, 'utf8'));
  const categories = inv.categories || [];
  const commands = inv.commands || [];

  const byCat = {};
  for (const c of commands) {
    (byCat[c.category] = byCat[c.category] || []).push(c);
  }

  let out = '';
  out += '---\n';
  out += 'title: "Maestro Commands Quick Reference"\n';
  out += '---\n\n';
  out += '> Auto-generated from `inventory-v2.json` + `.claude/commands/*.md` frontmatter.\n';
  out += `> v2 (v0.5.51+): ${commands.length} commands across ${categories.length} categories.\n`;
  out += '> Do not edit by hand — run `npm run sync:docs-reference` to regenerate.\n\n';
  out += '---\n\n';

  // Commands by category
  for (const cat of categories) {
    const cmds = byCat[cat.id] || [];
    if (cmds.length === 0) continue;

    out += `## ${cat.name}\n\n`;
    out += `*${esc(cat.description)}*\n\n`;

    for (const cmd of cmds) {
      const fm = loadCommandFrontmatter(cmd.file || `${cmd.name}.md`);
      const desc = cmd.description || fm.description || '';
      const argHint = cmd.argumentHint || fm['argument-hint'] || '';
      const subcommands = cmd.subcommands || [];
      const invocation = fm['disable-model-invocation'] === 'false' ? 'Automatic entrypoint and explicit slash command' : 'Explicit routing or user slash command';

      out += `### \`${cmd.name}\`\n\n`;
      if (argHint) {
        out += `**Usage:** \`${esc(argHint)}\`\n\n`;
      }
      out += `${esc(desc)}\n`;
      out += `\n**Invocation:** ${invocation}\n`;
      if (subcommands.length > 0) {
        out += `\n**Subcommands:** ${subcommands.map(s => `\`${s}\``).join(', ')}\n`;
      }
      out += '\n';
    }
    out += '---\n\n';
  }

  // Skills sections
  const teamSkills = listSkills(claudeSkills).filter(s => s.name.startsWith('team-'));
  const scholarSkills = listSkills(claudeSkills).filter(s => s.name.startsWith('scholar-'));
  const metaSkills = listSkills(claudeSkills).filter(s =>
    !s.name.startsWith('team-') && !s.name.startsWith('scholar-')
  );

  function renderSkillSection(title, skills, note) {
    if (skills.length === 0) return '';
    let s = `## ${title}\n\n`;
    if (note) s += `*${note}*\n\n`;
    for (const sk of skills) {
      const invocation = sk.manualOnly ? 'manual or explicit orchestrator recommendation' : 'automatic';
      s += `- **\`${sk.name}\`** — ${esc(sk.description)} _(${invocation})_\n`;
    }
    s += '\n---\n\n';
    return s;
  }

  out += renderSkillSection('Team Skills', teamSkills,
    'Parallel multi-agent campaign ecosystems. Start them explicitly with `/team-*`; Maestro routers do not select them.');
  out += renderSkillSection('Scholar Skills', scholarSkills,
    'Academic writing & research skills in `.claude/skills/scholar-*`.');
  out += renderSkillSection('Meta Skills', metaSkills,
    'Skill tooling and prompt engineering in `.claude/skills/`.');

  // Migration footer
  const v1Count = JSON.parse(readFileSync(inventoryV1Path, 'utf8')).commands.length;
  out += '## v1 → v2 Migration\n\n';
  out += `> v0.5.51 consolidated ${v1Count} v1 commands into ${commands.length} v2 unified commands. `;
  out += 'For legacy v1 references, see `inventory.json` (v1 inventory). ';
  out += 'Key replacements:\n';
  out += '>\n';
  out += '> - `/maestro-plan`, `/maestro-execute`, `/maestro-analyze` → first-tier steps `plan`/`execute`/`analyze`, reached through `/maestro "<intent>"`, `/maestro-next`, or `/maestro-companion`\n';
  out += '> - `/quality-review`, `/quality-test`, `/quality-auto-test`, `/quality-debug`, `/quality-retrospective` → first-tier steps `review`/`test`/`auto-test`/`debug`/`retrospective`, dispatched by an orchestrator inside a Session chain (no slash form)\n';
  out += '> - `/quality-refactor` → `/maestro-odyssey --mode improve`; `/security-audit` → `/maestro-odyssey --mode security` (`--tier quick|standard|deep`, `--scope`)\n';
  out += '> - `/odyssey-debug`, `/odyssey-improve`, `/odyssey-planex`, `/odyssey-ui` → `/maestro-odyssey --mode <name>`; `/odyssey-review-test-fix` → `/maestro-odyssey --mode review`\n';
  out += '> - `/spec-add` → `/maestro-spec "<constraint>"`; `/spec-load` → `maestro spec load`; `/spec-setup` → `maestro run skill specs-setup` (skeleton only: `maestro spec init`); `/spec-remove` → step `specs-remove`\n';
  out += '>   The slash command records only — it has no load/remove/setup subcommands. Spec management as a whole is not add-only: it lives on the CLI (`maestro spec load|list|search|init|status|add|injection|conflict|supersede|history|health|analytics`) and in the sibling steps `specs-load`/`specs-remove`/`specs-setup`\n';
  out += '> - `/manage-issue` → `/maestro-issue`; `/manage-knowhow` → `/maestro-knowhow`; `/manage-harvest`, `/manage-wiki`, `/wiki-connect`, `/wiki-digest` → `/maestro-knowledge <op>`\n';
  out += '> - `/manage-status` → `maestro session status`; `/manage-codebase-rebuild`, `/manage-codebase-refresh`, `/manage-drift-realign`, `/quality-sync` → `maestro kg index`\n';
  out += '> - `/learn-follow`, `/learn-investigate`, `/learn-decompose` → `/maestro-learn <sub>`; `/learn-second-opinion` → `/maestro-learn consult`; `/learn-retro` → step `retrospective`\n';
  out += '> - `/maestro-collab` → first-tier step `collab`; `/maestro-ui-codify` → `/maestro-impeccable --codify`\n';
  out += '> - `/maestro-verify` → first-tier step `verify`; per-phase verification is also a built-in gate inside `execute`. `/maestro-quick`, `/workflow-lite-plan`, `/workflow-lite-execute` → `/maestro "<intent>"` (the coordinator picks the shortest chain)\n';
  out += '> - `/maestro-milestone-complete` → `/maestro-session-seal`. `/maestro-milestone-audit` has no 1:1 successor: the completion gate is `/maestro-session-seal` (it verifies every run is done); a deep cross-run audit is `/maestro-odyssey --mode review`\n';
  out += '> - `/maestro-amend` split in two: amending a Session goal → `/maestro-ralph`; generating a command overlay → `/maestro-overlay --amend`\n';
  out += '> - **Removed with no successor** — `/maestro-swarm-workflow`, `/maestro-universal-workflow`, `/maestro-tools-register`, `/maestro-tools-execute`, `/maestro-composer`, `/maestro-player`, `/maestro-link-coordinate` (now internalised as a hook). Do not substitute another command for these.\n';
  out += '>\n';
  out += '> First-tier steps have no `/xxx` slash form — an orchestrator dispatches them inside a Session chain. User entry is `/maestro "<intent>"` or `/maestro-next`.\n';
  out += '\n';

  return out;
}

const newContent = generateReference();
const checkMode = process.argv.includes('--check');

if (checkMode) {
  const existing = existsSync(referencePath) ? readFileSync(referencePath, 'utf8') : '';
  const normalizedExisting = existing.replace(/\r\n?/g, '\n');
  if (normalizedExisting !== newContent) {
    console.error('✗ reference.md is out of sync with inventory-v2.json + .claude/commands/');
    console.error('  Run: npm run sync:docs-reference');
    process.exit(1);
  }
  console.log('✓ reference.md is in sync');
} else {
  writeFileSync(referencePath, newContent);
  console.log(`✓ reference.md regenerated (${newContent.split('\n').length} lines)`);
}
