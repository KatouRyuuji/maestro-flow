import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { z } from 'zod';

import type { ArtifactScanResult, DiscoveredArtifact } from './artifacts.js';
import { applyChainMutation } from './chain-admin.js';
import type { ChainEffect, CommandContract } from './contract.js';
import { applyDecideMutation } from './decide.js';
import type { CommandRun } from './schemas.js';
import type { SessionBundle } from './store.js';

const nonEmptyString = z.string().trim().min(1);

const insertOperationSchema = z.object({
  op: z.literal('insert'),
  after: nonEmptyString,
  command: nonEmptyString,
  args: z.string().optional(),
  stage: z.string().nullable().optional(),
  goal_ref: z.string().nullable().optional(),
  decision_ref: z.string().nullable().optional(),
}).strict();

const replaceOperationSchema = z.object({
  op: z.literal('replace'),
  step_id: nonEmptyString,
  command: nonEmptyString.optional(),
  args: z.string().optional(),
  stage: z.string().nullable().optional(),
  goal_ref: z.string().nullable().optional(),
}).strict().refine(operation => (
  operation.command !== undefined
  || operation.args !== undefined
  || operation.stage !== undefined
  || operation.goal_ref !== undefined
), { message: 'replace must change at least one field' });

const skipOperationSchema = z.object({
  op: z.literal('skip'),
  step_id: nonEmptyString,
  reason: nonEmptyString,
}).strict();

const decideOperationSchema = z.object({
  op: z.literal('decide'),
  point_id: nonEmptyString,
  verdict: z.enum(['proceed', 'fix', 'escalate']),
  confidence: z.enum(['high', 'medium', 'low']),
  summary: z.string().optional(),
  evidence: z.string().optional(),
}).strict();

export const chainProposalOperationSchema = z.discriminatedUnion('op', [
  insertOperationSchema,
  replaceOperationSchema,
  skipOperationSchema,
  decideOperationSchema,
]);

export const chainProposalV10Schema = z.object({
  _meta: z.object({
    kind: z.literal('chain-proposal'),
    schema: z.literal('chain-proposal/1.0'),
    role: z.enum(['primary', 'evidence', 'report', 'attachment', 'checkpoint']).optional(),
    alias: nonEmptyString.optional(),
  }).strict(),
  proposal_id: nonEmptyString,
  source: z.object({
    session_id: nonEmptyString,
    run_id: nonEmptyString,
    skill: nonEmptyString,
  }).strict(),
  reason: nonEmptyString,
  operations: z.array(chainProposalOperationSchema).min(1).max(10),
}).strict();

export type ChainProposal = z.infer<typeof chainProposalV10Schema>;

function runRelativePath(runDir: string, artifact: DiscoveredArtifact): string {
  return relative(runDir, artifact.absolutePath).replaceAll('\\', '/');
}

