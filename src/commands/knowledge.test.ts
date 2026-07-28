import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { registerKnowledgeCommand } from './knowledge.js';
import { runUnifiedSearch } from './search.js';
import { completeRun, createRun, sealSession } from '../run/runtime.js';
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

  it('reviews evidence, supports --workflow-root, and stages content from a file', async () => {
    const specsDir = join(projectRoot, '.workflow', 'specs');
    mkdirSync(specsDir, { recursive: true });
    writeFileSync(join(specsDir, 'coding-conventions.md'), `---
category: coding
---

<spec-entry category="coding" keywords="atomic" date="2026-07-28" sid="S-atomic" title="Atomic rule">

### Atomic rule

Persist coordinated writes atomically.

</spec-entry>
`, 'utf8');
    writeFileSync(
      join(projectRoot, 'candidate.txt'),
      'Persist coordinated writes atomically.',
      'utf8',
    );
    const created = createRun({
      projectRoot,
      command: 'knowledge-cli',
      sessionId: 'knowledge-review-session',
      intent: 'review candidate evidence',
    });

    process.chdir(previousCwd);
    await run(
      'stage',
      'spec',
      'Atomic rule copy',
      '--content-file',
      'candidate.txt',
      '--run',
      created.run_id,
      '--session',
      created.session_id,
      '--workflow-root',
      projectRoot,
      '--json',
    );
    const candidateId = (JSON.parse(logs.at(-1)!) as { candidate_id: string }).candidate_id;

    await run(
      'review',
      created.session_id,
      '--refresh',
      '--workflow-root',
      projectRoot,
      '--json',
    );
    expect(JSON.parse(logs.at(-1)!)).toMatchObject({
      session_id: created.session_id,
      candidates: [{
        candidate_id: candidateId,
        reconciliation: {
          disposition: 'exact_duplicate',
          promotion_eligibility: 'suppressed',
          freshness: 'fresh',
          matches: [{
            knowledge_id: 'S-atomic',
            relation: 'exact_duplicate',
          }],
        },
        review: {
          freshness: 'fresh',
          reconcile_commands: [],
          resolution_commands: [],
        },
      }],
    });
    expect(errors).toEqual([]);
  });

  it('rejects restaging identical content with a conflicting action', async () => {
    const created = createRun({
      projectRoot,
      command: 'knowledge-cli',
      sessionId: 'knowledge-action-session',
      intent: 'preserve candidate intent',
    });
    await run(
      'stage',
      'knowhow',
      'Candidate action',
      'Keep one semantic candidate identity.',
      '--action',
      'propose',
      '--run',
      created.run_id,
      '--session',
      created.session_id,
    );
    await run(
      'stage',
      'knowhow',
      'Candidate action',
      'Keep one semantic candidate identity.',
      '--action',
      'supersede',
      '--run',
      created.run_id,
      '--session',
      created.session_id,
    );

    expect(process.exitCode).toBe(1);
    expect(errors.join('\n')).toContain('instead of restaging');
  });

  it('executes the complete knowledge review, promotion, and Session seal chain', async () => {
    const specsDir = join(projectRoot, '.workflow', 'specs');
    mkdirSync(specsDir, { recursive: true });
    const specPath = join(specsDir, 'architecture-constraints.md');
    writeFileSync(specPath, `---
category: arch
---

<spec-entry category="arch" keywords="storage" date="2026-07-01" sid="S-old-storage" title="Canonical storage policy">

### Canonical storage policy

Use independent file writes for coordinated state.

</spec-entry>
`, 'utf8');
    const created = createRun({
      projectRoot,
      command: 'knowledge-cli',
      sessionId: 'knowledge-full-chain',
      intent: 'exercise the full knowledge lifecycle',
    });

    await run(
      'record',
      'S-old-storage',
      '--signal',
      'consumed',
      '--run',
      created.run_id,
      '--session',
      created.session_id,
      '--json',
    );
    await run(
      'stage',
      'spec',
      'Canonical storage policy',
      'Use one SessionStore transaction for coordinated state.',
      '--action',
      'supersede',
      '--category',
      'arch',
      '--evidence',
      'report.md#decision-storage',
      '--run',
      created.run_id,
      '--session',
      created.session_id,
      '--json',
    );
    const candidateId = (JSON.parse(logs.at(-1)!) as { candidate_id: string }).candidate_id;

    await run('review', created.session_id, '--refresh', '--json');
    const preCompletionReview = JSON.parse(logs.at(-1)!) as {
      candidates: Array<{
        candidate_id: string;
        reconciliation: {
          disposition: string;
          promotion_eligibility: string;
          canonical_id: string;
        };
        review: { resolution_commands: string[] };
      }>;
    };
    expect(preCompletionReview.candidates).toEqual([
      expect.objectContaining({
        candidate_id: candidateId,
        reconciliation: expect.objectContaining({
          disposition: 'supersede_candidate',
          promotion_eligibility: 'review_required',
          canonical_id: 'S-old-storage',
        }),
        review: expect.objectContaining({
          resolution_commands: expect.arrayContaining([
            expect.stringContaining('--as supersede --target S-old-storage'),
          ]),
        }),
      }),
    ]);

    await run(
      'resolve',
      candidateId,
      '--session',
      created.session_id,
      '--as',
      'supersede',
      '--target',
      'S-old-storage',
      '--reason',
      'Coordinated state now requires one atomic SessionStore transaction',
      '--json',
    );
    expect(JSON.parse(logs.at(-1)!)).toMatchObject({
      candidate_id: candidateId,
      promotion_eligibility: 'eligible',
      canonical_id: 'S-old-storage',
    });

    const runDir = new SessionStore(projectRoot).runDir(created.session_id, created.run_id);
    writeFileSync(join(runDir, 'report.md'), `---
verdict: ready
summary: Full knowledge lifecycle verified
constraints: []
decisions: []
concerns: []
next: []
---
Full knowledge lifecycle verified.
`, 'utf8');
    const completed = completeRun(projectRoot, created.run_id, created.session_id);
    expect(completed).toMatchObject({
      sealed: true,
      knowledge: {
        staged_candidate_ids: [candidateId],
        reconciliation: {
          review_required: 0,
          suppressed: 0,
        },
      },
    });

    await run('review', created.session_id, '--json');
    expect(JSON.parse(logs.at(-1)!)).toMatchObject({
      candidates: [{
        candidate_id: candidateId,
        status: 'pending',
        reconciliation: {
          disposition: 'supersede_candidate',
          promotion_eligibility: 'eligible',
          freshness: 'fresh',
        },
      }],
    });

    await run(
      'promote',
      created.session_id,
      '--candidate',
      candidateId,
      '--json',
    );
    const promotion = JSON.parse(logs.at(-1)!) as {
      promoted: Array<{ candidate_id: string; promoted_id: string; outcome: string }>;
    };
    expect(promotion.promoted).toEqual([
      expect.objectContaining({
        candidate_id: candidateId,
        promoted_id: expect.stringMatching(/^S-/),
        outcome: 'created',
      }),
    ]);
    const promotedId = promotion.promoted[0].promoted_id;

    const sealed = sealSession(projectRoot, created.session_id, 'full knowledge chain verified');
    expect(sealed).toMatchObject({
      status: 'sealed',
      run_count: 1,
      knowledge: {
        pending_candidates: 0,
        promoted_candidates: 1,
        review_command: `maestro knowledge review ${created.session_id}`,
      },
    });

    const specContent = readFileSync(specPath, 'utf8');
    expect(specContent).toContain('sid="S-old-storage" title="Canonical storage policy" status="deprecated"');
    expect(specContent).toContain(`superseded-by="${promotedId}"`);
    expect(specContent).toContain(`sid="${promotedId}"`);
    expect(specContent).toContain('supersedes="S-old-storage"');

    const searchResults = await runUnifiedSearch('SessionStore transaction coordinated state', {
      type: 'spec',
      limit: 5,
      executionMode: 'read-only-probe',
    });
    expect(searchResults).toEqual(expect.arrayContaining([
      expect.objectContaining({
        title: 'Canonical storage policy',
        snippet: expect.stringContaining('SessionStore transaction'),
      }),
    ]));
    expect(searchResults.some(result => result.id === 'S-old-storage')).toBe(false);
    expect(errors).toEqual([]);
  });
});
