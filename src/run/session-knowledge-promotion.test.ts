import { afterEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  promoteSessionKnowledge,
  readSessionKnowledgeDelta,
  sessionKnowledgeDeltaPath,
  sessionReconciliationPath,
  stageRunKnowledgeCandidate,
  summarizeSessionKnowledge,
} from './knowledge.js';
import {
  ensureSyntheticKnowledgeSession,
  stageSessionKnowledgeCandidate,
} from './session-knowledge.js';
import {
  promoteReconciledSessionKnowledge,
  resolveKnowledgeCandidate,
} from '../knowledge/reconcile.js';
import { completeRun, createRun, sealSession } from './runtime.js';
import { SessionStore } from './store.js';

const roots: string[] = [];

function root(): string {
  const path = mkdtempSync(join(tmpdir(), 'maestro-session-promotion-'));
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

afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('session-source promotion gate matrix (K5)', () => {
  it('rejects promotion before the Session is sealed', () => {
    const projectRoot = root();
    const { sessionId } = ensureSyntheticKnowledgeSession(projectRoot, 'gate-host');
    stageSessionKnowledgeCandidate(projectRoot, sessionId, {
      target: 'knowhow',
      title: 'Early promotion',
      content: 'Early promotion content',
      evidenceRefs: ['src/early.ts:1'],
    });
    expect(() => promoteReconciledSessionKnowledge(projectRoot, sessionId, { all: true }))
      .toThrow(/sealed before promotion/);
  });

  it('rejects a sealed Session with a missing receipt (fail-closed)', () => {
    const projectRoot = root();
    const { sessionId } = ensureSyntheticKnowledgeSession(projectRoot, 'gate-host');
    stageSessionKnowledgeCandidate(projectRoot, sessionId, {
      target: 'knowhow',
      title: 'Missing receipt',
      content: 'Missing receipt content',
      evidenceRefs: ['src/missing.ts:1'],
    });
    sealSession(projectRoot, sessionId, 'sealed');
    // Simulate a failed K6 receipt refresh.
    const store = new SessionStore(projectRoot);
    rmSync(sessionReconciliationPath(store, sessionId));
    expect(() => promoteSessionKnowledge(projectRoot, sessionId, { all: true }))
      .toThrow(/no session knowledge reconciliation receipt/);
  });

  it('resolve rejects a stale session receipt', () => {
    const projectRoot = root();
    const { sessionId } = ensureSyntheticKnowledgeSession(projectRoot, 'gate-host');
    const staged = stageSessionKnowledgeCandidate(projectRoot, sessionId, {
      target: 'knowhow',
      title: 'Stale gate',
      content: 'Stale gate content',
      evidenceRefs: ['src/stale.ts:1'],
    });
    sealSession(projectRoot, sessionId, 'sealed');
    // Tamper with the sealed delta to drift the snapshot hash (receipt stale).
    const store = new SessionStore(projectRoot);
    const deltaPath = sessionKnowledgeDeltaPath(store, sessionId);
    const delta = JSON.parse(readFileSync(deltaPath, 'utf8'));
    delta.candidates.push({
      ...delta.candidates[0],
      candidate_id: 'KDC-deadbeefdeadbeef',
      title: 'Drift',
      content: 'Drift content',
    });
    writeFileSync(deltaPath, JSON.stringify(delta), 'utf8');
    expect(() => resolveKnowledgeCandidate(
      projectRoot,
      sessionId,
      staged.candidate_id,
      'unique',
      { reason: 'attempt resolve against stale receipt' },
    )).toThrow(/stale session reconciliation receipt/);
  });

  it('promotes an eligible session candidate after seal (full gate satisfied)', () => {
    const projectRoot = root();
    const { sessionId } = ensureSyntheticKnowledgeSession(projectRoot, 'gate-host');
    const staged = stageSessionKnowledgeCandidate(projectRoot, sessionId, {
      target: 'knowhow',
      title: 'Promotable session insight',
      content: 'Promotable session insight content',
      evidenceRefs: ['src/promote.ts:2'],
    });
    sealSession(projectRoot, sessionId, 'sealed with receipt');
    const store = new SessionStore(projectRoot);
    expect(existsSync(sessionReconciliationPath(store, sessionId))).toBe(true);

    const result = promoteReconciledSessionKnowledge(projectRoot, sessionId, { all: true });
    expect(result.promoted.map(item => item.candidate_id)).toContain(staged.candidate_id);
    expect(result.promoted[0].outcome).toBe('created');

    const delta = readSessionKnowledgeDelta(store, sessionId, true);
    const promoted = delta.candidates.find(item => item.candidate_id === staged.candidate_id);
    expect(promoted?.status).toBe('promoted');
    expect(promoted?.promotion_receipt?.outcome).toBe('created');
  });

  it('resolves transcript-only copies across Run and Session origins with one decision', () => {
    const projectRoot = root();
    installCommand(projectRoot);
    const content = 'Shared transcript-only cross-origin insight';
    const created = createRun({
      projectRoot,
      command: 'knowledge-demo',
      sessionId: 'mixed-origin-transcript-session',
      intent: 'mixed origin transcript resolution',
    });
    const runStaged = stageRunKnowledgeCandidate(projectRoot, created.run_id, {
      target: 'knowhow',
      title: 'Shared transcript-only insight',
      content,
      evidenceRefs: ['transcript:pi:host-1:entry-1:aaaaaaaaaaaaaaaa'],
    }, created.session_id);
    const sessionStaged = stageSessionKnowledgeCandidate(projectRoot, created.session_id, {
      target: 'knowhow',
      title: 'Shared transcript-only insight',
      content,
      evidenceRefs: ['transcript:pi:host-2:entry-2:bbbbbbbbbbbbbbbb'],
    });
    expect(sessionStaged.candidate_id).toBe(runStaged.candidate_id);

    completeRun(projectRoot, created.run_id, created.session_id);
    sealSession(projectRoot, created.session_id, 'mixed transcript origins sealed');
    const resolved = resolveKnowledgeCandidate(
      projectRoot,
      created.session_id,
      runStaged.candidate_id,
      'unique',
      { reason: 'Human reviewed both cross-origin transcript references' },
    );
    expect(resolved.affected_runs).toContain(created.run_id);

    const result = promoteReconciledSessionKnowledge(projectRoot, created.session_id, {
      candidateIds: [runStaged.candidate_id],
    });
    expect(result.promoted.map(item => item.candidate_id)).toContain(runStaged.candidate_id);

    const store = new SessionStore(projectRoot);
    const sessionDelta = readSessionKnowledgeDelta(store, created.session_id, true);
    expect(sessionDelta.candidates.find(item => item.candidate_id === runStaged.candidate_id)?.status)
      .toBe('promoted');
    const runDelta = JSON.parse(readFileSync(
      join(store.runDir(created.session_id, created.run_id), 'knowledge-delta.json'),
      'utf8',
    ));
    expect(runDelta.candidates.find(
      (item: { candidate_id: string }) => item.candidate_id === runStaged.candidate_id,
    )?.status).toBe('promoted');
  });
});

describe('mixed-origin accounting (K7)', () => {
  it('dispatches promotion write-back to each origin ledger separately', () => {
    const projectRoot = root();
    installCommand(projectRoot);
    const content = 'Shared cross-origin insight content';
    const created = createRun({
      projectRoot,
      command: 'knowledge-demo',
      sessionId: 'mixed-origin-session',
      intent: 'mixed origin promotion',
    });
    stageRunKnowledgeCandidate(projectRoot, created.run_id, {
      target: 'knowhow',
      title: 'Shared cross-origin insight',
      content,
    }, created.session_id);
    const sessionStaged = stageSessionKnowledgeCandidate(projectRoot, created.session_id, {
      target: 'knowhow',
      title: 'Shared cross-origin insight',
      content,
      evidenceRefs: ['src/shared.ts:3'],
    });

    const summary = summarizeSessionKnowledge(projectRoot, created.session_id);
    expect(summary.candidates.filter(item => item.candidate_id === sessionStaged.candidate_id))
      .toHaveLength(2);

    // Seal both sources (run complete + session seal with K6 receipt), then
    // promote by ID: identical content in both ledgers promotes through each
    // origin's own gate and writes back to each ledger separately.
    completeRun(projectRoot, created.run_id, created.session_id);
    sealSession(projectRoot, created.session_id, 'mixed origin sealed');
    const result = promoteReconciledSessionKnowledge(projectRoot, created.session_id, {
      candidateIds: [sessionStaged.candidate_id],
    });
    expect(result.promoted.length).toBeGreaterThanOrEqual(1);
    expect(result.promoted.map(item => item.candidate_id))
      .toContain(sessionStaged.candidate_id);

    const store = new SessionStore(projectRoot);
    const sessionDelta = readSessionKnowledgeDelta(store, created.session_id, true);
    const sessionCopy = sessionDelta.candidates.find(
      item => item.candidate_id === sessionStaged.candidate_id,
    );
    expect(sessionCopy?.status).toBe('promoted');
    expect(sessionCopy?.promotion_receipt).toBeTruthy();

    const runDelta = JSON.parse(readFileSync(
      join(store.runDir(created.session_id, created.run_id), 'knowledge-delta.json'),
      'utf8',
    ));
    const runCopy = runDelta.candidates.find(
      (item: { candidate_id: string }) => item.candidate_id === sessionStaged.candidate_id,
    );
    expect(runCopy?.status).toBe('promoted');
    // Both copies share one corpus entry: outcomes are created + reaffirmed.
    const outcomes = result.promoted.map(item => item.outcome).sort();
    expect(outcomes).toContain('created');
  });
});
