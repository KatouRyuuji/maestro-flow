// M2 — `run complete` verdict-driven chain advancement, 免参 resolution, signal
// routing, lease guard, and the next-pointer closure. Covers the four verdicts
// against a real Run (created via createRun so the seal path exercises gates +
// handoff derivation), then asserts the chain / session transitions.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { briefRun, checkRun, completeRunWithVerdict, createRun } from './runtime.js';
import { runNextStep } from './next.js';
import { resolveRunningRun, runningChainStep } from './resolve.js';
import { checkLease } from './lease.js';
import { updateChainStepStatus } from './chain.js';
import { SessionStore } from './store.js';
import { registerRunCommand } from '../commands/run.js';
import { registerSessionCommand } from '../commands/session.js';
import { writeStateJson, migrateV1toV2 } from '../utils/state-schema.js';
import type { SessionState } from './schemas.js';
import { prepareTransitionMutation } from './transition-receipts.js';

function v2Workspace(root: string): void {
  mkdirSync(join(root, ".workflow"), { recursive: true });
  writeFileSync(join(root, ".workflow", "config.json"), JSON.stringify({
    session_schema: { schema_version: "session-schema-selection/1.0", writer: "session/1.3", features: { session_statusless: false } },
  }));
}

const roots: string[] = [];

function root(): string {
  const path = mkdtempSync(join(tmpdir(), 'maestro-verdict-'));

  v2Workspace(path);
  roots.push(path);
  return path;
}

/** A minimal command with a workflow body so createRun accepts it. */
function stepCommand(projectRoot: string, name: string): void {
  const cmdDir = join(projectRoot, '.claude', 'commands');
  mkdirSync(cmdDir, { recursive: true });
  writeFileSync(join(cmdDir, `${name}.md`), `<contract>\nconsumes: []\nproduces: []\ngates:\n  entry: []\n  exit: []\n</contract>\n`, 'utf8');
  const wfDir = join(projectRoot, 'workflows');
  mkdirSync(wfDir, { recursive: true });
  writeFileSync(join(wfDir, `${name}.md`), `# ${name}\n\nwork\n`, 'utf8');
}

/** A command whose contract requires a typed consume — proves a missing required
 * upstream blocks completion instead of hollow-sealing (007/013 regression). */
function requiredConsumeCommand(projectRoot: string, name: string, kind: string, alias: string): void {
  const cmdDir = join(projectRoot, '.claude', 'commands');
  mkdirSync(cmdDir, { recursive: true });
  writeFileSync(join(cmdDir, `${name}.md`), `<contract>\nconsumes:\n  - kind: ${kind}\n    alias: ${alias}\n    required: true\nproduces: []\ngates:\n  entry: []\n  exit: []\n</contract>\n`, 'utf8');
  const wfDir = join(projectRoot, 'workflows');
  mkdirSync(wfDir, { recursive: true });
  writeFileSync(join(wfDir, `${name}.md`), `# ${name}\n\nwork\n`, 'utf8');
}

function proposalCommand(projectRoot: string, name: string, effects: string[]): void {
  stepCommand(projectRoot, name);
  writeFileSync(join(projectRoot, '.claude', 'commands', `${name}.md`), `<contract>\ncontract_version: 2
orchestration:
  chain_effects: [${effects.join(', ')}]
consumes: []
produces:
  - kind: chain-proposal
    path: outputs/chain-proposal.json
    alias: chain-proposal
    role: attachment
    required: false
    schema: chain-proposal/1.0
gates:
  entry: []
  exit: []
</contract>\n`, 'utf8');
}

function reviewProposalCommand(projectRoot: string, name = 'review'): void {
  stepCommand(projectRoot, name);
  writeFileSync(join(projectRoot, '.claude', 'commands', `${name}.md`), `<contract>\ncontract_version: 2
orchestration:
  chain_effects: [insert]
consumes: []
produces:
  - kind: review-findings
    path: outputs/review-findings.json
    alias: latest-review
    role: primary
    required: true
    schema: review-findings/1.0
  - kind: chain-proposal
    path: outputs/chain-proposal.json
    alias: chain-proposal
    role: attachment
    required: false
    schema: chain-proposal/1.0
gates:
  entry: []
  exit: []
</contract>\n`, 'utf8');
}

function negativeEvidencePlanCommand(projectRoot: string, name = 'plan'): void {
  stepCommand(projectRoot, name);
  writeFileSync(join(projectRoot, '.claude', 'commands', `${name}.md`), `<contract>\ncontract_version: 2.1
consumes:
  - kind: review-findings
    alias: latest-review
    required: false
    schema: review-findings/1.0
    role: primary
    accepts_negative_evidence: true
produces: []
gates:
  entry: []
  exit: []
</contract>\n`, 'utf8');
}

function writeReviewFindings(
  projectRoot: string,
  sessionId: string,
  runId: string,
  verdict: 'PASS' | 'WARN' | 'BLOCK',
): void {
  writeFileSync(
    join(projectRoot, '.workflow', 'sessions', sessionId, 'runs', runId, 'outputs', 'review-findings.json'),
    JSON.stringify({
      _meta: { kind: 'review-findings', schema: 'review-findings/1.0', role: 'primary', alias: 'latest-review' },
      verdict,
      findings: [],
    }, null, 2),
    'utf8',
  );
}

function writeChainProposal(
  projectRoot: string,
  sessionId: string,
  runId: string,
  skill: string,
  operations: unknown[],
): string {
  const relativePath = 'outputs/chain-proposal.json';
  writeFileSync(join(projectRoot, '.workflow', 'sessions', sessionId, 'runs', runId, relativePath), JSON.stringify({
    _meta: { kind: 'chain-proposal', schema: 'chain-proposal/1.0', role: 'attachment', alias: 'chain-proposal' },
    proposal_id: 'cp-atomic-1',
    source: { session_id: sessionId, run_id: runId, skill },
    reason: 'Insert verification after the completed analysis.',
    operations,
  }, null, 2), 'utf8');
  return relativePath;
}

interface StepSeed {
  command: string;
  status?: string;
  decision_ref?: string | null;
}

function seedSession(
  projectRoot: string,
  sessionId: string,
  steps: StepSeed[],
  opts: { active?: boolean; lease?: SessionState['orchestration']['lease'] } = {},
): void {
  const store = new SessionStore(projectRoot);
  store.createSession(sessionId, `intent ${sessionId}`);
  store.update(sessionId, (draft) => {
    draft.session.orchestration.engine = 'coordinator';
    draft.session.orchestration.chain = steps.map((s, i) => ({
      step_id: `step-${String(i).padStart(3, '0')}-${s.command}`,
      command: s.command,
      status: s.status ?? 'pending',
      run_id: null,
      inserted_by: 'test',
      decision_ref: s.decision_ref ?? null,
    }));
    draft.session.orchestration.decision_points = steps.flatMap((step, index) => {
      if (!step.decision_ref) return [];
      return [{
        point_id: step.decision_ref,
        after_step_id: index > 0 ? `step-${String(index - 1).padStart(3, '0')}-${steps[index - 1].command}` : null,
        status: 'pending' as const,
        retry_count: 0,
        max_retries: 2,
        evidence_ref: null,
      }];
    });
    if (opts.lease !== undefined) draft.session.orchestration.lease = opts.lease;
    return null;
  });
  const state = migrateV1toV2({ project_name: 'demo', status: 'active' });
  state.sessions = [{
    session_id: sessionId, intent: `intent ${sessionId}`, status: 'running',
    depends_on: [], roadmap_artifact_id: null, seed_ref: null,
  }];
  if (opts.active) state.active_session_id = sessionId;
  writeStateJson(projectRoot, state);
}

/**
 * Create a Run for step `index` and mark that chain step running (what `run next`
 * does), then write a minimal ready report so the seal path produces a handoff.
 */
function startStep(projectRoot: string, sessionId: string, index: number, summary = 'done work'): string {
  const store = new SessionStore(projectRoot);
  const command = store.readBundle(sessionId).session.orchestration.chain[index].command;
  const created = createRun({ projectRoot, command, sessionId, intent: `intent ${sessionId}` });
  updateChainStepStatus(projectRoot, sessionId, index, 'running', created.run_id);
  const runDir = join(projectRoot, '.workflow', 'sessions', sessionId, 'runs', created.run_id);
  writeFileSync(join(runDir, 'report.md'), `---\nverdict: ready\nsummary: ${summary}\nconstraints: []\ndecisions: []\nconcerns: []\nnext: []\n---\n## 摘要\n${summary}\n`, 'utf8');
  return created.run_id;
}

