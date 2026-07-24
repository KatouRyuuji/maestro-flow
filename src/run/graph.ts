// ---------------------------------------------------------------------------
// `maestro session graph` — chain visualization with steps, decisions, goals.
//
// Read-only projection of a Session's orchestration chain, decision points,
// decomposition goals, and position. Complements `session status` (overview)
// and `session next` (step pointer) with a full chain-forward view.
// ---------------------------------------------------------------------------

import { activeStepIndex } from './chain.js';
import { inspectSessionContinuation } from './continuation.js';
import { resolveCompatibleSession, type ResolvedSession } from './session-resolver.js';
import type { SessionState } from './schemas.js';

// ── Result types ─────────────────────────────────────────────────────────────

export interface GraphChainStep {
  index: number;
  step_id: string;
  command: string;
  status: string;
  run_id: string | null;
  decision_ref: string | null;
  stage: string | null;
  goal_ref: string | null;
  active: boolean;
}

export interface GraphDecision {
  point_id: string;
  status: string;
  after_step_id: string | null;
  retry_count: number;
  max_retries: number;
  evidence_ref: string | null;
}

export interface GraphGoal {
  id: string;
  goal: string;
  status: string;
  done_when: string | null;
}

export interface GraphResult {
  session_id: string;
  intent: string;
  status: string;
  engine: string;
  quality_mode: string;
  progress: { sealed: number; running: number; pending: number; total: number };
  chain: GraphChainStep[];
  decisions: GraphDecision[];
  goals: GraphGoal[];
  position: {
    lifecycle: string;
    phase: number | null;
    phase_is_new: boolean;
    milestone: string;
    planning_mode: string | null;
    scope_verdict: string | null;
  } | null;
  continuation: { action: string; command: string | null; reason: string };
}

// ── Builder ──────────────────────────────────────────────────────────────────

export function buildGraph(projectRoot: string, sessionId?: string): GraphResult {
  const resolved = resolveCompatibleSession(projectRoot, sessionId);
  if (!resolved) {
    throw new Error(sessionId ? `Session not found: ${sessionId}` : 'no compatible Session found');
  }
  return buildGraphFromResolved(projectRoot, resolved);
}

export function buildGraphFromResolved(projectRoot: string, resolved: ResolvedSession): GraphResult {
  const { sessionId, bundle } = resolved;
  const session = bundle.session;
  const chain = session.orchestration.chain;
  const activeIdx = activeStepIndex(session);

  const sealed = chain.filter(s => ['completed', 'sealed', 'skipped'].includes(s.status)).length;
  const running = chain.filter(s => s.status === 'running').length;
  const pending = chain.filter(s => s.status === 'pending').length;

  const graphChain: GraphChainStep[] = chain.map((step, index) => ({
    index,
    step_id: step.step_id,
    command: step.command,
    status: step.status,
    run_id: step.run_id,
    decision_ref: step.decision_ref,
    stage: step.stage ?? null,
    goal_ref: step.goal_ref ?? null,
    active: index === activeIdx,
  }));

  const decisions: GraphDecision[] = session.orchestration.decision_points.map(point => ({
    point_id: point.point_id,
    status: point.status,
    after_step_id: point.after_step_id,
    retry_count: point.retry_count,
    max_retries: point.max_retries,
    evidence_ref: point.evidence_ref,
  }));

  const decomposition = session.orchestration.decomposition;
  const goals: GraphGoal[] = (decomposition?.goals ?? []).map(goal => ({
    id: goal.id,
    goal: goal.goal,
    status: goal.status,
    done_when: goal.done_when ?? null,
  }));

  const position = session.orchestration.position;
  const continuation = inspectSessionContinuation(projectRoot, sessionId);

  return {
    session_id: sessionId,
    intent: session.intent,
    status: session.status,
    engine: session.orchestration.engine,
    quality_mode: session.orchestration.quality_mode,
    progress: { sealed, running, pending, total: chain.length },
    chain: graphChain,
    decisions,
    goals,
    position: position ? {
      lifecycle: position.lifecycle,
      phase: position.phase,
      phase_is_new: position.phase_is_new,
      milestone: position.milestone,
      planning_mode: position.planning_mode,
      scope_verdict: position.scope_verdict,
    } : null,
    continuation: {
      action: continuation.action,
      command: continuation.command,
      reason: continuation.reason,
    },
  };
}

// ── Human-readable renderer ──────────────────────────────────────────────────

const STATUS_ICONS: Record<string, string> = {
  completed: '✓',
  sealed: '✓',
  skipped: '⊘',
  running: '▶',
  pending: '○',
  failed: '✗',
};

export function renderGraphHuman(graph: GraphResult): string {
  const lines: string[] = [];

  lines.push(`Session:  ${graph.session_id}`);
  lines.push(`Intent:   ${graph.intent}`);
  lines.push(`Status:   ${graph.status} | Engine: ${graph.engine} | Quality: ${graph.quality_mode}`);
  lines.push(`Progress: ${graph.progress.sealed}/${graph.progress.total} sealed, ${graph.progress.running} running, ${graph.progress.pending} pending`);
  lines.push('');

  // Chain
  lines.push('Chain:');
  for (const step of graph.chain) {
    const icon = step.decision_ref ? '◆' : (STATUS_ICONS[step.status] ?? '?');
    const activeMark = step.active ? '  ← active' : '';
    const runInfo = step.run_id ? ` run:${step.run_id}` : '';
    const decisionInfo = step.decision_ref ? ` decision:${step.decision_ref}` : '';
    const stageInfo = step.stage ? ` (${step.stage})` : '';
    const pad = String(graph.chain.length - 1).length;
    const idx = String(step.index).padStart(pad);
    lines.push(`  [${idx}] ${icon} ${step.command}${stageInfo}  ${step.status}${runInfo}${decisionInfo}${activeMark}`);
  }
  lines.push('');

  // Decisions
  if (graph.decisions.length > 0) {
    lines.push('Decisions:');
    for (const d of graph.decisions) {
      const after = d.after_step_id ? ` (after:${d.after_step_id})` : '';
      lines.push(`  ${d.point_id}: ${d.status}${after} retries:${d.retry_count}/${d.max_retries}`);
    }
    lines.push('');
  }

  // Goals
  if (graph.goals.length > 0) {
    lines.push('Goals:');
    for (const g of graph.goals) {
      const mark = g.status === 'done' ? '[x]' : '[ ]';
      const doneWhen = g.done_when ? ` — done_when: ${g.done_when}` : '';
      lines.push(`  ${mark} ${g.id}: ${g.goal}${doneWhen}`);
    }
    lines.push('');
  }

  // Position
  if (graph.position) {
    const p = graph.position;
    lines.push(`Position: ${p.lifecycle} | Phase ${p.phase ?? '-'}${p.phase_is_new ? ' (new)' : ''} | Milestone: ${p.milestone || '-'}`);
    lines.push('');
  }

  // Continuation
  lines.push(`Next: ${graph.continuation.command ?? graph.continuation.reason}`);

  return lines.join('\n');
}
