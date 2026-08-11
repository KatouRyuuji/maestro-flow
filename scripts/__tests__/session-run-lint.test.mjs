import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import {
  classifySessionRunProfile,
  RUN_MODE_LITE_REF,
  RUN_MODE_REF,
} from '../session-run-profiles.mjs';
import { lintSessionRunMirrors } from '../lint-session-run-mirrors.mjs';
import {
  validateCompanionRunCreate,
  validateConsumesSchema,
  validateExecutorLifecycleBoundary,
  validateRunCreateArgumentChannels,
} from '../lint-session-run-prompts.mjs';

const fm = (mode, body = '', extra = '') => `---\nname: demo\nsession-mode: ${mode}\n${extra}---\n${body}`;

test('classifies the full/lite/inherited/child/canonical/neutral profile matrix', () => {
  const rows = [
    { path: '.claude/commands/demo.md', kind: 'command', text: fm('run', RUN_MODE_REF), profile: 'full' },
    { path: '.claude/skills/team-demo/SKILL.md', kind: 'skill', text: fm('run', RUN_MODE_LITE_REF), profile: 'lite' },
    { path: '.claude/skills/team-demo/roles/x.md', kind: 'skill-child', text: '# child', profile: 'child-neutral' },
    { path: '.claude/skills/demo/phases/x.md', kind: 'skill-child', text: RUN_MODE_REF, profile: 'inherited-neutral' },
    { path: 'workflows/run-mode.md', kind: 'workflow', text: '<!-- session-mode: inherited -->', profile: 'canonical-full' },
    { path: 'workflows/run-mode-lite.md', kind: 'workflow', text: '<!-- session-mode: inherited -->', profile: 'canonical-lite' },
    { path: 'workflows/task-tracking.md', kind: 'workflow', text: '<!-- session-mode: none -->', profile: 'neutral' },
    { path: 'workflows/odyssey-debug.md', kind: 'workflow', text: fm('inherited', '# workflow', 'prepare: odyssey-debug\n'), profile: 'inherited-neutral' },
  ];
  for (const row of rows) {
    const result = classifySessionRunProfile(row);
    assert.equal(result.profile, row.profile, row.path);
    assert.deepEqual(result.errors, [], row.path);
  }
});

test('rejects missing and mixed lifecycle ownership with stable diagnostic families', () => {
  const missing = classifySessionRunProfile({
    path: '.claude/commands/demo.md', kind: 'command', text: fm('run', '# no reference'),
  });
  assert.match(missing.errors.join('\n'), /missing canonical workflow reference/);
  const mixed = classifySessionRunProfile({
    path: '.claude/skills/team-demo/SKILL.md', kind: 'skill', text: fm('run', `${RUN_MODE_REF}\n${RUN_MODE_LITE_REF}`),
  });
  assert.match(mixed.errors.join('\n'), /both full and lite/);
});

test('canonical Run creation lint separates Session metadata from command inputs', () => {
  const complete = '--intent is Session metadata only; use --arg <value> or -- <args...>.';
  assert.deepEqual(validateRunCreateArgumentChannels(complete, 'fixture.md'), []);

  const missing = validateRunCreateArgumentChannels(
    '--intent is Session metadata only; command inputs are positional.',
    'fixture.md',
  );
  assert.ok(missing.includes('fixture.md: missing --arg <value>'));
  assert.ok(missing.includes('fixture.md: missing -- <args...>'));
});

test('Companion creation lint requires intent in both metadata and command args', () => {
  const complete = 'maestro run create companion --intent "<intent>" --arg "<intent>"; required command arguments are validated.';
  assert.deepEqual(validateCompanionRunCreate(complete, 'fixture.md'), []);

  const missing = validateCompanionRunCreate(
    'maestro run create companion --intent "<intent>"; required command arguments are validated.',
    'fixture.md',
  );
  assert.ok(missing.includes('fixture.md: missing --arg "<intent>"'));
});

test('Run executor lint keeps completion ownership with the orchestrator', () => {
  const complete = [
    'maestro run brief <run-id>',
    'maestro run check <run-id>',
    'Do not call `maestro session done` or `maestro run complete` — completion is handled by the orchestrator',
  ].join('\n');
  assert.deepEqual(validateExecutorLifecycleBoundary(complete, 'executor.md'), []);

  const missing = validateExecutorLifecycleBoundary(
    'maestro run brief <run-id>\nmaestro run check <run-id>',
    'executor.md',
  );
  assert.ok(missing.includes('executor.md: missing Do not call `maestro session done`'));
  assert.ok(missing.includes('executor.md: missing handled by the orchestrator'));
});

