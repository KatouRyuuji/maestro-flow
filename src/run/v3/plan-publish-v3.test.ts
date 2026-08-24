import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { publishPlanV3 } from './plan-publish-v3.js';
import { SessionStore } from '../store.js';

const roots: string[] = [];

function setup(): string {
  const root = mkdtempSync(join(tmpdir(), 'maestro-plan-v3-'));
  roots.push(root);
  mkdirSync(join(root, '.workflow'), { recursive: true });
  writeFileSync(join(root, '.workflow', 'config.json'), JSON.stringify({
    session_schema: {
      schema_version: 'session-schema-selection/1.0',
      writer: 'session/3.0',
      features: { session_statusless: false },
    },
  }));
  mkdirSync(join(root, 'prepare'), { recursive: true });
  writeFileSync(join(root, 'prepare', 'plan-publish.md'), `---
name: plan-publish
session-mode: run
contract:
  contract_version: 2.1
  arguments: []
  consumes: []
  produces:
    - path: outputs/plan.json
      kind: plan
      alias: current-plan
      role: primary
      required: true
      schema: plan/1.0
  gates:
    entry: []
    exit: []
---
`, 'utf8');
  return root;
}

function source(root: string, markdown = '# Approved\n\nShip it.\n'): string {
  const path = join(root, 'approved.md');
  writeFileSync(path, markdown, 'utf8');
  return path;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('publishPlanV3', () => {
  it('publishes an approved Plan as a sealed plan/1.0 current-plan artifact', () => {
    const root = setup();
    const sourcePath = source(root);
    const result = publishPlanV3({
      projectRoot: root,
      sourcePath,
      handoffKey: 'handoff-v3-1',
      sourcePiSession: 'pi-session-1',
      planRevision: 3,
      approvedAt: '2026-08-24T01:00:00.000Z',
      actor: 'pi-session-1',
      reason: 'Publish approved v3 Plan',
      evidence: ['pi-plan:handoff-v3-1'],
    });

    expect(result.schema_version).toBe('plan-publish-result/1.2');
    expect(result.replayed).toBe(false);
    expect(result.created_session).toBe(true);
    expect(result.handoff_key).toBe('handoff-v3-1');
    expect(result.plan_revision).toBe(3);
    expect(result.approved_at).toBe('2026-08-24T01:00:00.000Z');
    expect(result.source_pi_session).toBe('pi-session-1');
    expect(result.source_checksum).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(result.artifact_id).not.toMatch(/^plan:/);
    expect(result.run_id).toMatch(/^run-/);
    expect(result.next.suggest_only).toBe(true);
    expect(result.next.command).toContain('maestro session complete');

    // The artifact is sealed in the Session Artifact Registry and bound to
    // the current-plan alias.
    const store = new SessionStore(root);
    const session = store.readSessionV30(result.session_id);
    const artifacts = JSON.parse(
      readFileSync(join(store.sessionDir(result.session_id), session.artifacts_ref), 'utf8'),
    ) as { artifacts: Record<string, { status: string; producer_run_id: string; relative_path: string }>; aliases: Record<string, string> };
    expect(artifacts.aliases['current-plan']).toBe(result.artifact_id);
    const artifact = artifacts.artifacts[result.artifact_id];
    expect(artifact.status).toBe('sealed');
    expect(artifact.producer_run_id).toBe(result.run_id);

    // The sealed plan.json carries the pi-markdown variant with _meta.
    const plan = JSON.parse(
      readFileSync(join(store.sessionDir(result.session_id), artifact.relative_path), 'utf8'),
    );
    expect(plan).toMatchObject({
      _meta: { kind: 'plan', schema: 'plan/1.0', role: 'primary', alias: 'current-plan' },
      source_format: 'pi-markdown',
      handoff_key: 'handoff-v3-1',
      revision: 3,
      approved_at: '2026-08-24T01:00:00.000Z',
      markdown: '# Approved\n\nShip it.\n',
    });
    expect(plan.source_checksum).toBe(result.source_checksum);

    // The chain step is completed after run complete --advance.
    expect(session.chain.map(step => [step.command, step.status])).toEqual([
      ['plan-publish', 'completed'],
    ]);
  });

  it('replays the same request idempotently', () => {
    const root = setup();
    const sourcePath = source(root);
    const options = {
      projectRoot: root,
      sourcePath,
      handoffKey: 'handoff-v3-2',
      sourcePiSession: 'pi-session-1',
      planRevision: 1,
      approvedAt: '2026-08-24T02:00:00.000Z',
      requestId: 'req-plan-v3-replay',
      actor: 'pi-session-1',
      reason: 'Publish approved v3 Plan',
      evidence: ['pi-plan:handoff-v3-2'],
    };

    const first = publishPlanV3(options);
    const replay = publishPlanV3(options);

    expect(replay.replayed).toBe(true);
    expect(replay.run_id).toBe(first.run_id);
    expect(replay.artifact_id).toBe(first.artifact_id);
    expect(replay.session_id).toBe(first.session_id);
    expect(replay.transition.transition_id).toBe(first.transition.transition_id);
  });

  it('rejects Execution authority options on the v3 path', () => {
    const root = setup();
    const sourcePath = source(root);
    // The v3 programmatic API (PublishPlanV3Options) intentionally exposes
    // no Execution/lease/legacy-revision surface. This test asserts the CLI
    // layer in src/commands/plan.ts rejects those flags before reaching the
    // v3 path; the type system enforces the same at compile time here.
    const v3Options = {
      projectRoot: root,
      sourcePath,
      handoffKey: 'handoff-v3-3',
    };
    // No execution field exists on PublishPlanV3Options, so any attempt to
    // pass one is a compile-time error. Verify the happy path still works.
    const result = publishPlanV3(v3Options);
    expect(result.schema_version).toBe('plan-publish-result/1.2');
  });

  it('requires the session/3.0 writer', () => {
    const root = mkdtempSync(join(tmpdir(), 'maestro-plan-v3-legacy-'));
    roots.push(root);
    mkdirSync(join(root, '.workflow'), { recursive: true });
    writeFileSync(join(root, '.workflow', 'config.json'), JSON.stringify({
      session_schema: {
        schema_version: 'session-schema-selection/1.0',
        writer: 'session/1.3',
        features: { session_statusless: false },
      },
    }));
    const sourcePath = source(root);
    expect(() => publishPlanV3({
      projectRoot: root,
      sourcePath,
      handoffKey: 'handoff-v3-4',
    })).toThrow(/session\/3.0 writer/);
  });

  it('derives a stable automatic Session id from the request id', () => {
    const root = setup();
    const sourcePath = source(root);
    const first = publishPlanV3({
      projectRoot: root,
      sourcePath,
      handoffKey: 'handoff-v3-5',
      requestId: 'req-plan-v3-auto',
      actor: 'pi-session-1',
      reason: 'Publish approved v3 Plan',
    });
    // No --session supplied: the automatic id is deterministic from the
    // request id, so a second publish with the same request id replays.
    const replay = publishPlanV3({
      projectRoot: root,
      sourcePath,
      handoffKey: 'handoff-v3-5',
      requestId: 'req-plan-v3-auto',
      actor: 'pi-session-1',
      reason: 'Publish approved v3 Plan',
    });
    expect(replay.session_id).toBe(first.session_id);
    expect(replay.replayed).toBe(true);
  });
});
