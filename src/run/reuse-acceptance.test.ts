import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

import { acceptRunReuse, checkRun, completeRun, createRun } from './runtime.js';
import { inspectSessionContinuation } from './continuation.js';
import { SessionStore } from './store.js';
import { runResponseSchema } from './protocol-schemas.js';

function v2Workspace(root: string): void {
  mkdirSync(join(root, ".workflow"), { recursive: true });
  writeFileSync(join(root, ".workflow", "config.json"), JSON.stringify({
    session_schema: { schema_version: "session-schema-selection/1.0", writer: "session/1.3", features: { session_statusless: false } },
  }));
}

const roots: string[] = [];

function root(): string {
  const path = mkdtempSync(join(tmpdir(), 'maestro-reuse-accept-'));

  v2Workspace(path);
  roots.push(path);
  return path;
}

function command(projectRoot: string, name: string, contract: string): void {
  const commands = join(projectRoot, '.claude', 'commands');
  const workflows = join(projectRoot, 'workflows');
  mkdirSync(commands, { recursive: true });
  mkdirSync(workflows, { recursive: true });
  writeFileSync(join(commands, `${name}.md`), `<contract>\n${contract}\n</contract>\n`, 'utf8');
  writeFileSync(join(workflows, `${name}.md`), `# ${name}\n\nwork\n`, 'utf8');
}

function seedReviewedPlan(projectRoot: string): ReturnType<typeof createRun> {
  command(projectRoot, 'review-plan-fixture', [
    'consumes: []',
    'produces:',
    '  - kind: plan',
    '    alias: current-plan',
    '    primary: true',
    '    path: outputs/plan.json',
    'gates:',
    '  entry: []',
    '  exit: []',
  ].join('\n'));
  command(projectRoot, 'review-execute-fixture', [
    'consumes:',
    '  - kind: plan',
    '    alias: current-plan',
    '    required: true',
    '    require_status: sealed',
    'produces: []',
    'gates:',
    '  entry: []',
    '  exit: []',
  ].join('\n'));
  const plan = createRun({ projectRoot, command: 'review-plan-fixture', sessionId: 's', intent: 'reviewed plan' });
  const planDir = join(projectRoot, '.workflow', 'sessions', 's', 'runs', plan.run_id);
  writeFileSync(join(planDir, 'outputs', 'plan.json'), JSON.stringify({
    _meta: { kind: 'plan', schema: 'plan/1.0', role: 'primary', alias: 'current-plan' },
    tasks: [],
  }, null, 2), 'utf8');
  writeFileSync(join(planDir, 'report.md'), [
    '---', 'verdict: ready_with_concerns', 'summary: reviewed plan', 'constraints: []',
    'decisions: []', 'concerns:', '  - manual review required', 'next: []', '---', '',
  ].join('\n'), 'utf8');
  const completed = completeRun(projectRoot, plan.run_id, 's');
  expect(completed.errors).toEqual([]);
  expect(completed.gates.blocking).toEqual([]);
  expect(completed.sealed).toBe(true);
  return createRun({ projectRoot, command: 'review-execute-fixture', sessionId: 's', intent: 'reviewed plan' });
}

afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

