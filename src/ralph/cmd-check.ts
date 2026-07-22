// ---------------------------------------------------------------------------
// `maestro ralph check` — compatibility alias for canonical Session health.
// Exit code: 0 if no E findings, 1 otherwise.
// ---------------------------------------------------------------------------

import { resolveCompatibleSession } from '../run/session-resolver.js';
import { checkResolvedSession, summarizeSessionCheck, type SessionCheckFinding } from '../run/session-check.js';
import { workflowRoot } from './session-adapter.js';

export interface CheckCmdOptions {
  sessionId?: string;
  json?: boolean;
}

export type CheckFinding = SessionCheckFinding;

export async function runCheck(opts: CheckCmdOptions): Promise<number> {
  const projectRoot = workflowRoot();
  const resolved = resolveCompatibleSession(projectRoot, opts.sessionId);
  if (!resolved) {
    const msg = opts.sessionId
      ? `[ralph check] session not found: ${opts.sessionId}`
      : '[ralph check] no compatible sessions found in .workflow/sessions/';
    if (opts.json) {
      process.stdout.write(JSON.stringify({ ok: false, error: msg }) + '\n');
    } else {
      console.error(msg);
    }
    return 1;
  }

  const { sessionId, bundle } = resolved;
  const session = bundle.session;
  const findings = checkResolvedSession(projectRoot, resolved);
  const { errors, warnings } = summarizeSessionCheck(findings);

  if (opts.json) {
    process.stdout.write(JSON.stringify({
      ok: errors === 0,
      session_id: sessionId,
      errors, warnings,
      findings,
    }, null, 2) + '\n');
    return errors === 0 ? 0 : 1;
  }

  console.log(`session: ${sessionId}`);
  console.log(`status:  ${session.status}`);
  console.log(`engine:  ${session.orchestration.engine}`);
  console.log(`chain:   ${session.orchestration.chain.length} steps`);
  console.log('');

  if (findings.length === 0) {
    console.log('  ✓ no issues found');
  } else {
    for (const f of findings) {
      const loc = f.step_index !== undefined ? ` [step ${f.step_index}]` : '';
      console.log(`  ${f.level === 'E' ? '✗' : '!'} ${f.code}${loc}: ${f.message}`);
    }
  }
  console.log('');
  console.log(`  summary: ${errors} error${errors === 1 ? '' : 's'}, ${warnings} warning${warnings === 1 ? '' : 's'}`);

  return errors === 0 ? 0 : 1;
}

export function hasErrors(findings: CheckFinding[]): boolean {
  return findings.some(f => f.level === 'E');
}