function chainOf(projectRoot: string, sessionId: string): SessionState['orchestration']['chain'] {
  return new SessionStore(projectRoot).readBundle(sessionId).session.orchestration.chain;
}

function readRunHandoff(projectRoot: string, sessionId: string, runId: string) {
  return new SessionStore(projectRoot).readRun(sessionId, runId).handoff;
}

afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

/** Drive `maestro run complete` through commander with the given argv tail. */
async function runCompleteCli(projectRoot: string, argv: string[]): Promise<unknown> {
  const program = new Command();
  program.exitOverride();
  registerRunCommand(program);
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  try {
    await program.parseAsync(['node', 'maestro', 'run', 'complete', ...argv, '--workflow-root', projectRoot]);
  } catch {
    /* commander exitOverride throws on parse/validation exit — inspect exitCode */
  }
  const last = log.mock.calls.at(-1)?.[0];
  return typeof last === 'string' ? JSON.parse(last) : undefined;
}

/** Drive `maestro session done` through commander with the given argv tail. */
async function runSessionDoneCli(projectRoot: string, argv: string[]): Promise<unknown> {
  const program = new Command();
  program.exitOverride();
  registerSessionCommand(program);
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  try {
    await program.parseAsync(['node', 'maestro', 'session', 'done', ...argv, '--workflow-root', projectRoot]);
  } catch {
    /* commander exitOverride throws on parse/validation exit — inspect exitCode */
  }
  const last = log.mock.calls.at(-1)?.[0];
  return typeof last === 'string' ? JSON.parse(last) : undefined;
}

/** Drive `maestro run done` through commander with the given argv tail. */
async function runDoneCli(projectRoot: string, argv: string[]): Promise<unknown> {
  const program = new Command();
  program.exitOverride();
  registerRunCommand(program);
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  try {
    await program.parseAsync(['node', 'maestro', 'run', 'done', ...argv, '--workflow-root', projectRoot]);
  } catch {
    /* commander exitOverride throws on parse/validation exit — inspect exitCode */
  }
  const last = log.mock.calls.at(-1)?.[0];
  return typeof last === 'string' ? JSON.parse(last) : undefined;
}

// ── 免参 resolution ────────────────────────────────────────────────────────────

describe('run complete — 免参 resolution', () => {
  it('resolves the unique running session with a running chain step', () => {
    const projectRoot = root();
    stepCommand(projectRoot, 'demo');
    seedSession(projectRoot, 's', [{ command: 'demo' }]);
    const runId = startStep(projectRoot, 's', 0);

    const store = new SessionStore(projectRoot);
    const resolved = resolveRunningRun(projectRoot, store);
    expect(resolved.kind).toBe('ok');
    if (resolved.kind === 'ok') {
      expect(resolved.sessionId).toBe('s');
      expect(resolved.step.run_id).toBe(runId);
      expect(resolved.step.index).toBe(0);
    }
  });

  it('errors with guidance when no running session has a running step', () => {
    const projectRoot = root();
    stepCommand(projectRoot, 'demo');
    seedSession(projectRoot, 's', [{ command: 'demo' }]); // pending, not running
    const store = new SessionStore(projectRoot);
    const resolved = resolveRunningRun(projectRoot, store);
    expect(resolved.kind).toBe('error');
    if (resolved.kind === 'error') expect(resolved.message).toContain('no running session');
  });

  it('reports ambiguity and lists candidates for multiple running steps', () => {
    const projectRoot = root();
    stepCommand(projectRoot, 'demo');
    seedSession(projectRoot, 'a', [{ command: 'demo' }]);
    seedSession(projectRoot, 'b', [{ command: 'demo' }]);
    startStep(projectRoot, 'a', 0);
    startStep(projectRoot, 'b', 0);
    // No active pointer → both are candidates.
    const state = migrateV1toV2({ project_name: 'demo', status: 'active' });
    state.sessions = [
      { session_id: 'a', intent: 'intent a', status: 'running', depends_on: [], roadmap_artifact_id: null, seed_ref: null },
      { session_id: 'b', intent: 'intent b', status: 'running', depends_on: [], roadmap_artifact_id: null, seed_ref: null },
    ];
    writeStateJson(projectRoot, state);
    const store = new SessionStore(projectRoot);
    const resolved = resolveRunningRun(projectRoot, store);
    expect(resolved.kind).toBe('error');
    if (resolved.kind === 'error') {
      expect(resolved.message).toContain('ambiguous');
      expect(resolved.message).toContain('a');
      expect(resolved.message).toContain('b');
    }
  });

  it('runningChainStep returns null when no step is running', () => {
    const projectRoot = root();
    stepCommand(projectRoot, 'demo');
    seedSession(projectRoot, 's', [{ command: 'demo', status: 'sealed' }]);
    const session = new SessionStore(projectRoot).readBundle('s').session;
    expect(runningChainStep(session)).toBeNull();
  });
});

// ── Four-state chain transitions ────────────────────────────────────────────────

