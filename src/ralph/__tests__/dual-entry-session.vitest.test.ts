// P0 dual-entry E2E — verifies that Maestro-created and Ralph-created Sessions
// are mutually resolvable after the engine filter removal (P0-2).
//
// Invariants under test:
//  1. resolveRalphSession() resolves a Session created with engine=manual (maestro).
//  2. resolveRalphSession() auto-discovers the latest compatible Session regardless of engine.
//  3. A Ralph-created Session (engine=ralph) is readable via the generic SessionStore.
//  4. requireRunning filter still works after engine filter removal.

import { describe, it, beforeEach, afterEach, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createChainSession, type ChainDefinition } from '../../run/chain-admin.js';
import { createRalphSession, resolveRalphSession } from '../session-adapter.js';
import { SessionStore } from '../../run/store.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dual-entry-'));
});

afterEach(() => {
  try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
});

function maestroDefinition(): ChainDefinition {
  return {
    intent: 'maestro orchestration task',
    engine: 'manual',
    steps: [
      { command: 'analyze', stage: 'analyze' },
      { command: 'execute', stage: 'execute' },
    ],
  };
}

describe('P0 dual-entry: Maestro Session resolved by Ralph resolver', () => {
  it('resolves a maestro-engine Session by explicit sessionId', () => {
    // createChainSession derives sessionId from slug; capture the actual id
    const { sessionId } = createChainSession(root, 'maestro-task', {
      definition: maestroDefinition(),
    });

    // Ralph resolver must find it — no engine filter
    const resolved = resolveRalphSession(root, sessionId);
    expect(resolved).not.toBeNull();
    expect(resolved!.sessionId).toBe(sessionId);
    expect(resolved!.bundle.session.orchestration.engine).toBe('manual');
    expect(resolved!.bundle.session.orchestration.chain).toHaveLength(2);
  });

  it('auto-discovers the latest compatible Session regardless of engine', () => {
    // Create a maestro session (older)
    createChainSession(root, 'maestro-older', { definition: maestroDefinition() });

    // Create a ralph session with explicit timestamp id (newer)
    createRalphSession(root, 'ralph-20260722-000002', 'ralph task', {
      chain: [
        { step_id: 'step-000-review', command: 'review', status: 'pending', run_id: null, inserted_by: 'build', decision_ref: null },
      ],
    });

    // Auto-discover should return the newest session (ralph-20260722-000002)
    const resolved = resolveRalphSession(root);
    expect(resolved).not.toBeNull();
    expect(resolved!.sessionId).toBe('ralph-20260722-000002');
  });

  it('auto-discovers a maestro Session when it is the only one', () => {
    const { sessionId } = createChainSession(root, 'maestro-only', {
      definition: maestroDefinition(),
    });

    const resolved = resolveRalphSession(root);
    expect(resolved).not.toBeNull();
    expect(resolved!.sessionId).toBe(sessionId);
    expect(resolved!.bundle.session.orchestration.engine).toBe('manual');
  });

  it('requireRunning filter still works after engine filter removal', () => {
    const { sessionId } = createChainSession(root, 'maestro-running-check', {
      definition: maestroDefinition(),
    });

    // createChainSession creates sessions with status 'running'
    const store = new SessionStore(root);
    const status = store.readBundle(sessionId).session.status;
    expect(status).toBe('running');

    // requireRunning: true should succeed for a running session
    expect(resolveRalphSession(root, sessionId, { requireRunning: true })).not.toBeNull();
  });
});

describe('P0 dual-entry: Ralph Session readable by generic SessionStore', () => {
  it('reads a ralph-engine Session via SessionStore without engine filtering', () => {
    // Use explicit timestamp id so sessionId is used verbatim
    createRalphSession(root, 'ralph-20260722-000001', 'ralph orchestration task', {
      chain: [
        { step_id: 'step-000-analyze', command: 'analyze', status: 'pending', run_id: null, inserted_by: 'build', decision_ref: null },
        { step_id: 'step-001-execute', command: 'execute', status: 'pending', run_id: null, inserted_by: 'build', decision_ref: null },
      ],
    });

    const store = new SessionStore(root);
    expect(store.sessionExists('ralph-20260722-000001')).toBe(true);

    const bundle = store.readBundle('ralph-20260722-000001');
    expect(bundle.session.orchestration.engine).toBe('ralph');
    expect(bundle.session.orchestration.chain).toHaveLength(2);
    expect(bundle.session.intent).toBe('ralph orchestration task');
  });

  it('ralph Session schema is session/1.3 and chain is intact', () => {
    const { sessionId } = createRalphSession(root, 'ralph-20260722-000003', 'lineage test', {
      chain: [
        { step_id: 'step-000-analyze', command: 'analyze', status: 'pending', run_id: null, inserted_by: 'build', decision_ref: null },
      ],
    });

    const store = new SessionStore(root);
    const bundle = store.readBundle(sessionId);
    expect(bundle.session.schema_version).toBe('session/1.3');
    expect(bundle.session.orchestration.chain[0].step_id).toBe('step-000-analyze');
  });
});
