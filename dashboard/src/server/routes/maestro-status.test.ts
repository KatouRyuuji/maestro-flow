import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  createMaestroStatusRoutes,
  type MaestroStatusResponse,
} from './maestro-status.js';

let workflowRoot: string;
let app: ReturnType<typeof createMaestroStatusRoutes>;

async function write(relativePath: string, value: unknown): Promise<void> {
  const path = join(workflowRoot, relativePath);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    typeof value === 'string' ? value : JSON.stringify(value, null, 2),
    'utf-8',
  );
}

beforeEach(async () => {
  workflowRoot = await mkdtemp(join(tmpdir(), 'maestro-status-route-'));
  app = createMaestroStatusRoutes(workflowRoot);
});

afterEach(async () => {
  await rm(workflowRoot, { recursive: true, force: true });
});

describe('maestro status routes', () => {
  it('reads canonical session/3.0 and run/3.0 projections chronologically', async () => {
    const sessionId = 'session-v3-hash-runs';
    await write('state.json', {
      version: '3.0',
      project_name: 'route-fixture',
      active_session_id: sessionId,
      sessions: [{ session_id: sessionId, intent: 'stale registry intent', status: 'sealed' }],
    });
    await write(`sessions/${sessionId}/session.json`, {
      schema_version: 'session/3.0',
      session_id: sessionId,
      objective: 'Project canonical Session and Run state',
      definition_of_done: 'The status route is read-compatible',
      status: 'open',
      orchestration_revision: 4,
      activity_revision: 4,
      chain: [],
      decisions: [],
      active_run_ids: ['hash-b-pending', 'hash-c-running'],
      artifacts_ref: 'artifacts.json',
      evidence_ref: 'evidence.json',
      created_at: '2026-08-20T00:00:00.000Z',
      updated_at: '2026-08-20T05:00:00.000Z',
      completed_at: null,
      archived_at: null,
    });

    const canonicalRun = (
      runId: string,
      status: string,
      createdAt: string,
      endedAt: string | null,
      overrides: Record<string, unknown> = {},
    ) => ({
      schema_version: 'run/3.0',
      run_id: runId,
      session_id: sessionId,
      step_id: `step-${runId}`,
      parent_run_id: null,
      retry_of_run_id: null,
      attempt: 1,
      command: 'verify',
      args: [],
      goal: null,
      status,
      revision: 1,
      actor_id: 'actor-v3',
      input_refs: [],
      output_refs: [],
      primary_artifact_id: null,
      verdict: status === 'sealed' ? 'done_with_concerns' : null,
      summary: `Summary for ${runId}`,
      created_at: createdAt,
      started_at: createdAt,
      ended_at: endedAt,
      sealed_at: status === 'sealed' ? endedAt : null,
      ...overrides,
    });

    // Hash-like IDs deliberately sort opposite their lifecycle timestamps.
    await write(`sessions/${sessionId}/runs/hash-z-old/run.json`, canonicalRun(
      'hash-z-old',
      'sealed',
      '2026-08-20T01:00:00.000Z',
      '2026-08-20T04:30:00.000Z',
    ));
    await write(`sessions/${sessionId}/runs/hash-a-new/run.json`, canonicalRun(
      'hash-a-new',
      'sealed',
      '2026-08-20T03:00:00.000Z',
      '2026-08-20T03:30:00.000Z',
    ));
    await write(`sessions/${sessionId}/runs/hash-b-pending/run.json`, canonicalRun(
      'hash-b-pending',
      'pending',
      '2026-08-20T05:00:00.000Z',
      null,
    ));
    await write(`sessions/${sessionId}/runs/hash-c-running/run.json`, canonicalRun(
      'hash-c-running',
      'running',
      '2026-08-20T06:00:00.000Z',
      null,
    ));
    await write(`sessions/${sessionId}/runs/hash-d-cancelled/run.json`, canonicalRun(
      'hash-d-cancelled',
      'cancelled',
      '2026-08-20T04:00:00.000Z',
      '2026-08-20T04:01:00.000Z',
    ));

    await write('specs/spec.md', '# Spec\n');
    await write('memory/memory.md', '# Memory\n');
    await write('knowhow/knowhow.md', '# Knowhow\n');
    await write('learning/events.jsonl', '{"id":1}\n{"id":2}\n');
    await write('issues/issues.jsonl', '{"id":1}\n{"id":2}\n{"id":3}\n');

    const overviewResponse = await app.request('/api/maestro-status');
    expect(overviewResponse.status).toBe(200);
    const overview = await overviewResponse.json() as MaestroStatusResponse;
    expect(overview.sessions).toHaveLength(1);
    expect(overview.sessions[0]).toMatchObject({
      session_id: sessionId,
      intent: 'Project canonical Session and Run state',
      status: 'open',
      active_run_ids: ['hash-b-pending', 'hash-c-running'],
      active_run_id: 'hash-c-running',
      latest_completed_run_id: 'hash-z-old',
      run_count: 5,
      latest_run: {
        run_id: 'hash-c-running',
        status: 'running',
        actor_id: 'actor-v3',
        summary: 'Summary for hash-c-running',
        created_at: '2026-08-20T06:00:00.000Z',
        ended_at: null,
      },
    });
    expect(overview.knowledge).toEqual({
      specs: 1,
      memory: 1,
      knowhow: 1,
      learning_rows: 2,
      issue_rows: 3,
      total: 8,
    });

    const runsResponse = await app.request(`/api/maestro-status/runs?session=${sessionId}`);
    expect(runsResponse.status).toBe(200);
    const detail = await runsResponse.json() as {
      session_id: string;
      runs: Array<Record<string, unknown>>;
    };
    expect(detail.runs.map((run) => run.run_id)).toEqual([
      'hash-z-old',
      'hash-a-new',
      'hash-d-cancelled',
      'hash-b-pending',
      'hash-c-running',
    ]);
    expect(detail.runs[1]).toMatchObject({
      verdict: 'done_with_concerns',
      command: 'verify',
      platform: null,
      actor_id: 'actor-v3',
      summary: 'Summary for hash-a-new',
      created_at: '2026-08-20T03:00:00.000Z',
      ended_at: '2026-08-20T03:30:00.000Z',
      completed_at: '2026-08-20T03:30:00.000Z',
    });
  });

  it('invalidates the overview cache when the workflow root changes', async () => {
    const secondRoot = await mkdtemp(join(tmpdir(), 'maestro-status-route-second-'));
    let currentRoot = workflowRoot;
    const dynamicApp = createMaestroStatusRoutes(() => currentRoot);
    try {
      await write('state.json', { project_name: 'first-project', sessions: [] });
      const first = await dynamicApp.request('/api/maestro-status');
      expect((await first.json() as MaestroStatusResponse).project.project_name).toBe('first-project');

      currentRoot = secondRoot;
      await writeFile(join(secondRoot, 'state.json'), JSON.stringify({
        project_name: 'second-project',
        sessions: [],
      }), 'utf8');
      const second = await dynamicApp.request('/api/maestro-status');
      expect((await second.json() as MaestroStatusResponse).project.project_name).toBe('second-project');
    } finally {
      await rm(secondRoot, { recursive: true, force: true });
    }
  });

  it('preserves legacy singular session and nested run fields', async () => {
    const sessionId = '20260820-legacy';
    const runId = '20260820-001-review';
    await write('state.json', {
      sessions: [{ session_id: sessionId, intent: 'Legacy intent', status: 'sealed' }],
    });
    await write(`sessions/${sessionId}/session.json`, {
      schema_version: 'session/1.3',
      session_id: sessionId,
      active_run_id: runId,
      latest_completed_run_id: runId,
    });
    await write(`sessions/${sessionId}/runs/${runId}/run.json`, {
      schema_version: 'command-run/1.3',
      run_id: runId,
      sequence: 1,
      status: 'sealed',
      command: { name: 'review' },
      resolved_platform: 'claude',
      output: { verdict: 'done' },
      handoff: { summary: 'Legacy nested summary' },
      started_at: '2026-08-20T01:00:00.000Z',
      completed_at: '2026-08-20T01:05:00.000Z',
    });

    const response = await app.request('/api/maestro-status');
    const body = await response.json() as MaestroStatusResponse;
    expect(body.sessions[0]).toMatchObject({
      intent: 'Legacy intent',
      status: 'sealed',
      active_run_ids: [runId],
      active_run_id: runId,
      latest_completed_run_id: runId,
      latest_run: {
        run_id: runId,
        sequence: 1,
        verdict: 'done',
        command: 'review',
        platform: 'claude',
        actor_id: null,
        summary: 'Legacy nested summary',
        completed_at: '2026-08-20T01:05:00.000Z',
      },
    });
  });
});