describe('run complete — verdict chain transitions', () => {
  it('done → step sealed, session running, run sealed', () => {
    const projectRoot = root();
    stepCommand(projectRoot, 'demo');
    seedSession(projectRoot, 's', [{ command: 'demo' }]);
    const runId = startStep(projectRoot, 's', 0);

    const result = completeRunWithVerdict(projectRoot, runId, 's', { verdict: 'done' });
    expect(result.run_sealed).toBe(true);
    expect(result.chain?.step_status).toBe('sealed');
    expect(result.session_status).toBe('running');
    expect(chainOf(projectRoot, 's')[0].status).toBe('sealed');
  });

  it('done-with-concerns → step sealed + auto concern when no note given', () => {
    const projectRoot = root();
    stepCommand(projectRoot, 'demo');
    seedSession(projectRoot, 's', [{ command: 'demo' }]);
    const runId = startStep(projectRoot, 's', 0);

    const result = completeRunWithVerdict(projectRoot, runId, 's', { verdict: 'done-with-concerns' });
    expect(result.chain?.step_status).toBe('sealed');
    const handoff = readRunHandoff(projectRoot, 's', runId);
    expect(handoff?.concerns).toContain('completed with concerns');
  });

  it('does not advance a blocked review without an applied proposal or immediate decision', () => {
    const projectRoot = root();
    reviewProposalCommand(projectRoot);
    stepCommand(projectRoot, 'execute');
    seedSession(projectRoot, 's', [{ command: 'review' }, { command: 'execute' }]);
    const runId = startStep(projectRoot, 's', 0);
    const report = join(projectRoot, '.workflow', 'sessions', 's', 'runs', runId, 'report.md');
    writeFileSync(report, '---\nverdict: blocked\nsummary: findings block delivery\nconcerns: []\nnext: []\n---\n', 'utf8');
    writeReviewFindings(projectRoot, 's', runId, 'BLOCK');

    const result = completeRunWithVerdict(projectRoot, runId, 's', { verdict: 'done-with-concerns' });
    expect(result.run_sealed).toBe(false);
    expect(result.seal.errors).toContain(
      'report verdict blocked cannot advance the existing chain without an applied chain proposal or immediate decision node',
    );
    expect(chainOf(projectRoot, 's')[0].status).toBe('running');
  });

  it('rejects disagreement between review-findings and report verdicts', () => {
    const projectRoot = root();
    reviewProposalCommand(projectRoot);
    seedSession(projectRoot, 's', [{ command: 'review' }]);
    const runId = startStep(projectRoot, 's', 0);
    writeReviewFindings(projectRoot, 's', runId, 'BLOCK');

    const result = completeRunWithVerdict(projectRoot, runId, 's', { verdict: 'done-with-concerns' });
    expect(result.run_sealed).toBe(false);
    expect(result.seal.errors).toContain('review-findings verdict BLOCK conflicts with report verdict ready');
  });

  it('allows a blocked review to hand off to the immediate formal decision', () => {
    const projectRoot = root();
    reviewProposalCommand(projectRoot);
    stepCommand(projectRoot, 'execute');
    seedSession(projectRoot, 's', [
      { command: 'review' },
      { command: 'post-review', decision_ref: 'post-review' },
      { command: 'execute' },
    ]);
    const runId = startStep(projectRoot, 's', 0);
    const report = join(projectRoot, '.workflow', 'sessions', 's', 'runs', runId, 'report.md');
    writeFileSync(report, '---\nverdict: blocked\nsummary: decision required\nconcerns: []\nnext: []\n---\n', 'utf8');
    writeReviewFindings(projectRoot, 's', runId, 'BLOCK');

    const result = completeRunWithVerdict(projectRoot, runId, 's', { verdict: 'done-with-concerns' });
    expect(result.run_sealed).toBe(true);
    expect(result.chain?.step_status).toBe('sealed');
    expect(result.next.action).toBe('evaluate_decision');
  });

  it('rejects a dangling decision_ref as BLOCK routing authority', () => {
    const projectRoot = root();
    reviewProposalCommand(projectRoot);
    stepCommand(projectRoot, 'execute');
    seedSession(projectRoot, 's', [
      { command: 'review' },
      { command: 'post-review', decision_ref: 'post-review' },
      { command: 'execute' },
    ]);
    new SessionStore(projectRoot).update('s', draft => {
      draft.session.orchestration.decision_points = [];
      return null;
    });
    const runId = startStep(projectRoot, 's', 0);
    const report = join(projectRoot, '.workflow', 'sessions', 's', 'runs', runId, 'report.md');
    writeFileSync(report, '---\nverdict: blocked\nsummary: dangling decision\nconcerns: []\nnext: []\n---\n', 'utf8');
    writeReviewFindings(projectRoot, 's', runId, 'BLOCK');

    const result = completeRunWithVerdict(projectRoot, runId, 's', { verdict: 'done-with-concerns' });
    expect(result.run_sealed).toBe(false);
    expect(result.seal.errors).toContain(
      'report verdict blocked cannot advance the existing chain without an applied chain proposal or immediate decision node',
    );
  });

  it('rejects a repair proposal when the immediate formal decision owns BLOCK routing', () => {
    const projectRoot = root();
    reviewProposalCommand(projectRoot);
    negativeEvidencePlanCommand(projectRoot);
    stepCommand(projectRoot, 'execute');
    seedSession(projectRoot, 's', [
      { command: 'review' },
      { command: 'post-review', decision_ref: 'post-review' },
      { command: 'execute' },
    ]);
    const runId = startStep(projectRoot, 's', 0);
    const report = join(projectRoot, '.workflow', 'sessions', 's', 'runs', runId, 'report.md');
    writeFileSync(report, '---\nverdict: blocked\nsummary: decision owns routing\nconcerns: []\nnext: []\n---\n', 'utf8');
    writeReviewFindings(projectRoot, 's', runId, 'BLOCK');
    writeChainProposal(projectRoot, 's', runId, 'review', [
      { op: 'insert', after: 'step-000-review', command: 'review', stage: 'repair-review' },
      { op: 'insert', after: 'step-000-review', command: 'execute', stage: 'repair-execute' },
      { op: 'insert', after: 'step-000-review', command: 'plan', args: '--gaps', stage: 'repair-plan' },
    ]);

    const result = completeRunWithVerdict(projectRoot, runId, 's', {
      verdict: 'done-with-concerns', applyChainProposal: true,
    });
    expect(result.run_sealed).toBe(false);
    expect(result.seal.errors).toContain(
      'review BLOCK must not apply a chain proposal when formal decision post-review owns routing',
    );
  });

  it('rejects an incomplete proposal for a blocked review', () => {
    const projectRoot = root();
    reviewProposalCommand(projectRoot);
    negativeEvidencePlanCommand(projectRoot);
    stepCommand(projectRoot, 'execute');
    seedSession(projectRoot, 's', [{ command: 'review' }, { command: 'execute' }]);
    const runId = startStep(projectRoot, 's', 0);
    const report = join(projectRoot, '.workflow', 'sessions', 's', 'runs', runId, 'report.md');
    writeFileSync(report, '---\nverdict: blocked\nsummary: repair required\nconcerns: []\nnext: []\n---\n', 'utf8');
    writeReviewFindings(projectRoot, 's', runId, 'BLOCK');
    writeFileSync(
      join(projectRoot, '.workflow', 'sessions', 's', 'runs', runId, 'outputs', '000-shadow.json'),
      JSON.stringify({
        _meta: { kind: 'review-findings', schema: 'review-findings/1.0', role: 'primary' },
        verdict: 'PASS', findings: [],
      }, null, 2),
      'utf8',
    );
    writeChainProposal(projectRoot, 's', runId, 'review', [
      { op: 'insert', after: 'step-000-review', command: 'plan', args: '--gaps' },
    ]);

    const result = completeRunWithVerdict(projectRoot, runId, 's', {
      verdict: 'done-with-concerns',
      applyChainProposal: true,
    });
    expect(result.run_sealed).toBe(false);
    expect(result.seal.errors).toContain(
      'review BLOCK repair proposal is incomplete: expected exactly 3 insert operations, received 1',
    );
  });

  it('applies the complete repair loop for a blocked review atomically', () => {
    const projectRoot = root();
    reviewProposalCommand(projectRoot);
    negativeEvidencePlanCommand(projectRoot);
    stepCommand(projectRoot, 'execute');
    seedSession(projectRoot, 's', [{ command: 'review' }, { command: 'execute' }]);
    const runId = startStep(projectRoot, 's', 0);
    const report = join(projectRoot, '.workflow', 'sessions', 's', 'runs', runId, 'report.md');
    writeFileSync(report, '---\nverdict: blocked\nsummary: repair required\nconcerns: []\nnext: []\n---\n', 'utf8');
    writeReviewFindings(projectRoot, 's', runId, 'BLOCK');
    writeChainProposal(projectRoot, 's', runId, 'review', [
      { op: 'insert', after: 'step-000-review', command: 'review', stage: 'repair-review' },
      { op: 'insert', after: 'step-000-review', command: 'execute', stage: 'repair-execute' },
      { op: 'insert', after: 'step-000-review', command: 'plan', args: '--gaps', stage: 'repair-plan' },
    ]);

    const result = completeRunWithVerdict(projectRoot, runId, 's', {
      verdict: 'done-with-concerns',
      applyChainProposal: true,
    });
    expect(result.run_sealed).toBe(true);
    expect(result.seal.chain_proposal?.status).toBe('applied');
    expect(chainOf(projectRoot, 's').map(step => step.command))
      .toEqual(['review', 'plan', 'execute', 'review', 'execute']);

    const dispatched = runNextStep(projectRoot, { sessionId: 's' });
    expect(dispatched.exitCode, dispatched.message).toBe(0);
    const planRunId = dispatched.result?.run_id;
    expect(planRunId).toBeTruthy();
    const brief = briefRun(projectRoot, planRunId!, 's');
    expect(brief.upstream['latest-review']).toMatchObject({ kind: 'review-findings', status: 'sealed' });
  });

  it('needs-retry → step pending, run_id cleared, retry.count incremented', () => {
    const projectRoot = root();
    stepCommand(projectRoot, 'demo');
    seedSession(projectRoot, 's', [{ command: 'demo' }]);
    const runId = startStep(projectRoot, 's', 0);

    const result = completeRunWithVerdict(projectRoot, runId, 's', { verdict: 'needs-retry' });
    expect(result.chain?.step_status).toBe('pending');
    expect(result.chain?.retry).toEqual({ count: 1, max: 2, exhausted: false });
    const step = chainOf(projectRoot, 's')[0];
    expect(step.status).toBe('pending');
    expect(step.run_id).toBeNull();
    expect(step.retry).toEqual({ count: 1, max: 2 });
    // The run itself still sealed (completeRun ran).
    expect(result.run_sealed).toBe(true);
  });

  it('needs-retry flags exhausted once count reaches max (default 2)', () => {
    const projectRoot = root();
    stepCommand(projectRoot, 'demo');
    seedSession(projectRoot, 's', [{ command: 'demo' }]);

    // First retry: count 1 (not exhausted).
    let runId = startStep(projectRoot, 's', 0);
    let result = completeRunWithVerdict(projectRoot, runId, 's', { verdict: 'needs-retry' });
    expect(result.chain?.retry?.exhausted).toBe(false);

    // Second retry: count 2 == max → exhausted (CLI does not cap; it reports).
    runId = startStep(projectRoot, 's', 0);
    result = completeRunWithVerdict(projectRoot, runId, 's', { verdict: 'needs-retry' });
    expect(result.chain?.retry).toEqual({ count: 2, max: 2, exhausted: true });
    expect(chainOf(projectRoot, 's')[0].status).toBe('pending'); // still re-queued
  });

  it('blocked → step failed, session paused, reason folded into concerns', () => {
    const projectRoot = root();
    stepCommand(projectRoot, 'demo');
    seedSession(projectRoot, 's', [{ command: 'demo' }]);
    const runId = startStep(projectRoot, 's', 0);

    const result = completeRunWithVerdict(projectRoot, runId, 's', {
      verdict: 'blocked',
      reason: 'upstream API down',
    });
    expect(result.chain?.step_status).toBe('failed');
    expect(result.session_status).toBe('paused');
    expect(chainOf(projectRoot, 's')[0].status).toBe('failed');
    const handoff = readRunHandoff(projectRoot, 's', runId);
    expect(handoff?.concerns).toContain('upstream API down');
  });
});

