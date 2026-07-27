#!/usr/bin/env node
// ---------------------------------------------------------------------------
// build-codex-skills.mjs
//
// Regenerates the .codex/skills/ mirror from .claude/. Outputs:
//   .codex/skills/<name>/SKILL.md   ← from .claude/commands/<name>.md
//   .codex/skills/<name>/           ← from .claude/skills/<name>/ (directory copy)
//
// Unlike convert-claude-to-agy.mjs and build-agents-standard.mjs — which
// reimplement their conversions inline — this script delegates to the canonical
// converter in src/core/skill-converter.ts (buildCodexSkills → CODEX_PROFILE),
// the same implementation the install pipeline uses for .codex/agents/. Keeping
// one implementation avoids the codex conversion rules drifting away from the
// runtime ones.
//
// That reuse costs a build dependency: the compiled converter must exist under
// dist/ before this runs. `prepublishOnly` already runs `npm run build` ahead of
// `build:mirrors`; standalone runs need `npm run build` first.
//
// Must run BEFORE sync-codex-run-mode.mjs --write: the converter emits skill
// bodies only, while that script layers on `version` and the Run `contract`
// block. Reversing the order strips those fields and fails the mirror lint.
//
// Idempotent.
//
// Usage:
//   node scripts/build-codex-skills.mjs
// ---------------------------------------------------------------------------

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(__dirname);

const CLAUDE_DIR = join(REPO_ROOT, '.claude');
const CODEX_SKILLS_DIR = join(REPO_ROOT, '.codex', 'skills');
const CONVERTER = join(REPO_ROOT, 'dist', 'src', 'core', 'skill-converter.js');

async function main() {
  if (!existsSync(CONVERTER)) {
    console.error(`Missing ${CONVERTER}`);
    console.error('Run `npm run build` first — this script reuses the compiled converter.');
    process.exit(1);
  }

  const { buildCodexSkills } = await import(pathToFileURL(CONVERTER).href);
  const { files } = buildCodexSkills(CLAUDE_DIR, CODEX_SKILLS_DIR);

  console.error('');
  console.error('Done.');
  console.error(`  files written: ${files}`);
  console.error('');
  console.error('Next: run sync-codex-run-mode.mjs --write to restore version + contract frontmatter.');
}

main();
