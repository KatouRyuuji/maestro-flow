import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

import {
  commandRunSchema,
  type CommandRun,
  type RunV30,
  type SessionStateV30,
} from './schemas.js';
import { SessionStore } from './store.js';

const roots: string[] = [];
const sidecarSchema = z.object({
  schema_version: z.literal('test-knowledge-sidecar/1.0'),
  revision: z.number().int().nonnegative(),
  entries: z.array(z.string()),
}).strict();
type Sidecar = z.infer<typeof sidecarSchema>;

function root(writer: 'session/1.3' | 'session/3.0'): string {
  const value = mkdtempSync(join(tmpdir(), 'maestro-store-knowledge-v3-'));
  roots.push(value);
  const workflowRoot = join(value, '.workflow');
  mkdirSync(workflowRoot, { recursive: true });
  writeFileSync(join(workflowRoot, 'config.json'), `${JSON.stringify({
    session_schema: {
      schema_version: 'session-schema-selection/1.0',
      writer,
      features: { session_statusless: false },
    },
  }, null, 2)}\n`);
  return value;
}

function sessionV30(
  sessionId = 's-v3',
  activeRunIds: string[] = ['run-v3'],
): SessionStateV30 {
  return {
    schema_version: 'session/3.0',
    session_id: sessionId,
    objective: 'exercise v3 knowledge storage',
    definition_of_done: 'knowledge writes preserve execution authority',
    status: 'open',
    orchestration_revision: 0,
    activity_revision: 0,
    chain: [{
      step_id: 'step-1',
      command: 'implement',
      args: [],
      status: 'running',
      run_ids: [...activeRunIds],
      goal_ref: null,
      decision_ref: null,
      decision_refs: [],
    }],
    decisions: [],
    active_run_ids: [...activeRunIds],
    artifacts_ref: 'artifacts.json',
    evidence_ref: 'evidence.json',
    created_at: '2026-08-16T00:00:00.000Z',
    updated_at: '2026-08-16T00:00:00.000Z',
    completed_at: null,
    archived_at: null,
  };
}

function runV30(sessionId = 's-v3', runId = 'run-v3'): RunV30 {
  return {
    schema_version: 'run/3.0',
    run_id: runId,
    session_id: sessionId,
    step_id: 'step-1',
    parent_run_id: null,
    retry_of_run_id: null,
    attempt: 1,
    command: 'implement',
    args: [],
    goal: null,
    status: 'running',
    revision: 1,
    actor_id: 'actor-a',
    input_refs: [],
    output_refs: [],
    primary_artifact_id: null,
    verdict: null,
    summary: null,
    legacy_execution_generation: null,
    created_at: '2026-08-16T00:00:00.000Z',
    started_at: '2026-08-16T00:01:00.000Z',
    ended_at: null,
    sealed_at: null,
  };
}

function setupV30(): SessionStore {
  const store = new SessionStore(root('session/3.0'));
  store.writeSessionV30(sessionV30());
  store.writeRunV30(runV30());
  return store;
}

function legacyRun(sessionId: string, runId: string): CommandRun {
  const hash = 'a'.repeat(64);
  return commandRunSchema.parse({
    schema_version: 'command-run/1.0',
    session_id: sessionId,
    run_id: runId,
    sequence: 1,
    parent_run_id: null,
    command: {
      name: 'legacy',
      version: '1.0',
      source_path: 'legacy.md',
      content_hash: hash,
      resolved_prompt_hash: hash,
    },
    status: 'running',
    input: { args: [], consumes: [], context_identity_revision: 0 },
    gate_ids: [],
    output: { produces: [], primary_artifact_id: null, verdict: null },
    handoff: null,
    started_at: '2026-08-16T00:00:00.000Z',
    completed_at: null,
    sealed_at: null,
  });
}

function setupLegacy(): { store: SessionStore; sessionId: string; runId: string } {
  const store = new SessionStore(root('session/1.3'));
  const sessionId = 's-legacy';
  const runId = 'run-legacy';
  store.createSession(sessionId, 'legacy store compatibility');
  store.update(sessionId, (draft, tx) => {
    draft.session.active_run_id = runId;
    tx.writeRun(legacyRun(sessionId, runId));
  });
  return { store, sessionId, runId };
}

function authorityBytes(store: SessionStore, sessionId: string, runId: string): string[] {
  return [
    readFileSync(join(store.sessionDir(sessionId), 'session.json'), 'utf8'),
    readFileSync(join(store.runDir(sessionId, runId), 'run.json'), 'utf8'),
  ];
}

function sidecar(revision = 0, entries: string[] = []): Sidecar {
  return { schema_version: 'test-knowledge-sidecar/1.0', revision, entries };
}

afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('SessionStore v3 knowledge primitives', () => {
  it('fails closed on retained legacy Executions after v3 migration without changing canonical authority', () => {
    const store = setupV30();
    const executionId = 'execution-legacy-g1';
    const executionDir = join(store.sessionDir('s-v3'), 'executions', executionId);
    mkdirSync(executionDir, { recursive: true });
    writeFileSync(join(executionDir, 'execution.json'), `${JSON.stringify({
      schema_version: 'execution/1.0', execution_id: executionId, session_id: 's-v3',
      generation: 1, status: 'sealed', revision: 1, active_run_id: null,
      chain: [], decision_points: [], gates_ref: 'gates.json', artifacts_ref: 'artifacts.json',
      evidence_ref: 'evidence.json', lease: null, started_at: '2026-08-16T00:00:00.000Z',
      sealed_at: '2026-08-16T00:01:00.000Z', seal_summary: 'legacy', final_outcome: 'done',
    }, null, 2)}\n`);
    const authorityBefore = authorityBytes(store, 's-v3', 'run-v3');

    expect(() => store.listExecutions('s-v3')).toThrow(/retained legacy Execution storage is not a v3 authority/);
    expect(() => store.readExecution('s-v3', executionId)).toThrow(/retained legacy Execution storage is not a v3 authority/);
    expect(authorityBytes(store, 's-v3', 'run-v3')).toEqual(authorityBefore);
  });

  it('locates strict Run records across generations without changing legacy findRun', () => {
    const v3 = setupV30();
    expect(v3.findRunRecord('run-v3')).toEqual({
      sessionId: 's-v3',
      run: runV30(),
    });
    expect(() => v3.findRun('run-v3')).toThrowError(expect.objectContaining({
      code: 'SESSION_SCHEMA_UNSUPPORTED',
    }));

    v3.writeSessionV30(sessionV30('s-other', ['run-v3']));
    v3.writeRunV30(runV30('s-other', 'run-v3'));
    expect(() => v3.findRunRecord('run-v3')).toThrow(/Run ID is ambiguous/);
    expect(v3.findRunRecord('run-v3', 's-other').run).toMatchObject({
      schema_version: 'run/3.0',
      session_id: 's-other',
    });

    const legacy = setupLegacy();
    expect(legacy.store.findRunRecord(legacy.runId)).toMatchObject({
      sessionId: legacy.sessionId,
      run: { schema_version: 'command-run/1.3', run_id: legacy.runId },
    });
    expect(legacy.store.findRun(legacy.runId).run).toMatchObject({
      schema_version: 'command-run/1.3',
      run_id: legacy.runId,
    });
  });

  it('commits only v3 knowledge sidecars and corpus files in one batch', () => {
    const store = setupV30();
    const runSidecar = join(store.runDir('s-v3', 'run-v3'), 'knowledge-delta.json');
    const corpus = join(store.workflowRoot, 'specs', 'coding-conventions.md');
    mkdirSync(join(store.workflowRoot, 'specs'), { recursive: true });
    writeFileSync(corpus, 'before\n', 'utf8');
    const authorityBefore = authorityBytes(store, 's-v3', 'run-v3');

    expect(() => store.withV30KnowledgeTransaction('s-v3', tx => {
      tx.writeJson(runSidecar, sidecar(1, ['queued']), sidecarSchema);
      tx.writeText(corpus, 'not committed\n');
      expect(existsSync(`${corpus}.lock`)).toBe(true);
      expect(existsSync(join(store.workflowRoot, '.knowledge-corpus.namespace.lock'))).toBe(true);
      throw new Error('abort knowledge transaction');
    })).toThrow(/abort knowledge transaction/);
    expect(existsSync(runSidecar)).toBe(false);
    expect(readFileSync(corpus, 'utf8')).toBe('before\n');
    expect(existsSync(`${corpus}.lock`)).toBe(false);
    expect(existsSync(join(store.workflowRoot, '.knowledge-corpus.namespace.lock'))).toBe(false);

    const result = store.withV30KnowledgeTransaction('s-v3', tx => {
      expect(tx.readSession().schema_version).toBe('session/3.0');
      expect(tx.readRun('run-v3').schema_version).toBe('run/3.0');
      expect(tx.pendingText(corpus)).toBeNull();
      tx.writeText(corpus, 'committed\n');
      expect(existsSync(`${corpus}.lock`)).toBe(true);
      expect(tx.pendingText(corpus)).toBe('committed\n');
      tx.writeJson(runSidecar, sidecar(1, ['committed']), sidecarSchema);
      return 'committed';
    });

    expect(result).toBe('committed');
    expect(JSON.parse(readFileSync(runSidecar, 'utf8'))).toEqual(sidecar(1, ['committed']));
    expect(readFileSync(corpus, 'utf8')).toBe('committed\n');
    expect(existsSync(`${corpus}.lock`)).toBe(false);
    expect(existsSync(join(store.workflowRoot, '.knowledge-corpus.namespace.lock'))).toBe(false);
    expect(authorityBytes(store, 's-v3', 'run-v3')).toEqual(authorityBefore);
  });

  it('preserves unrelated corpus bytes during crashed transaction recovery', () => {
    const store = setupV30();
    const corpus = join(store.workflowRoot, 'knowhow', 'recovery.md');
    mkdirSync(join(store.workflowRoot, 'knowhow'), { recursive: true });
    const original = 'original corpus bytes\n';
    const next = 'partial transaction bytes\n';
    const thirdParty = 'legitimate post-crash bytes\n';
    writeFileSync(corpus, thirdParty, 'utf8');
    const partialCorpus = join(store.workflowRoot, 'knowhow', 'partial.md');
    const partialOriginal = 'partial original bytes\n';
    const partialNext = 'partial committed bytes\n';
    writeFileSync(partialCorpus, partialNext, 'utf8');
    const tmpPath = `${corpus}.tmp-recovery-fixture`;
    const partialTmpPath = `${partialCorpus}.tmp-recovery-fixture`;
    writeFileSync(tmpPath, next, 'utf8');
    writeFileSync(partialTmpPath, partialNext, 'utf8');
    const hash = (value: string) => createHash('sha256').update(value).digest('hex');
    const intentPath = join(store.sessionsRoot, '.session-store-transaction.json');
    writeFileSync(intentPath, `${JSON.stringify({
      schema_version: 'session-store-intent/1.0',
      transaction_id: 'tx_recovery_fixture',
      created_at: '2026-08-16T00:00:00.000Z',
      writes: [
        {
          path: 'knowhow/recovery.md',
          tmp_path: 'knowhow/recovery.md.tmp-recovery-fixture',
          original_base64: Buffer.from(original).toString('base64'),
          original_sha256: hash(original),
          next_sha256: hash(next),
        },
        {
          path: 'knowhow/partial.md',
          tmp_path: 'knowhow/partial.md.tmp-recovery-fixture',
          original_base64: Buffer.from(partialOriginal).toString('base64'),
          original_sha256: hash(partialOriginal),
          next_sha256: hash(partialNext),
        },
      ],
    }, null, 2)}\n`, 'utf8');

    store.withV30KnowledgeTransaction('s-v3', () => undefined);
    expect(readFileSync(corpus, 'utf8')).toBe(thirdParty);
    expect(readFileSync(partialCorpus, 'utf8')).toBe(partialOriginal);
    expect(existsSync(tmpPath)).toBe(false);
    expect(existsSync(partialTmpPath)).toBe(false);
    expect(existsSync(intentPath)).toBe(false);
    expect(existsSync(join(store.workflowRoot, '.knowledge-corpus.namespace.lock'))).toBe(false);
  });

  it('rejects symlinked corpus parents before reading or acquiring external locks', () => {
    const store = setupV30();
    const outside = join(store.projectRoot, 'outside-specs');
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'external.md'), 'external bytes\n', 'utf8');
    symlinkSync(outside, join(store.workflowRoot, 'specs'), process.platform === 'win32' ? 'junction' : 'dir');
    const throughLink = join(store.workflowRoot, 'specs', 'external.md');

    expect(() => store.withV30KnowledgeTransaction('s-v3', tx => tx.readText(throughLink)))
      .toThrow(/Unsafe v3 knowledge corpus path/);
    expect(existsSync(join(outside, 'external.md.lock'))).toBe(false);
    expect(existsSync(join(store.workflowRoot, '.knowledge-corpus.namespace.lock'))).toBe(false);
  });

  it('rejects authority, receipt, cross-session, escape, and non-corpus paths before commit', () => {
    const store = setupV30();
    const validSidecar = join(store.runDir('s-v3', 'run-v3'), 'knowledge-reconciliation.json');
    const sessionPath = join(store.sessionDir('s-v3'), 'session.json');
    const runPath = join(store.runDir('s-v3', 'run-v3'), 'run.json');
    const receiptPath = store.requestReceiptV20Path('s-v3', 'req-1');
    const crossSession = join(store.sessionDir('s-other'), 'knowledge-delta.json');
    const nestedCorpus = join(store.workflowRoot, 'specs', 'nested', 'entry.md');
    const outside = join(store.projectRoot, 'outside.md');
    const authorityBefore = authorityBytes(store, 's-v3', 'run-v3');

    expect(() => store.withV30KnowledgeTransaction('s-v3', tx => {
      tx.writeJson(validSidecar, sidecar(1), sidecarSchema);
      tx.writeJson(sessionPath, sidecar(2), sidecarSchema);
    })).toThrow(/limited to Session\/Run knowledge sidecars/);
    expect(existsSync(validSidecar)).toBe(false);

    for (const rejected of [runPath, receiptPath, crossSession]) {
      expect(() => store.withV30KnowledgeTransaction('s-v3', tx => {
        tx.writeJson(rejected, sidecar(1), sidecarSchema);
      })).toThrow(/limited to Session\/Run knowledge sidecars/);
    }
    for (const rejected of [nestedCorpus, outside]) {
      expect(() => store.withV30KnowledgeTransaction('s-v3', tx => {
        tx.writeText(rejected, 'rejected\n');
      })).toThrow(/limited to top-level Markdown corpus files/);
    }
    expect(() => store.withV30KnowledgeTransaction('s-v3', tx => {
      tx.writeJson(join(store.workflowRoot, 'specs', 'entry.md'), sidecar(1), sidecarSchema);
    })).toThrow(/limited to Session\/Run knowledge sidecars/);
    expect(authorityBytes(store, 's-v3', 'run-v3')).toEqual(authorityBefore);
  });

  it('mutates only an owned sidecar of an active mutable v3 Run and preserves legacy behavior', () => {
    const store = setupV30();
    const path = join(store.runDir('s-v3', 'run-v3'), 'knowledge-delta.json');
    const authorityBefore = authorityBytes(store, 's-v3', 'run-v3');

    const result = store.updateActiveRunSidecar(
      's-v3',
      'run-v3',
      path,
      sidecarSchema,
      sidecar(),
      draft => {
        draft.entries.push('recorded');
        draft.revision++;
        return { revision: draft.revision };
      },
    );
    expect(result).toEqual({ revision: 1 });
    expect(authorityBytes(store, 's-v3', 'run-v3')).toEqual(authorityBefore);

    store.writeActiveRunSidecar('s-v3', 'run-v3', path, sidecar(2, ['replaced']), sidecarSchema);
    const sidecarBeforeAbort = readFileSync(path, 'utf8');
    expect(() => store.updateActiveRunSidecar(
      's-v3',
      'run-v3',
      path,
      sidecarSchema,
      sidecar(),
      draft => {
        draft.entries.push('not committed');
        throw new Error('abort sidecar mutation');
      },
    )).toThrow(/abort sidecar mutation/);
    expect(readFileSync(path, 'utf8')).toBe(sidecarBeforeAbort);

    expect(() => store.updateActiveRunSidecar(
      's-v3',
      'run-v3',
      join(store.runDir('s-v3', 'run-v3'), 'focused-sidecar.json'),
      sidecarSchema,
      sidecar(),
      () => undefined,
    )).toThrow(/limited to Session\/Run knowledge sidecars/);
    expect(() => store.updateActiveRunSidecar(
      's-v3',
      'run-v3',
      join(store.sessionDir('s-v3'), 'knowledge-delta.json'),
      sidecarSchema,
      sidecar(),
      () => undefined,
    )).toThrow(/not owned by Run run-v3/);

    store.writeSessionV30({ ...store.readSessionV30('s-v3'), active_run_ids: [] });
    expect(() => store.updateActiveRunSidecar(
      's-v3', 'run-v3', path, sidecarSchema, sidecar(), () => undefined,
    )).toThrow(/not an active Run/);

    const legacy = setupLegacy();
    const legacyPath = join(legacy.store.runDir(legacy.sessionId, legacy.runId), 'focused-sidecar.json');
    expect(legacy.store.updateActiveRunSidecar(
      legacy.sessionId,
      legacy.runId,
      legacyPath,
      sidecarSchema,
      sidecar(),
      draft => {
        draft.revision++;
        return draft.revision;
      },
    )).toBe(1);
    expect(existsSync(legacyPath)).toBe(true);
  });

  it('discovers one v3 active Run and fails ambiguity closed', () => {
    const store = setupV30();
    expect(store.findUniqueActiveRun()).toEqual({ sessionId: 's-v3', runId: 'run-v3' });

    store.writeRunV30(runV30('s-v3', 'run-2'));
    store.writeSessionV30(sessionV30('s-v3', ['run-v3', 'run-2']));
    expect(store.findUniqueActiveRun()).toBeNull();

    store.writeSessionV30(sessionV30('s-v3', ['run-v3']));
    store.writeSessionV30(sessionV30('s-other', ['run-other']));
    store.writeRunV30(runV30('s-other', 'run-other'));
    expect(store.findUniqueActiveRun()).toBeNull();

    store.writeSessionV30({
      ...store.readSessionV30('s-other'),
      status: 'completed',
      active_run_ids: [],
      completed_at: '2026-08-16T00:02:00.000Z',
    });
    expect(store.findUniqueActiveRun()).toEqual({ sessionId: 's-v3', runId: 'run-v3' });
  });
});