describe('run complete — required consume gate blocks hollow seal', () => {
  it('done over a failed blocking consume gate forces blocked, not a hollow ready seal', () => {
    const projectRoot = root();
    requiredConsumeCommand(projectRoot, 'zz-consume-gate', 'verification', 'latest-verification');
    seedSession(projectRoot, 's', [{ command: 'zz-consume-gate' }]);
    // startStep writes a `verdict: ready` report but registers NO verification
    // artifact — the required latest-verification consume gate must fail.
    const runId = startStep(projectRoot, 's', 0);

    const result = completeRunWithVerdict(projectRoot, runId, 's', { verdict: 'done' });

    // The run must NOT hollow-seal as ready: it blocks on the consume gate.
    expect(result.run_sealed).toBe(false);
    expect(result.seal.status).toBe('blocked');
    expect(result.seal.gates.blocking.length).toBeGreaterThan(0);
    expect(result.next?.action).toBe('repair_run');

    const store = new SessionStore(projectRoot);
    const run = store.readRun('s', runId);
    expect(run.status).toBe('blocked');
    // No ready verdict was fabricated over the missing upstream (output.verdict
    // stays null because the blocked path returns before deriving the handoff).
    expect(run.output.verdict).not.toBe('ready');

    // The blocking gate is the required latest-verification consume gate.
    const gates = store.readBundle('s').gates.gates;
    const blockingGate = gates[result.seal.gates.blocking[0]];
    expect(blockingGate.check).toMatchObject({ type: 'artifact', kind: 'verification', alias: 'latest-verification' });
    expect(blockingGate.required).toBe(true);
    expect(blockingGate.blocking).toBe(true);
    expect(blockingGate.status).toBe('failed');
  });
});

