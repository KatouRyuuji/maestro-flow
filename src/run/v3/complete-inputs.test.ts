import { Command } from 'commander';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { runResponseV12Schema } from '../protocol-schemas.js';
import type { ChainProposal } from '../chain-proposal.js';
import type { RunV30, SessionStateV30 } from '../schemas.js';
import { SessionStore } from '../store.js';
import { registerRunV3Command } from '../../commands/run-v3.js';
import { V3StructuredError } from './errors.js';
import { completeRunAndAdvance } from './mutation-engine.js';

const roots: string[] = [];

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'maestro-v3-complete-inputs-'));
  roots.push(value);
  mkdirSync(join(value, '.workflow'), { recursive: true });
  writeFileSync(join(value, '.workflow', 'config.json'), `${JSON.stringify({
    session_schema: {
      schema_version: 'session-schema-selection/1.0',
      writer: 'session/3.0',
      features: { session_statusless: false },
    },
  }, null, 2)}\n`);
  return value;
}

function session(status: SessionStateV30['status'] = 'open'): SessionStateV30 {
  return {
    schema_version: 'session/3.0', session_id: 's-1', objective: 'v3 complete inputs', definition_of_done: 'tests pass',
    status, identity_revision: 1, orchestration_revision: 0, activity_revision: 0,
    chain: [
      { step_id: 'step-1', command: 'implement', args: [], status: 'running', run_ids: ['r-1'], goal_ref: null, decision_refs: [] },
      { step_id: 'step-2', command: 'verify', args: [], status: 'pending', run_ids: ['r-2'], goal_ref: null, decision_refs: [] },
    ],
    decisions: [], active_run_ids: ['r-1', 'r-2'], gates_ref: 'gates.json', artifacts_ref: 'artifacts.json', evidence_ref: 'evidence.json',
    created_at: '2026-08-12T00:00:00.000Z', updated_at: '2026-08-12T00:00:00.000Z', completed_at: null, archived_at: null,
  };
}

function run(runId: string, stepId: string, status: RunV30['status'] = 'running'): RunV30 {
  return {
    schema_version: 'run/3.0', run_id: runId, session_id: 's-1', step_id: stepId,
    parent_run_id: null, retry_of_run_id: null, attempt: 1, command: 'work', args: [], goal: null,
    status, revision: 0, actor_id: 'actor-a', participant_id: 'p-a', gate_refs: [], input_refs: [], output_refs: [],
    primary_artifact_id: null, verdict: null, summary: null, legacy_execution_generation: null,
    created_at: '2026-08-12T00:00:00.000Z', started_at: status === 'running' ? '2026-08-12T00:00:00.000Z' : null,
    ended_at: null, sealed_at: null,
  };
}

function setup(status: SessionStateV30['status'] = 'open'): SessionStore {
  const store = new SessionStore(root());
  store.writeSessionV30(session(status));
  writeFileSync(join(store.sessionDir('s-1'), 'gates.json'), `${JSON.stringify({
    schema_version: 'gates/1.0', revision: 0, gates: {},
    summary: { total: 0, passed: 0, blocked: 0, failed: 0, active_gate_ids: [], blocking_run_id: null },
  }, null, 2)}\n`);
  writeFileSync(join(store.sessionDir('s-1'), 'artifacts.json'), `${JSON.stringify({
    schema_version: 'artifacts/1.0', revision: 0, artifacts: {}, aliases: {},
  }, null, 2)}\n`);
  store.writeRunV30(run('r-1', 'step-1'));
  store.writeRunV30(run('r-2', 'step-2'));
  return store;
}

function identity(requestId: string, participantId = 'p-a') {
  return {
    sessionId: 's-1', requestId, participantId, actorId: 'actor-a', reason: 'test complete inputs',
    recordedAt: '2026-08-12T01:00:00.000Z',
  };
}

function reportFrontmatter(extra = ''): string {
  return `---\nverdict: done\nsummary: "frontmatter summary"\ndecisions:\n  - text: "Use X"\n    status: accepted\n  - text: "Evaluate Y"\n    status: proposed\n${extra}---\n`;
}

