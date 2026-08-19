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

export interface KgAutoInitResult {
  initialized: boolean;
  reason?: string;
  durationMs?: number;
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
    // Hold the same FileLock syncKnowledgeGraph uses so DB creation, schema
    // load, and migrations are mutually exclusive with any concurrent
    // auto-init or sync. Without this, two hooks could both pass
    // isInitialized()=false and race on schema/migration application,
    // corrupting FTS shadow tables.
    const { FileLock } = await import('../graph/kg/sync/file-lock.js');
    const lockPath = resolve(projectPath, '.workflow', 'kg', 'maestro.db.lock');
    return await new FileLock(lockPath, { timeoutMs: 30_000 }).withLock(async () => {
      // Re-check inside the lock: a concurrent init may have created the DB
      // while we waited.
      if (MaestroGraph.isInitialized(projectPath)) {
        return { initialized: false, reason: 'already-initialized' };
      }
      const mg = await MaestroGraph.init(projectPath);
      try {
        await mg.sync();
      } finally {
        mg.close();
      }
      kgInitGuard.markDone(sessionId);
      return { initialized: true, durationMs: Date.now() - start };
    });
  } catch (error) {
    // Failed/racing work must stay immediately retryable (CooldownGuard.clear
    // contract) — do NOT markDone on failure; that would suppress retry for
    // the full 5-minute cooldown window and hide transient failures.
    kgInitGuard.clear(sessionId);
    process.stderr.write(
      `[MaestroGraph] KG auto-init failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return { initialized: false, reason: 'init-error' };
  }
}
