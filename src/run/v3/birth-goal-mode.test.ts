import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { ArtifactRegistry, RunV30, SessionStateV30 } from '../schemas.js';
import { SessionStore } from '../store.js';
import { v3BirthPacket } from './mutation-engine.js';

const artifacts: ArtifactRegistry = {
  schema_version: 'artifacts/1.0',
  revision: 0,
  artifacts: {},
  aliases: {},
};

function writeSession(root: string): { store: SessionStore; session: SessionStateV30; run: RunV30 } {
  mkdirSync(join(root, '.workflow'), { recursive: true });
  writeFileSync(join(root, '.workflow', 'config.json'), `${JSON.stringify({
    session_schema: {
      schema_version: 'session-schema-selection/1.0',
      writer: 'session/3.0',
      features: { session_statusless: false },
    },
  }, null, 2)}\n`);
  mkdirSync(join(root, 'prepare'), { recursive: true });
  writeFileSync(join(root, 'prepare', 'maestro.md'), [
    '---',
    'name: maestro',
    'goal: true',
    '---',
    '',
    '# Prepare',
  ].join('\n'));

  const store = new SessionStore(root);
  const session: SessionStateV30 = {
    schema_version: 'session/3.0',
    session_id: 's-goal',
    objective: 'refresh goal ui',
    definition_of_done: 'goal panel updates',
    status: 'open',
    orchestration_revision: 0,
    activity_revision: 0,
    chain: [{
      step_id: 'step-1', command: 'maestro', args: [], status: 'running',
      run_ids: ['r-1'], goal_ref: null, decision_refs: [],
    }],
    decisions: [],
    active_run_ids: ['r-1'],
    artifacts_ref: 'artifacts.json',
    evidence_ref: 'evidence.json',
    created_at: '2026-09-07T00:00:00.000Z',
    updated_at: '2026-09-07T00:00:00.000Z',
    completed_at: null,
    archived_at: null,
  };
  const run: RunV30 = {
    schema_version: 'run/3.0',
    run_id: 'r-1',
    session_id: 's-goal',
    step_id: 'step-1',
    parent_run_id: null,
    retry_of_run_id: null,
    attempt: 1,
    command: 'maestro',
    args: [],
    goal: null,
    status: 'running',
    revision: 0,
    actor_id: 'actor-a',
    input_refs: [],
    output_refs: [],
    primary_artifact_id: null,
    verdict: null,
    summary: null,
    created_at: '2026-09-07T00:00:00.000Z',
    started_at: '2026-09-07T00:00:00.000Z',
    ended_at: null,
    sealed_at: null,
  };
  store.writeSessionV30(session);
  writeFileSync(join(store.sessionDir('s-goal'), 'artifacts.json'), `${JSON.stringify(artifacts, null, 2)}\n`);
  store.writeRunV30(run);
  return { store, session, run };
}

describe('v3 birth packet goal_mode', () => {
  const previousAgent = process.env.CURSOR_AGENT;
  const previousPlatform = process.env.MAESTRO_PLATFORM;

  afterEach(() => {
    if (previousAgent === undefined) delete process.env.CURSOR_AGENT;
    else process.env.CURSOR_AGENT = previousAgent;
    if (previousPlatform === undefined) delete process.env.MAESTRO_PLATFORM;
    else process.env.MAESTRO_PLATFORM = previousPlatform;
  });

  it('injects Cursor CreateGoal instructions when the host is Cursor', () => {
    const root = mkdtempSync(join(tmpdir(), 'maestro-birth-goal-'));
    const { store, session, run } = writeSession(root);
    process.env.CURSOR_AGENT = '1';
    delete process.env.MAESTRO_PLATFORM;

    const birth = v3BirthPacket(store, session, run, artifacts);
    expect(birth.goal_mode?.platform).toBe('cursor');
    expect(birth.goal_mode?.instructions).toContain('CreateGoal');
    expect(birth.goal_mode?.instructions).toContain('用户清除或关闭 Goal 后');
  });

  it('stays on the bound platform when not running as a Cursor agent', () => {
    const root = mkdtempSync(join(tmpdir(), 'maestro-birth-goal-'));
    const { store, session, run } = writeSession(root);
    delete process.env.CURSOR_AGENT;
    delete process.env.MAESTRO_PLATFORM;

    const birth = v3BirthPacket(store, session, run, artifacts);
    expect(birth.goal_mode?.platform).toBe('claude');
    expect(birth.goal_mode?.instructions).toContain('用户清除或关闭 /goal 后');
  });

  it('injects Grok-native /goal clear rules when MAESTRO_PLATFORM=grok', () => {
    const root = mkdtempSync(join(tmpdir(), 'maestro-birth-goal-'));
    const { store, session, run } = writeSession(root);
    delete process.env.CURSOR_AGENT;
    process.env.MAESTRO_PLATFORM = 'grok';

    const birth = v3BirthPacket(store, session, run, artifacts);
    expect(birth.goal_mode?.platform).toBe('grok');
    expect(birth.goal_mode?.instructions).toContain('/goal clear');
  });
});
