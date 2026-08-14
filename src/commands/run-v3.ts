import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import type { Command } from 'commander';

import { chainProposalV10Schema, type ChainProposal } from '../run/chain-proposal.js';
import type { RunV30 } from '../run/schemas.js';
import { buildRetryMetadata } from '../run/v3/run-machine.js';
import {
  completeRunAndAdvance,
  createRunningRunV3,
  mutateRunV3,
  recoverSealRunV3,
} from '../run/v3/mutation-engine.js';
import {
  decideV3,
  type DecideV3Confidence,
  type DecideV3Verdict,
} from '../run/v3/decide-v3.js';
import {
  readV3KnowledgeReconciliation,
  reconcileV3RunKnowledge,
  v3ReconciliationSummary,
} from '../run/v3/knowledge-v3.js';
import { ensureV3RunShell } from '../run/v3/run-shell.js';
import {
  addV3MutationOptions,
  addV3ReadOptions,
  collectV3,
  emitV3Error,
  emitV3Success,
  listV3Sessions,
  mutationIdentity,
  parseV3Revision,
  resolveV3Options,
  retiredV3Action,
  retiredV3Options,
  type V3CommonOptions,
  v3Store,
} from './v3-cli-shared.js';

type RunMutationOptions = V3CommonOptions & { run: string };

function runResult(mutation: ReturnType<typeof mutateRunV3>): unknown {
  return mutation.transition.result;
}

/**
 * Read and validate a run-relative chain-proposal document under outputs/.
 * Mirrors the v2 readProposal safety mode: realpath checks that the resolved
 * file is a regular file inside the canonical Run outputs/ directory.
 */
function readV3ChainProposal(runDir: string, path: string): ChainProposal {
  const outputsRoot = resolve(runDir, 'outputs');
  if (!existsSync(outputsRoot)) {
    throw new Error('chain proposal must remain under the current Run outputs/ directory');
  }
  const canonicalOutputs = realpathSync(outputsRoot);
  const candidate = resolve(runDir, path);
  const stat = lstatSync(candidate);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('chain proposal must be a regular file');
  const canonical = realpathSync(candidate);
  const rel = relative(canonicalOutputs, canonical);
  if (!rel || rel.startsWith('..') || isAbsolute(rel) || resolve(canonicalOutputs, rel) !== canonical) {
    throw new Error('chain proposal must remain under the current Run outputs/ directory');
  }
  const parsed = chainProposalV10Schema.safeParse(JSON.parse(readFileSync(canonical, 'utf8')));
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map(issue => `${issue.path.join('.') || 'proposal'}: ${issue.message}`)
      .join('; ');
    throw new Error(`chain proposal is invalid: ${detail}`);
  }
  return parsed.data;
}

