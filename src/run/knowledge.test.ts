import { afterEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  readRunKnowledgeDelta,
  promoteSessionKnowledge,
  recordActiveRunKnowledgeInputs,
  runKnowledgeDeltaSchema,
  summarizeSessionKnowledge,
} from './knowledge.js';
import { completeRun, createRun, sealSession } from './runtime.js';
import { SessionStore } from './store.js';

const roots: string[] = [];

function root(): string {
  const path = mkdtempSync(join(tmpdir(), 'maestro-knowledge-ledger-'));
  roots.push(path);
  return path;
}

function installCommand(projectRoot: string, name = 'knowledge-demo'): void {
  const commandDir = join(projectRoot, '.claude', 'commands');
  const workflowDir = join(projectRoot, 'workflows');
  mkdirSync(commandDir, { recursive: true });
  mkdirSync(workflowDir, { recursive: true });
  writeFileSync(
    join(commandDir, `${name}.md`),
    '<contract>\nconsumes: []\nproduces: []\ngates:\n  entry: []\n  exit: []\n</contract>\n',
    'utf8',
  );
  writeFileSync(join(workflowDir, `${name}.md`), `# ${name}\n`, 'utf8');
}

function writeKnowledgeReport(projectRoot: string, sessionId: string, runId: string): void {
  const runDir = join(projectRoot, '.workflow', 'sessions', sessionId, 'runs', runId);
  writeFileSync(join(runDir, 'report.md'), `---
verdict: ready
summary: Knowledge ledger ready
constraints:
  - id: C1
    text: Preserve backward compatibility
    status: locked
decisions:
  - id: D1
    text: Use the canonical SessionStore
    status: accepted
concerns: []
next: []
---
Knowledge ledger ready.
`, 'utf8');
}

afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('Run knowledge delta', () => {
  it('attributes explicit consumption only to the unique active Run', () => {
    const projectRoot = root();
    installCommand(projectRoot);
    const created = createRun({
      projectRoot,
      command: 'knowledge-demo',
      sessionId: 'knowledge-session',
      intent: 'track knowledge consumption',
    });

    expect(recordActiveRunKnowledgeInputs(projectRoot, ['spec:SPC-1', 'spec:SPC-1', 'knowhow:K1']))
      .toEqual({
        session_id: created.session_id,
        run_id: created.run_id,
        recorded: 2,
      });

    const delta = readRunKnowledgeDelta(
      new SessionStore(projectRoot),
      created.session_id,
      created.run_id,
    );
    expect(delta.inputs).toEqual([
      expect.objectContaining({ knowledge_id: 'spec:SPC-1', signal: 'consumed', count: 1 }),
      expect.objectContaining({ knowledge_id: 'knowhow:K1', signal: 'consumed', count: 1 }),
    ]);
  });

  it('does not guess attribution when multiple Runs are active', () => {
    const projectRoot = root();
    installCommand(projectRoot);
    const first = createRun({
      projectRoot,
      command: 'knowledge-demo',
      sessionId: 'first-session',
      intent: 'first',
    });
    const second = createRun({
      projectRoot,
      command: 'knowledge-demo',
      sessionId: 'second-session',
      intent: 'second',
    });

    expect(recordActiveRunKnowledgeInputs(projectRoot, ['spec:SPC-1'])).toBeNull();
    for (const run of [first, second]) {
      expect(existsSync(join(
        projectRoot,
        '.workflow',
        'sessions',
        run.session_id,
        'runs',
        run.run_id,
        'knowledge-delta.json',
      ))).toBe(false);
    }
  });

  it('stages accepted handoff facts without auto-promoting project knowledge', () => {
    const projectRoot = root();
    installCommand(projectRoot);
    const created = createRun({
      projectRoot,
      command: 'knowledge-demo',
      sessionId: 'knowledge-session',
      intent: 'stage handoff knowledge',
    });
    writeKnowledgeReport(projectRoot, created.session_id, created.run_id);

    expect(completeRun(projectRoot, created.run_id, created.session_id).sealed).toBe(true);
    const delta = readRunKnowledgeDelta(
      new SessionStore(projectRoot),
      created.session_id,
      created.run_id,
    );
    expect(delta.candidates).toEqual([
      expect.objectContaining({
        target: 'spec',
        source_kind: 'decision',
        content: 'Use the canonical SessionStore',
        status: 'pending',
        promoted_id: null,
      }),
      expect.objectContaining({
        target: 'spec',
        source_kind: 'constraint',
        content: 'Preserve backward compatibility',
        status: 'pending',
        promoted_id: null,
      }),
    ]);
    expect(existsSync(join(projectRoot, '.workflow', 'specs'))).toBe(false);
  });

  it('marks the same candidate from multiple Run ledgers as corroborated', () => {
    const projectRoot = root();
    installCommand(projectRoot);
    const created = createRun({
      projectRoot,
      command: 'knowledge-demo',
      sessionId: 'knowledge-session',
      intent: 'summarize candidate evidence',
    });
    writeKnowledgeReport(projectRoot, created.session_id, created.run_id);
    completeRun(projectRoot, created.run_id, created.session_id);

    const store = new SessionStore(projectRoot);
    const first = readRunKnowledgeDelta(store, created.session_id, created.run_id);
    const secondRunId = `${created.run_id}-corroboration`;
    const secondRunDir = store.runDir(created.session_id, secondRunId);
    mkdirSync(secondRunDir, { recursive: true });
    writeFileSync(join(secondRunDir, 'run.json'), '{}\n', 'utf8');
    store.updateJsonFile(
      join(secondRunDir, 'knowledge-delta.json'),
      runKnowledgeDeltaSchema,
      {
        ...first,
        run_id: secondRunId,
        revision: 0,
      },
      () => undefined,
    );

    const summary = summarizeSessionKnowledge(projectRoot, created.session_id);
    expect(summary.run_count).toBe(2);
    expect(summary.ledger_count).toBe(2);
    expect(summary.candidates).toHaveLength(2);
    expect(summary.candidates.every(candidate =>
      candidate.stage === 'corroborated' && candidate.run_ids.length === 2
    )).toBe(true);
  });

  it('promotes an explicitly selected observed candidate and persists a replay-safe receipt', () => {
    const projectRoot = root();
    installCommand(projectRoot);
    const created = createRun({
      projectRoot,
      command: 'knowledge-demo',
      sessionId: 'knowledge-session',
      intent: 'promote reviewed knowledge',
    });
    writeKnowledgeReport(projectRoot, created.session_id, created.run_id);
    completeRun(projectRoot, created.run_id, created.session_id);
    sealSession(projectRoot, created.session_id, 'ready for knowledge promotion');

    const before = summarizeSessionKnowledge(projectRoot, created.session_id);
    const candidate = before.candidates.find(item => item.source_kind === 'decision')!;
    expect(() => promoteSessionKnowledge(projectRoot, created.session_id, { all: true }))
      .toThrow(/No corroborated pending candidates/);

    const promoted = promoteSessionKnowledge(projectRoot, created.session_id, {
      candidateIds: [candidate.candidate_id],
    });
    expect(promoted.promoted).toEqual([
      expect.objectContaining({
        candidate_id: candidate.candidate_id,
        target: 'spec',
        outcome: 'created',
      }),
    ]);

    const after = summarizeSessionKnowledge(projectRoot, created.session_id);
    const recorded = after.candidates.find(item => item.candidate_id === candidate.candidate_id)!;
    expect(recorded).toMatchObject({
      status: 'promoted',
      promoted_id: promoted.promoted[0].promoted_id,
      promotion_receipt: {
        outcome: 'created',
        content_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
    expect(new SessionStore(projectRoot).readBundle(created.session_id).session.lifecycle.promoted_spec_ids)
      .toContain(promoted.promoted[0].promoted_id);

    const replay = promoteSessionKnowledge(projectRoot, created.session_id, {
      candidateIds: [candidate.candidate_id],
    });
    expect(replay.promoted).toEqual([]);
    expect(replay.already_promoted).toEqual([{
      candidate_id: candidate.candidate_id,
      promoted_id: promoted.promoted[0].promoted_id,
    }]);
  });
});
