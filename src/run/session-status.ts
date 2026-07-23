import { activeStepIndex } from './chain.js';
import { inspectSessionContinuation } from './continuation.js';
import type { ContinuationDirective } from './protocol-schemas.js';
import type { ResolvedSession } from './session-resolver.js';
import { listRecoveryBlockers, nextRecoveryAction, type RecoveryBlocker, type RecoveryNext } from './session-transition.js';

export interface SessionStatusSummary {
  session_id: string;
  status: ResolvedSession['bundle']['session']['status'];
  engine: ResolvedSession['bundle']['session']['orchestration']['engine'];
  intent: string;
  progress: { terminal: number; total: number; pending: number };
  active_step: null | {
    index: number;
    step_id: string;
    command: string;
    status: string;
    run_id: string | null;
    decision_ref: string | null;
  };
  active_run_id: string | null;
  latest_completed_run_id: string | null;
  revisions: { identity: number; activity: number };
  recovery: {
    blockers: RecoveryBlocker[];
    can_resume: boolean;
    next: RecoveryNext;
  };
  position: ResolvedSession['bundle']['session']['orchestration']['position'];
  decomposition: ResolvedSession['bundle']['session']['orchestration']['decomposition'];
  registry: { artifacts: number; evidence: number; gates: number };
  continuation: ContinuationDirective;
}

export function summarizeSession(projectRoot: string, resolved: ResolvedSession): SessionStatusSummary {
  const { session, artifacts, evidence, gates } = resolved.bundle;
  const chain = session.orchestration.chain;
  const active = activeStepIndex(session);
  const terminal = chain.filter(step => ['completed', 'sealed', 'skipped'].includes(step.status)).length;
  const pending = chain.filter(step => step.status === 'pending').length;
  const activeStep = active === null ? null : {
    index: active,
    step: chain[active],
  };
  const blockers = listRecoveryBlockers(session);
  return {
    session_id: resolved.sessionId,
    status: session.status,
    engine: session.orchestration.engine,
    intent: session.intent,
    progress: { terminal, total: chain.length, pending },
    active_step: activeStep ? {
      index: activeStep.index,
      step_id: activeStep.step.step_id,
      command: activeStep.step.command,
      status: activeStep.step.status,
      run_id: activeStep.step.run_id,
      decision_ref: activeStep.step.decision_ref,
    } : null,
    active_run_id: session.active_run_id,
    latest_completed_run_id: session.latest_completed_run_id,
    revisions: { identity: session.identity_revision, activity: session.activity_revision },
    recovery: {
      blockers,
      can_resume: session.status === 'paused' && blockers.length === 0,
      next: nextRecoveryAction(session),
    },
    position: session.orchestration.position,
    decomposition: session.orchestration.decomposition,
    registry: {
      artifacts: Object.keys(artifacts.artifacts).length,
      evidence: Object.keys(evidence.records).length,
      gates: Object.keys(gates.gates).length,
    },
    continuation: inspectSessionContinuation(projectRoot, resolved.sessionId),
  };
}
