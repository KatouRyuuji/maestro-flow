import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
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

export interface ValidatedChainProposal {
  proposal: ChainProposal;
  artifact: DiscoveredArtifact;
  path: string;
}

export interface AppliedChainProposalOperation {
  op: ChainEffect;
  target: string;
  status: string;
}

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

export function applyChainProposal(
  draft: SessionBundle,
  proposal: ChainProposal,
): AppliedChainProposalOperation[] {
  const applied: AppliedChainProposalOperation[] = [];
  for (const [index, operation] of proposal.operations.entries()) {
    try {
      if (operation.op === 'insert') {
        const step = applyChainMutation(draft, {
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
        applied.push({ op: operation.op, target: step.step_id, status: step.status });
      } else if (operation.op === 'replace') {
        const step = applyChainMutation(draft, {
          operation: 'replace',
          stepId: operation.step_id,
          options: {
            ...(operation.command !== undefined ? { command: operation.command } : {}),
            ...(operation.args !== undefined ? { args: operation.args } : {}),
            ...(operation.stage !== undefined ? { stage: operation.stage } : {}),
            ...(operation.goal_ref !== undefined ? { goalRef: operation.goal_ref } : {}),
          },
        });
        applied.push({ op: operation.op, target: step.step_id, status: step.status });
      } else if (operation.op === 'skip') {
        const step = applyChainMutation(draft, { operation: 'skip', stepId: operation.step_id });
        applied.push({ op: operation.op, target: step.step_id, status: step.status });
      } else {
        const decision = applyDecideMutation(draft, operation.point_id, {
          verdict: operation.verdict,
          confidence: operation.confidence,
          ...(operation.summary !== undefined ? { summary: operation.summary } : {}),
          ...(operation.evidence !== undefined ? { evidence: operation.evidence } : {}),
        }, `proposal:${proposal.proposal_id}:${index}`, new Date(0).toISOString()).decision;
        applied.push({ op: operation.op, target: decision.point_id, status: decision.point_status });
      }
    } catch (error) {
      throw new Error(`operations[${index}] ${operation.op}: ${(error as Error).message}`);
    }
  }
  return applied;
}

export function validateChainProposalArtifacts(
  runDir: string,
  bundle: SessionBundle,
  run: CommandRun,
  contract: CommandContract,
  scan: ArtifactScanResult,
  options: {
    preflight?: boolean;
    validateCommand?: (command: string, args: string[]) => void;
  } = {},
): ValidatedChainProposal[] {
  const proposals = scan.artifacts.filter(artifact => (
    artifact.kind === 'chain-proposal'
    || artifact.schemaVersion === 'chain-proposal/1.0'
    || isDeclaredProposal(contract, artifact, runDir)
  ));
  const allowed = new Set(contract.orchestration?.chain_effects ?? []);
  const ids = new Set<string>();
  const validated: ValidatedChainProposal[] = [];

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
      for (const [index, operation] of proposal.operations.entries()) {
        const effect = operationEffect(operation);
        if (!allowed.has(effect)) throw new Error(`operation ${effect} is not allowed by contract orchestration.chain_effects`);
        if (!options.validateCommand) continue;
        if (operation.op === 'insert') {
          if (!operation.decision_ref) {
            try {
              options.validateCommand(operation.command, operation.args === undefined ? [] : [operation.args]);
            } catch (error) {
              throw new Error(`operations[${index}] insert command ${operation.command}: ${(error as Error).message}`);
            }
          }
        } else if (operation.op === 'replace') {
          const target = bundle.session.orchestration.chain.find(step => step.step_id === operation.step_id);
          if (target && !target.decision_ref) {
            const command = operation.command ?? target.command;
            const args = operation.args ?? target.args;
            try {
              options.validateCommand(command, args === undefined ? [] : [args]);
            } catch (error) {
              throw new Error(`operations[${index}] replace command ${command}: ${(error as Error).message}`);
            }
          }
        }
      }
      if (options.preflight !== false) applyChainProposal(structuredClone(bundle), proposal);
      validated.push({ proposal, artifact, path: label });
    } catch (error) {
      const detail = error instanceof z.ZodError
        ? error.issues.map(issue => `${issue.path.join('.') || 'proposal'}: ${issue.message}`).join('; ')
        : (error as Error).message;
      scan.errors.push(`${label}: invalid chain-proposal/1.0 (${detail})`);
    }
  }
  return validated;
}

export function selectChainProposal(
  runDir: string,
  requestedPath: string,
  proposals: readonly ValidatedChainProposal[],
): ValidatedChainProposal {
  const outputsRoot = realpathSync(resolve(runDir, 'outputs'));
  const underOutputs = (candidate: string) => {
    const rel = relative(outputsRoot, candidate);
    // isAbsolute(rel): cross-drive Windows paths yield an absolute rel instead of '..'
    return Boolean(rel) && !isAbsolute(rel) && !rel.startsWith('..') && resolve(outputsRoot, rel) === candidate;
  };
  let requested = resolve(runDir, requestedPath);
  if (!underOutputs(requested) && !isAbsolute(requestedPath)) {
    // Callers habitually pass shell-CWD-relative paths; accept that reading
    // unambiguously when it lands under the current Run outputs/.
    const cwdCandidate = resolve(requestedPath);
    if (underOutputs(cwdCandidate)) requested = cwdCandidate;
  }
  if (!underOutputs(requested)) {
    throw new Error(
      `chain proposal path must remain under the current Run outputs/: ${requestedPath} (resolved to ${requested}; relative paths resolve against the run directory ${resolve(runDir)} — pass a run-relative or absolute path under ${outputsRoot})`,
    );
  }
  const selected = proposals.find(item => resolve(item.artifact.absolutePath) === requested);
  if (!selected) {
    throw new Error(
      `chain proposal is missing or invalid: ${requestedPath} (resolved to ${requested}; expected a validated proposal under ${outputsRoot})`,
    );
  }
  return selected;
}