export function registerRunV3Command(program: Command): void {
  const run = program.command('run').description('Manage session/3.0 Runs');

  addV3MutationOptions(run.command('next').description('Create the next pending chain Run'), 'orchestration')
    .requiredOption('--run <id>', 'new Run ID')
    .action((options: V3CommonOptions & { run: string }) => {
      try {
        const { store, options: resolved } = resolveV3Options(options);
        const state = store.readSessionV30(resolved.session);
        const existingRun = (() => {
          try { return store.readRunV30(resolved.session, resolved.run); } catch { return null; }
        })();
        const pendingStep = existingRun ? null : state.chain.find(item => item.status === 'pending');
        const step = existingRun
          ? state.chain.find(item => item.step_id === existingRun.step_id && item.run_ids.includes(existingRun.run_id))
          : pendingStep;
        if (!step) throw new Error('Session chain has no pending step');
        const now = new Date().toISOString();
        const candidate: RunV30 = existingRun ? {
          ...existingRun,
          status: 'pending',
          revision: 0,
          started_at: null,
          ended_at: null,
          sealed_at: null,
        } : {
          schema_version: 'run/3.0', run_id: resolved.run, session_id: resolved.session,
          step_id: step.step_id, parent_run_id: null, retry_of_run_id: null, attempt: 1,
          command: step.command, args: step.args, goal: step.goal_ref, status: 'pending', revision: 0,
          actor_id: resolved.actor, participant_id: resolved.participant,
          gate_refs: [], input_refs: [], output_refs: [], primary_artifact_id: null,
          verdict: null, summary: null, created_at: now, started_at: null, ended_at: null, sealed_at: null,
        };
        const mutation = createRunningRunV3(store, {
          ...mutationIdentity(resolved), expectedOrchestrationRevision: resolved.expectedOrchestrationRevision!, run: candidate,
        });
        ensureV3RunShell(store, resolved.session, resolved.run);
        const result = {
          ...(runResult(mutation) as Record<string, unknown>),
          step_id: step.step_id,
          next: {
            suggest_only: true,
            command: `maestro run complete ${resolved.run} --advance`,
            reason: 'Run created — execute and complete it with run complete --advance',
          },
        };
        emitV3Success({ operation: 'next', sessionId: resolved.session, runId: resolved.run,
          requestId: resolved.requestId, result, mutation });
      } catch (error) {
        emitV3Error('next', error, { session: options.session, runId: options.run, requestId: options.requestId });
      }
    });

  addV3MutationOptions(run.command('create <command> [args...]').description('Create and start a Run'), 'orchestration')
    .requiredOption('--run <id>', 'new Run ID')
    .requiredOption('--step <id>', 'target chain step ID')
    .option('--parent-run <id>', 'parent Run ID')
    .option('--retry-of-run <id>', 'derive retry lineage from an existing failed Run')
    .option('--goal <text>', 'Run goal')
    .option('--gate <ref>', 'gate reference (repeatable)', collectV3, [])
    .option('--input <ref>', 'input reference (repeatable)', collectV3, [])
    .action((command: string, args: string[], options: V3CommonOptions & {
      run: string; step: string; parentRun?: string; retryOfRun?: string;
      goal?: string; gate: string[]; input: string[];
    }) => {
      try {
        const { store, options: resolved } = resolveV3Options(options);
        const now = new Date().toISOString();
        const retrySource = resolved.retryOfRun
          ? store.readRunV30(resolved.session, resolved.retryOfRun)
          : null;
        const retry = retrySource
          ? retrySource.status === 'sealed'
            ? buildRetryMetadata({
              runId: retrySource.run_id,
              attempt: retrySource.attempt,
              status: retrySource.status,
              verdict: retrySource.verdict,
            })
            : buildRetryMetadata({
              runId: retrySource.run_id,
              attempt: retrySource.attempt,
              status: retrySource.status,
            })
          : null;
        const candidate: RunV30 = {
          schema_version: 'run/3.0', run_id: resolved.run, session_id: resolved.session,
          step_id: resolved.step, parent_run_id: resolved.parentRun ?? null,
          retry_of_run_id: retry?.retryOfRunId ?? null, attempt: retry?.attempt ?? 1,
          command, args, goal: resolved.goal ?? null, status: 'pending', revision: 0,
          actor_id: resolved.actor, participant_id: resolved.participant,
          gate_refs: resolved.gate, input_refs: resolved.input, output_refs: [],
          primary_artifact_id: null, verdict: null, summary: null,
          created_at: now, started_at: null, ended_at: null, sealed_at: null,
        };
        const mutation = createRunningRunV3(store, {
          ...mutationIdentity(resolved),
          expectedOrchestrationRevision: resolved.expectedOrchestrationRevision!,
          requestOperation: 'run-create',
          run: candidate,
        });
        ensureV3RunShell(store, resolved.session, resolved.run);
        emitV3Success({ operation: 'create', sessionId: resolved.session, runId: resolved.run,
          requestId: resolved.requestId, result: runResult(mutation), mutation });
      } catch (error) {
        emitV3Error('create', error, { session: options.session, runId: options.run, requestId: options.requestId });
      }
    });

  addV3MutationOptions(run.command('complete <run-id>').description('Complete and seal a Run atomically'), 'run')
    .option('--summary <text>', 'completion summary (fallback: report.md frontmatter summary)')
    .option('--verdict <verdict>', 'done or done_with_concerns', 'done')
    .option('--advance', 'complete the Run and its chain step atomically')
    .option('--decision <text>', 'decision record (repeatable)', collectV3, [])
    .option('--note <text>', 'supplementary note (repeatable)', collectV3, [])
    .option('--artifact <path>', 'run-relative extra artifact (repeatable)', collectV3, [])
    .option('--chain-proposal <path>', 'run-relative chain-proposal JSON under outputs/')
    .option('--apply-proposal', 'apply the single validated chain-proposal artifact discovered in this Run')
    .requiredOption('--expected-orchestration-revision <n>', 'expected Session orchestration revision', parseV3Revision)
    .action((runId: string, options: V3CommonOptions & {
      summary?: string; verdict: string; advance?: boolean;
      decision: string[]; note: string[]; artifact: string[];
      chainProposal?: string; applyProposal?: boolean;
    }) => {
      try {
        if (!options.advance) {
          throw new Error('run complete requires --advance to update the chain step atomically');
        }
        if (options.verdict !== 'done' && options.verdict !== 'done_with_concerns') {
          throw new Error('--verdict must be done or done_with_concerns');
        }
        if (options.chainProposal && options.applyProposal) {
          throw new Error('--chain-proposal and --apply-proposal are mutually exclusive');
        }
        const { store, options: resolved } = resolveV3Options(options);
        const verdict = resolved.verdict as 'done' | 'done_with_concerns';
        const chainProposal = resolved.chainProposal
          ? readV3ChainProposal(store.runDir(resolved.session, runId), resolved.chainProposal)
          : undefined;
        const mutation = completeRunAndAdvance(store, {
          ...mutationIdentity(resolved), runId,
          expectedRunRevision: resolved.expectedRunRevision!,
          expectedOrchestrationRevision: resolved.expectedOrchestrationRevision!,
          summary: resolved.summary, verdict,
          notes: resolved.note,
          decisionRecords: resolved.decision.map(text => ({ text })),
          extraArtifactRefs: resolved.artifact,
          chainProposal,
          applyChainProposal: resolved.applyProposal,
        });
        emitV3Success({ operation: 'complete', sessionId: resolved.session, runId,
          requestId: resolved.requestId, result: runResult(mutation), mutation });
      } catch (error) {
        emitV3Error('complete', error, { session: options.session, runId, requestId: options.requestId });
      }
    });

  addV3MutationOptions(run.command('transition <run-id> <status>').description('Transition a Run between active states'), 'run')
    .action((runId: string, status: string, options: RunMutationOptions) => {
      try {
        if (!['running', 'blocked', 'failed'].includes(status)) {
          throw new Error('status must be running, blocked, or failed');
        }
        const { store, options: resolved } = resolveV3Options(options);
        const toStatus = status as 'running' | 'blocked' | 'failed';
        const mutation = mutateRunV3(store, {
          ...mutationIdentity(resolved), runId,
          expectedRunRevision: resolved.expectedRunRevision!, toStatus,
          transitionEvidence: { reason: resolved.reason, evidence: resolved.evidence },
          verdict: toStatus === 'blocked' ? 'blocked' : toStatus === 'failed' ? 'needs_retry' : undefined,
        });
        emitV3Success({ operation: 'run-transition', sessionId: resolved.session, runId,
          requestId: resolved.requestId, result: runResult(mutation), mutation });
      } catch (error) {
        emitV3Error('run-transition', error, { session: options.session, runId, requestId: options.requestId });
      }
    });

  addV3MutationOptions(run.command('cancel <run-id>').description('Cancel a Run'), 'run')
    .action((runId: string, options: RunMutationOptions) => {
      try {
        const { store, options: resolved } = resolveV3Options(options);
        const mutation = mutateRunV3(store, {
          ...mutationIdentity(resolved), runId,
          expectedRunRevision: resolved.expectedRunRevision!, toStatus: 'cancelled',
        });
        emitV3Success({ operation: 'run-cancel', sessionId: resolved.session, runId,
          requestId: resolved.requestId, result: runResult(mutation), mutation });
      } catch (error) {
        emitV3Error('run-cancel', error, { session: options.session, runId, requestId: options.requestId });
      }
    });

  addV3MutationOptions(run.command('seal <run-id>').description('Deprecated recovery seal for an already terminal pre-upgrade Run'), 'run')
    .action((runId: string, options: RunMutationOptions) => {
      try {
        const { store, options: resolved } = resolveV3Options(options);
        const mutation = recoverSealRunV3(store, {
          ...mutationIdentity(resolved), runId,
          expectedRunRevision: resolved.expectedRunRevision!,
        });
        emitV3Success({ operation: 'run-seal', sessionId: resolved.session, runId,
          requestId: resolved.requestId, result: runResult(mutation), mutation });
      } catch (error) {
        emitV3Error('run-seal', error, { session: options.session, runId, requestId: options.requestId });
      }
    });

  addV3MutationOptions(run.command('decide <point-id>').description('Record a decision point verdict'), 'orchestration')
    .requiredOption('--verdict <verdict>', 'proceed|fix|escalate')
    .option('--confidence <level>', 'high|medium|low', 'medium')
    .option('--summary <text>', 'decision summary')
    .option('--after-step <id>', 'chain step the decision gates (default: first pending step)')
    .action((pointId: string, options: V3CommonOptions & {
      verdict: string; confidence: string; summary?: string; afterStep?: string;
    }) => {
      try {
        if (!['proceed', 'fix', 'escalate'].includes(options.verdict)) {
          throw new Error('--verdict must be proceed, fix, or escalate');
        }
        if (!['high', 'medium', 'low'].includes(options.confidence)) {
          throw new Error('--confidence must be high, medium, or low');
        }
        const { store, options: resolved } = resolveV3Options(options);
        const mutation = decideV3(store, {
          ...mutationIdentity(resolved),
          pointId,
          verdict: resolved.verdict as DecideV3Verdict,
          confidence: resolved.confidence as DecideV3Confidence,
          summary: resolved.summary,
          expectedOrchestrationRevision: resolved.expectedOrchestrationRevision!,
          afterStepId: resolved.afterStep,
        });
        emitV3Success({ operation: 'run-decide', sessionId: resolved.session,
          requestId: resolved.requestId, result: runResult(mutation), mutation });
      } catch (error) {
        emitV3Error('run-decide', error, { session: options.session, requestId: options.requestId });
      }
    });

  addV3ReadOptions(run.command('brief <run-id>').description('Read a Run brief'))
    .action((runId: string, options: { session?: string; workflowRoot: string }) => {
      try {
        const { store, options: resolved } = resolveV3Options(options);
        const value = store.readRunV30(resolved.session, runId);
        emitV3Success({ operation: 'brief', sessionId: resolved.session, runId, result: value });
      } catch (error) {
        emitV3Error('brief', error, { session: options.session, runId });
      }
    });

  addV3ReadOptions(run.command('recall <command> [args...]').description('Read-only topic search across session/3.0 Sessions'))
    .action((command: string, args: string[], options: { session?: string; workflowRoot: string }) => {
      try {
        const store = v3Store(options);
        const query = [command, ...args].join(' ').trim().toLowerCase();
        const matches: Array<{
          session_id: string;
          status: string;
          objective: string;
          updated_at: string;
          matched: string[];
        }> = [];
        if (query) {
          for (const session of listV3Sessions(store)) {
            const matched: string[] = [];
            const consider = (value: string): void => {
              if (value.toLowerCase().includes(query)) matched.push(value);
            };
            consider(session.objective);
            consider(session.definition_of_done);
            for (const step of session.chain) consider(step.command);
            const unique = [...new Set(matched)];
            if (unique.length > 0) {
              matches.push({
                session_id: session.session_id,
                status: session.status,
                objective: session.objective,
                updated_at: session.updated_at,
                matched: unique,
              });
            }
          }
        }
        matches.sort((left, right) => right.updated_at.localeCompare(left.updated_at)
          || left.session_id.localeCompare(right.session_id));
        emitV3Success({ operation: 'recall', sessionId: null, result: matches });
      } catch (error) {
        emitV3Error('recall', error, { session: options.session });
      }
    });

  addV3ReadOptions(run.command('check <run-id>').description('Check Run state and available transitions'))
    .action((runId: string, options: { session?: string; workflowRoot: string }) => {
      try {
        const { store, options: resolved } = resolveV3Options(options);
        const value = store.readRunV30(resolved.session, runId);
        const transitions: Record<RunV30['status'], string[]> = {
          pending: ['running', 'cancelled'], running: ['completed', 'failed', 'blocked', 'cancelled'],
          blocked: ['running', 'failed', 'cancelled'], completed: ['sealed'], failed: ['sealed'],
          cancelled: ['sealed'], sealed: [],
        };
        const result: Record<string, unknown> = {
          run_id: runId, status: value.status, revision: value.revision,
          available_transitions: transitions[value.status],
        };
        if (value.status === 'sealed') {
          // Sealed Runs are immutable: attach the persisted receipt without
          // re-running reconciliation (mirrors v2 checkRun's sealed branch).
          const receipt = readV3KnowledgeReconciliation(store, resolved.session, runId);
          if (receipt) result.knowledge_reconciliation = v3ReconciliationSummary(receipt);
        } else {
          const receipt = reconcileV3RunKnowledge(store.projectRoot, resolved.session, runId);
          if (receipt) {
            result.knowledge_reconciliation = v3ReconciliationSummary(receipt);
            if (receipt.counts.review_required > 0) {
              result.warnings = [
                `${receipt.counts.review_required} knowledge candidate(s) require review before promotion`,
              ];
            }
          }
        }
        emitV3Success({ operation: 'check', sessionId: resolved.session, runId, result });
      } catch (error) {
        emitV3Error('check', error, { session: options.session, runId });
      }
    });

  for (const [name, replacement] of [
    ['start', 'run next / run create'],
    ['done', 'run complete'],
    ['edit', 'session chain insert|skip|replace'],
    ['prepare', 'skills --steps'],
    ['skill', 'skills --steps'],
    ['recover', 'session resume'],
    ['status', 'session status'],
    ['log-mutation', 'session status'],
    ['mutations', 'session status'],
    ['accept-reuse', 'run brief'],
    ['recall-confirm', 'run check'],
    ['fork', 'run create'],
    ['import', 'session migrate'],
    ['new', 'run create'],
    ['rebind', 'run brief'],
    ['seal-session', 'session complete'],
  ] as const) {
    retiredV3Options(run.command(name).description('Deprecated in session/3.0'))
      .action(retiredV3Action(`run ${name}`, replacement));
  }
}
