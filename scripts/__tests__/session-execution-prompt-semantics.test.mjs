import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { validateExecutionPromptSemantics } from '../session-execution-prompt-semantics.mjs';

const repoRoot = process.cwd();
const fixtureFiles = [
  'workflows/run-mode.md',
  'workflows/run-mode-lite.md',
  'workflows/orchestrator-run-loop.md',
  'workflows/ralph.md',
  'workflows/ralph-amend-goal.md',
  'workflows/codex-run-mode.md',
  'workflows/claude-instructions.md',
  'workflows/agy-instructions.md',
  'workflows/codex-instructions.md',
  'prepare/ralph.md',
  '.claude/commands/maestro-ralph.md',
  '.claude/skills/skill-generator/SKILL.md',
  '.claude/skills/skill-generator/phases/02-structure-generation.md',
  '.claude/skills/skill-iter-tune/SKILL.md',
  '.claude/skills/skill-iter-tune/phases/05-report.md',
  '.claude/skills/skill-tuning/SKILL.md',
  '.claude/skills/skill-tuning/phases/actions/action-complete.md',
  '.claude/skills/team-coordinate/SKILL.md',
  '.claude/skills/team-coordinate/roles/coordinator/commands/monitor.md',
  '.claude/skills/team-swarm/SKILL.md',
  '.claude/skills/team-swarm/roles/coordinator/commands/converge.md',
  'src/core/entry-command-generator.ts',
  'src/run/runtime.ts',
];
const tempRoots = [];

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), 'session-execution-prompts-'));
  tempRoots.push(root);
  for (const relativePath of fixtureFiles) {
    const target = join(root, relativePath);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(repoRoot, relativePath), target);
  }
  return root;
}

function replace(root, relativePath, before, after, all = false) {
  const path = join(root, relativePath);
  const text = readFileSync(path, 'utf8');
  expect(text).toContain(before);
  writeFileSync(path, all ? text.replaceAll(before, after) : text.replace(before, after));
}

afterEach(() => {
  while (tempRoots.length > 0) rmSync(tempRoots.pop(), { recursive: true, force: true });
});

describe('Session identity plus bounded Execution prompt semantics', () => {
  it('passes independently of unrelated prepare contract lint', () => {
    expect(validateExecutionPromptSemantics(repoRoot)).toEqual([]);
  });

  it('fails focused mutations that remove or regress Execution authority', () => {
    const cases = [
      {
        name: 'full capability negotiation',
        path: 'workflows/run-mode.md',
        before: 'maestro capabilities --json',
        after: 'maestro legacy-capabilities --json',
        expected: /workflows\/run-mode\.md: missing Execution semantic token: maestro capabilities --json/,
      },
      {
        name: 'lite Run completion',
        path: 'workflows/run-mode-lite.md',
        before: 'maestro run complete',
        after: 'maestro legacy complete',
        all: true,
        expected: /workflows\/run-mode-lite\.md: missing Execution semantic token: maestro run complete/,
      },
      {
        name: 'orchestrator revision fence',
        path: 'workflows/orchestrator-run-loop.md',
        before: '--expected-orchestration-revision',
        after: '--expected-session-revision',
        all: true,
        expected: /workflows\/orchestrator-run-loop\.md: missing Execution semantic token: --expected-orchestration-revision/,
      },
      {
        name: 'Ralph v3 resume packet',
        path: 'prepare/ralph.md',
        before: 'brief-result/3.0',
        after: 'brief-result/1.1',
        all: true,
        expected: /prepare\/ralph\.md: missing Execution semantic token: brief-result\/3\.0/,
      },
      {
        name: 'Ralph amendment Session mutation',
        path: 'workflows/ralph-amend-goal.md',
        before: '## 4. Commit the Amendment',
        after: 'maestro session meta update --session {session_id}\n\n## 4. Commit the Amendment',
        expected: /workflows\/ralph-amend-goal\.md: canonical new-runtime path contains canonical Session amendment mutation/,
      },
      {
        name: 'session-source sealed Session regression',
        path: 'workflows/run-mode.md',
        before: 'A `session/3.0` session-source candidate does **not** require Session completion.',
        after: 'A session-source candidate requires the Session itself sealed.',
        expected: /workflows\/run-mode\.md: canonical new-runtime path contains Session seal promotion prerequisite/,
      },
    ];

    for (const testCase of cases) {
      const root = createFixture();
      replace(root, testCase.path, testCase.before, testCase.after, testCase.all);
      const errors = validateExecutionPromptSemantics(root).join('\n');
      expect(errors, testCase.name).toMatch(testCase.expected);
    }
  }, 30_000);

  it('rejects abbreviated canonical v3 Run completion examples without their executable option set', () => {
    const root = createFixture();
    replace(
      root,
      'workflows/run-mode.md',
      'maestro run complete {run_id} --session {session_id} --participant {actor_id} --actor {actor_id} --request-id {complete_request_id} --reason "<reason>" [--evidence <ref> ...] --expected-orchestration-revision {orchestration_revision} --expected-run-revision {run_revision} --verdict {done|done_with_concerns} [--summary "<summary>"] --advance --json',
      'maestro run complete {run_id} --session {session_id} ... --json',
    );
    expect(validateExecutionPromptSemantics(root).join('\n')).toMatch(
      /workflows\/run-mode\.md: executable canonical maestro run complete is missing required options:/,
    );
  });

  it('recursively rejects nested legacy Session lifecycle commands owned by active importers', () => {
    for (const relativePath of [
      '.claude/skills/skill-generator/phases/02-structure-generation.md',
      '.claude/skills/skill-iter-tune/phases/05-report.md',
      '.claude/skills/skill-tuning/phases/actions/action-complete.md',
      '.claude/skills/team-coordinate/roles/coordinator/commands/monitor.md',
      '.claude/skills/team-swarm/roles/coordinator/commands/converge.md',
    ]) {
      const root = createFixture();
      replace(root, relativePath, '\n', '\nmaestro session done {run_id}\n');
      expect(validateExecutionPromptSemantics(root).join('\n'), relativePath).toMatch(
        new RegExp(`${relativePath.replaceAll('.', '\\.').replaceAll('/', '\\/')}: canonical new-runtime path contains Session lifecycle mutation command`),
      );
    }
  });

  it('preserves labeled legacy branches and ignores an inactive odyssey-ui alias', () => {
    const root = createFixture();
    replace(
      root,
      '.claude/skills/skill-generator/phases/02-structure-generation.md',
      '\n',
      '\n## Legacy `session/1.x` Compatibility Branch\n\nmaestro session done {run_id}\n',
    );
    mkdirSync(join(root, 'workflows'), { recursive: true });
    writeFileSync(
      join(root, 'workflows/odyssey-ui.md'),
      '<!-- session-mode: inherited -->\nmaestro session done dead-alias\n',
    );
    expect(validateExecutionPromptSemantics(root)).toEqual([]);
  });

  it('rejects Session lifecycle commands in the canonical branch but permits the labeled legacy branch', () => {
    const cleanRoot = createFixture();
    expect(validateExecutionPromptSemantics(cleanRoot)).toEqual([]);

    const regressedRoot = createFixture();
    replace(
      regressedRoot,
      'workflows/orchestrator-run-loop.md',
      '## Lifecycle',
      'maestro session seal {session_id} --summary "regression"\n\n## Lifecycle',
    );
    expect(validateExecutionPromptSemantics(regressedRoot).join('\n')).toMatch(
      /workflows\/orchestrator-run-loop\.md: canonical new-runtime path contains Session lifecycle mutation command/,
    );
  });
});
