import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  sessionKnowledgeDeltaPath,
  stageRunKnowledgeCandidate,
  summarizeSessionKnowledge,
} from './knowledge.js';
import {
  ensureSyntheticKnowledgeSession,
  recordSessionKnowledgeInputs,
  stageSessionKnowledgeCandidate,
  SYNTHETIC_SESSION_PREFIX,
  syntheticKnowledgeSessionId,
} from './session-knowledge.js';
import { completeRun, createRun, sealSession } from './runtime.js';
import { SessionStore } from './store.js';

const roots: string[] = [];

function root(): string {
  const path = mkdtempSync(join(tmpdir(), 'maestro-session-knowledge-'));
  roots.push(path);
  installCommand(path);
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

describe('synthetic knowledge session (K2)', () => {
  it('derives deterministic daily-partitioned IDs from host/project/date', () => {
    const projectRoot = root();
    const fixed = new Date(2026, 7, 6);
    const a = syntheticKnowledgeSessionId('pi-uuid-1', projectRoot, fixed);
    const b = syntheticKnowledgeSessionId('pi-uuid-1', projectRoot, fixed);
    expect(a).toBe(b);
    expect(a).toMatch(/^ksyn-[a-f0-9]{16}$/);
    expect(syntheticKnowledgeSessionId('pi-uuid-2', projectRoot, fixed)).not.toBe(a);
    expect(syntheticKnowledgeSessionId('pi-uuid-1', projectRoot, new Date(2026, 7, 7))).not.toBe(a);
  });

  it('creates idempotently and reuses the same bundle', () => {
    const projectRoot = root();
    const first = ensureSyntheticKnowledgeSession(projectRoot, 'claude-uuid-1');
    expect(first.created).toBe(true);
    expect(first.sessionId.startsWith(SYNTHETIC_SESSION_PREFIX)).toBe(true);
    const second = ensureSyntheticKnowledgeSession(projectRoot, 'claude-uuid-1');
    expect(second.created).toBe(false);
    expect(second.sessionId).toBe(first.sessionId);
    const store = new SessionStore(projectRoot);
    expect(store.sessionExists(first.sessionId)).toBe(true);
  });
});

describe('session knowledge ledger (K1)', () => {
  it('stages candidates with session evidence anchor and summarizes origin=session', () => {
    const projectRoot = root();
    const { sessionId } = ensureSyntheticKnowledgeSession(projectRoot, 'host-a');

    const result = stageSessionKnowledgeCandidate(projectRoot, sessionId, {
      target: 'knowhow',
      title: 'Session-only insight',
      content: 'Session-only insight content',
      evidenceRefs: ['src/foo.ts:12'],
    });
    expect(result.origin).toBe('session');
    expect(result.session_id).toBe(sessionId);

    const summary = summarizeSessionKnowledge(projectRoot, sessionId, { readOnly: true });
    const candidate = summary.candidates.find(item => item.candidate_id === result.candidate_id);
    expect(candidate).toBeDefined();
    expect(candidate?.origin).toBe('session');
    expect(candidate?.run_ids).toEqual([]);
    expect(candidate?.stage).toBe('observed');
    expect(candidate?.evidence_refs).toContain(`session:${sessionId}`);
    expect(candidate?.evidence_refs).toContain('src/foo.ts:12');
    expect(summary.run_count).toBe(0);
  });

  it('rejects staging without evidence (S2 precondition)', () => {
    const projectRoot = root();
    const { sessionId } = ensureSyntheticKnowledgeSession(projectRoot, 'host-b');
    expect(() => stageSessionKnowledgeCandidate(projectRoot, sessionId, {
      target: 'knowhow',
      title: 'No evidence',
      content: 'No evidence content',
    })).toThrow(/--evidence/);
  });

  it('records inputs visible in summary with origin=session', () => {
    const projectRoot = root();
    const { sessionId } = ensureSyntheticKnowledgeSession(projectRoot, 'host-c');
    const result = recordSessionKnowledgeInputs(projectRoot, sessionId, ['spec:SPC-1'], 'validated', 'manual');
    expect(result.recorded).toBe(1);
    const summary = summarizeSessionKnowledge(projectRoot, sessionId, { readOnly: true });
    const input = summary.inputs.find(item => item.knowledge_id === 'spec:SPC-1');
    expect(input?.origin).toBe('session');
    expect(input?.run_id).toBe('');
    expect(summary.input_totals.validated).toBe(1);
  });

  it('keeps cross-origin same candidate IDs separately accounted (K7)', () => {
    const projectRoot = root();
    const created = createRun({
      projectRoot,
      command: 'knowledge-demo',
      sessionId: 'cross-origin-session',
      intent: 'cross origin accounting',
    });
    const content = 'Shared insight across run and session ledgers';
    // Run-origin staging (run delta).
    const runStore = new SessionStore(projectRoot);
    expect(runStore.sessionExists(created.session_id)).toBe(true);
    stageRunKnowledgeCandidate(projectRoot, created.run_id, {
      target: 'knowhow',
      title: 'Shared insight',
      content,
    }, created.session_id);
    // Session-origin staging of the identical content on the same Session.
    const sessionResult = stageSessionKnowledgeCandidate(projectRoot, created.session_id, {
      target: 'knowhow',
      title: 'Shared insight',
      content,
      evidenceRefs: ['manual-note'],
    });

    const summary = summarizeSessionKnowledge(projectRoot, created.session_id, { readOnly: true });
    const matching = summary.candidates.filter(item => item.candidate_id === sessionResult.candidate_id);
    expect(matching).toHaveLength(2);
    const origins = matching.map(item => item.origin ?? 'run').sort();
    expect(origins).toEqual(['run', 'session']);
    const runEntry = matching.find(item => (item.origin ?? 'run') === 'run')!;
    expect(runEntry.run_ids).toEqual([created.run_id]);
  });

  it('refuses sidecar writes once the Session is sealed (S8)', () => {
    const projectRoot = root();
    const created = createRun({
      projectRoot,
      command: 'knowledge-demo',
      sessionId: 'seal-guard-session',
      intent: 'sealed write guard',
    });
    completeRun(projectRoot, created.run_id, created.session_id);
    sealSession(projectRoot, created.session_id, 'sealed for guard test');
    expect(() => stageSessionKnowledgeCandidate(projectRoot, created.session_id, {
      target: 'knowhow',
      title: 'Too late',
      content: 'Too late content',
      evidenceRefs: ['src/x.ts:1'],
    })).toThrow(/cannot mutate knowledge sidecars/);
  });

  it('writes the session delta sidecar next to session.json', () => {
    const projectRoot = root();
    const { sessionId } = ensureSyntheticKnowledgeSession(projectRoot, 'host-d');
    recordSessionKnowledgeInputs(projectRoot, sessionId, ['spec:SPC-9'], 'cited', 'manual');
    const store = new SessionStore(projectRoot);
    expect(existsSync(sessionKnowledgeDeltaPath(store, sessionId))).toBe(true);
  });
});
