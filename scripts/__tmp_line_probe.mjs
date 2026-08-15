import { readFileSync } from 'node:fs';

const LEGACY_HEADING = /^## Legacy `session\/1\.x(?:\/2\.x)?` Compatibility Branch\s*$/m;

function canonicalBranch(text) {
  const match = LEGACY_HEADING.exec(text);
  return match ? text.slice(0, match.index) : text;
}

const EXECUTION_MUTATIONS = {
  'maestro session open': ['--id', '--definition-of-done', '--chain', '--participant', '--actor', '--request-id', '--reason', '--evidence', '--json'],
  'maestro run create': ['--session', '--run', '--step', '--goal', '--input', '--participant', '--actor', '--request-id', '--reason', '--evidence', '--expected-orchestration-revision', '--json'],
  'maestro run next': ['--session', '--participant', '--actor', '--request-id', '--reason', '--evidence', '--expected-orchestration-revision', '--json'],
  'maestro run complete': ['--session', '--participant', '--actor', '--request-id', '--reason', '--evidence', '--expected-orchestration-revision', '--expected-run-revision', '--verdict', '--summary', '--advance', '--json'],
  'maestro run decide': ['--session', '--participant', '--actor', '--request-id', '--reason', '--evidence', '--expected-orchestration-revision', '--verdict', '--confidence', '--summary', '--after-step', '--json'],
  'maestro session chain insert': ['--session', '--step-id', '--command', '--arg', '--after-step', '--goal-ref', '--stage', '--decision-ref', '--participant', '--actor', '--request-id', '--reason', '--expected-orchestration-revision', '--json'],
  'maestro session complete': ['--session', '--participant', '--actor', '--request-id', '--reason', '--evidence', '--expected-orchestration-revision', '--json'],
};

function normalizedCommandLine(line) {
  return line.trim()
    .replace(/^[-*+]\s+/, '')
    .replace(/^\d+\.\s+/, '')
    .replace(/^`+/, '')
    .replace(/`+$/, '')
    .trim();
}

function commandLines(text, command) {
  return text.split(/\r?\n/)
    .map(normalizedCommandLine)
    .filter(line => line.startsWith(command));
}

const docs = ['workflows/run-mode.md', 'workflows/run-mode-lite.md', 'workflows/orchestrator-run-loop.md', 'prepare/ralph.md'];

for (const doc of docs) {
  const text = canonicalBranch(readFileSync(doc, 'utf8'));
  console.log(`=== ${doc}`);
  for (const [command, options] of Object.entries(EXECUTION_MUTATIONS)) {
    const lines = commandLines(text, command);
    for (const line of lines) {
      const hasEllipsis = /(?:\.\.\.|…)/.test(line);
      const missing = options.filter(o => !line.includes(o));
      if (hasEllipsis) {
        console.log(`  [ELLIPSIS] ${command} -> ${line.slice(0, 130)}... missing: ${missing.join(' ')}`);
      }
    }
  }
}