describe('run complete — completion gate integrity', () => {
  it('applies and replays a selected chain proposal in the completion transaction', () => {
    const projectRoot = root();
    proposalCommand(projectRoot, 'adaptive', ['insert', 'replace', 'skip']);
    stepCommand(projectRoot, 'execute');
    stepCommand(projectRoot, 'verify');
    stepCommand(projectRoot, 'debug');
    seedSession(projectRoot, 's', [
      { command: 'adaptive' }, { command: 'execute' }, { command: 'cleanup' },
    ]);
    const runId = startStep(projectRoot, 's', 0);
    const proposalPath = writeChainProposal(projectRoot, 's', runId, 'adaptive', [
      { op: 'insert', after: 'step-000-adaptive', command: 'verify' },
      { op: 'replace', step_id: 'step-001-execute', command: 'debug' },
      { op: 'skip', step_id: 'step-002-cleanup', reason: 'No cleanup remains after verification.' },
    ]);
    const store = new SessionStore(projectRoot);
    const before = store.readBundle('s').session;
    const transition = {
      requestId: 'req-complete-chain-proposal',
      expectedIdentityRevision: before.identity_revision,
      expectedActivityRevision: before.activity_revision,
    };

    const original = (SessionStore.prototype as any).writeBatchUnlocked;
    const fault = vi.spyOn(SessionStore.prototype as any, 'writeBatchUnlocked')
      .mockImplementationOnce(() => { throw new Error('injected proposal commit fault'); });
    expect(() => completeRunWithVerdict(projectRoot, runId, 's', {
      verdict: 'done', chainProposal: proposalPath, transition,
    })).toThrow(/injected proposal commit fault/);
    fault.mockRestore();
    expect(chainOf(projectRoot, 's').map(step => [step.command, step.status])).toEqual([
      ['adaptive', 'running'], ['execute', 'pending'], ['cleanup', 'pending'],
    ]);
    expect(store.readRun('s', runId).status).not.toBe('sealed');

    const batches: string[][] = [];
    const capture = vi.spyOn(SessionStore.prototype as any, 'writeBatchUnlocked')
      .mockImplementation(function (this: SessionStore, writes: Array<{ path: string }>) {
        batches.push(writes.map(write => write.path));
        return original.call(this, writes);
      });
    const applied = completeRunWithVerdict(projectRoot, runId, 's', {
      verdict: 'done', chainProposal: proposalPath, transition,
    });
    capture.mockRestore();
    expect(applied.seal.chain_proposal).toMatchObject({
      proposal_id: 'cp-atomic-1', path: proposalPath, status: 'applied',
      operations: [
        { op: 'insert', status: 'pending' },
        { op: 'replace', status: 'pending' },
        { op: 'skip', status: 'skipped' },
      ],
    });
    expect(chainOf(projectRoot, 's').map(step => [step.command, step.status])).toEqual([
      ['adaptive', 'sealed'], ['verify', 'pending'], ['debug', 'pending'], ['cleanup', 'skipped'],
    ]);
    expect(batches).toHaveLength(1);
    const receipt = store.readBundle('s').session.requests.find(item => item.request_id === transition.requestId) as any;
    expect(receipt.payload.payload.chain_proposal).toMatchObject({
      path: proposalPath, proposal_id: 'cp-atomic-1', content_hash: expect.any(String),
    });

    const replay = completeRunWithVerdict(projectRoot, runId, 's', {
      verdict: 'done', chainProposal: proposalPath, transition,
    });
    expect(replay.seal.transition.status).toBe('replayed');
    expect(chainOf(projectRoot, 's').map(step => step.command)).toEqual(['adaptive', 'verify', 'debug', 'cleanup']);

    const proposalFile = join(store.runDir('s', runId), proposalPath);
    writeFileSync(proposalFile, `${readFileSync(proposalFile, 'utf8')}\n`, 'utf8');
    expect(() => completeRunWithVerdict(projectRoot, runId, 's', {
      verdict: 'done', chainProposal: proposalPath, transition,
    })).toThrowError(expect.objectContaining({ code: 'FENCE_CONFLICT' }));
  });

  it('rejects chain proposal application on failure verdicts without changing authority', () => {
    const projectRoot = root();
    proposalCommand(projectRoot, 'adaptive', ['insert']);
    seedSession(projectRoot, 's', [{ command: 'adaptive' }]);
    const runId = startStep(projectRoot, 's', 0);
    const proposalPath = writeChainProposal(projectRoot, 's', runId, 'adaptive', [
      { op: 'insert', after: 'step-000-adaptive', command: 'verify' },
    ]);

    expect(() => completeRunWithVerdict(projectRoot, runId, 's', {
      verdict: 'needs-retry', chainProposal: proposalPath,
    })).toThrow(/cannot be applied with needs-retry or blocked/);
    expect(chainOf(projectRoot, 's').map(step => [step.command, step.status])).toEqual([
      ['adaptive', 'running'],
    ]);
    expect(new SessionStore(projectRoot).readRun('s', runId).status).not.toBe('sealed');
  });

  it('rejects an undispatchable proposed command before mutating the pending tail', () => {
    const projectRoot = root();
    proposalCommand(projectRoot, 'adaptive', ['insert']);
    seedSession(projectRoot, 's', [{ command: 'adaptive' }]);
    const runId = startStep(projectRoot, 's', 0);
    const proposalPath = writeChainProposal(projectRoot, 's', runId, 'adaptive', [
      { op: 'insert', after: 'step-000-adaptive', command: 'not-registered' },
    ]);

    expect(checkRun(projectRoot, runId, 's').errors).toEqual([
      expect.stringMatching(/not-registered.*no prepare or workflow content/),
    ]);
    expect(() => completeRunWithVerdict(projectRoot, runId, 's', {
      verdict: 'done',
      chainProposal: proposalPath,
    })).toThrow(/chain proposal is missing or invalid/);
    expect(chainOf(projectRoot, 's').map(step => step.command)).toEqual(['adaptive']);
  });

  it('accepts a CWD-relative chain-proposal path that lands under the run outputs', () => {
    const projectRoot = root();
    proposalCommand(projectRoot, 'adaptive', ['insert']);
    stepCommand(projectRoot, 'verify');
    seedSession(projectRoot, 's', [{ command: 'adaptive' }]);
    const runId = startStep(projectRoot, 's', 0);
    writeChainProposal(projectRoot, 's', runId, 'adaptive', [
      { op: 'insert', after: 'step-000-adaptive', command: 'verify' },
    ]);
    const store = new SessionStore(projectRoot);
    const before = store.readBundle('s').session;

    // Callers pass shell-CWD-relative paths by habit; the run-relative reading
    // misses, but the CWD reading lands under the run outputs/.
    const prevCwd = process.cwd();
    process.chdir(projectRoot);
    try {
      const result = completeRunWithVerdict(projectRoot, runId, 's', {
        verdict: 'done',
        chainProposal: join('.workflow', 'sessions', 's', 'runs', runId, 'outputs', 'chain-proposal.json'),
        transition: {
          requestId: 'req-cwd-proposal',
          expectedIdentityRevision: before.identity_revision,
          expectedActivityRevision: before.activity_revision,
        },
      });
      expect(result.run_sealed).toBe(true);
      expect(chainOf(projectRoot, 's').map(step => step.command)).toEqual(['adaptive', 'verify']);
    } finally {
      process.chdir(prevCwd);
    }
  });

  it('chain proposal path errors name the run-directory resolution base', () => {
    const projectRoot = root();
    proposalCommand(projectRoot, 'adaptive', ['insert']);
    seedSession(projectRoot, 's', [{ command: 'adaptive' }]);
    const runId = startStep(projectRoot, 's', 0);

    expect(() => completeRunWithVerdict(projectRoot, runId, 's', {
      verdict: 'done',
      chainProposal: 'nowhere/proposal.json',
    })).toThrow(/relative paths resolve against the run directory/);
  });

  it('commits complete authority and receipt in one StoreTransaction', () => {
    const projectRoot = root();
    stepCommand(projectRoot, 'demo');
    seedSession(projectRoot, 's', [{ command: 'demo' }]);
    const runId = startStep(projectRoot, 's', 0);
    const store = new SessionStore(projectRoot);
    const before = store.readBundle('s').session;
    const transition = {
      requestId: 'req-complete-atomic',
      expectedIdentityRevision: before.identity_revision,
      expectedActivityRevision: before.activity_revision,
    };
    const authorityPaths = [
      join(store.sessionDir('s'), 'session.json'), join(store.sessionDir('s'), 'gates.json'),
      join(store.sessionDir('s'), 'artifacts.json'), join(store.sessionDir('s'), 'evidence.json'),
      join(store.runDir('s', runId), 'run.json'), join(projectRoot, '.workflow', 'state.json'),
    ];
    const snapshots = new Map(authorityPaths.map(path => [path, readFileSync(path, 'utf8')]));
    const original = (SessionStore.prototype as any).writeBatchUnlocked;
    const failed = vi.spyOn(SessionStore.prototype as any, 'writeBatchUnlocked')
      .mockImplementationOnce(() => { throw new Error('injected writeBatch fault'); });
    expect(() => completeRunWithVerdict(projectRoot, runId, 's', {
      verdict: 'done', transition,
    })).toThrow(/injected writeBatch fault/);
    failed.mockRestore();
    for (const [path, value] of snapshots) expect(readFileSync(path, 'utf8')).toBe(value);
    expect(store.readBundle('s').session.requests.some(item => item.request_id === transition.requestId)).toBe(false);

    const batches: string[][] = [];
    const capture = vi.spyOn(SessionStore.prototype as any, 'writeBatchUnlocked')
      .mockImplementation(function (this: SessionStore, writes: Array<{ path: string }>) {
        batches.push(writes.map(write => write.path));
        return original.call(this, writes);
      });
    const result = completeRunWithVerdict(projectRoot, runId, 's', { verdict: 'done', transition });
    capture.mockRestore();
    expect(result.seal.transition.status).toBe('applied');
    expect(store.readBundle('s').session.requests.some(item => item.request_id === transition.requestId)).toBe(true);
    expect(batches).toHaveLength(1);
    for (const path of authorityPaths) expect(batches[0]).toContain(path);

    const committed = new Map(authorityPaths.map(path => [path, readFileSync(path, 'utf8')]));
    const replay = completeRunWithVerdict(projectRoot, runId, 's', { verdict: 'done', transition });
    expect(replay.seal.transition.status).toBe('replayed');
    for (const [path, value] of committed) expect(readFileSync(path, 'utf8')).toBe(value);
  });

  it('replays needs-retry without duplicating retry authority or replacement Runs', () => {
    const projectRoot = root();
    stepCommand(projectRoot, 'demo');
    seedSession(projectRoot, 's', [{ command: 'demo' }]);
    const runId = startStep(projectRoot, 's', 0);
    const store = new SessionStore(projectRoot);
    const before = store.readBundle('s').session;
    const transition = {
      requestId: 'req-complete-retry-once',
      expectedIdentityRevision: before.identity_revision,
      expectedActivityRevision: before.activity_revision,
    };
    const first = completeRunWithVerdict(projectRoot, runId, 's', { verdict: 'needs-retry', transition });
    const runDirs = readdirSync(join(store.sessionDir('s'), 'runs'));
    const bundleAfterFirst = store.readBundle('s');
    const storedRequest = bundleAfterFirst.session.requests.find(item => item.request_id === transition.requestId);
    const reconstructed = prepareTransitionMutation({
      session: bundleAfterFirst.session,
      currentFence: store.readSessionFence('s', runId),
      operation: 'complete',
      subject: { session_id: 's', run_id: runId, chain_step_id: store.readRun('s', runId).chain_step_id },
      payload: {
        run_id: runId, notes: [], extra_artifacts: [], summary_fallback: null,
        decisions: [], chain_verdict: 'needs-retry',
        skip_artifact_metadata_validation: false,
        chain_proposal: null,
        completion_input_snapshot: (storedRequest as any).payload.payload.completion_input_snapshot,
      },
      options: transition,
    });
    expect(reconstructed.request).toEqual((storedRequest as any).payload);
    // The complete payload shape is pinned (no stray fields such as the removed
    // require_running_session may be re-introduced on either path).
    expect(Object.keys((storedRequest as any).payload.payload).sort()).toEqual([
      'chain_proposal', 'chain_verdict', 'completion_input_snapshot', 'decisions',
      'expected_activity_revision', 'expected_identity_revision', 'extra_artifacts',
      'lease', 'notes', 'run_id', 'skip_artifact_metadata_validation', 'summary_fallback',
    ]);
    const replay = completeRunWithVerdict(projectRoot, runId, 's', { verdict: 'needs-retry', transition });
    expect(first.seal.transition.status).toBe('applied');
    expect(replay.seal.transition.status).toBe('replayed');
    expect(chainOf(projectRoot, 's')[0].retry?.count).toBe(1);
    expect(readdirSync(join(store.sessionDir('s'), 'runs'))).toEqual(runDirs);
  });

  it('revalidates prepared complete inputs inside the transition lock', () => {
    const projectRoot = root();
    stepCommand(projectRoot, 'demo');
    seedSession(projectRoot, 's', [{ command: 'demo' }]);
    const runId = startStep(projectRoot, 's', 0);
    const store = new SessionStore(projectRoot);
    const before = store.readBundle('s').session;
    const transition = {
      requestId: 'req-complete-input-fence',
      expectedIdentityRevision: before.identity_revision,
      expectedActivityRevision: before.activity_revision,
    };
    const sessionPath = join(store.sessionDir('s'), 'session.json');
    const runPath = join(store.runDir('s', runId), 'run.json');
    const statePath = join(projectRoot, '.workflow', 'state.json');
    const authority = [sessionPath, runPath, statePath].map(path => readFileSync(path, 'utf8'));
    const reportPath = join(store.runDir('s', runId), 'report.md');
    const originalReplay = SessionStore.prototype.replayOrApplyTransition;
    const intercept = vi.spyOn(SessionStore.prototype, 'replayOrApplyTransition')
      .mockImplementation(function (this: SessionStore, sessionId, request, apply) {
        writeFileSync(reportPath, `${readFileSync(reportPath, 'utf8')}\nchanged after prepare\n`, 'utf8');
        return originalReplay.call(this, sessionId, request, apply);
      });
    expect(() => completeRunWithVerdict(projectRoot, runId, 's', {
      verdict: 'done', transition,
    })).toThrowError(expect.objectContaining({ code: 'FENCE_CONFLICT' }));
    intercept.mockRestore();
    expect([sessionPath, runPath, statePath].map(path => readFileSync(path, 'utf8'))).toEqual(authority);
    expect(store.readBundle('s').session.requests.some(item => item.request_id === transition.requestId)).toBe(false);
  });

  it('rejects replay when persisted report, declared output, or extra artifact bytes drift', () => {
    const cases = ['report', 'declared', 'extra', 'extra-deleted'] as const;
    for (const kind of cases) {
      const projectRoot = root();
      stepCommand(projectRoot, 'demo');
      if (kind === 'declared') {
        const commandPath = join(projectRoot, '.claude', 'commands', 'demo.md');
        writeFileSync(commandPath, [
          '<contract>', 'consumes: []', 'produces:', '  - kind: plan',
          '    primary: true', '    path: outputs/plan.json',
          'gates:', '  entry: []', '  exit: []', '</contract>', '',
        ].join('\n'), 'utf8');
      }
      seedSession(projectRoot, 's', [{ command: 'demo' }]);
      const runId = startStep(projectRoot, 's', 0);
      const store = new SessionStore(projectRoot);
      const runDir = store.runDir('s', runId);
      const completionOptions: any = { verdict: 'done' };
      let target = join(runDir, 'report.md');
      if (kind === 'declared') {
        target = join(runDir, 'outputs', 'plan.json');
        writeFileSync(target, JSON.stringify({ _meta: { kind: 'plan', role: 'primary' } }), 'utf8');
      } else if (kind === 'extra' || kind === 'extra-deleted') {
        mkdirSync(join(runDir, 'evidence'), { recursive: true });
        target = join(runDir, 'evidence', 'review.txt');
        writeFileSync(target, 'approved\n', 'utf8');
        completionOptions.extraArtifacts = ['evidence/review.txt'];
      }
      const before = store.readBundle('s').session;
      completionOptions.transition = {
        requestId: `req-complete-drift-${kind}`,
        expectedIdentityRevision: before.identity_revision,
        expectedActivityRevision: before.activity_revision,
      };
      const first = completeRunWithVerdict(projectRoot, runId, 's', completionOptions);
      expect(first.seal.transition.status).toBe('applied');
      if (kind === 'extra-deleted') rmSync(target);
      else writeFileSync(target, `${readFileSync(target, 'utf8')}tampered\n`, 'utf8');
      expect(() => completeRunWithVerdict(projectRoot, runId, 's', completionOptions))
        .toThrowError(expect.objectContaining({ code: 'FENCE_CONFLICT' }));
    }
  });

  it('uses one SessionStore lock for complete mutation application', () => {
    const projectRoot = root();
    stepCommand(projectRoot, 'demo');
    seedSession(projectRoot, 's', [{ command: 'demo' }]);
    const runId = startStep(projectRoot, 's', 0);
    const store = new SessionStore(projectRoot);
    const before = store.readBundle('s').session;
    let insideApply = false;
    let nestedCalls = 0;
    let replayCalls = 0;
    const originalReplay = SessionStore.prototype.replayOrApplyTransition;
    const originalUpdate = SessionStore.prototype.update;
    const originalWithLock = SessionStore.prototype.withLock;
    const originalAppend = SessionStore.prototype.appendLine;
    const replaySpy = vi.spyOn(SessionStore.prototype, 'replayOrApplyTransition')
      .mockImplementation(function (this: SessionStore, sessionId, request, apply) {
        replayCalls++;
        return originalReplay.call(this, sessionId, request, (draft, tx) => {
          insideApply = true;
          try { return apply(draft, tx); } finally { insideApply = false; }
        });
      });
    const updateSpy = vi.spyOn(SessionStore.prototype, 'update').mockImplementation(function (this: SessionStore, ...args: any[]) {
      if (insideApply) nestedCalls++;
      return originalUpdate.apply(this, args as any);
    });
    const lockSpy = vi.spyOn(SessionStore.prototype, 'withLock').mockImplementation(function (this: SessionStore, ...args: any[]) {
      if (insideApply) nestedCalls++;
      return originalWithLock.apply(this, args as any);
    });
    const appendSpy = vi.spyOn(SessionStore.prototype, 'appendLine').mockImplementation(function (this: SessionStore, ...args: any[]) {
      if (insideApply) nestedCalls++;
      return originalAppend.apply(this, args as any);
    });
    completeRunWithVerdict(projectRoot, runId, 's', {
      verdict: 'done',
      transition: {
        requestId: 'req-complete-one-lock',
        expectedIdentityRevision: before.identity_revision,
        expectedActivityRevision: before.activity_revision,
      },
    });
    replaySpy.mockRestore(); updateSpy.mockRestore(); lockSpy.mockRestore(); appendSpy.mockRestore();
    expect(replayCalls).toBe(1);
    expect(nestedCalls).toBe(0);
  });

  it('does not advance the chain when the Run cannot seal', () => {
    const projectRoot = root();
    stepCommand(projectRoot, 'demo');
    const commandPath = join(projectRoot, '.claude', 'commands', 'demo.md');
    writeFileSync(commandPath, `<contract>\ncontract_version: 2\nconsumes: []\nproduces:\n  - kind: plan\n    path: outputs/plan.json\n    role: primary\n    required: true\n    schema: plan/1.0\ngates:\n  entry: []\n  exit: []\n</contract>\n`, 'utf8');
    seedSession(projectRoot, 's', [{ command: 'demo' }]);
    const runId = startStep(projectRoot, 's', 0);

    const result = completeRunWithVerdict(projectRoot, runId, 's', { verdict: 'done' });
    expect(result.run_sealed).toBe(false);
    expect(chainOf(projectRoot, 's')[0]).toMatchObject({ status: 'running', run_id: runId });
    expect(result.next.command).toBe(`maestro run check ${runId}`);
  });

  it('treats legacy v1 outputs as optional when no artifact is produced', () => {
    const projectRoot = root();
    stepCommand(projectRoot, 'demo');
    const commandPath = join(projectRoot, '.claude', 'commands', 'demo.md');
    writeFileSync(commandPath, `<contract>\nconsumes: []\nproduces:\n  - kind: plan\n    primary: true\n    path: outputs/plan.json\ngates:\n  entry: []\n  exit: []\n</contract>\n`, 'utf8');
    seedSession(projectRoot, 's', [{ command: 'demo' }]);
    const runId = startStep(projectRoot, 's', 0);

    const result = completeRunWithVerdict(projectRoot, runId, 's', { verdict: 'done' });
    expect(result.run_sealed).toBe(true);
    expect(result.seal.gates.blocking).toEqual([]);
    expect(chainOf(projectRoot, 's')[0].status).toBe('sealed');
  });

  it.each([
    { verdict: 'needs-retry' as const, stepStatus: 'pending', sessionStatus: 'running' },
    { verdict: 'blocked' as const, stepStatus: 'failed', sessionStatus: 'paused' },
  ])('allows $verdict without required success artifacts', ({ verdict, stepStatus, sessionStatus }) => {
    const projectRoot = root();
    stepCommand(projectRoot, 'demo');
    const commandPath = join(projectRoot, '.claude', 'commands', 'demo.md');
    writeFileSync(commandPath, `<contract>\ncontract_version: 2\nconsumes: []\nproduces:\n  - kind: result\n    path: outputs/result.json\n    role: primary\n    required: true\n    schema: result/1.0\ngates:\n  entry: []\n  exit: []\n</contract>\n`, 'utf8');
    seedSession(projectRoot, 's', [{ command: 'demo' }]);
    const runId = startStep(projectRoot, 's', 0);

    const result = completeRunWithVerdict(projectRoot, runId, 's', {
      verdict,
      reason: verdict === 'blocked' ? 'cannot continue' : undefined,
    });
    expect(result.run_sealed).toBe(true);
    expect(result.seal.gates.blocking).toEqual([]);
    expect(chainOf(projectRoot, 's')[0].status).toBe(stepStatus);
    expect(new SessionStore(projectRoot).readBundle('s').session.status).toBe(sessionStatus);
  });
});

