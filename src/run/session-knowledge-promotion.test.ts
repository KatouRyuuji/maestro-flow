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
  ensureSessionKnowledgeReconciliation,
  isSessionKnowledgeReconciliationFresh,
  persistSessionKnowledgeReconciliation,
  promoteReconciledSessionKnowledge,
  resolveKnowledgeCandidate,
} from '../knowledge/reconcile.js';
import { migrateSession } from './migrate.js';
import { completeRun, createRun, sealSession } from './runtime.js';
import { SessionStore } from './store.js';
import { buildTranscriptUri, storeTranscriptEvidence } from './transcript-evidence.js';

function v2Workspace(root: string): void {
  mkdirSync(join(root, ".workflow"), { recursive: true });
  writeFileSync(join(root, ".workflow", "config.json"), JSON.stringify({
    session_schema: { schema_version: "session-schema-selection/1.0", writer: "session/1.3", features: { session_statusless: false } },
  }));
}

const roots: string[] = [];

function root(): string {
  const path = mkdtempSync(join(tmpdir(), 'maestro-session-promotion-'));

  v2Workspace(path);
  roots.push(path);
  const srcDir = join(path, 'src');
  mkdirSync(srcDir, { recursive: true });
  for (const file of [
    'early.ts', 'missing.ts', 'stale.ts', 'promote.ts', 'content.ts',
    'evidence.ts', 'corpus.ts', 'revision.ts', 'v20-promotion.ts', 'shared.ts',
  ]) {
    writeFileSync(join(srcDir, file), `// immutable evidence fixture: ${file}\n`, 'utf8');
  }
  return path;
}

function reviewSessionKnowledge(projectRoot: string, sessionId: string): void {
  persistSessionKnowledgeReconciliation(
    projectRoot,
    ensureSessionKnowledgeReconciliation(projectRoot, sessionId),
  );
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

function writeSpec(projectRoot: string, content: string): void {
  const dir = join(projectRoot, '.workflow', 'specs');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'phase-four.md'), `---
category: coding
---

<spec-entry category="coding" date="2026-08-01" sid="S-phase-four" title="Phase four corpus">

### Phase four corpus

${content}

</spec-entry>
`, 'utf8');
}

afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('session-source promotion gate matrix (K5)', () => {
  it('promotes a reviewed session candidate without sealing the Session', () => {
    const projectRoot = root();
    const { sessionId } = ensureSyntheticKnowledgeSession(projectRoot, 'gate-host');
    const staged = stageSessionKnowledgeCandidate(projectRoot, sessionId, {
      target: 'knowhow',
      title: 'Early promotion',
      content: 'Early promotion content',
      evidenceRefs: ['src/early.ts:1'],
    });
    reviewSessionKnowledge(projectRoot, sessionId);
    expect(new SessionStore(projectRoot).readBundle(sessionId).session.status).toBe('running');
    const result = promoteReconciledSessionKnowledge(projectRoot, sessionId, { all: true });
    expect(result.promoted.map(item => item.candidate_id)).toContain(staged.candidate_id);
  });

  it('rejects a session candidate with a missing receipt (fail-closed)', () => {
    const projectRoot = root();
    const { sessionId } = ensureSyntheticKnowledgeSession(projectRoot, 'gate-host');
    stageSessionKnowledgeCandidate(projectRoot, sessionId, {
      target: 'knowhow',
      title: 'Missing receipt',
      content: 'Missing receipt content',
      evidenceRefs: ['src/missing.ts:1'],
    });
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
    reviewSessionKnowledge(projectRoot, sessionId);
    // Tamper with the bound delta evidence after review.
    const store = new SessionStore(projectRoot);
    const deltaPath = sessionKnowledgeDeltaPath(store, sessionId);
    const delta = JSON.parse(readFileSync(deltaPath, 'utf8'));
    delta.candidates[0].evidence_refs.push('src/changed.ts:9');
    writeFileSync(deltaPath, JSON.stringify(delta), 'utf8');
    expect(() => resolveKnowledgeCandidate(
      projectRoot,
      sessionId,
      staged.candidate_id,
      'unique',
      { reason: 'attempt resolve against stale receipt' },
    )).toThrow(/stale session reconciliation receipt/);
  });

  it('promotes an eligible session candidate after review without seal', () => {
    const projectRoot = root();
    const { sessionId } = ensureSyntheticKnowledgeSession(projectRoot, 'gate-host');
    const staged = stageSessionKnowledgeCandidate(projectRoot, sessionId, {
      target: 'knowhow',
      title: 'Promotable session insight',
      content: 'Promotable session insight content',
      evidenceRefs: ['src/promote.ts:2'],
    });
    reviewSessionKnowledge(projectRoot, sessionId);
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

  it('fails closed when candidate content or evidence changes after review', () => {
    for (const field of ['content', 'evidence'] as const) {
      const projectRoot = root();
      const { sessionId } = ensureSyntheticKnowledgeSession(projectRoot, `mutation-${field}`);
      stageSessionKnowledgeCandidate(projectRoot, sessionId, {
        target: 'knowhow',
        title: `Bound ${field}`,
        content: `Bound ${field} content`,
        evidenceRefs: [`src/${field}.ts:1`],
      });
      reviewSessionKnowledge(projectRoot, sessionId);
      const store = new SessionStore(projectRoot);
      const deltaPath = sessionKnowledgeDeltaPath(store, sessionId);
      const delta = JSON.parse(readFileSync(deltaPath, 'utf8'));
      if (field === 'content') delta.candidates[0].content = 'Mutated candidate content';
      else delta.candidates[0].evidence_refs.push('src/mutated-evidence.ts:2');
      writeFileSync(deltaPath, JSON.stringify(delta), 'utf8');
      expect(() => promoteReconciledSessionKnowledge(projectRoot, sessionId, { all: true }))
        .toThrow(/stale session knowledge reconciliation receipt/);
    }
  });

  it('fails closed when the corpus changes after session review', () => {
    const projectRoot = root();
    const { sessionId } = ensureSyntheticKnowledgeSession(projectRoot, 'corpus-host');
    stageSessionKnowledgeCandidate(projectRoot, sessionId, {
      target: 'knowhow',
      title: 'Corpus-bound candidate',
      content: 'Corpus-bound candidate content',
      evidenceRefs: ['src/corpus.ts:1'],
    });
    reviewSessionKnowledge(projectRoot, sessionId);
    writeSpec(projectRoot, 'The corpus changed after review.');
    expect(() => promoteReconciledSessionKnowledge(projectRoot, sessionId, { all: true }))
      .toThrow(/stale session knowledge reconciliation receipt/);
  });

  it('fails closed when referenced file bytes change after review', () => {
    const projectRoot = root();
    const { sessionId } = ensureSyntheticKnowledgeSession(projectRoot, 'evidence-byte-host');
    stageSessionKnowledgeCandidate(projectRoot, sessionId, {
      target: 'knowhow',
      title: 'Byte-bound candidate',
      content: 'Byte-bound candidate content',
      evidenceRefs: ['src/evidence.ts:1'],
    });
    reviewSessionKnowledge(projectRoot, sessionId);
    writeFileSync(join(projectRoot, 'src', 'evidence.ts'), '// changed after review\n', 'utf8');

    expect(() => promoteReconciledSessionKnowledge(projectRoot, sessionId, { all: true }))
      .toThrow(/stale session knowledge reconciliation receipt|evidence bytes changed/);
  });

  it('fails closed when the corpus changes inside the final promotion transaction', () => {
    const projectRoot = root();
    const { sessionId } = ensureSyntheticKnowledgeSession(projectRoot, 'final-cas-host');
    stageSessionKnowledgeCandidate(projectRoot, sessionId, {
      target: 'knowhow',
      title: 'Final CAS candidate',
      content: 'Final CAS candidate content',
      evidenceRefs: ['inline:reviewed immutable evidence'],
    });
    reviewSessionKnowledge(projectRoot, sessionId);

    expect(() => promoteReconciledSessionKnowledge(projectRoot, sessionId, {
      all: true,
      _beforeFinalSessionValidation: () => {
        writeSpec(projectRoot, 'Concurrent corpus bytes written at final validation.');
      },
    })).toThrow(/stale session knowledge reconciliation receipt at final commit/);
    expect(readSessionKnowledgeDelta(new SessionStore(projectRoot), sessionId, true).candidates[0].status)
      .toBe('pending');
    expect(existsSync(join(projectRoot, '.workflow', 'knowhow'))).toBe(false);
  });

  it('keeps a bound candidate fresh across unrelated later Session activity', () => {
    const projectRoot = root();
    const { sessionId } = ensureSyntheticKnowledgeSession(projectRoot, 'activity-host');
    const staged = stageSessionKnowledgeCandidate(projectRoot, sessionId, {
      target: 'knowhow',
      title: 'Revision-independent candidate',
      content: 'Revision-independent candidate content',
      evidenceRefs: ['src/revision.ts:1'],
    });
    const receipt = ensureSessionKnowledgeReconciliation(projectRoot, sessionId);
    expect(receipt.session_source).toMatchObject({
      schema_version: 'session-knowledge-reconciliation-source/1.0',
      session_activity_revision: 0,
      candidates: [{
        candidate_id: staged.candidate_id,
        candidate_version: 1,
        observed_activity_revision: 0,
      }],
    });
    expect(receipt.session_source?.evidence_root_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(receipt.session_source?.candidates[0].content_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(receipt.session_source?.candidates[0].evidence_root_descriptors).toEqual([
      expect.objectContaining({
        kind: 'file',
        ref: 'src/revision.ts:1',
        path: 'src/revision.ts',
        content_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    ]);
    persistSessionKnowledgeReconciliation(projectRoot, receipt);
    const store = new SessionStore(projectRoot);
    store.update(sessionId, draft => {
      draft.session.activity_revision++;
    });
    expect(isSessionKnowledgeReconciliationFresh(projectRoot, sessionId, receipt)).toBe(true);
    const result = promoteReconciledSessionKnowledge(projectRoot, sessionId, {
      candidateIds: [staged.candidate_id],
    });
    expect(result.promoted.map(item => item.candidate_id)).toContain(staged.candidate_id);
  });

  it('reviews and promotes a canonical session/2.0 candidate without a Session seal gate', () => {
    const projectRoot = root();
    const { sessionId } = ensureSyntheticKnowledgeSession(projectRoot, 'v20-promotion-host');
    sealSession(projectRoot, sessionId, 'legacy seal before statusless migration');
    writeFileSync(join(projectRoot, '.workflow', 'config.json'), JSON.stringify({
      session_schema: {
        schema_version: 'session-schema-selection/1.0',
        writer: 'session/2.0',
        features: { session_statusless: true },
      },
    }, null, 2), 'utf8');
    migrateSession(projectRoot, sessionId);
    const staged = stageSessionKnowledgeCandidate(projectRoot, sessionId, {
      target: 'knowhow',
      title: 'Statusless promotion candidate',
      content: 'Statusless promotion candidate content',
      evidenceRefs: ['src/v20-promotion.ts:3'],
    });
    reviewSessionKnowledge(projectRoot, sessionId);

    const result = promoteReconciledSessionKnowledge(projectRoot, sessionId, {
      candidateIds: [staged.candidate_id],
    });
    expect(result.promoted.map(item => item.candidate_id)).toContain(staged.candidate_id);
    const store = new SessionStore(projectRoot);
    expect(store.readSessionRecordReadOnly(sessionId).schema_version).toBe('session/2.0');
    expect(readSessionKnowledgeDelta(store, sessionId, true).candidates[0].status).toBe('promoted');
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
    const sessionTranscript = storeTranscriptEvidence(
      projectRoot,
      created.session_id,
      'Session-origin transcript evidence',
      { host_kind: 'pi', host_session_id: 'host-2', entry_id: 'entry-2' },
    );
    const sessionStaged = stageSessionKnowledgeCandidate(projectRoot, created.session_id, {
      target: 'knowhow',
      title: 'Shared transcript-only insight',
      content,
      evidenceRefs: [buildTranscriptUri(
        'pi',
        'host-2',
        'entry-2',
        sessionTranscript.sha256,
      )],
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
