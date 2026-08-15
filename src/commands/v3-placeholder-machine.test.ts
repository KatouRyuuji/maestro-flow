import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { runResponseSchema } from '../run/protocol-schemas.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function invoke(args: string[]) {
  const result = spawnSync(process.execPath, [resolve('bin/maestro.js'), ...args], {
    cwd: resolve('.'),
    encoding: 'utf8',
  });
  const lines = result.stdout.trim().split(/\r?\n/).filter(Boolean);
  return {
    status: result.status,
    stderr: result.stderr,
    lines,
    response: lines.length === 1 ? runResponseSchema.parse(JSON.parse(lines[0])) : null,
  };
}

describe('v3 CLI downgrade guard', () => {
  it('returns SESSION_SCHEMA_UNSUPPORTED before a legacy mutation can rewrite v3 state', () => {
    const root = mkdtempSync(join(tmpdir(), 'maestro-v3-placeholder-'));
    roots.push(root);
    // Legacy writer: `run next` must route through the v2 CLI guard and fail
    // closed on the v3 state instead of dispatching the v3 engine.
    mkdirSync(join(root, '.workflow'), { recursive: true });
    writeFileSync(join(root, '.workflow', 'config.json'), JSON.stringify({
      session_schema: { schema_version: 'session-schema-selection/1.0', writer: 'session/1.3', features: { session_statusless: false } },
    }));
    const sessionDir = join(root, '.workflow', 'sessions', 's-v3');
    mkdirSync(sessionDir, { recursive: true });
    const session = {
      schema_version: 'session/3.0', session_id: 's-v3', objective: 'protect v3',
      definition_of_done: 'no downgrade', status: 'open',
      identity_revision: 1, orchestration_revision: 0, activity_revision: 0,
      chain: [], decisions: [], active_run_ids: [],
      gates_ref: 'gates.json', artifacts_ref: 'artifacts.json', evidence_ref: 'evidence.json',
      created_at: '2026-08-12T00:00:00.000Z', updated_at: '2026-08-12T00:00:00.000Z',
      completed_at: null, archived_at: null,
    };
    const sessionPath = join(sessionDir, 'session.json');
    const bytes = `${JSON.stringify(session, null, 2)}\n`;
    writeFileSync(sessionPath, bytes);

    const result = invoke(['run', 'next', '--session', 's-v3', '--json', '--workflow-root', root]);
    expect(result.status).toBe(1);
    expect(result.stderr).toBe('');
    expect(result.lines).toHaveLength(1);
    expect(runResponseSchema.parse(JSON.parse(result.lines[0]))).toMatchObject({
      ok: false,
      exit_code: 1,
      error: { code: 'SESSION_SCHEMA_UNSUPPORTED' },
    });
    expect(readFileSync(sessionPath, 'utf8')).toBe(bytes);
  });
});
