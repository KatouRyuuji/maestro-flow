import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RunV30, SessionStateV30 } from '../schemas.js';
import { SessionStore } from '../store.js';
import { completeRunAndAdvance } from './mutation-engine.js';

const roots: string[] = [];

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'maestro-v3-complete-inputs-'));
  roots.push(value);
  mkdirSync(join(value, '.workflow'), { recursive: true });
  writeFileSync(join(value, '.workflow', 'config.json'), `${JSON.stringify({
    session_schema: {
      schema_version: 'session-schema-selection/1.0',
      writer: 'session/3.0',
      features: { session_statusless: false },
    },
  }, null, 2)}\n`);
  return value;
}

function session(status: SessionStateV30['status'] = 'open'): SessionStateV30 {
  return {
    schema_version: 'session/3.0', session_id: 's-1', objective: 'v3 complete inputs', definition_of_done: 'tests pass',
    status, orchestration_revision: 0, activity_revision: 0,
    chain: [
      { step_id: 'step-1', command: 'implement', args: [], status: 'running', run_ids: ['r-1'], goal_ref: null, decision_refs: [] },
      { step_id: 'step-2', command: 'verify', args: [], status: 'pending', run_ids: ['r-2'], goal_ref: null, decision_refs: [] },
    ],
    decisions: [], active_run_ids: ['r-1', 'r-2'], artifacts_ref: 'artifacts.json', evidence_ref: 'evidence.json',
    created_at: '2026-08-12T00:00:00.000Z', updated_at: '2026-08-12T00:00:00.000Z', completed_at: null, archived_at: null,
  };
}

function run(runId: string, stepId: string, status: RunV30['status'] = 'running'): RunV30 {
  return {
    schema_version: 'run/3.0', run_id: runId, session_id: 's-1', step_id: stepId,
    parent_run_id: null, retry_of_run_id: null, attempt: 1, command: 'work', args: [], goal: null,
    status, revision: 0, actor_id: 'actor-a', input_refs: [], output_refs: [],
    primary_artifact_id: null, verdict: null, summary: null, legacy_execution_generation: null,
    created_at: '2026-08-12T00:00:00.000Z', started_at: status === 'running' ? '2026-08-12T00:00:00.000Z' : null,
    ended_at: null, sealed_at: null,
  };
}

function setup(status: SessionStateV30['status'] = 'open'): SessionStore {
  const store = new SessionStore(root());
  store.writeSessionV30(session(status));
  writeFileSync(join(store.sessionDir('s-1'), 'artifacts.json'), `${JSON.stringify({
    schema_version: 'artifacts/1.0', revision: 0, artifacts: {}, aliases: {},
  }, null, 2)}\n`);
  store.writeRunV30(run('r-1', 'step-1'));
  store.writeRunV30(run('r-2', 'step-2'));
  return store;
}

function identity(requestId: string) {
  return {
    sessionId: 's-1', requestId, actorId: 'actor-a', reason: 'test complete inputs',
    recordedAt: '2026-08-12T01:00:00.000Z',
  };
}

function reportFrontmatter(extra = ''): string {
  return `---\nverdict: done\nsummary: "frontmatter summary"\n${extra}---\n`;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('v3 complete-and-advance input handling', () => {
  it('falls back to report.md frontmatter summary when the input summary is omitted', () => {
    const store = setup();
    mkdirSync(store.runDir('s-1', 'r-1'), { recursive: true });
    writeFileSync(join(store.runDir('s-1', 'r-1'), 'report.md'), reportFrontmatter());
    const applied = completeRunAndAdvance(store, {
      ...identity('req-frontmatter'), runId: 'r-1', expectedRunRevision: 0,
      expectedOrchestrationRevision: 0, verdict: 'done',
    });
    expect(applied.status).toBe('applied');
    expect(store.readRunV30('s-1', 'r-1')).toMatchObject({
      status: 'sealed', summary: 'frontmatter summary',
    });
  });

  it('does not persist report.md decisions as decision_records on the sealed Run', () => {
    const store = setup();
    mkdirSync(store.runDir('s-1', 'r-1'), { recursive: true });
    writeFileSync(join(store.runDir('s-1', 'r-1'), 'report.md'), reportFrontmatter(
      'decisions:\n  - text: "Use X"\n    status: accepted\n',
    ));
    const applied = completeRunAndAdvance(store, {
      ...identity('req-decisions'), runId: 'r-1', expectedRunRevision: 0,
      expectedOrchestrationRevision: 0, verdict: 'done',
    });
    expect(applied.status).toBe('applied');
    const sealed = store.readRunV30('s-1', 'r-1');
    expect(sealed.summary).toBe('frontmatter summary');
    expect('decision_records' in sealed).toBe(false);
    expect(sealed).not.toHaveProperty('notes');
  });
});
