import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { registerKnowledgeCommand } from './knowledge.js';
import { createRun } from '../run/runtime.js';
import { readRunKnowledgeDelta, summarizeSessionKnowledge } from '../run/knowledge.js';
import { SessionStore } from '../run/store.js';

let projectRoot: string;
let previousCwd: string;
let logs: string[];
let errors: string[];

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'maestro-knowledge-cli-'));
  previousCwd = process.cwd();
  process.chdir(projectRoot);
  logs = [];
  errors = [];
  vi.spyOn(console, 'log').mockImplementation(value => { logs.push(String(value)); });
  vi.spyOn(console, 'error').mockImplementation(value => { errors.push(String(value)); });
  process.exitCode = undefined;

  const commandDir = join(projectRoot, '.claude', 'commands');
  mkdirSync(commandDir, { recursive: true });
  writeFileSync(
    join(commandDir, 'knowledge-cli.md'),
    '<contract>\nconsumes: []\nproduces: []\ngates:\n  entry: []\n  exit: []\n</contract>\n',
    'utf8',
  );
});

afterEach(() => {
  process.chdir(previousCwd);
  rmSync(projectRoot, { recursive: true, force: true });
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

function program(): Command {
  const value = new Command();
  value.exitOverride();
  registerKnowledgeCommand(value);
  return value;
}

async function run(...args: string[]): Promise<void> {
  await program().parseAsync(['node', 'maestro', 'knowledge', ...args]);
}

describe('maestro knowledge Run lifecycle CLI', () => {
  it('records explicit signals and stages reviewable candidates on the active Run', async () => {
    const created = createRun({
      projectRoot,
      command: 'knowledge-cli',
      sessionId: 'knowledge-cli-session',
      intent: 'exercise knowledge lifecycle CLI',
    });

    await run(
      'record',
      'spec:S-1,knowhow:K-1',
      '--run',
      created.run_id,
      '--session',
      created.session_id,
      '--signal',
      'validated',
      '--json',
    );
    expect(JSON.parse(logs.at(-1)!)).toMatchObject({
      session_id: created.session_id,
      run_id: created.run_id,
      recorded: 2,
    });

    await run(
      'stage',
      'knowhow',
      'Stable transaction recipe',
      'Use one SessionStore transaction for coordinated writes.',
      '--run',
      created.run_id,
      '--session',
      created.session_id,
      '--category',
      'recipe',
      '--evidence',
      'artifact:A-1',
      '--json',
    );
    const staged = JSON.parse(logs.at(-1)!) as { candidate_id: string };
    expect(staged.candidate_id).toMatch(/^KDC-[a-f0-9]{16}$/);

    const delta = readRunKnowledgeDelta(
      new SessionStore(projectRoot),
      created.session_id,
      created.run_id,
    );
    expect(delta.inputs).toEqual([
      expect.objectContaining({ knowledge_id: 'spec:S-1', signal: 'validated', source: 'manual' }),
      expect.objectContaining({ knowledge_id: 'knowhow:K-1', signal: 'validated', source: 'manual' }),
    ]);
    expect(summarizeSessionKnowledge(projectRoot, created.session_id).candidates).toEqual([
      expect.objectContaining({
        candidate_id: staged.candidate_id,
        target: 'knowhow',
        status: 'pending',
      }),
    ]);
    expect(errors).toEqual([]);
  });

  it('fails closed when explicit Run authority is not active', async () => {
    const created = createRun({
      projectRoot,
      command: 'knowledge-cli',
      sessionId: 'knowledge-cli-session',
      intent: 'reject stale knowledge attribution',
    });
    const store = new SessionStore(projectRoot);
    store.update(created.session_id, bundle => {
      bundle.session.active_run_id = null;
    });

    await run('record', 'spec:S-1', '--run', created.run_id, '--session', created.session_id);
    expect(process.exitCode).toBe(1);
    expect(errors.join('\n')).toContain('is not the active Run');
  });

  it('reconciles and resolves a candidate through the CLI', async () => {
    const specsDir = join(projectRoot, '.workflow', 'specs');
    mkdirSync(specsDir, { recursive: true });
    writeFileSync(join(specsDir, 'coding-conventions.md'), `---
category: coding
---

<spec-entry category="coding" keywords="store" date="2026-07-28" sid="S-store" title="Store rule">

### Store rule

Use one SessionStore transaction.

</spec-entry>
`, 'utf8');
    const created = createRun({
      projectRoot,
      command: 'knowledge-cli',
      sessionId: 'knowledge-cli-session',
      intent: 'reconcile CLI candidate',
    });
    await run(
      'stage',
      'spec',
      'Store rule copy',
      'Use one SessionStore transaction.',
      '--run',
      created.run_id,
      '--session',
      created.session_id,
      '--json',
    );
    const candidateId = (JSON.parse(logs.at(-1)!) as { candidate_id: string }).candidate_id;

    await run(
      'reconcile',
      '--run',
      created.run_id,
      '--session',
      created.session_id,
      '--json',
    );
    expect(JSON.parse(logs.at(-1)!)).toMatchObject({
      counts: { duplicates: 1, suppressed: 1 },
      candidates: [{
        candidate_id: candidateId,
        disposition: 'exact_duplicate',
        canonical_id: 'S-store',
      }],
    });
    await run('session', created.session_id, '--json');
    expect(JSON.parse(logs.at(-1)!)).toMatchObject({
      candidates: [{
        candidate_id: candidateId,
        reconciliation: {
          disposition: 'exact_duplicate',
          freshness: 'fresh',
        },
      }],
    });

    await run(
      'resolve',
      candidateId,
      '--session',
      created.session_id,
      '--as',
      'duplicate',
      '--target',
      'S-store',
      '--reason',
      'Confirmed exact duplicate',
      '--json',
    );
    expect(JSON.parse(logs.at(-1)!)).toMatchObject({
      candidate_id: candidateId,
      promotion_eligibility: 'suppressed',
      canonical_id: 'S-store',
    });
    expect(readRunKnowledgeDelta(
      new SessionStore(projectRoot),
      created.session_id,
      created.run_id,
    ).candidates[0].status).toBe('rejected');
    expect(errors).toEqual([]);
  });
});
