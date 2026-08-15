import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { chainProposalV10Schema } from './chain-proposal.js';
import { briefRun, checkRun, completeRun, createRun } from './runtime.js';

function v2Workspace(root: string): void {
  mkdirSync(join(root, ".workflow"), { recursive: true });
  writeFileSync(join(root, ".workflow", "config.json"), JSON.stringify({
    session_schema: { schema_version: "session-schema-selection/1.0", writer: "session/1.3", features: { session_statusless: false } },
  }));
}

const roots: string[] = [];

function root(): string {
  const path = mkdtempSync(join(tmpdir(), 'maestro-chain-proposal-'));

  v2Workspace(path);
  roots.push(path);
  return path;
}

afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

function commandFile(projectRoot: string, name: string, effects: string[]): void {
  const commandDir = join(projectRoot, '.claude', 'commands');
  const workflowDir = join(projectRoot, 'workflows');
  mkdirSync(commandDir, { recursive: true });
  mkdirSync(workflowDir, { recursive: true });
  const orchestration = effects.length > 0
    ? `orchestration:\n  chain_effects: [${effects.join(', ')}]\n`
    : '';
  writeFileSync(join(commandDir, `${name}.md`), `<contract>\ncontract_version: 2\n${orchestration}consumes: []
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
  writeFileSync(join(workflowDir, `${name}.md`), `# ${name}\n`, 'utf8');
}

function proposal(
  sessionId: string,
  runId: string,
  skill: string,
  operations: unknown[],
): Record<string, unknown> {
  return {
    _meta: { kind: 'chain-proposal', schema: 'chain-proposal/1.0', role: 'attachment', alias: 'chain-proposal' },
    proposal_id: 'cp-001',
    source: { session_id: sessionId, run_id: runId, skill },
    reason: 'Adapt the remaining chain to verified findings.',
    operations,
  };
}

function writeProposal(projectRoot: string, sessionId: string, runId: string, value: unknown): void {
  writeFileSync(
    join(projectRoot, '.workflow', 'sessions', sessionId, 'runs', runId, 'outputs', 'chain-proposal.json'),
    JSON.stringify(value, null, 2),
    'utf8',
  );
}

describe('chain-proposal/1.0', () => {
  it('bounds operation count and requires a meaningful replace', () => {
    const base = proposal('s', 'r', 'review', [{ op: 'insert', after: 'start', command: 'analyze' }]);
    expect(chainProposalV10Schema.parse(base).operations).toHaveLength(1);
    expect(() => chainProposalV10Schema.parse({
      ...base,
      operations: Array.from({ length: 11 }, () => ({ op: 'insert', after: 'start', command: 'analyze' })),
    })).toThrow();
    expect(() => chainProposalV10Schema.parse({
      ...base,
      operations: [{ op: 'replace', step_id: 'step-001-execute' }],
    })).toThrow(/replace must change at least one field/);
  });

  it('injects allowed effects into brief and accepts a valid preflight proposal without mutating Session', () => {
    const projectRoot = root();
    commandFile(projectRoot, 'adaptive-review', ['insert']);
    const created = createRun({ projectRoot, command: 'adaptive-review', intent: 'review and adapt' });
    writeProposal(projectRoot, created.session_id, created.run_id, proposal(
      created.session_id,
      created.run_id,
      'adaptive-review',
      [{ op: 'insert', after: 'start', command: 'verify' }],
    ));

    expect(briefRun(projectRoot, created.run_id, created.session_id).execution_contract.orchestration)
      .toEqual({ chain_effects: ['insert'] });
    expect(checkRun(projectRoot, created.run_id, created.session_id).errors).toEqual([]);
    expect(briefRun(projectRoot, created.run_id, created.session_id).session.activity_revision).toBe(1);
  });

  it('rejects a proposal when the Skill did not declare the requested capability', () => {
    const projectRoot = root();
    commandFile(projectRoot, 'plain-review', []);
    const created = createRun({ projectRoot, command: 'plain-review', intent: 'plain review' });
    writeProposal(projectRoot, created.session_id, created.run_id, proposal(
      created.session_id,
      created.run_id,
      'plain-review',
      [{ op: 'insert', after: 'start', command: 'verify' }],
    ));

    expect(checkRun(projectRoot, created.run_id, created.session_id).errors).toEqual(expect.arrayContaining([
      expect.stringContaining('operation insert is not allowed'),
    ]));
    const completion = completeRun(projectRoot, created.run_id, created.session_id);
    expect(completion.sealed).toBe(false);
    expect(completion.errors).toEqual(expect.arrayContaining([
      expect.stringContaining('operation insert is not allowed'),
    ]));
  });

  it('rejects source mismatch and stale or unsafe operation targets', () => {
    const projectRoot = root();
    commandFile(projectRoot, 'bounded-review', ['replace']);
    const created = createRun({ projectRoot, command: 'bounded-review', intent: 'bounded review' });
    writeProposal(projectRoot, created.session_id, created.run_id, proposal(
      created.session_id,
      created.run_id,
      'wrong-skill',
      [{ op: 'replace', step_id: 'missing-step', command: 'verify' }],
    ));
    expect(checkRun(projectRoot, created.run_id, created.session_id).errors).toEqual(expect.arrayContaining([
      expect.stringContaining('source.skill wrong-skill does not match bounded-review'),
    ]));

    writeProposal(projectRoot, created.session_id, created.run_id, proposal(
      created.session_id,
      created.run_id,
      'bounded-review',
      [{ op: 'replace', step_id: 'missing-step', command: 'verify' }],
    ));
    expect(checkRun(projectRoot, created.run_id, created.session_id).errors).toEqual(expect.arrayContaining([
      expect.stringContaining('chain step not found: missing-step'),
    ]));
  });
});
