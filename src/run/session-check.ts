import { resolveStepContent } from './contract.js';
import { SessionStore } from './store.js';
import type { ResolvedSession } from './session-resolver.js';

export interface SessionCheckFinding {
  level: 'E' | 'W';
  code: string;
  message: string;
  step_index?: number;
}

export function checkResolvedSession(projectRoot: string, resolved: ResolvedSession): SessionCheckFinding[] {
  const findings: SessionCheckFinding[] = [];
  const store = new SessionStore(projectRoot);
  const session = resolved.bundle.session;
  const chain = session.orchestration.chain;
  const stepIds = new Set<string>();

  for (let index = 0; index < chain.length; index++) {
    const step = chain[index];
    if (stepIds.has(step.step_id)) {
      findings.push({ level: 'E', code: 'E010', message: `duplicate step_id "${step.step_id}"`, step_index: index });
    }
    stepIds.add(step.step_id);

    if (!step.decision_ref && step.status !== 'skipped') {
      const content = resolveStepContent(projectRoot, step.command);
      if (!content.prepare && !content.workflow) {
        findings.push({
          level: 'E', code: 'E006',
          message: `command "${step.command}" has no prepare or workflow content`,
          step_index: index,
        });
      }
    }

    if (step.status === 'running' && !step.run_id) {
      findings.push({ level: 'E', code: 'E005', message: 'running step has no run_id', step_index: index });
      continue;
    }
    if (!step.run_id) continue;
    try {
      const run = store.readRun(resolved.sessionId, step.run_id);
      if (run.chain_step_id !== step.step_id) {
        findings.push({ level: 'E', code: 'E011', message: `Run ${run.run_id} binds ${run.chain_step_id ?? '(none)'}`, step_index: index });
      }
      if (run.command.name !== step.command) {
        findings.push({ level: 'E', code: 'E012', message: `Run ${run.run_id} command is "${run.command.name}"`, step_index: index });
      }
      if (['completed', 'sealed'].includes(step.status) && run.status !== 'sealed') {
        findings.push({ level: 'W', code: 'W006', message: `terminal step Run ${run.run_id} is ${run.status}, expected sealed`, step_index: index });
      }
      if (['completed', 'sealed'].includes(step.status) && !run.handoff?.summary) {
        findings.push({ level: 'W', code: 'W007', message: `terminal step Run ${run.run_id} has no handoff summary`, step_index: index });
      }
    } catch (error) {
      findings.push({ level: 'E', code: 'E007', message: `cannot read Run ${step.run_id}: ${(error as Error).message}`, step_index: index });
    }
  }

  const running = chain.filter(step => step.status === 'running');
  if (running.length > 1) findings.push({ level: 'E', code: 'E008', message: `${running.length} steps are running simultaneously (expected <=1)` });
  if (running.length === 1 && session.active_run_id !== running[0].run_id) {
    findings.push({ level: 'E', code: 'E009', message: `active_run_id does not match running step ${running[0].step_id}` });
  }
  if (running.length === 0 && session.active_run_id) {
    findings.push({ level: 'W', code: 'W009', message: `active_run_id ${session.active_run_id} has no running chain step` });
  }

  const pointIds = new Set(session.orchestration.decision_points.map(point => point.point_id));
  for (let index = 0; index < chain.length; index++) {
    const ref = chain[index].decision_ref;
    if (ref && !pointIds.has(ref)) findings.push({ level: 'E', code: 'E013', message: `decision_ref "${ref}" has no decision point`, step_index: index });
  }
  for (const point of session.orchestration.decision_points) {
    if (!chain.some(step => step.decision_ref === point.point_id)) {
      findings.push({ level: 'W', code: 'W008', message: `decision point "${point.point_id}" has no matching chain step` });
    }
    if (point.after_step_id && !stepIds.has(point.after_step_id)) {
      findings.push({ level: 'E', code: 'E014', message: `decision point "${point.point_id}" references missing step "${point.after_step_id}"` });
    }
  }

  return findings;
}

export function summarizeSessionCheck(findings: SessionCheckFinding[]): { errors: number; warnings: number } {
  return {
    errors: findings.filter(finding => finding.level === 'E').length,
    warnings: findings.filter(finding => finding.level === 'W').length,
  };
}
