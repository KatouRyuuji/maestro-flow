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
 * v3 seal-time knowledge reconciliation hook. Reuses the v2 reconciliation
 * engine verbatim (reconcileRunKnowledgeSync) and persists the receipt at the
 * exact v2 path (reconciliationPath, i.e. knowledge-reconciliation.json next
 * to the Run). The write is a plain, idempotent, non-CAS file write: it never
 * touches session.json, orchestration revision, or any receipt ledger, so a
 * failed or repeated reconcile cannot corrupt v3 mutation authority.
 *
 * Returns the written receipt, or null when reconciliation is unavailable
 * (e.g. missing/unreadable report frontmatter) so `run check` degrades
 * gracefully instead of failing the read command.
 */
export function reconcileV3RunKnowledge(
  projectRoot: string,
  sessionId: string,
  runId: string,
): KnowledgeReconciliation | null {
  try {
    const store = new SessionStore(projectRoot);
    const runDir = store.runDir(sessionId, runId);
    const frontmatter = readReportFrontmatter(runDir);
    const receipt = reconcileRunKnowledgeSync(projectRoot, sessionId, runId, frontmatter);
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