function isDeclaredProposal(contract: CommandContract, artifact: DiscoveredArtifact, runDir: string): boolean {
  const artifactPath = runRelativePath(runDir, artifact);
  return contract.produces.some(output => {
    const declaresProposal = output.kind === 'chain-proposal' || output.schema === 'chain-proposal/1.0';
    const declaredPath = output.path?.replaceAll('\\', '/').replace(/^\.\//, '');
    return declaresProposal && (declaredPath === undefined || declaredPath === artifactPath);
  });
}

function readProposal(path: string, runDir: string): unknown {
  const outputsRoot = realpathSync(resolve(runDir, 'outputs'));
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('proposal must be a regular file');
  const canonical = realpathSync(path);
  const rel = relative(outputsRoot, canonical);
  if (!rel || rel.startsWith('..') || resolve(outputsRoot, rel) !== canonical) {
    throw new Error('proposal must remain under the current Run outputs/ directory');
  }
  return JSON.parse(readFileSync(canonical, 'utf8')) as unknown;
}

function operationEffect(operation: ChainProposal['operations'][number]): ChainEffect {
  return operation.op;
}

function preflightProposal(bundle: SessionBundle, proposal: ChainProposal): void {
  const draft = structuredClone(bundle);
  for (const [index, operation] of proposal.operations.entries()) {
    try {
      if (operation.op === 'insert') {
        applyChainMutation(draft, {
          operation: 'insert',
          options: {
            after: operation.after,
            command: operation.command,
            ...(operation.args !== undefined ? { args: operation.args } : {}),
            ...(operation.stage !== undefined ? { stage: operation.stage } : {}),
            ...(operation.goal_ref !== undefined ? { goalRef: operation.goal_ref } : {}),
            insertedBy: `proposal:${proposal.proposal_id}`,
            ...(operation.decision_ref !== undefined ? { decisionRef: operation.decision_ref } : {}),
          },
        });
      } else if (operation.op === 'replace') {
        applyChainMutation(draft, {
          operation: 'replace',
          stepId: operation.step_id,
          options: {
            ...(operation.command !== undefined ? { command: operation.command } : {}),
            ...(operation.args !== undefined ? { args: operation.args } : {}),
            ...(operation.stage !== undefined ? { stage: operation.stage } : {}),
            ...(operation.goal_ref !== undefined ? { goalRef: operation.goal_ref } : {}),
          },
        });
      } else if (operation.op === 'skip') {
        applyChainMutation(draft, { operation: 'skip', stepId: operation.step_id });
      } else {
        applyDecideMutation(draft, operation.point_id, {
          verdict: operation.verdict,
          confidence: operation.confidence,
          ...(operation.summary !== undefined ? { summary: operation.summary } : {}),
          ...(operation.evidence !== undefined ? { evidence: operation.evidence } : {}),
        }, `proposal:${proposal.proposal_id}:${index}`, new Date(0).toISOString());
      }
    } catch (error) {
      throw new Error(`operations[${index}] ${operation.op}: ${(error as Error).message}`);
    }
  }
}

export function validateChainProposalArtifacts(
  runDir: string,
  bundle: SessionBundle,
  run: CommandRun,
  contract: CommandContract,
  scan: ArtifactScanResult,
): void {
  const proposals = scan.artifacts.filter(artifact => (
    artifact.kind === 'chain-proposal'
    || artifact.schemaVersion === 'chain-proposal/1.0'
    || isDeclaredProposal(contract, artifact, runDir)
  ));
  const allowed = new Set(contract.orchestration?.chain_effects ?? []);
  const ids = new Set<string>();

  for (const artifact of proposals) {
    const label = runRelativePath(runDir, artifact);
    try {
      const proposal = chainProposalV10Schema.parse(readProposal(artifact.absolutePath, runDir));
      if (ids.has(proposal.proposal_id)) throw new Error(`duplicate proposal_id: ${proposal.proposal_id}`);
      ids.add(proposal.proposal_id);
      if (proposal.source.session_id !== bundle.session.session_id) {
        throw new Error(`source.session_id ${proposal.source.session_id} does not match ${bundle.session.session_id}`);
      }
      if (proposal.source.run_id !== run.run_id) {
        throw new Error(`source.run_id ${proposal.source.run_id} does not match ${run.run_id}`);
      }
      if (proposal.source.skill !== run.command.name) {
        throw new Error(`source.skill ${proposal.source.skill} does not match ${run.command.name}`);
      }
      for (const operation of proposal.operations) {
        const effect = operationEffect(operation);
        if (!allowed.has(effect)) throw new Error(`operation ${effect} is not allowed by contract orchestration.chain_effects`);
      }
      preflightProposal(bundle, proposal);
    } catch (error) {
      const detail = error instanceof z.ZodError
        ? error.issues.map(issue => `${issue.path.join('.') || 'proposal'}: ${issue.message}`).join('; ')
        : (error as Error).message;
      scan.errors.push(`${label}: invalid chain-proposal/1.0 (${detail})`);
    }
  }
}
