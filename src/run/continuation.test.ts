import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync,} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createChainSession } from './chain-admin.js';
import {
  continuationAfterDecide,
  continuationForNextFailure,
  inspectSessionContinuation,
  renderContinuationCard,
} from './continuation.js';
import { SessionStore } from './store.js';

function v2Workspace(root: string): void {
  mkdirSync(join(root, ".workflow"), { recursive: true });
  writeFileSync(join(root, ".workflow", "config.json"), JSON.stringify({
    session_schema: { schema_version: "session-schema-selection/1.0", writer: "session/1.3", features: { session_statusless: false } },
  }));
}

const roots: string[] = [];

function root(): string {
  const path = mkdtempSync(join(tmpdir(), 'maestro-continuation-'));

  v2Workspace(path);
  roots.push(path);
  return path;
}

afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('canonical Run continuation', () => {
  it('dispatches a confirmed pending step for manual engine without requiring -y', () => {
    const projectRoot = root();
    const created = createChainSession(projectRoot, 'manual', {
      intent: 'continue manual chain',
      engine: 'manual',
      definition: { steps: [{ command: 'plan' }] },
    });

    const result = inspectSessionContinuation(projectRoot, created.sessionId);
    expect(result).toMatchObject({
      schema_version: 'run-continuation/1.0',
      action: 'dispatch_next',
      authority: 'automatic',
      auto_mode: false,
      reason_code: 'MORE_STEPS',
      command: `maestro run next --session ${created.sessionId} --json`,
    });
    expect(renderContinuationCard(result)).toContain('`suggest_only` means the CLI is passive');
  });

  it('persists auto mode in the directive but keeps normal dispatch automatic', () => {
    const projectRoot = root();
    const created = createChainSession(projectRoot, 'auto', {
      intent: 'continue auto chain',
      engine: 'manual',
      autoMode: true,
      definition: { steps: [{ command: 'execute' }] },
    });

    expect(inspectSessionContinuation(projectRoot, created.sessionId)).toMatchObject({
      action: 'dispatch_next',
      authority: 'automatic',
      auto_mode: true,
    });
  });

  it('surfaces a decision as an automatic formal node without allocating a Run', () => {
    const projectRoot = root();
    const created = createChainSession(projectRoot, 'decision', {
      intent: 'evaluate quality before execution',
      engine: 'ralph',
      definition: {
        steps: [
          { command: 'quality-gate', decision_ref: 'DP-quality' },
          { command: 'execute' },
        ],
        decision_points: [{ point_id: 'DP-quality', after_step_id: null, max_retries: 2 }],
      },
    });

    const result = inspectSessionContinuation(projectRoot, created.sessionId);
    expect(result).toMatchObject({
      action: 'evaluate_decision',
      authority: 'automatic',
      reason_code: 'DECISION_REQUIRED',
      run_id: null,
    });
    expect(result.preconditions).toEqual(expect.arrayContaining([
      'decision_point=DP-quality',
      'do not allocate an execution Run for a decision node',
    ]));
    expect(renderContinuationCard(result)).toContain('- decision_point=DP-quality');
  });

  it('does not loop a fix decision without new repair evidence', () => {
    const projectRoot = root();
    const created = createChainSession(projectRoot, 'decision-fix', {
      intent: 'repair before re-evaluation',
      engine: 'ralph',
      definition: {
        steps: [{ command: 'quality-gate', decision_ref: 'DP-quality' }],
        decision_points: [{ point_id: 'DP-quality', after_step_id: null, max_retries: 2 }],
      },
    });

    expect(continuationAfterDecide(
      projectRoot,
      created.sessionId,
      'DP-quality',
      'fix',
      { count: 1, max: 2, exhausted: false },
    )).toMatchObject({
      action: 'repair_chain',
      authority: 'user_required',
      reason_code: 'DECISION_FIX_REQUIRED',
      command: null,
    });
  });

  it('does not request run next again after the decision card is already loaded', () => {
    const projectRoot = root();
    const created = createChainSession(projectRoot, 'decision-card', {
      intent: 'evaluate one loaded card',
      engine: 'ralph',
      definition: {
        steps: [{ command: 'quality-gate', decision_ref: 'DP-quality' }],
        decision_points: [{ point_id: 'DP-quality', after_step_id: null, max_retries: 2 }],
      },
    });

    expect(continuationForNextFailure(
      projectRoot,
      created.sessionId,
      'DECISION_REQUIRED',
      'canonical decision card',
    )).toMatchObject({
      action: 'evaluate_decision',
      authority: 'automatic',
      reason_code: 'DECISION_CARD_READY',
      command: null,
      preconditions: expect.arrayContaining([
        'do not call run next again for this decision card',
      ]),
    });
  });

  it('requires audited recovery for a paused Session', () => {
    const projectRoot = root();
    const created = createChainSession(projectRoot, 'paused', {
      intent: 'recover paused chain',
      definition: { steps: [{ command: 'review' }] },
    });
    new SessionStore(projectRoot).update(created.sessionId, draft => {
      draft.session.status = 'paused';
      return null;
    });

    expect(inspectSessionContinuation(projectRoot, created.sessionId)).toMatchObject({
      action: 'recover_session',
      authority: 'user_required',
      reason_code: 'SESSION_PAUSED',
      command: null,
    });
  });

  it('seals a drained running chain instead of inventing another command', () => {
    const projectRoot = root();
    const created = createChainSession(projectRoot, 'drained', {
      intent: 'seal drained chain',
      definition: { steps: [{ command: 'test' }] },
    });
    new SessionStore(projectRoot).update(created.sessionId, draft => {
      draft.session.orchestration.chain[0].status = 'sealed';
      return null;
    });

    expect(inspectSessionContinuation(projectRoot, created.sessionId)).toMatchObject({
      action: 'seal_session',
      authority: 'automatic',
      reason_code: 'CHAIN_COMPLETE',
      command: `maestro run seal-session ${created.sessionId} --json`,
    });
  });
});