function proposalFixture(overrides: Partial<ChainProposal> = {}): ChainProposal {
  return {
    _meta: { kind: 'chain-proposal', schema: 'chain-proposal/1.0' },
    proposal_id: 'P-100',
    source: { session_id: 's-1', run_id: 'r-1', skill: 'work' },
    reason: 'add verification step and record decision',
    operations: [
      { op: 'insert', after: 'step-2', command: 'verify-extra', args: '--strict' },
      { op: 'decide', point_id: 'DP-1', verdict: 'proceed', confidence: 'high', summary: 'approved', evidence: 'EVD-proposal' },
    ],
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('v3 complete-and-advance v2-contract inputs (TC-P0-3)', () => {
  it('falls back to report.md frontmatter summary and decisions when inputs are omitted', () => {
    const store = setup();
    mkdirSync(store.runDir('s-1', 'r-1'), { recursive: true });
    writeFileSync(join(store.runDir('s-1', 'r-1'), 'report.md'), reportFrontmatter());
    const applied = completeRunAndAdvance(store, {
      ...identity('req-frontmatter'), runId: 'r-1', expectedRunRevision: 0,
      expectedOrchestrationRevision: 0, verdict: 'done',
    });
    expect(applied.status).toBe('applied');
    const sealed = store.readRunV30('s-1', 'r-1');
    expect(sealed).toMatchObject({
      status: 'sealed', summary: 'frontmatter summary',
      decision_records: [
        { text: 'Use X', status: 'accepted' },
        { text: 'Evaluate Y', status: 'proposed' },
      ],
    });
  });

  it('writes decision records and notes into the sealed Run', () => {
    const store = setup();
    const applied = completeRunAndAdvance(store, {
      ...identity('req-inputs'), runId: 'r-1', expectedRunRevision: 0,
      expectedOrchestrationRevision: 0, summary: 'implemented', verdict: 'done',
      decisionRecords: [
        { text: 'Adopt approach A', status: 'accepted' },
        { text: 'Revisit later' },
      ],
      notes: ['note one', 'note two'],
    });
    expect(applied.status).toBe('applied');
    expect(store.readRunV30('s-1', 'r-1')).toMatchObject({
      decision_records: [
        { text: 'Adopt approach A', status: 'accepted' },
        { text: 'Revisit later', status: 'accepted' },
      ],
      notes: ['note one', 'note two'],
    });
  });

  it('registers run-relative extra artifacts into the registry and output_refs', () => {
    const store = setup();
    const runDir = store.runDir('s-1', 'r-1');
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, 'evidence.json'), `${JSON.stringify({
      _meta: { kind: 'evidence', schema: 'evidence/1.0' },
      ok: true,
    }, null, 2)}\n`);
    const applied = completeRunAndAdvance(store, {
      ...identity('req-extra-artifact'), runId: 'r-1', expectedRunRevision: 0,
      expectedOrchestrationRevision: 0, summary: 'done', verdict: 'done',
      extraArtifactRefs: ['evidence.json'],
    });
    expect(applied.status).toBe('applied');
    const sealed = store.readRunV30('s-1', 'r-1');
    expect(sealed.output_refs).toHaveLength(1);
    const artifactId = sealed.output_refs[0];
    expect(artifactId).toMatch(/^ART-/);
    const registry = JSON.parse(readFileSync(join(store.sessionDir('s-1'), 'artifacts.json'), 'utf8'));
    expect(registry).toMatchObject({
      revision: 1,
      artifacts: {
        [artifactId]: {
          kind: 'evidence', role: 'evidence', producer_run_id: 'r-1',
          relative_path: 'runs/r-1/evidence.json', status: 'sealed',
        },
      },
    });
    expect(applied.transition.result).toMatchObject({
      artifact_publication: { artifact_ids: [artifactId], primary_artifact_id: null },
    });
  });

  it('applies a chain proposal insert and decide atomically before the chain advance', () => {
    const store = setup();
    const applied = completeRunAndAdvance(store, {
      ...identity('req-proposal'), runId: 'r-1', expectedRunRevision: 0,
      expectedOrchestrationRevision: 0, summary: 'with proposal', verdict: 'done',
      chainProposal: proposalFixture(),
    });
    expect(applied.status).toBe('applied');
    expect(applied.transition.result).toMatchObject({
      applied_proposal: {
        proposal_id: 'P-100',
        operations: [
          { op: 'insert', target: 's-1', status: 'pending' },
          { op: 'decide', target: 'DP-1', status: 'resolved' },
        ],
      },
    });
    const session = store.readSessionV30('s-1');
    expect(session).toMatchObject({
      status: 'open', orchestration_revision: 1, activity_revision: 1,
      chain: [
        { step_id: 'step-1', status: 'completed' },
        { step_id: 'step-2', status: 'pending', decision_refs: ['DP-1'] },
        { step_id: 's-1', command: 'verify-extra', args: ['--strict'], status: 'pending', run_ids: [], goal_ref: null },
      ],
      decisions: [
        { decision_id: 'DP-1', after_step_id: 'step-2', status: 'resolved', evidence_refs: ['EVD-proposal'] },
      ],
    });
    expect(store.readRunV30('s-1', 'r-1')).toMatchObject({ status: 'sealed', revision: 1 });
  });

  it('replays a chain-proposal completion idempotently without re-applying', () => {
    const store = setup();
    const input = {
      ...identity('req-proposal-replay'), runId: 'r-1', expectedRunRevision: 0,
      expectedOrchestrationRevision: 0, summary: 'once', verdict: 'done' as const,
      chainProposal: proposalFixture(),
    };
    const applied = completeRunAndAdvance(store, input);
    const replayed = completeRunAndAdvance(store, input);
    expect(replayed).toEqual({ status: 'replayed', transition: applied.transition });
    const session = store.readSessionV30('s-1');
    expect(session.chain).toHaveLength(3);
    expect(session.decisions).toHaveLength(1);
    expect(session.orchestration_revision).toBe(1);
    expect(store.listTransitionReceiptsV20('s-1')).toHaveLength(1);
  });

  it('discovers the first chain-proposal artifact under outputs with --apply-proposal', () => {
    const store = setup();
    const outputs = join(store.runDir('s-1', 'r-1'), 'outputs');
    mkdirSync(outputs, { recursive: true });
    writeFileSync(join(outputs, 'proposal.json'), `${JSON.stringify({
      ...proposalFixture({ proposal_id: 'P-scan' }),
      operations: [{ op: 'insert', after: 'step-2', command: 'scan-step' }],
    }, null, 2)}\n`);
    const applied = completeRunAndAdvance(store, {
      ...identity('req-scan'), runId: 'r-1', expectedRunRevision: 0,
      expectedOrchestrationRevision: 0, summary: 'scan proposal', verdict: 'done',
      applyChainProposal: true,
    });
    expect(applied.status).toBe('applied');
    expect(applied.transition.result).toMatchObject({
      applied_proposal: { proposal_id: 'P-scan', operations: [{ op: 'insert', target: 's-1', status: 'pending' }] },
    });
    expect(store.readSessionV30('s-1').chain.map(step => step.step_id)).toEqual(['step-1', 'step-2', 's-1']);
  });

  it('rejects apply-proposal when no chain-proposal artifact exists', () => {
    const store = setup();
    expect(() => completeRunAndAdvance(store, {
      ...identity('req-no-proposal'), runId: 'r-1', expectedRunRevision: 0,
      expectedOrchestrationRevision: 0, summary: 'none', verdict: 'done',
      applyChainProposal: true,
    })).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
    expect(store.readSessionV30('s-1')).toMatchObject({ orchestration_revision: 0, activity_revision: 0 });
    expect(store.readRequestReceiptV20('s-1', 'req-no-proposal')).toBeNull();
  });

  it('wraps chain proposal operation failures as INVALID_ARGUMENT and leaves state untouched', () => {
    const store = setup();
    expect(() => completeRunAndAdvance(store, {
      ...identity('req-bad-op'), runId: 'r-1', expectedRunRevision: 0,
      expectedOrchestrationRevision: 0, summary: 'bad', verdict: 'done',
      chainProposal: proposalFixture({ operations: [{ op: 'insert', after: 'step-missing', command: 'x' }] }),
    })).toThrow(expect.objectContaining({
      code: 'INVALID_ARGUMENT',
      message: expect.stringContaining('chain proposal operations[0] insert: after step not found: step-missing'),
    }));
    expect(store.readSessionV30('s-1')).toMatchObject({ chain: [{ status: 'running' }, { status: 'pending' }] });
    expect(store.readRequestReceiptV20('s-1', 'req-bad-op')).toBeNull();
  });
});