describe('explicit REVIEW reuse acceptance', () => {
  it('keeps optional REJECT consumes non-blocking while required consumes fail closed', () => {
    const projectRoot = root();
    command(projectRoot, 'optional-producer-fixture', [
      'contract_version: 2.1', 'arguments: []', 'consumes: []', 'produces:',
      '  - kind: context', '    alias: current-context', '    role: primary',
      '    required: true', '    schema: context/1.0', '    path: outputs/context.json',
      'gates: { entry: [], exit: [] }',
    ].join('\n'));
    command(projectRoot, 'optional-consumer-fixture', [
      'contract_version: 2.1', 'arguments: []', 'consumes:', '  - kind: context',
      '    alias: current-context', '    required: false', '    require_status: sealed',
      '    schema: context/2.0', '    role: primary', 'produces: []',
      'gates: { entry: [], exit: [] }',
    ].join('\n'));
    const producer = createRun({ projectRoot, command: 'optional-producer-fixture', sessionId: 's', intent: 'optional' });
    const producerDir = join(projectRoot, '.workflow', 'sessions', 's', 'runs', producer.run_id);
    writeFileSync(join(producerDir, 'outputs', 'context.json'), JSON.stringify({
      _meta: { kind: 'context', schema: 'context/1.0', role: 'primary', alias: 'current-context' },
    }), 'utf8');
    expect(completeRun(projectRoot, producer.run_id, 's').sealed).toBe(true);
    const consumer = createRun({ projectRoot, command: 'optional-consumer-fixture', sessionId: 's', intent: 'optional' });
    expect(consumer.reuse_assessments[0]).toMatchObject({ decision: 'REJECT' });
    expect(consumer.upstream).toEqual({});
    expect(consumer.entry_gates.blocking).toEqual([]);
    expect(completeRun(projectRoot, consumer.run_id, 's').sealed).toBe(true);
  });

  it('prioritizes a required REVIEW when an optional REJECT assessment is also present', () => {
    const projectRoot = root();
    const execute = seedReviewedPlan(projectRoot);
    const store = new SessionStore(projectRoot);
    const requiredReview = store.readRun('s', execute.run_id).input.reuse_assessments.find(
      item => item.decision === 'REVIEW',
    )!;

    store.update('s', (draft, tx) => {
      const run = tx.readRun(execute.run_id);
      run.input.reuse_assessments = [
        {
          ...requiredReview,
          assessment_hash: `sha256:${'f'.repeat(64)}`,
          consumer: { kind: 'review-findings', alias: 'latest-review', schema: null, role: null },
          decision: 'REJECT',
          reason_codes: ['QUALITY_LOW'],
        },
        requiredReview,
      ];
      tx.writeRun(run);
      draft.session.activity_revision++;
    });

    expect(inspectSessionContinuation(projectRoot, 's')).toMatchObject({
      action: 'accept_reuse',
      assessment: {
        assessment_hash: requiredReview.assessment_hash,
        decision: 'REVIEW',
        acceptance_status: 'pending_review',
      },
    });
  });

  it('requires actual consumes binding and revalidates only the exact accepted REVIEW', () => {
    const projectRoot = root();
    const execute = seedReviewedPlan(projectRoot);
    const store = new SessionStore(projectRoot);
    const beforeRun = store.readRun('s', execute.run_id);
    const review = beforeRun.input.reuse_assessments.find(item => item.decision === 'REVIEW');
    expect(review?.reason_codes).toContain('QUALITY_MEDIUM');
    expect(beforeRun.input.consumes).toEqual([]);
    expect(execute.entry_gates.blocking).toHaveLength(1);
    expect(beforeRun.status).toBe('blocked');
    expect(inspectSessionContinuation(projectRoot, 's')).toMatchObject({
      action: 'accept_reuse',
      authority: 'auto_mode_only',
      reason_code: 'QUALITY_MEDIUM',
      assessment: {
        assessment_hash: review!.assessment_hash,
        acceptance_status: 'pending_review',
      },
    });

    const beforeSession = store.readBundle('s').session;
    const transition = {
      requestId: 'req-accept-reviewed-plan',
      expectedIdentityRevision: beforeSession.identity_revision,
      expectedActivityRevision: beforeSession.activity_revision,
      actor: 'reviewer',
      reason: 'reviewed exact source fence',
      evidence: ['outputs/review.json'],
    };
    const first = acceptRunReuse(projectRoot, execute.run_id, review!.assessment_hash, 's', transition);
    const replay = acceptRunReuse(projectRoot, execute.run_id, review!.assessment_hash, 's', transition);
    expect(first.transition.status).toBe('applied');
    expect(replay.transition.status).toBe('replayed');
    expect(replay.transition.transition_id).toBe(first.transition.transition_id);
    expect(store.readRun('s', execute.run_id).input.consumes).toEqual([review!.source_fence.artifact_id]);

    const afterSession = store.readBundle('s').session;
    expect(() => acceptRunReuse(projectRoot, execute.run_id, review!.assessment_hash, 's', {
      requestId: 'req-accept-reviewed-plan-again',
      expectedIdentityRevision: afterSession.identity_revision,
      expectedActivityRevision: afterSession.activity_revision,
      actor: 'reviewer',
      reason: 'duplicate acceptance attempt',
      evidence: ['outputs/review.json'],
    })).toThrow(/already accepted/);
    expect(first.entry_gates.blocking).toEqual([]);
    expect(inspectSessionContinuation(projectRoot, 's')).toMatchObject({
      action: 'load_run',
      authority: 'automatic',
      reason_code: 'RUN_ACTIVE',
      assessment: {
        assessment_hash: review!.assessment_hash,
        acceptance_status: 'accepted',
      },
    });
    const acceptanceRecord = store.readBundle('s').session.requests.find(item => item.request_id === transition.requestId) as any;
    expect(acceptanceRecord.payload.payload).toMatchObject({
      actor: 'reviewer', reason: 'reviewed exact source fence', evidence: ['outputs/review.json'],
    });
    expect(acceptanceRecord.outcome.result.acceptance).toMatchObject({
      actor: 'reviewer', reason: 'reviewed exact source fence', evidence: ['outputs/review.json'],
    });

    const validated = checkRun(projectRoot, execute.run_id, 's');
    expect(validated.errors).toEqual([]);
    expect(validated.upstream['current-plan']?.artifact_id).toBe(review!.source_fence.artifact_id);
    expect(validated.reuse_assessments.find(item => item.assessment_hash === review!.assessment_hash)?.decision)
      .toBe('REVIEW');

    store.update('s', draft => { draft.artifacts.revision++; });
    const drifted = checkRun(projectRoot, execute.run_id, 's');
    expect(drifted.errors.some(error => error.includes('no longer current or accepted'))).toBe(true);
  });

  it('exposes canonical built run accept-reuse machine CLI with audited acceptance and fences', () => {
    const projectRoot = root();
    const execute = seedReviewedPlan(projectRoot);
    const store = new SessionStore(projectRoot);
    const run = store.readRun('s', execute.run_id);
    const review = run.input.reuse_assessments.find(item => item.decision === 'REVIEW')!;
    const session = store.readBundle('s').session;
    const invoked = spawnSync(process.execPath, [
      resolve('bin/maestro.js'), 'run', 'accept-reuse', execute.run_id,
      '--session', 's', '--assessment-hash', review.assessment_hash,
      '--request-id', 'req-cli-accept-review',
      '--actor', 'release-reviewer', '--reason', 'review evidence approved',
      '--evidence', 'outputs/review.json',
      '--expected-identity-revision', String(session.identity_revision),
      '--expected-activity-revision', String(session.activity_revision),
      '--json',
      '--workflow-root', projectRoot,
    ], { encoding: 'utf8', cwd: resolve('.') });
    const lines = invoked.stdout.trim().split(/\r?\n/).filter(Boolean);
    expect(invoked.status, invoked.stderr).toBe(0);
    expect(invoked.stderr).toBe('');
    expect(lines).toHaveLength(1);
    const output = runResponseSchema.parse(JSON.parse(lines[0]));
    expect(output).toMatchObject({
      operation: 'accept-reuse', ok: true, exit_code: 0,
      request_id: 'req-cli-accept-review', replay: { status: 'applied' },
    });
    expect(store.readRun('s', execute.run_id).input.consumes).toContain(review.source_fence.artifact_id);
  });

  it('rejects acceptance without actor, reason, or evidence', () => {
    const projectRoot = root();
    const execute = seedReviewedPlan(projectRoot);
    const store = new SessionStore(projectRoot);
    const review = store.readRun('s', execute.run_id).input.reuse_assessments.find(item => item.decision === 'REVIEW')!;
    expect(() => acceptRunReuse(projectRoot, execute.run_id, review.assessment_hash, 's', {
      requestId: 'req-incomplete-acceptance', actor: '', reason: '', evidence: [],
    })).toThrow(/non-empty actor/);
  });

  function seedSealedExecution(projectRoot: string, consumerContract: string[]): ReturnType<typeof createRun> {
    command(projectRoot, 'schema-producer-fixture', [
      'contract_version: 2.1', 'arguments: []', 'consumes: []', 'produces:',
      '  - kind: execution', '    alias: current-execution', '    role: primary',
      '    required: true', '    schema: execution/1.0', '    path: outputs/execution.json',
      'gates: { entry: [], exit: [] }',
    ].join('\n'));
    command(projectRoot, 'schema-consumer-fixture', consumerContract.join('\n'));
    const producer = createRun({ projectRoot, command: 'schema-producer-fixture', sessionId: 's', intent: 'schema' });
    const producerDir = join(projectRoot, '.workflow', 'sessions', 's', 'runs', producer.run_id);
    writeFileSync(join(producerDir, 'outputs', 'execution.json'), JSON.stringify({
      _meta: { kind: 'execution', schema: 'execution/1.0', role: 'primary', alias: 'current-execution' },
    }), 'utf8');
    writeFileSync(join(producerDir, 'report.md'), [
      '---', 'verdict: ready', 'summary: sealed execution', 'constraints: []', 'decisions: []',
      'concerns: []', 'next: []', '---', '',
    ].join('\n'), 'utf8');
    expect(completeRun(projectRoot, producer.run_id, 's').sealed).toBe(true);
    return createRun({ projectRoot, command: 'schema-consumer-fixture', sessionId: 's', intent: 'schema' });
  }

  it('blocks a v2.1 consume missing schema with ARTIFACT_SCHEMA_UNKNOWN until explicit accept', () => {
    const projectRoot = root();
    const consumer = seedSealedExecution(projectRoot, [
      'contract_version: 2.1', 'arguments: []', 'consumes:',
      '  - kind: execution', '    alias: current-execution', '    required: true',
      '    require_status: sealed', 'produces: []', 'gates: { entry: [], exit: [] }',
    ]);
    const review = consumer.reuse_assessments[0];
    expect(review).toMatchObject({
      decision: 'REVIEW',
      reason_codes: expect.arrayContaining(['ARTIFACT_SCHEMA_UNKNOWN']),
    });
    expect(consumer.upstream).toEqual({});
    expect(consumer.entry_gates.blocking).toHaveLength(1);

    const store = new SessionStore(projectRoot);
    const beforeSession = store.readBundle('s').session;
    const accepted = acceptRunReuse(projectRoot, consumer.run_id, review!.assessment_hash, 's', {
      requestId: 'req-accept-schema-review',
      expectedIdentityRevision: beforeSession.identity_revision,
      expectedActivityRevision: beforeSession.activity_revision,
      actor: 'reviewer',
      reason: 'producer schema execution/1.0 verified; consumer contract underspecified',
      evidence: ['outputs/execution.json'],
    });
    expect(accepted.entry_gates.blocking).toEqual([]);
    expect(store.readRun('s', consumer.run_id).input.consumes).toEqual([review!.source_fence.artifact_id]);
  });

  it('binds REUSE directly when the v2.1 consume declares the producer schema and role', () => {
    const projectRoot = root();
    const consumer = seedSealedExecution(projectRoot, [
      'contract_version: 2.1', 'arguments: []', 'consumes:',
      '  - kind: execution', '    alias: current-execution', '    required: true',
      '    require_status: sealed', '    schema: execution/1.0', '    role: primary',
      'produces: []', 'gates: { entry: [], exit: [] }',
    ]);
    expect(consumer.reuse_assessments[0]).toMatchObject({
      decision: 'REUSE',
      reason_codes: ['REUSE_ELIGIBLE'],
    });
    expect(consumer.upstream['current-execution']).toBeDefined();
    expect(consumer.entry_gates.blocking).toEqual([]);
  });
});