// ── Non-chain run ───────────────────────────────────────────────────────────────

describe('run complete — non-chain run', () => {
  it('verdict does not touch chain/session for an ad-hoc run; signals ride handoff', () => {
    const projectRoot = root();
    stepCommand(projectRoot, 'demo');
    seedSession(projectRoot, 's', [{ command: 'demo' }]);
    // An ad-hoc run that is NOT bound to any chain step (chain step stays pending).
    const created = createRun({ projectRoot, command: 'demo', sessionId: 's', intent: 'intent s' });
    const runDir = join(projectRoot, '.workflow', 'sessions', 's', 'runs', created.run_id);
    writeFileSync(join(runDir, 'report.md'), `---\nverdict: ready\nsummary: adhoc\nconstraints: []\ndecisions: []\nconcerns: []\nnext: []\n---\n## 摘要\nadhoc\n`, 'utf8');

    const result = completeRunWithVerdict(projectRoot, created.run_id, 's', {
      verdict: 'blocked',
      reason: 'ignored for chain but on handoff',
    });
    expect(result.chain).toBeNull();
    expect(result.session_status).toBe('running'); // NOT paused — no chain binding
    expect(chainOf(projectRoot, 's')[0].status).toBe('pending'); // untouched
    const handoff = readRunHandoff(projectRoot, 's', created.run_id);
    expect(handoff?.concerns).toContain('ignored for chain but on handoff');
  });
});