test('mirror lint reports a deterministic missing-root diagnostic', () => {
  const root = mkdtempSync(join(tmpdir(), 'session-run-mirror-'));
  try {
    writeFileSync(join(root, 'package.json'), '{"version":"1.0.0"}');
    mkdirSync(join(root, '.claude', 'commands'), { recursive: true });
    mkdirSync(join(root, '.claude', 'skills'), { recursive: true });
    mkdirSync(join(root, '.agy', 'skills'), { recursive: true });
    mkdirSync(join(root, '.codex', 'skills'), { recursive: true });
    const errors = lintSessionRunMirrors(root);
    assert.ok(errors.includes('.agents/skills: missing mirror root'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('mirror lint detects lifecycle profile divergence', () => {
  const root = mkdtempSync(join(tmpdir(), 'session-run-profile-'));
  try {
    writeFileSync(join(root, 'package.json'), '{"version":"1.0.0"}');
    mkdirSync(join(root, '.claude', 'commands'), { recursive: true });
    mkdirSync(join(root, '.claude', 'skills'), { recursive: true });
    const source = fm('run', RUN_MODE_REF, 'contract:\n  consumes: []\n  produces: []\n  gates:\n    entry: []\n    exit: []\n');
    writeFileSync(join(root, '.claude', 'commands', 'demo.md'), source);
    for (const mirror of ['.agy', '.agents', '.codex']) {
      const dir = join(root, mirror, 'skills', 'demo');
      mkdirSync(dir, { recursive: true });
      const target = mirror === '.codex'
        ? fm('run', RUN_MODE_LITE_REF, 'version: 1.0.0\ncontract:\n  consumes: []\n  produces: []\n  gates:\n    entry: []\n    exit: []\n')
        : source;
      writeFileSync(join(dir, 'SKILL.md'), target);
    }
    assert.ok(lintSessionRunMirrors(root).some(error => error.includes('lifecycle profile lite diverges from full')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('source lint accepts alias-free Odyssey workflows while enforcing prepare associations', () => {
  const repoRoot = process.cwd();
  const output = execFileSync(process.execPath, [join(repoRoot, 'scripts', 'lint-session-run-prompts.mjs')], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  assert.match(output, /session-run prompt lint passed/);
  for (const mode of ['debug', 'improve', 'planex', 'review', 'ui']) {
    const text = readFileSync(join(repoRoot, 'workflows', `odyssey-${mode}.md`), 'utf8');
    assert.match(text, new RegExp(`prepare:\\s*odyssey-${mode}`));
    assert.doesNotMatch(text, /^commands:/m);
  }

  const teamSkillRoot = join(repoRoot, '.claude', 'skills');
  const teamStateReferences = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && entry.name.endsWith('.md') && /team-state\.json|(?<!team-)session\.json/.test(readFileSync(path, 'utf8'))) {
        teamStateReferences.push(path);
      }
    }
  };
  for (const entry of readdirSync(teamSkillRoot, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name.startsWith('team-')) walk(join(teamSkillRoot, entry.name));
  }
  assert.deepEqual(teamStateReferences, []);

  const lite = readFileSync(join(repoRoot, 'workflows', 'run-mode-lite.md'), 'utf8');
  assert.match(lite, /team-session\.json.*single coordinator-owned state file/);
  assert.match(lite, /complete top-level `_meta` object/);
  assert.match(lite, /`kind` and `schema` are required together/);
  assert.match(lite, /maestro knowledge stage knowhow/);
  assert.match(lite, /--signal cited\|validated\|contradicted --signal-ids <knowledge-ids>/);
  assert.match(lite, /maestro knowledge review <session_id>/);

  const full = readFileSync(join(repoRoot, 'workflows', 'run-mode.md'), 'utf8');
  assert.match(full, /complete top-level `_meta` object/);
  assert.match(full, /`kind` and `schema` are required together/);
  assert.match(full, /Session is a durable \*\*topic grouping\/index\*\*/);
  assert.match(full, /same Session.*canonical `upstream`\/Artifact Registry map/);
  assert.match(full, /Historical similarity is read-only evidence/);
  assert.match(full, /Completion atomically seals the Run and stages handoff-derived knowledge candidates.*never promotes project knowledge, executes the suggested next action, or creates another Run/);
  assert.match(full, /deprecated admin-only compatibility commands/);
  assert.match(full, /compact `knowledge_context` reconciliation card/);
  assert.match(full, /`brief-result\/1\.1` Resume Packet/);
  assert.match(full, /knowledge-candidate-receipt\/1\.0/);
  assert.match(full, /Routine Run completion MUST NOT call `maestro spec add` or `maestro knowhow add` directly/);
  assert.doesNotMatch(full, /same normalized intent/);

  const seal = readFileSync(join(repoRoot, '.claude', 'commands', 'maestro-session-seal.md'), 'utf8');
  assert.match(seal, /maestro knowledge review \{session_id\} --json/);
  assert.match(seal, /maestro knowledge promote \{session_id\} --candidate/);
  assert.doesNotMatch(seal, /Scan session artifacts|recommend `\/maestro-spec add/);

  const maestro = readFileSync(join(repoRoot, '.claude', 'commands', 'maestro.md'), 'utf8');
  assert.match(maestro, /argument-hint: "<intent> \[-y\] \[-c\] \[--amend\] \[--dry-run\]"/);
  assert.match(maestro, /Compatibility commands are out of band/);
  assert.match(maestro, /Historical similarity remains read-only evidence/);
  assert.doesNotMatch(maestro, /resolved paused Session.*maestro session resume/);
  assert.doesNotMatch(maestro, /offer confirmation-token fork\/import/);

  const ralph = readFileSync(join(repoRoot, '.claude', 'commands', 'maestro-ralph.md'), 'utf8');
  assert.match(ralph, /argument-hint: "<intent> \[-y\] \[-c\] \[--amend\]"/);
  assert.match(ralph, /Sessions are topic grouping\/indexes/);
  assert.match(ralph, /Compatibility commands are out of band/);
  assert.match(ralph, /canonical upstream map/);
  assert.doesNotMatch(ralph, /Read state\.json\.artifacts/);
  for (const prompt of [maestro, ralph]) {
    assert.doesNotMatch(prompt, /maestro ralph\s/);
  }

  const codexMaestro = readFileSync(join(repoRoot, '.codex', 'skills', 'Maestro', 'SKILL.md'), 'utf8');
  const codexRalph = readFileSync(join(repoRoot, '.codex', 'skills', 'maestro-ralph', 'SKILL.md'), 'utf8');
  for (const prompt of [codexMaestro, codexRalph]) {
    assert.match(prompt, /argument-hint: <intent> \[-y\] \[-c\] \[--amend\]/);
    assert.doesNotMatch(prompt, /maestro ralph\s/);
  }
  for (const prompt of [ralph, codexRalph]) {
    for (const token of [
      'S_INFER → S_DECOMPOSE → S_ASSESS → S_BUILD → S_CREATE',
      '### A_INFER',
      '### A_DECOMPOSE',
      '### A_ASSESS',
      'confidence_score',
      'risk ≠ high AND confidence_score ≥ 60',
      'Confidence below 60 cannot enter S_RUN_LOOP',
      'at least 2 independently releasable milestones',
      '--platform {target_platform}',
      'pi-maestro-flow',
    ]) {
      assert.match(prompt, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }
    assert.doesNotMatch(prompt, /maestro skills --steps --json --platform claude/);
  }

  const orchestratorLoop = readFileSync(join(repoRoot, 'workflows', 'orchestrator-run-loop.md'), 'utf8');
  for (const token of [
    '## Continuation Router',
    'Turn 终止不变量',
    'authority=automatic',
    'authority=auto_mode_only',
    'authority=user_required',
    'assessment.acceptance_status=accepted',
    '`QUALITY_MEDIUM`',
    'handoff `next[]`',
    '### `complete` / `decide` 闭环',
    'run_already_created=true',
    'session decide --json',
    'reason_code=DECISION_CARD_READY',
  ]) {
    assert.match(orchestratorLoop, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.match(ralph, /Decision is mandatory/);
  assert.match(ralph, /every Ralph-created chain/);
  assert.match(ralph, /session decide --json/);
  assert.match(ralph, /session done --json/);
  const amendFlow = readFileSync(join(repoRoot, 'workflows', 'ralph-amend-goal.md'), 'utf8');
  assert.match(amendFlow, /maestro session meta update --session \{session_id\} --decomposition-file -/);
  assert.match(amendFlow, /maestro session next --session \{session_id\} --pick \{plan_step_id\} --inline-brief --json/);
  assert.match(amendFlow, /maestro run create plan --session \{session_id\} --arg "\{change_request\}"/);
  assert.doesNotMatch(amendFlow, /session start --chain plan/);
  const ralphPrepare = readFileSync(join(repoRoot, 'prepare', 'ralph.md'), 'utf8');
  assert.match(ralphPrepare, /\| init \| `init` \|/);
  assert.match(ralphPrepare, /\| specs-setup \| `specs-setup` \|/);
  assert.match(ralphPrepare, /--platform \{target_platform\}/);
  assert.match(ralphPrepare, /package\.json#pi\.skills/);
  assert.doesNotMatch(ralphPrepare, /maestro skills --steps --json --platform claude/);
  const maestroPrepare = readFileSync(join(repoRoot, 'prepare', 'maestro.md'), 'utf8');
  assert.match(maestroPrepare, /--platform \{target_platform\}/);
  assert.match(maestroPrepare, /package\.json#pi\.skills/);
  assert.doesNotMatch(maestroPrepare, /maestro skills --steps --json --platform claude/);
  for (const workflow of [full, lite, orchestratorLoop, amendFlow]) {
    assert.doesNotMatch(workflow, /maestro ralph\s/);
    assert.doesNotMatch(workflow, /maestro run decide\s/);
    assert.doesNotMatch(workflow, /\bralph next\b/);
  }
});

test('package release gate orders source lint, generation, freshness, then parity', () => {
  const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));
  assert.ok(pkg.files.includes('.codex/agent-overrides'));
  const build = pkg.scripts['build:mirrors'];
  const ordered = [
    'lint-session-run-prompts.mjs',
    'convert-claude-to-agy.mjs',
    'build-agents-standard.mjs',
    'sync-codex-run-mode.mjs --write',
    'sync-codex-run-mode.mjs --check',
    'sync-codex-agents.mjs --check',
    'lint-session-run-mirrors.mjs',
  ];
  let cursor = -1;
  for (const token of ordered) {
    const next = build.indexOf(token, cursor + 1);
    assert.ok(next > cursor, `${token} must appear in safe order`);
    cursor = next;
  }
  assert.match(
    pkg.scripts.prepublishOnly,
    /^node scripts\/lint-invocation-policy\.mjs && node scripts\/lint-session-run-prompts\.mjs/,
  );
});

test('validateConsumesSchema rejects v2.1 consumes missing schema/role and versionless contracts', () => {
  const missingSchemaRole = validateConsumesSchema(
    { contract_version: 2.1, consumes: [{ kind: 'execution', alias: 'current-execution', required: true }] },
    'prepare/review.md',
  );
  assert.deepEqual(missingSchemaRole, [
    'prepare/review.md: consumes[0] kind=execution: missing schema (declare the producer artifact schema so reuse binds without a manual REVIEW)',
    'prepare/review.md: consumes[0] kind=execution: missing role for contract_version 2.1',
  ]);

  const versionless = validateConsumesSchema(
    { consumes: [{ kind: 'execution', required: true }] },
    'prepare/legacy.md',
  );
  assert.deepEqual(versionless, [
    'prepare/legacy.md: consumes without contract_version 2/2.1 parse as v1 where schema/role are metadata-only; declare contract_version: 2.1',
  ]);

  const v2SchemaOnly = validateConsumesSchema(
    { contract_version: 2, consumes: [{ kind: 'execution', alias: 'current-execution', schema: 'execution/1.0', required: true }] },
    'prepare/v2.md',
  );
  assert.deepEqual(v2SchemaOnly, []);

  const v21Complete = validateConsumesSchema(
    { contract_version: 2.1, consumes: [{ kind: 'execution', alias: 'current-execution', schema: 'execution/1.0', role: 'primary', required: true }] },
    'prepare/review.md',
  );
  assert.deepEqual(v21Complete, []);

  assert.deepEqual(validateConsumesSchema({ contract_version: 2.1, consumes: [] }, 'prepare/empty.md'), []);
});
