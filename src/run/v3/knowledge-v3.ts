import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

import {
  knowledgeReconciliationSchema,
  reconcileRunKnowledgeSync,
  reconciliationPath,
  reconciliationSummary,
  type KnowledgeReconciliation,
} from '../../knowledge/reconcile.js';
import { readReportFrontmatter } from '../report.js';
import { SessionStore } from '../store.js';

/**
 * Generate the v3 Run knowledge reconciliation receipt (pure computation, no
 * writes). Reuses the v2 reconciliation engine verbatim
 * (reconcileRunKnowledgeSync); the caller decides how to persist it. In the
 * v3 complete path the receipt is committed inside the same atomic
 * withV30Transaction as the staged knowledge delta (mutation-engine.ts), so
 * reconciliation and staging can never diverge.
 *
 * Returns null when reconciliation is unavailable (e.g. missing/unreadable
 * report frontmatter) so callers degrade gracefully instead of failing.
 */
export function generateV3RunKnowledgeReconciliation(
  projectRoot: string,
  sessionId: string,
  runId: string,
): KnowledgeReconciliation | null {
  try {
    const store = new SessionStore(projectRoot);
    const runDir = store.runDir(sessionId, runId);
    const frontmatter = readReportFrontmatter(runDir);
    return reconcileRunKnowledgeSync(projectRoot, sessionId, runId, frontmatter);
  } catch {
    return null;
  }
}

/**
 * Legacy v3 seal-time knowledge reconciliation hook: generate + plain write
 * outside any mutation transaction. Retained for compatibility/fallback
 * (idempotent, non-CAS, never touches mutation authority); the canonical v3
 * complete path uses generateV3RunKnowledgeReconciliation and commits the
 * receipt inside the mutation transaction instead.
 */
export function reconcileV3RunKnowledge(
  projectRoot: string,
  sessionId: string,
  runId: string,
): KnowledgeReconciliation | null {
  try {
    const receipt = generateV3RunKnowledgeReconciliation(projectRoot, sessionId, runId);
    if (!receipt) return null;
    const store = new SessionStore(projectRoot);
    const runDir = store.runDir(sessionId, runId);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      reconciliationPath(store, sessionId, runId),
      `${JSON.stringify(receipt, null, 2)}\n`,
      'utf8',
    );
    return receipt;
  } catch {
    return null;
  }
}

/**
 * Read the v3 Run knowledge reconciliation receipt from the same path v2 uses
 * (reconciliationPath). JSON.parse + schema validation; any failure returns
 * null so callers treat a missing or corrupted receipt as "not reconciled".
 */
export function readV3KnowledgeReconciliation(
  store: SessionStore,
  sessionId: string,
  runId: string,
): KnowledgeReconciliation | null {
  const path = reconciliationPath(store, sessionId, runId);
  if (!existsSync(path)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    const result = knowledgeReconciliationSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

/**
 * v2-aligned summary shape (reconcile.ts reconciliationSummary): candidates/
 * counts digest including the review_required count. Delegating to the shared
 * v2 function guarantees the v3 check payload stays byte-identical in shape.
 */
export function v3ReconciliationSummary(
  receipt: KnowledgeReconciliation,
): ReturnType<typeof reconciliationSummary> {
  return reconciliationSummary(receipt);
}
