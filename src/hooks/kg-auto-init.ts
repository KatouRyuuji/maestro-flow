/**
 * KG Auto-Init Hook — UserPromptSubmit / SessionStart
 *
 * Checks if KG database exists; if not, initializes + runs first sync.
 * Uses kgInitGuard for 5-minute cooldown to avoid repeated init attempts.
 *
 * Failure contract (mirrors kg-sync-hook): a failed attempt MUST remain
 * immediately retryable, so the cooldown is cleared (not marked done) on
 * error. See CooldownGuard.clear() docstring "Failed or racing work must
 * remain immediately retryable."
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { kgInitGuard } from '../utils/cooldown-guard.js';
import { logHookError } from './hook-logger.js';

export interface KgAutoInitResult {
  initialized: boolean;
  reason?: string;
  durationMs?: number;
}

class AlreadyInitializedError extends Error {
  constructor() {
    super('MaestroGraph already initialized by a concurrent auto-init');
    this.name = 'AlreadyInitializedError';
  }
}

export async function evaluateKgAutoInit(
  projectPath: string,
  sessionId: string,
): Promise<KgAutoInitResult> {
  try {
    if (!existsSync(resolve(projectPath, '.workflow'))) {
      return { initialized: false, reason: 'no-workflow-dir' };
    }

    const { MaestroGraph } = await import('../graph/kg/engine.js');

    if (MaestroGraph.isInitialized(projectPath)) {
      return { initialized: false, reason: 'already-initialized' };
    }

    if (!kgInitGuard.shouldRun(sessionId)) {
      return { initialized: false, reason: 'cooldown' };
    }

    const start = Date.now();
    // Protect ONLY MaestroGraph.init() (DB create + schema + migrations) with
    // the same FileLock syncKnowledgeGraph uses, so two concurrent auto-init
    // hooks cannot race on schema/migration application and corrupt FTS shadow
    // tables. mg.sync() is invoked OUTSIDE this lock because syncKnowledgeGraph
    // acquires the SAME lock internally — wrapping sync() here would deadlock
    // (FileLock is not re-entrant). The gap between init and sync is safe: init
    // is idempotent for an existing file, and sync serializes itself.
    const { FileLock } = await import('../graph/kg/sync/file-lock.js');
    const lockPath = resolve(projectPath, '.workflow', 'kg', 'maestro.db.lock');
    const mg = await new FileLock(lockPath, { timeoutMs: 30_000 }).withLock(async () => {
      // Re-check inside the lock: a concurrent init may have created the DB
      // while we waited.
      if (MaestroGraph.isInitialized(projectPath)) {
        throw new AlreadyInitializedError();
      }
      return await MaestroGraph.init(projectPath);
    });
    try {
      await mg.sync();
    } finally {
      mg.close();
    }
    kgInitGuard.markDone(sessionId);
    return { initialized: true, durationMs: Date.now() - start };
  } catch (error) {
    // A concurrent auto-init created the DB while we held the lock — not an
    // error, just nothing to do.
    if (error instanceof AlreadyInitializedError) {
      return { initialized: false, reason: 'already-initialized' };
    }
    // Failed/racing work must stay immediately retryable (CooldownGuard.clear
    // contract) — do NOT markDone on failure; that would suppress retry for
    // the full 5-minute cooldown window and hide transient failures.
    kgInitGuard.clear(sessionId);
    logHookError('kg-auto-init', error, { message: 'KG auto-init failed' });
    return { initialized: false, reason: 'init-error' };
  }
}
