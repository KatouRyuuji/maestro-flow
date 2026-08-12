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
1. \`maestro run prepare ${info.step}\` - read the returned pre-task thinking and note \`workflow.path\`. This is read-only.
2. Follow \`run-mode.md\` exactly. Before any mutation, negotiate \`maestro capabilities --json\`; require the canonical \`session/2.0 + execution/1.0 + core_execution_lease + run-response/1.1\` contract, then use or acquire the exact current Execution. Retain \`session_id\`, \`execution_id\`, \`generation\`, revisions, private core claim, \`run_id\`, \`run_dir\`, and \`upstream\`. Never persist the raw lease token.
3. If an orchestrator birth packet already contains the exact Run locator, do NOT create another Run. Otherwise create the self-started Run through the Execution-aware \`maestro run create\` command in \`run-mode.md\`, passing required command inputs with repeatable \`--arg <value>\`; \`--intent\` is Session metadata only.
4. Optionally use \`maestro run brief <run_id> --session <session_id>\` for read-only re-attach/backtracking.
5. Execute the workflow completely. Write formal artifacts to \`{run_dir}/outputs/\`.
6. Run \`maestro run check <run_id> --session <session_id>\` and repair blocking gates.
7. If dispatched, return to the claim-holding orchestrator without completing. If self-started and still holding the exact current claim, complete through Execution-aware \`maestro run complete ... --json\`, consume the fresh \`run-response/1.1\` fence, then finish the bounded generation with \`maestro execution seal ... --json\`. Session lifecycle aliases are legacy compatibility only.
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
