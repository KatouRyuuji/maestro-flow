import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { SessionStore } from '../store.js';

/**
 * v2-identical Run report template (src/run/runtime.ts ensureRunShell).
 * Deliberately duplicated as a local constant instead of importing runtime.ts:
 * v3 must never pull the v2 runtime graph into its command wiring, and the
 * bytes must stay byte-for-byte equal to the v2 shell.
 */
const RUN_REPORT_TEMPLATE = '---\nverdict: ready\nsummary: ""\nconstraints: []\ndecisions: []\nconcerns: []\nnext: []\ndetails: {}\n---\n## 摘要\n\n## 结论/Verdict\n\n## 讨论/复盘\n\n## 产物\n\n## 交接/Next\n';

/**
 * Create the v3 Run directory shell exactly like the v2 lifecycle
 * (ensureRunShell): outputs/, evidence/, work/, a report.md seeded with the
 * shared template, and an append-only diagnostics.ndjson. Idempotent —
 * existing files are never overwritten and the diagnostics stream is only
 * ever appended to (with an empty record, so repeated calls are no-ops).
 */
export function ensureV3RunShell(store: SessionStore, sessionId: string, runId: string): string {
  const runDir = store.runDir(sessionId, runId);
  mkdirSync(join(runDir, 'outputs'), { recursive: true });
  mkdirSync(join(runDir, 'evidence'), { recursive: true });
  mkdirSync(join(runDir, 'work'), { recursive: true });
  const report = join(runDir, 'report.md');
  if (!existsSync(report)) {
    writeFileSync(report, RUN_REPORT_TEMPLATE, 'utf8');
  }
  writeFileSync(join(runDir, 'diagnostics.ndjson'), '', { flag: 'a' });
  return runDir;
}
