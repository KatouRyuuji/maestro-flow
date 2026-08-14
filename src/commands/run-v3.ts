import type { Command } from 'commander';

import type { RunV30 } from '../run/schemas.js';
import { buildRetryMetadata } from '../run/v3/run-machine.js';
import {
  completeRunAndAdvance,
  createRunningRunV3,
  mutateRunV3,
  recoverSealRunV3,
} from '../run/v3/mutation-engine.js';
import {
  addV3MutationOptions,
  addV3ReadOptions,
  collectV3,
  emitV3Error,
  emitV3Success,
  mutationIdentity,
  parseV3Revision,
  resolveV3Options,
  type V3CommonOptions,
} from './v3-cli-shared.js';

type RunMutationOptions = V3CommonOptions & { run: string };

function runResult(mutation: ReturnType<typeof mutateRunV3>): unknown {
  return mutation.transition.result;
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
        emitV3Success({ operation: 'next', sessionId: resolved.session, runId: resolved.run,
          requestId: resolved.requestId, result: runResult(mutation), mutation });
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
        emitV3Success({ operation: 'create', sessionId: resolved.session, runId: resolved.run,
          requestId: resolved.requestId, result: runResult(mutation), mutation });
      } catch (error) {
        emitV3Error('create', error, { session: options.session, runId: options.run, requestId: options.requestId });
      }
    });

  addV3MutationOptions(run.command('complete <run-id>').description('Complete and seal a Run atomically'), 'run')
    .requiredOption('--summary <text>', 'completion summary')
    .option('--verdict <verdict>', 'done or done_with_concerns', 'done')
    .option('--advance', 'complete the Run and its chain step atomically')
    .requiredOption('--expected-orchestration-revision <n>', 'expected Session orchestration revision', parseV3Revision)
    .action((runId: string, options: V3CommonOptions & {
      summary: string; verdict: string; advance?: boolean;
    }) => {
      try {
        if (!options.advance) {
          throw new Error('run complete requires --advance to update the chain step atomically');
        }
        if (options.verdict !== 'done' && options.verdict !== 'done_with_concerns') {
          throw new Error('--verdict must be done or done_with_concerns');
        }
        const { store, options: resolved } = resolveV3Options(options);
        const verdict = resolved.verdict as 'done' | 'done_with_concerns';
        const mutation = completeRunAndAdvance(store, {
          ...mutationIdentity(resolved), runId,
          expectedRunRevision: resolved.expectedRunRevision!,
          expectedOrchestrationRevision: resolved.expectedOrchestrationRevision!,
          summary: resolved.summary, verdict,
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
        emitV3Success({ operation: 'check', sessionId: resolved.session, runId,
          result: { run_id: runId, status: value.status, revision: value.revision, available_transitions: transitions[value.status] } });
      } catch (error) {
        emitV3Error('check', error, { session: options.session, runId });
      }
    });
}