// ── Signal routing (decision / evidence / reason landing) ────────────────────────

describe('run complete — signal routing', () => {
  it('decisions append to handoff.decisions with accepted status', () => {
    const projectRoot = root();
    stepCommand(projectRoot, 'demo');
    seedSession(projectRoot, 's', [{ command: 'demo' }]);
    const runId = startStep(projectRoot, 's', 0);

    completeRunWithVerdict(projectRoot, runId, 's', {
      verdict: 'done',
      decisions: ['picked option B', 'deferred caching'],
    });
    const handoff = readRunHandoff(projectRoot, 's', runId);
    const texts = handoff?.decisions.map(d => d.text) ?? [];
    expect(texts).toContain('picked option B');
    expect(texts).toContain('deferred caching');
    expect(handoff?.decisions.every(d => d.status === 'accepted')).toBe(true);
  });

  it('evidence paths register as artifacts on the run', () => {
    const projectRoot = root();
    stepCommand(projectRoot, 'demo');
    seedSession(projectRoot, 's', [{ command: 'demo' }]);
    const runId = startStep(projectRoot, 's', 0);
    // Write an evidence file inside the run dir.
    const runDir = join(projectRoot, '.workflow', 'sessions', 's', 'runs', runId);
    mkdirSync(join(runDir, 'evidence'), { recursive: true });
    writeFileSync(join(runDir, 'evidence', 'log.txt'), 'trace output\n', 'utf8');

    const result = completeRunWithVerdict(projectRoot, runId, 's', {
      verdict: 'done',
      extraArtifacts: ['evidence/log.txt'],
    });
    // Extra evidence lands in the artifact registry (artifact_ids), not the
    // outputs-scan summary — same channel `--artifact` uses.
    expect(result.seal.artifact_ids.length).toBeGreaterThan(0);
    const registry = new SessionStore(projectRoot).readBundle('s').artifacts;
    const found = Object.values(registry.artifacts).some(a => a.relative_path.endsWith('evidence/log.txt'));
    expect(found).toBe(true);
  });
});

// ── Lease guard ─────────────────────────────────────────────────────────────────

describe('run complete — lease guard (checkLease)', () => {
  const lease = { owner: 'ralph-execute', epoch: 1, id: 'L1' };

  it('rejects a mismatched owner', () => {
    expect(checkLease(lease, { executionOwner: 'other', leaseId: 'L1' })).toContain('lease conflict');
  });

  it('rejects a mismatched lease id', () => {
    expect(checkLease(lease, { executionOwner: 'ralph-execute', leaseId: 'WRONG' })).toContain('lease conflict');
  });

  it('rejects a mismatched epoch when the claim supplies one', () => {
    expect(checkLease(lease, { executionOwner: 'ralph-execute', leaseId: 'L1', ownerEpoch: 9 })).toContain('lease conflict');
  });

  it('passes a fully matching claim', () => {
    expect(checkLease(lease, { executionOwner: 'ralph-execute', leaseId: 'L1', ownerEpoch: 1 })).toBeNull();
  });

  it('a null lease imposes zero verification', () => {
    expect(checkLease(null, {})).toBeNull();
    expect(checkLease({ owner: null, epoch: 0, id: null }, {})).toBeNull();
  });
});

// ── Next-pointer closure ────────────────────────────────────────────────────────

describe('run complete — next pointer', () => {
  it('points at run next when more pending execution steps remain', () => {
    const projectRoot = root();
    stepCommand(projectRoot, 'demo');
    seedSession(projectRoot, 's', [{ command: 'demo' }, { command: 'demo' }]);
    const runId = startStep(projectRoot, 's', 0);
    const runsDir = join(projectRoot, '.workflow', 'sessions', 's', 'runs');
    const beforeRuns = readdirSync(runsDir);
    const result = completeRunWithVerdict(projectRoot, runId, 's', { verdict: 'done' });
    expect(result.next.suggest_only).toBe(true);
    expect(result.next.action).toBe('dispatch_next');
    expect(result.next.command).toBe('maestro run next --session s');
    expect(result.next.reason).toContain('more pending steps');
    expect(result.next.preconditions).toContain('active_run_id=null');
    expect(readdirSync(runsDir)).toEqual(beforeRuns);
    expect(chainOf(projectRoot, 's')[1]).toMatchObject({ status: 'pending', run_id: null });

    const dispatched = runNextStep(projectRoot, { sessionId: 's' });
    expect(dispatched.exitCode, dispatched.message).toBe(0);
    expect(dispatched.result?.run_id).not.toBe(runId);
    expect(readdirSync(runsDir)).toHaveLength(beforeRuns.length + 1);
    expect(chainOf(projectRoot, 's')[1]).toMatchObject({
      status: 'running', run_id: dispatched.result?.run_id,
    });
  });

  it('points at run next (decision) when the next node is a decision', () => {
    const projectRoot = root();
    stepCommand(projectRoot, 'demo');
    seedSession(projectRoot, 's', [
      { command: 'demo' },
      { command: 'gate', decision_ref: 'DP-1' },
    ]);
    const runId = startStep(projectRoot, 's', 0);
    const result = completeRunWithVerdict(projectRoot, runId, 's', { verdict: 'done' });
    expect(result.next.reason).toContain('decision');
  });

  it('points at seal-session when all steps are complete', () => {
    const projectRoot = root();
    stepCommand(projectRoot, 'demo');
    seedSession(projectRoot, 's', [{ command: 'demo' }]);
    const runId = startStep(projectRoot, 's', 0);
    const result = completeRunWithVerdict(projectRoot, runId, 's', { verdict: 'done' });
    expect(result.next.command).toBe('maestro run seal-session s');
    expect(result.next.reason).toContain('seal the session');
  });

  it('points at resume when the session is paused (blocked)', () => {
    const projectRoot = root();
    stepCommand(projectRoot, 'demo');
    seedSession(projectRoot, 's', [{ command: 'demo' }, { command: 'demo' }]);
    const runId = startStep(projectRoot, 's', 0);
    const result = completeRunWithVerdict(projectRoot, runId, 's', { verdict: 'blocked', reason: 'x' });
    expect(result.next.reason).toContain('paused');
    expect(result.next).toMatchObject({ suggest_only: true, action: 'resolve_session', command: null });
    expect(result.next.preconditions).toContain('perform an authorized Session resume transition');
  });
});

// ── CLI wiring (commander) ───────────────────────────────────────────────────────

