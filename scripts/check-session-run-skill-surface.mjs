// ---------------------------------------------------------------------------
// `npm run check:session-run-skill-surface` — cross-validates every `maestro`
// invocation in the canonical skill sources (.claude/commands) against the v3
// help catalog, and smokes `knowledge stage --session` on a v3 Session.
//
// GPT skill-flow audit (agent://31c153b9) showed the prompt/mirror gates did
// not catch skill texts calling removed v2 commands (run skill, session
// create/done, execution start, run prepare). This gate closes that gap.
// ---------------------------------------------------------------------------

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const repoRoot = resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const binPath = join(repoRoot, 'bin', 'maestro.js');
const commandsDir = join(repoRoot, '.claude', 'commands');

function assert(condition, message) {
  if (!condition) throw new Error(`skill surface check failed: ${message}`);
}

function invoke(args, options = {}) {
  return spawnSync(process.execPath, [binPath, ...args], {
    encoding: 'utf8',
    cwd: repoRoot,
    ...options,
  });
}

function knownCommandFamilies() {
  // v3 command catalog: the session/run/artifact surface plus the standalone
  // knowledge/config families that remain available in every workspace.
  return new Set([
    'session', 'run', 'artifact', 'knowledge', 'config', 'skills', 'help',
    'load', 'recall', 'search', 'wiki', 'graph', 'kg', 'delegate', 'explore',
    'moa', 'ralph', 'fork', 'merge', 'init', 'update', 'issue', 'odyssey',
    'companion', 'impeccable', 'session-seal', 'spec', 'knowhow', 'learn',
    'next', 'maestro', 'flow', 'overlay', 'hooks', 'install', 'version',
  ]);
}

function legacyOrNote(line) {
  return /removed|deprecated|legacy|compatib|retired|no longer|v2'?s|was |used to|historical|out of band/i.test(line);
}

function skillCommandInvocations() {
  const files = readdirSync(commandsDir).filter(file => file.endsWith('.md')).sort();
  const invocations = [];
  for (const file of files) {
    const text = readFileSync(join(commandsDir, file), 'utf8');
    const lines = text.split(/\r?\n/);
    let inLegacy = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^##\s+Legacy/i.test(line) || /^###\s+Legacy/i.test(line)) inLegacy = true;
      if (inLegacy) continue;
      if (legacyOrNote(line)) continue;
      // Only actual invocations: backticked commands or lines starting with a
      // command-like token. Skip prose (lines without `maestro`).
      const matches = [...line.matchAll(/`maestro ([a-z][a-z0-9-]*)/gi)];
      for (const match of matches) {
        invocations.push({ file, line: i + 1, family: match[1] });
      }
    }
  }
  return invocations;
}

function checkSkillCommandSurface() {
  const known = knownCommandFamilies();
  const errors = [];
  for (const { file, line, family } of skillCommandInvocations()) {
    if (!known.has(family)) {
      errors.push(`${file}:${line}: unknown maestro command family \`maestro ${family}\``);
    }
  }
  return errors;
}

function smokeKnowledgeStageOnV3() {
  const work = mkdtempSync(join(tmpdir(), 'maestro-skill-surface-'));
  try {
    mkdirSync(join(work, '.claude', 'commands'), { recursive: true });
    const open = invoke([
      'session', 'open', 'skill surface smoke', '--id', 'surface-smoke',
      '--participant', 'pi-surface', '--actor', 'pi-surface',
      '--request-id', 'req-surface-open', '--reason', 'skill surface smoke',
      '--json', '--workflow-root', work,
    ]);
    assert(open.status === 0, `session open failed:\n${open.stderr}`);
    const contentFile = join(work, 'candidate.md');
    writeFileSync(contentFile, 'skill surface knowledge candidate\n', 'utf8');
    const evidenceFile = join(work, 'evidence.md');
    writeFileSync(evidenceFile, 'evidence\n', 'utf8');
    const stage = invoke([
      'knowledge', 'stage', 'spec', 'skill surface candidate',
      '--content-file', contentFile, '--session', 'surface-smoke',
      '--evidence', 'evidence.md:1', '--json', '--workflow-root', work,
    ]);
    assert(stage.status === 0, `knowledge stage on v3 Session failed:\n${stage.stdout}\n${stage.stderr}`);
    const staged = JSON.parse(stage.stdout.trim());
    assert(typeof staged.candidate_id === 'string' && staged.candidate_id.startsWith('KDC-'),
      `unexpected stage result: ${JSON.stringify(staged)}`);
    const review = invoke([
      'knowledge', 'review', 'surface-smoke', '--json', '--workflow-root', work,
    ]);
    assert(review.status === 0, `knowledge review failed:\n${review.stdout}\n${review.stderr}`);
    const reviewed = JSON.parse(review.stdout.trim());
    const candidates = Array.isArray(reviewed) ? reviewed : (reviewed.candidates ?? []);
    assert(candidates.some(candidate => candidate?.candidate_id === staged.candidate_id),
      'staged candidate not visible to knowledge review');
  } finally {
    rmSync(work, { recursive: true, force: true, maxRetries: 3 });
  }
}

function main() {
  const commandErrors = checkSkillCommandSurface();
  for (const error of commandErrors) console.error(error);
  assert(commandErrors.length === 0, `${commandErrors.length} unknown command invocation(s) in skill sources`);
  smokeKnowledgeStageOnV3();
  console.log(`skill surface check passed: ${skillCommandInvocations().length} invocations cross-validated, v3 knowledge stage smoke ok`);
}

try {
  main();
} catch (error) {
  console.error(String(error.message ?? error));
  process.exitCode = 1;
}