describe('maestro run complete v2-contract inputs (CLI)', () => {
  function fixture(input: { run?: Partial<RunV30> } = {}): string {
    const root = mkdtempSync(join(tmpdir(), 'maestro-v3-complete-cli-'));
    roots.push(root);
    const sessionDir = join(root, '.workflow', 'sessions', 's-v3');
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(root, '.workflow', 'config.json'), `${JSON.stringify({
      session_schema: {
        schema_version: 'session-schema-selection/1.0',
        writer: 'session/3.0',
        features: { session_statusless: false },
      },
    }, null, 2)}\n`);
    writeFileSync(join(sessionDir, 'gates.json'), `${JSON.stringify({
      schema_version: 'gates/1.0', revision: 0, gates: {},
      summary: { total: 0, passed: 0, blocked: 0, failed: 0, active_gate_ids: [], blocking_run_id: null },
    }, null, 2)}\n`);
    writeFileSync(join(sessionDir, 'artifacts.json'), `${JSON.stringify({
      schema_version: 'artifacts/1.0', revision: 0, artifacts: {}, aliases: {},
    }, null, 2)}\n`);
    const session: SessionStateV30 = {
      schema_version: 'session/3.0', session_id: 's-v3', objective: 'exercise complete inputs',
      definition_of_done: 'commands persist atomically', status: 'open',
      identity_revision: 1, orchestration_revision: 0, activity_revision: 0,
      chain: [{
        step_id: 'step-1', command: 'implement', args: [], status: 'running',
        run_ids: ['run-1'], goal_ref: null, decision_refs: [],
      }],
      decisions: [], active_run_ids: ['run-1'],
      gates_ref: 'gates.json', artifacts_ref: 'artifacts.json', evidence_ref: 'evidence.json',
      created_at: '2026-08-12T00:00:00.000Z', updated_at: '2026-08-12T00:00:00.000Z',
      completed_at: null, archived_at: null,
    };
    writeFileSync(join(sessionDir, 'session.json'), `${JSON.stringify(session, null, 2)}\n`);
    const runDir = join(sessionDir, 'runs', 'run-1');
    mkdirSync(runDir, { recursive: true });
    const run: RunV30 = {
      schema_version: 'run/3.0', run_id: 'run-1', session_id: 's-v3', step_id: 'step-1',
      parent_run_id: null, retry_of_run_id: null, attempt: 1, command: 'implement', args: [], goal: null,
      status: 'running', revision: 0, actor_id: 'actor', participant_id: 'participant',
      gate_refs: [], input_refs: [], output_refs: [], primary_artifact_id: null, verdict: null, summary: null,
      created_at: '2026-08-12T00:00:00.000Z', started_at: '2026-08-12T00:01:00.000Z', ended_at: null, sealed_at: null,
      ...input.run,
    };
    writeFileSync(join(runDir, 'run.json'), `${JSON.stringify(run, null, 2)}\n`);
    return root;
  }

  async function invoke(args: string[]) {
    const writes: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    const program = new Command().name('maestro').exitOverride();
    registerRunV3Command(program);
    await program.parseAsync(['node', 'maestro', ...args]);
    expect(writes).toHaveLength(1);
    return runResponseV12Schema.parse(JSON.parse(writes[0]));
  }

  function completeArgs(root: string, extra: string[], revision = 0): string[] {
    return [
      'run', 'complete', 'run-1', '--advance', '--expected-orchestration-revision', String(revision),
      '--session', 's-v3', '--participant', 'participant', '--actor', 'actor',
      '--request-id', `req-cli-${Math.random()}`, '--expected-run-revision', '0',
      '--reason', 'focused test', '--evidence', 'evidence-1', '--json', '--workflow-root', root,
      ...extra,
    ];
  }

  it('completes without --summary using report.md frontmatter summary and decisions', async () => {
    const root = fixture();
    const runDir = join(root, '.workflow', 'sessions', 's-v3', 'runs', 'run-1');
    writeFileSync(join(runDir, 'report.md'), reportFrontmatter());
    const response = await invoke(completeArgs(root, []));
    expect(response).toMatchObject({ operation: 'complete', ok: true });
    const run = JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf8'));
    expect(run).toMatchObject({
      status: 'sealed', summary: 'frontmatter summary',
      decision_records: [
        { text: 'Use X', status: 'accepted' },
        { text: 'Evaluate Y', status: 'proposed' },
      ],
    });
  });

  it('writes --decision/--note and registers --artifact through the CLI', async () => {
    const root = fixture();
    const runDir = join(root, '.workflow', 'sessions', 's-v3', 'runs', 'run-1');
    writeFileSync(join(runDir, 'extra.json'), `${JSON.stringify({
      _meta: { kind: 'attachment', schema: 'attachment/1.0' },
    }, null, 2)}\n`);
    const response = await invoke(completeArgs(root, [
      '--summary', 'cli summary',
      '--decision', 'Use X', '--decision', 'Try Y',
      '--note', 'first note', '--note', 'second note',
      '--artifact', 'extra.json',
    ]));
    expect(response).toMatchObject({ operation: 'complete', ok: true });
    const run = JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf8'));
    expect(run).toMatchObject({
      summary: 'cli summary',
      decision_records: [
        { text: 'Use X', status: 'accepted' },
        { text: 'Try Y', status: 'accepted' },
      ],
      notes: ['first note', 'second note'],
    });
    expect(run.output_refs).toHaveLength(1);
    const registry = JSON.parse(readFileSync(join(root, '.workflow', 'sessions', 's-v3', 'artifacts.json'), 'utf8'));
    expect(registry.artifacts[run.output_refs[0]]).toMatchObject({
      kind: 'attachment', role: 'evidence', relative_path: 'runs/run-1/extra.json', status: 'sealed',
    });
  });

  it('rejects a chain-proposal path outside the Run outputs/ directory', async () => {
    const root = fixture();
    const runDir = join(root, '.workflow', 'sessions', 's-v3', 'runs', 'run-1');
    mkdirSync(join(runDir, 'outputs'), { recursive: true });
    writeFileSync(join(runDir, '..', 'outside-proposal.json'), `${JSON.stringify(proposalFixture(), null, 2)}\n`);
    const response = await invoke(completeArgs(root, [
      '--summary', 'escape attempt', '--chain-proposal', '../outside-proposal.json',
    ]));
    expect(response).toMatchObject({ operation: 'complete', ok: false });
    expect(response.error?.message).toContain('must remain under the current Run outputs/');
  });

  it('applies an explicit --chain-proposal under outputs/ and reports applied_proposal', async () => {
    const root = fixture();
    const runDir = join(root, '.workflow', 'sessions', 's-v3', 'runs', 'run-1');
    mkdirSync(join(runDir, 'outputs'), { recursive: true });
    writeFileSync(join(runDir, 'outputs', 'proposal.json'), `${JSON.stringify({
      ...proposalFixture({ proposal_id: 'P-cli' }),
      operations: [{ op: 'insert', after: 'step-1', command: 'cli-step' }],
    }, null, 2)}\n`);
    const response = await invoke(completeArgs(root, [
      '--summary', 'explicit proposal', '--chain-proposal', 'outputs/proposal.json',
    ]));
    expect(response).toMatchObject({
      operation: 'complete', ok: true,
      result: { applied_proposal: { proposal_id: 'P-cli', operations: [{ op: 'insert', target: 's-1', status: 'pending' }] } },
    });
    const session = JSON.parse(readFileSync(join(root, '.workflow', 'sessions', 's-v3', 'session.json'), 'utf8'));
    expect(session.chain.map((step: { step_id: string }) => step.step_id)).toEqual(['step-1', 's-1']);
  });

  it('rejects --chain-proposal combined with --apply-proposal', async () => {
    const root = fixture();
    const runDir = join(root, '.workflow', 'sessions', 's-v3', 'runs', 'run-1');
    mkdirSync(join(runDir, 'outputs'), { recursive: true });
    writeFileSync(join(runDir, 'outputs', 'proposal.json'), `${JSON.stringify(proposalFixture(), null, 2)}\n`);
    const response = await invoke(completeArgs(root, [
      '--summary', 'both', '--chain-proposal', 'outputs/proposal.json', '--apply-proposal',
    ]));
    expect(response).toMatchObject({ operation: 'complete', ok: false });
    expect(response.error?.message).toContain('mutually exclusive');
  });
});
