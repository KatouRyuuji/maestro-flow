// ---------------------------------------------------------------------------
// Entry command generator — thin skill wrappers over `maestro run`.
//
// A generated entry skill carries NO domain logic: its body is the Run
// lifecycle invocation (prepare → create → brief → execute → check → complete).
// All domain content lives in the step's prepare/<step>.md + workflows/<step>.md.
// Generated as SKILL.md (skill format); description marks it as internal-only
// (not for manual /command invocation).
//
// Consumed by:
//   - `maestro install entry-commands` (CLI, per-step selection via --steps)
//   - install TUI entry_commands_config step
// ---------------------------------------------------------------------------

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import YAML from 'yaml';

/** Steps generated when no explicit selection is given. */
export const DEFAULT_ENTRY_STEPS = [
  'grill', 'collab',
  'analyze', 'plan', 'execute',
  'test', 'auto-test', 'debug',
  'odyssey-debug', 'odyssey-improve', 'odyssey-planex', 'odyssey-review', 'odyssey-ui',
];

export interface EntryStepInfo {
  step: string;
  description: string;
  argumentHint: string;
  preparePath: string;
}

function parseFrontmatter(raw: string): Record<string, unknown> {
  const match = raw.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  try {
    const parsed = YAML.parse(match[1]);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

/**
 * Scan pkgRoot for steps eligible for entry skill generation:
 * a step qualifies when both prepare/<step>.md and workflows/<step>.md exist.
 */
export function scanEntrySteps(pkgRoot: string): EntryStepInfo[] {
  const prepareDir = join(pkgRoot, 'prepare');
  if (!existsSync(prepareDir)) return [];
  const steps: EntryStepInfo[] = [];
  for (const entry of readdirSync(prepareDir)) {
    if (!entry.endsWith('.md')) continue;
    const step = basename(entry, '.md');
    if (!existsSync(join(pkgRoot, 'workflows', `${step}.md`))) continue;
    const preparePath = join(prepareDir, entry);
    const fm = parseFrontmatter(readFileSync(preparePath, 'utf-8'));
    steps.push({
      step,
      description: typeof fm.description === 'string' ? fm.description : `Run step ${step}`,
      argumentHint: typeof fm['argument-hint'] === 'string' ? fm['argument-hint'] : '',
      preparePath,
    });
  }
  return steps;
}

/** Skill name: odyssey-* steps keep their own name; others get maestro- prefix. */
export function entrySkillName(step: string): string {
  return step.startsWith('odyssey-') ? step : `maestro-${step}`;
}

export function renderEntryCommand(info: EntryStepInfo): string {
  const skillName = entrySkillName(info.step);
  const hint = info.argumentHint ? `argument-hint: ${JSON.stringify(info.argumentHint)}\n` : '';
  const desc = `Internal maestro run entry for step "${info.step}" — lifecycle wrapper only. Do NOT invoke manually; triggered by maestro run orchestration. ${info.description}`;
  return `---
name: ${skillName}
description: ${JSON.stringify(desc)}
${hint}allowed-tools:
  - Read
  - Write
  - Edit
  - Bash
  - Glob
  - Grep
  - Agent
  - AskUserQuestion
session-mode: run
generated-by: maestro install entry-commands
step: ${info.step}
---

<required_reading>
@~/.maestro/workflows/run-mode.md
</required_reading>

<purpose>
Entry skill for step \`${info.step}\` — a thin wrapper over the Run lifecycle. All domain logic lives in the step's prepare/workflow files; this skill only drives the run verbs.
This skill is for internal orchestration use only. Do not invoke it manually.
</purpose>

<execution>
1. \`maestro run prepare ${info.step}\` — read the returned pre-task thinking (purpose, contract, boundaries, risks) before doing anything. Note the returned \`workflow.path\`.
2. Follow run-mode.md: compose an ASCII session slug \`YYYYMMDD-${info.step}-{topic}\`, then run:
   \`maestro run start "<one-line goal>" --cmd ${info.step} --session <slug> [--arg "<command input>"]\`
   Intent text is Session metadata only and never enters the target command's \`Run input.args\`. When the command contract or \`argument-hint\` requires inputs, pass them with repeatable \`--arg <value>\`; use lower-level \`maestro run create\` only when a compatibility caller needs raw positional passthrough after \`--\`.
   Retain the returned \`run_id\`, \`run_dir\`, and \`upstream\`.
3. (Optional) \`maestro run brief <run_id>\` — re-attach the execution manual, goals, gate status, and upstream handoff. Recommended when resuming a Run or consuming upstream artifacts; a fresh Run with no upstream may instead read \`workflow.path\` from step 1 directly and skip this.
4. Execute the workflow completely. Write formal artifacts to \`{run_dir}/outputs/\`.
5. \`maestro run check <run_id>\` — repair any blocking artifact or exit gate it reports.
6. \`maestro run done <run_id>\` — report success only after the Run is completed.
</execution>
`;
}

/**
 * Generate entry skills for the given steps into targetDir
 * (a skills directory, e.g. `.pi/skills`). Each step produces
 * `<targetDir>/maestro-<step>/SKILL.md`. Unknown step names are skipped.
 */
export function buildEntryCommands(
  pkgRoot: string,
  targetDir: string,
  steps: string[] = DEFAULT_ENTRY_STEPS,
): { files: number; written: string[]; unknown: string[] } {
  const eligible = new Map(scanEntrySteps(pkgRoot).map(info => [info.step, info]));
  const written: string[] = [];
  const unknown: string[] = [];
  for (const step of steps) {
    const info = eligible.get(step);
    if (!info) {
      unknown.push(step);
      continue;
    }
    const skillDir = join(targetDir, entrySkillName(step));
    mkdirSync(skillDir, { recursive: true });
    const outPath = join(skillDir, 'SKILL.md');
    writeFileSync(outPath, renderEntryCommand(info), 'utf-8');
    written.push(outPath);
  }
  return { files: written.length, written, unknown };
}