describe('run complete CLI — verdict + 免参 + lease', () => {
  it('applies --chain-proposal through the canonical complete path', async () => {
    const projectRoot = root();
    proposalCommand(projectRoot, 'adaptive', ['insert']);
    stepCommand(projectRoot, 'verify');
    seedSession(projectRoot, 's', [{ command: 'adaptive' }], { active: true });
    const runId = startStep(projectRoot, 's', 0);
    const proposalPath = writeChainProposal(projectRoot, 's', runId, 'adaptive', [
      { op: 'insert', after: 'step-000-adaptive', command: 'verify' },
    ]);

    const out = (await runCompleteCli(projectRoot, [
      runId, '--session', 's', '--verdict', 'done', '--chain-proposal', proposalPath,
    ])) as { seal?: { chain_proposal?: { proposal_id: string } } };
    expect(out?.seal?.chain_proposal?.proposal_id).toBe('cp-atomic-1');
    expect(chainOf(projectRoot, 's').map(step => step.command)).toEqual(['adaptive', 'verify']);
  });

  it('applies the single discovered proposal without a path argument', async () => {
    const projectRoot = root();
    proposalCommand(projectRoot, 'adaptive', ['insert']);
    stepCommand(projectRoot, 'verify');
    seedSession(projectRoot, 's', [{ command: 'adaptive' }], { active: true });
    const runId = startStep(projectRoot, 's', 0);
    writeChainProposal(projectRoot, 's', runId, 'adaptive', [
      { op: 'insert', after: 'step-000-adaptive', command: 'verify' },
    ]);

    const out = (await runCompleteCli(projectRoot, [
      runId, '--session', 's', '--verdict', 'done', '--apply-proposal',
    ])) as { seal?: { chain_proposal?: { proposal_id: string } } };
    expect(out?.seal?.chain_proposal?.proposal_id).toBe('cp-atomic-1');
    expect(chainOf(projectRoot, 's').map(step => step.command)).toEqual(['adaptive', 'verify']);
  });

  it('免参 done resolves the active step and seals it', async () => {
    const projectRoot = root();
    stepCommand(projectRoot, 'demo');
    seedSession(projectRoot, 's', [{ command: 'demo' }], { active: true });
    startStep(projectRoot, 's', 0);

    const out = (await runCompleteCli(projectRoot, ['--verdict', 'done'])) as { chain?: { step_status: string } };
    expect(out?.chain?.step_status).toBe('sealed');
    expect(chainOf(projectRoot, 's')[0].status).toBe('sealed');
    expect(process.exitCode).toBeFalsy();
  });

  it('accepts case-insensitive / underscore verdict spellings', async () => {
    const projectRoot = root();
    stepCommand(projectRoot, 'demo');
    seedSession(projectRoot, 's', [{ command: 'demo' }], { active: true });
    const runId = startStep(projectRoot, 's', 0);

    const out = (await runCompleteCli(projectRoot, [runId, '--session', 's', '--verdict', 'DONE_WITH_CONCERNS'])) as { verdict?: string };
    expect(out?.verdict).toBe('done-with-concerns');
  });

  it('rejects an invalid verdict with exit 2', async () => {
    const projectRoot = root();
    stepCommand(projectRoot, 'demo');
    seedSession(projectRoot, 's', [{ command: 'demo' }], { active: true });
    startStep(projectRoot, 's', 0);

    await runCompleteCli(projectRoot, ['--verdict', 'maybe']);
    expect(process.exitCode).toBe(2);
    expect(chainOf(projectRoot, 's')[0].status).toBe('running'); // untouched
  });

  it('maps ready-vocabulary verdict aliases onto the chain-advance vocabulary', async () => {
    const aliases: Array<[string, string, string]> = [
      ['ready', 'done', 'sealed'],
      ['ready_with_concerns', 'done-with-concerns', 'sealed'],
      ['failed', 'needs-retry', 'pending'],
      ['blocked', 'blocked', 'failed'],
    ];
    for (const [token, expected, stepStatus] of aliases) {
      const projectRoot = root();
      stepCommand(projectRoot, 'demo');
      seedSession(projectRoot, 's', [{ command: 'demo' }], { active: true });
      const runId = startStep(projectRoot, 's', 0);

      const out = (await runCompleteCli(projectRoot, [runId, '--session', 's', '--verdict', token])) as { verdict?: string; chain?: { step_status?: string } };
      expect(out?.verdict).toBe(expected);
      expect(out?.chain?.step_status).toBe(stepStatus);
      expect(process.exitCode).toBeFalsy();
    }
  });

  it('session done maps the full ready-vocabulary alias matrix', async () => {
    const aliases: Array<[string, string, string]> = [
      ['ready', 'done', 'sealed'],
      ['ready_with_concerns', 'done-with-concerns', 'sealed'],
      ['failed', 'needs-retry', 'pending'],
      ['blocked', 'blocked', 'failed'],
    ];
    for (const [token, expected, stepStatus] of aliases) {
      const projectRoot = root();
      stepCommand(projectRoot, 'demo');
      seedSession(projectRoot, 's', [{ command: 'demo' }], { active: true });
      const runId = startStep(projectRoot, 's', 0);

      const out = (await runSessionDoneCli(projectRoot, [runId, '--session', 's', '--verdict', token])) as { verdict?: string; chain?: { step_status?: string } };
      expect(out?.verdict).toBe(expected);
      expect(out?.chain?.step_status).toBe(stepStatus);
      expect(process.exitCode).toBeFalsy();
    }
  });

  it('session done 免参 resolves the active step under a ready alias', async () => {
    const projectRoot = root();
    stepCommand(projectRoot, 'demo');
    seedSession(projectRoot, 's', [{ command: 'demo' }], { active: true });
    startStep(projectRoot, 's', 0);

    const out = (await runSessionDoneCli(projectRoot, ['--session', 's', '--verdict', 'ready'])) as { chain?: { step_status?: string } };
    expect(out?.chain?.step_status).toBe('sealed');
    expect(process.exitCode).toBeFalsy();
  });

  it('run done maps the full ready-vocabulary alias matrix', async () => {
    const aliases: Array<[string, string, string]> = [
      ['ready', 'done', 'sealed'],
      ['ready_with_concerns', 'done-with-concerns', 'sealed'],
      ['failed', 'needs-retry', 'pending'],
      ['blocked', 'blocked', 'failed'],
    ];
    for (const [token, expected, stepStatus] of aliases) {
      const projectRoot = root();
      stepCommand(projectRoot, 'demo');
      seedSession(projectRoot, 's', [{ command: 'demo' }], { active: true });
      const runId = startStep(projectRoot, 's', 0);

      const out = (await runDoneCli(projectRoot, [runId, '--session', 's', '--verdict', token])) as { verdict?: string; chain?: { step_status?: string } };
      expect(out?.verdict).toBe(expected);
      expect(out?.chain?.step_status).toBe(stepStatus);
      expect(process.exitCode).toBeFalsy();
    }
  });

  it('treats an empty --verdict as the default done on run complete and session done', async () => {
    const projectRoot = root();
    stepCommand(projectRoot, 'demo');
    seedSession(projectRoot, 's', [{ command: 'demo' }], { active: true });
    const runId = startStep(projectRoot, 's', 0);

    const complete = (await runCompleteCli(projectRoot, [runId, '--session', 's', '--verdict', ''])) as { verdict?: string };
    expect(complete?.verdict).toBe('done');

    const second = root();
    stepCommand(second, 'demo');
    seedSession(second, 's', [{ command: 'demo' }], { active: true });
    const secondRunId = startStep(second, 's', 0);
    const sessionDone = (await runSessionDoneCli(second, [secondRunId, '--session', 's', '--verdict', ''])) as { verdict?: string };
    expect(sessionDone?.verdict).toBe('done');
  });

  it('decide rejects ready-vocabulary tokens as INVALID_VERDICT (exit 2)', async () => {
    const program = new Command();
    program.exitOverride();
    registerRunCommand(program);
    try {
      await program.parseAsync(['node', 'maestro', 'run', 'decide', 'DP-1', '--session', 's', '--verdict', 'ready', '--confidence', 'high', '--workflow-root', root()]);
    } catch {
      /* commander exitOverride throws on validation exit — inspect exitCode */
    }
    expect(process.exitCode).toBe(2);
  });

  it('refuses on a lease conflict (exit 1) and does not advance the chain', async () => {
    const projectRoot = root();
    stepCommand(projectRoot, 'demo');
    seedSession(projectRoot, 's', [{ command: 'demo' }], {
      active: true,
      lease: { owner: 'ralph-execute', epoch: 1, id: 'L1' },
    });
    const runId = startStep(projectRoot, 's', 0);

    await runCompleteCli(projectRoot, [runId, '--session', 's', '--verdict', 'done', '--execution-owner', 'other', '--lease-id', 'L1']);
    expect(process.exitCode).toBe(1);
    expect(chainOf(projectRoot, 's')[0].status).toBe('running'); // conflict never advances
  });

  it('passes a matching lease and advances', async () => {
    const projectRoot = root();
    stepCommand(projectRoot, 'demo');
    seedSession(projectRoot, 's', [{ command: 'demo' }], {
      active: true,
      lease: { owner: 'ralph-execute', epoch: 1, id: 'L1' },
    });
    const runId = startStep(projectRoot, 's', 0);

    await runCompleteCli(projectRoot, [
      runId, '--session', 's', '--verdict', 'done',
      '--execution-owner', 'ralph-execute', '--lease-id', 'L1', '--owner-epoch', '1',
    ]);
    expect(chainOf(projectRoot, 's')[0].status).toBe('sealed');
  });

  it('preserves the plain seal path for a verbless explicit run-id', async () => {
    const projectRoot = root();
    stepCommand(projectRoot, 'demo');
    seedSession(projectRoot, 's', [{ command: 'demo' }], { active: true });
    const runId = startStep(projectRoot, 's', 0);

    // No verdict, no lease, explicit run-id → legacy completeRun (seals the run,
    // leaves the chain step running — chain driving is opt-in via verdict).
    const runsDir = join(projectRoot, '.workflow', 'sessions', 's', 'runs');
    const beforeRuns = readdirSync(runsDir);
    const out = (await runCompleteCli(projectRoot, [runId, '--session', 's'])) as {
      sealed?: boolean;
      next_action?: { suggest_only: boolean; action: string; command: string | null; preconditions: string[] };
    };
    expect(out?.sealed).toBe(true);
    expect(out?.next_action).toMatchObject({
      suggest_only: true,
      action: 'dispatch_next',
      command: 'maestro run next --session s',
    });
    expect(out?.next_action?.preconditions).toContain(`sealed_run_id=${runId}`);
    expect(readdirSync(runsDir)).toEqual(beforeRuns);
    expect(chainOf(projectRoot, 's')[0].status).toBe('running'); // chain untouched
  });
});
