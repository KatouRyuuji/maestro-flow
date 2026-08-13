import { resolve } from 'node:path';
import { InvalidArgumentError, type Command } from 'commander';

import {
  acceptExecutionHandoff,
  attachExecution,
  cancelExecutionHandoff,
  executionStatus,
  heartbeatExecutionLease,
  pauseExecution,
  prepareExecutionHandoff,
  recoverExecutionLease,
  releaseExecutionLease,
  resolveExecution,
  resumeExecution,
  sealExecution,
  startExecution,
} from '../run/execution.js';
import { SessionStore } from '../run/store.js';
import {
  addAuditedExecutionOptions,
  addExecutionAcquireOptions,
  addExecutionLeaseOptions,
  addExecutionLocatorOptions,
  addExecutionOutputOptions,
  addExecutionRevisionOptions,
  addExecutionSessionCasOptions,
  emitExecutionError,
  emitExecutionSuccess,
  executionLeaseClaim,
  normalizedExecutionOwner,
  parsePositiveInteger,
  prepareExecutionClaimOutput,
  printExecutionHuman,
  reportExecutionHuman,
  type AuditedExecutionOptions,
  type ExecutionAcquireOptions,
  type ExecutionLeaseOptions,
  type ExecutionLocatorOptions,
  type ExecutionOutputOptions,
  type ExecutionRevisionOptions,
  type ExecutionSessionCasOptions,
} from './execution-cli-shared.js';

type BaseOptions = ExecutionOutputOptions;
type MutationOptions = BaseOptions & ExecutionRevisionOptions;
type LeasedMutationOptions = MutationOptions & ExecutionLeaseOptions;
type AuditedMutationOptions = MutationOptions & AuditedExecutionOptions;
type AuditedLeasedMutationOptions = LeasedMutationOptions & AuditedExecutionOptions;
type AcquisitionOptions = MutationOptions & ExecutionAcquireOptions;
type AuditedAcquisitionOptions = AcquisitionOptions & AuditedExecutionOptions & ExecutionSessionCasOptions;

function auditedDomainOptions(options: AuditedExecutionOptions): AuditedExecutionOptions {
  return { actor: options.actor, reason: options.reason, evidence: [...options.evidence] };
}

function assertSessionCas(
  projectRoot: string,
  sessionId: string,
  options: ExecutionSessionCasOptions,
  requirements: { identity?: boolean; activity?: boolean },
): void {
  const session = new SessionStore(projectRoot).readBundle(sessionId).session;
  if (requirements.identity && session.identity_revision !== options.expectedIdentityRevision) {
    throw new Error(
      `session identity revision conflict: expected ${options.expectedIdentityRevision}, current ${session.identity_revision}`,
    );
  }
  if (requirements.activity && session.activity_revision !== options.expectedActivityRevision) {
    throw new Error(
      `session activity revision conflict: expected ${options.expectedActivityRevision}, current ${session.activity_revision}`,
    );
  }
}

function latestExecutionLeaseEpoch(projectRoot: string, sessionId: string, executionId: string): number {
  const store = new SessionStore(projectRoot);
  const values: unknown[] = [store.readExecution(sessionId, executionId), ...store.listExecutionTransitions(sessionId, executionId)];
  let maximum = 0;
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if ((key === 'epoch' || key === 'released_epoch' || key === 'recovered_from_epoch')
        && typeof child === 'number' && Number.isInteger(child)) {
        maximum = Math.max(maximum, child);
      }
      visit(child);
    }
  };
  values.forEach(visit);
  return maximum;
}

function assertExpectedLeaseEpoch(options: ExecutionAcquireOptions, observed: number): void {
  if (options.expectedLeaseEpoch !== observed) {
    throw new Error(`lease epoch conflict: expected ${options.expectedLeaseEpoch}, current ${observed}`);
  }
}

function prepareHumanClaimOutput(
  options: ExecutionOutputOptions,
  secretField: 'lease_claim' | 'handoff_token' = 'lease_claim',
): void {
  if (options.json) return;
  options.claimOutput = prepareExecutionClaimOutput(options.claimOutput, resolve(options.workflowRoot), secretField);
}

function handleResult(
  operation: Parameters<typeof emitExecutionSuccess>[0]['operation'],
  result: any,
  opts: BaseOptions & { requestId?: string },
  secretField?: 'lease_claim' | 'handoff_token',
): void {
  const projectRoot = resolve(opts.workflowRoot);
  if (opts.json) {
    emitExecutionSuccess({
      operation,
      result,
      projectRoot,
      execution: result.execution,
      requestId: opts.requestId,
      replay: 'transition_id' in result
        ? { replayed: Boolean(result.replayed), transition_id: result.transition_id }
        : null,
    });
  } else {
    printExecutionHuman(result, opts.claimOutput, secretField, projectRoot);
  }
}

function handleError(
  operation: Parameters<typeof emitExecutionError>[0]['operation'],
  error: unknown,
  opts: BaseOptions & Partial<ExecutionLocatorOptions & { requestId: string }>,
): void {
  if (opts.json) {
    emitExecutionError({
      operation,
      error,
      projectRoot: resolve(opts.workflowRoot),
      sessionId: opts.session,
      executionId: opts.execution,
      requestId: opts.requestId,
      ...(error instanceof InvalidArgumentError
        ? { exitCode: 2 as const, disposition: 'usage_error' as const, code: 'COMMANDER_USAGE' as const }
        : {}),
    });
  } else {
    reportExecutionHuman(error);
  }
}

export function registerExecutionCommand(program: Command): void {
  const execution = program.command('execution').description('Manage bounded Execution generations inside a Session');

  addExecutionOutputOptions(addAuditedExecutionOptions(addExecutionAcquireOptions(addExecutionSessionCasOptions(execution
    .command('start')
    .description('Start the next Execution generation and acquire its lease')
    .requiredOption('--session <id>', 'exact Session ID')
    .requiredOption('--request-id <id>', 'idempotent request ID')
    .option('--execution <id>', 'explicit Execution ID'), { identity: true, activity: true }))), true)
    .action((opts: BaseOptions & ExecutionAcquireOptions & AuditedExecutionOptions & ExecutionSessionCasOptions & {
      session: string; execution?: string; requestId: string;
    }) => {
      try {
        const projectRoot = resolve(opts.workflowRoot);
        prepareHumanClaimOutput(opts);
        assertSessionCas(projectRoot, opts.session, opts, { identity: true, activity: true });
        assertExpectedLeaseEpoch(opts, 0);
        const result = startExecution(projectRoot, opts.session, {
          executionId: opts.execution,
          requestId: opts.requestId,
          ownerId: normalizedExecutionOwner(opts),
          ownerKind: opts.ownerKind,
          ...auditedDomainOptions(opts),
          expectedIdentityRevision: opts.expectedIdentityRevision,
          expectedActivityRevision: opts.expectedActivityRevision,
          expectedLeaseEpoch: opts.expectedLeaseEpoch,
        } as Parameters<typeof startExecution>[2]);
        handleResult('execution-start', result, opts);
      } catch (error) { handleError('execution-start', error, opts); }
    });

  addExecutionOutputOptions(addExecutionAcquireOptions(addExecutionRevisionOptions(execution
    .command('attach')
    .description('Acquire an unleased open Execution'))), true)
    .action((opts: AcquisitionOptions) => {
      try {
        const projectRoot = resolve(opts.workflowRoot);
        prepareHumanClaimOutput(opts);
        assertExpectedLeaseEpoch(
          opts,
          latestExecutionLeaseEpoch(projectRoot, opts.session, opts.execution),
        );
        handleResult('execution-attach', attachExecution(projectRoot, {
          sessionId: opts.session,
          executionId: opts.execution,
          requestId: opts.requestId,
          expectedExecutionRevision: opts.expectedExecutionRevision,
          ownerId: normalizedExecutionOwner(opts),
          ownerKind: opts.ownerKind,
          expectedLeaseEpoch: opts.expectedLeaseEpoch,
        } as Parameters<typeof attachExecution>[1]), opts);
      } catch (error) { handleError('execution-attach', error, opts); }
    });

  addExecutionOutputOptions(addExecutionLocatorOptions(execution
    .command('status')
    .description('Show Execution and lease status')))
    .option('--stale-after-ms <n>', 'lease staleness threshold in milliseconds', parsePositiveInteger)
    .action((opts: BaseOptions & ExecutionLocatorOptions & { staleAfterMs?: number }) => {
      try {
        handleResult('execution-status', executionStatus(resolve(opts.workflowRoot), opts.session, opts.execution, {
          staleAfterMs: opts.staleAfterMs,
        }), opts);
      } catch (error) { handleError('execution-status', error, opts); }
    });

  addExecutionOutputOptions(addAuditedExecutionOptions(addExecutionLeaseOptions(addExecutionRevisionOptions(execution
    .command('pause')
    .description('Pause an idle active Execution and release its lease')))))
    .action((opts: AuditedLeasedMutationOptions) => {
      try {
        handleResult('execution-pause', pauseExecution(resolve(opts.workflowRoot), {
          sessionId: opts.session,
          executionId: opts.execution,
          requestId: opts.requestId,
          expectedExecutionRevision: opts.expectedExecutionRevision,
          lease: executionLeaseClaim(opts),
          ...auditedDomainOptions(opts),
        }), opts);
      } catch (error) { handleError('execution-pause', error, opts); }
    });

  addExecutionOutputOptions(addAuditedExecutionOptions(addExecutionRevisionOptions(execution
    .command('resolve')
    .description('Resolve one paused Execution blocker')
    .option('--decision <id>', 'escalated decision ID')
    .option('--step <id>', 'failed chain step ID')
    .requiredOption('--disposition <value>', 'decision: proceed|retry; step: retry|skip'))))
    .action((opts: AuditedMutationOptions & { decision?: string; step?: string; disposition: string }) => {
      try {
        if (Boolean(opts.decision) === Boolean(opts.step)) throw new Error('exactly one of --decision or --step is required');
        const target = opts.decision
          ? { kind: 'decision' as const, id: opts.decision, disposition: opts.disposition as 'proceed' | 'retry' }
          : { kind: 'step' as const, id: opts.step!, disposition: opts.disposition as 'retry' | 'skip' };
        if (target.kind === 'decision' && !['proceed', 'retry'].includes(target.disposition)) throw new Error('decision disposition must be proceed|retry');
        if (target.kind === 'step' && !['retry', 'skip'].includes(target.disposition)) throw new Error('step disposition must be retry|skip');
        handleResult('execution-resolve', resolveExecution(resolve(opts.workflowRoot), {
          sessionId: opts.session,
          executionId: opts.execution,
          requestId: opts.requestId,
          expectedExecutionRevision: opts.expectedExecutionRevision,
          target,
          ...auditedDomainOptions(opts),
        }), opts);
      } catch (error) { handleError('execution-resolve', error, opts); }
    });

  addExecutionOutputOptions(addAuditedExecutionOptions(addExecutionAcquireOptions(addExecutionSessionCasOptions(addExecutionRevisionOptions(execution
    .command('resume')
    .description('Resume a cleared paused Execution and acquire a new lease')), { activity: true }))), true)
    .action((opts: AuditedAcquisitionOptions) => {
      try {
        const projectRoot = resolve(opts.workflowRoot);
        prepareHumanClaimOutput(opts);
        assertSessionCas(projectRoot, opts.session, opts, { activity: true });
        assertExpectedLeaseEpoch(
          opts,
          latestExecutionLeaseEpoch(projectRoot, opts.session, opts.execution),
        );
        handleResult('execution-resume', resumeExecution(projectRoot, {
          sessionId: opts.session,
          executionId: opts.execution,
          requestId: opts.requestId,
          expectedExecutionRevision: opts.expectedExecutionRevision,
          ownerId: normalizedExecutionOwner(opts),
          ownerKind: opts.ownerKind,
          expectedActivityRevision: opts.expectedActivityRevision,
          expectedLeaseEpoch: opts.expectedLeaseEpoch,
          ...auditedDomainOptions(opts),
        } as Parameters<typeof resumeExecution>[1]), opts);
      } catch (error) { handleError('execution-resume', error, opts); }
    });

  addExecutionOutputOptions(addAuditedExecutionOptions(addExecutionLeaseOptions(addExecutionSessionCasOptions(addExecutionRevisionOptions(execution
    .command('seal')
    .description('Seal an Execution generation without sealing Session identity')
    .requiredOption('--outcome <value>', 'done|done_with_concerns|failed')
    .option('--summary <text>', 'human-readable Execution seal summary', '')), { activity: true }))))
    .action((opts: AuditedLeasedMutationOptions & ExecutionSessionCasOptions & { outcome: string; summary: string }) => {
      try {
        if (!['done', 'done_with_concerns', 'failed'].includes(opts.outcome)) throw new Error('outcome must be done|done_with_concerns|failed');
        const projectRoot = resolve(opts.workflowRoot);
        assertSessionCas(projectRoot, opts.session, opts, { activity: true });
        handleResult('execution-seal', sealExecution(projectRoot, {
          sessionId: opts.session,
          executionId: opts.execution,
          requestId: opts.requestId,
          expectedExecutionRevision: opts.expectedExecutionRevision,
          expectedActivityRevision: opts.expectedActivityRevision,
          lease: executionLeaseClaim(opts),
          summary: opts.summary,
          outcome: opts.outcome as 'done' | 'done_with_concerns' | 'failed',
          ...auditedDomainOptions(opts),
        }), opts);
      } catch (error) { handleError('execution-seal', error, opts); }
    });

  const handoff = execution.command('handoff').description('Transfer Execution lease ownership');

  addExecutionOutputOptions(addAuditedExecutionOptions(addExecutionLeaseOptions(addExecutionRevisionOptions(handoff
    .command('prepare')
    .description('Prepare a one-time handoff credential')
    .requiredOption('--to-owner-id <id>', 'target owner ID')))), true)
    .action((opts: AuditedLeasedMutationOptions & { toOwnerId: string }) => {
      try {
        prepareHumanClaimOutput(opts, 'handoff_token');
        handleResult('execution-handoff-prepare', prepareExecutionHandoff(resolve(opts.workflowRoot), {
          sessionId: opts.session,
          executionId: opts.execution,
          requestId: opts.requestId,
          expectedExecutionRevision: opts.expectedExecutionRevision,
          lease: executionLeaseClaim(opts),
          toOwnerId: opts.toOwnerId,
          ...auditedDomainOptions(opts),
        }), opts, 'handoff_token');
      } catch (error) { handleError('execution-handoff-prepare', error, opts); }
    });

  addExecutionOutputOptions(addAuditedExecutionOptions(addExecutionAcquireOptions(addExecutionRevisionOptions(handoff
    .command('accept')
    .description('Accept a prepared lease handoff')
    .requiredOption('--handoff-token <token>', 'private one-time handoff token')))), true)
    .action((opts: AuditedAcquisitionOptions & { handoffToken: string }) => {
      try {
        const projectRoot = resolve(opts.workflowRoot);
        prepareHumanClaimOutput(opts);
        assertExpectedLeaseEpoch(
          opts,
          latestExecutionLeaseEpoch(projectRoot, opts.session, opts.execution),
        );
        handleResult('execution-handoff-accept', acceptExecutionHandoff(projectRoot, {
          sessionId: opts.session,
          executionId: opts.execution,
          requestId: opts.requestId,
          expectedExecutionRevision: opts.expectedExecutionRevision,
          ownerId: normalizedExecutionOwner(opts),
          ownerKind: opts.ownerKind,
          handoffToken: opts.handoffToken,
          expectedLeaseEpoch: opts.expectedLeaseEpoch,
          ...auditedDomainOptions(opts),
        } as Parameters<typeof acceptExecutionHandoff>[1]), opts);
      } catch (error) { handleError('execution-handoff-accept', error, opts); }
    });

  addExecutionOutputOptions(addAuditedExecutionOptions(addExecutionLeaseOptions(addExecutionRevisionOptions(handoff
    .command('cancel')
    .description('Cancel a prepared handoff')))))
    .action((opts: AuditedLeasedMutationOptions) => {
      try {
        handleResult('execution-handoff-cancel', cancelExecutionHandoff(resolve(opts.workflowRoot), {
          sessionId: opts.session,
          executionId: opts.execution,
          requestId: opts.requestId,
          expectedExecutionRevision: opts.expectedExecutionRevision,
          lease: executionLeaseClaim(opts),
          ...auditedDomainOptions(opts),
        }), opts);
      } catch (error) { handleError('execution-handoff-cancel', error, opts); }
    });

  const lease = execution.command('lease').description('Inspect and maintain the Execution lease');

  addExecutionOutputOptions(addExecutionLocatorOptions(lease.command('status').description('Show public lease state')))
    .option('--stale-after-ms <n>', 'lease staleness threshold in milliseconds', parsePositiveInteger)
    .action((opts: BaseOptions & ExecutionLocatorOptions & { staleAfterMs?: number }) => {
      try {
        handleResult('execution-lease-status', executionStatus(resolve(opts.workflowRoot), opts.session, opts.execution, {
          staleAfterMs: opts.staleAfterMs,
        }), opts);
      } catch (error) { handleError('execution-lease-status', error, opts); }
    });

  addExecutionOutputOptions(addExecutionLeaseOptions(addExecutionRevisionOptions(lease
    .command('heartbeat')
    .description('Refresh the current lease heartbeat'))))
    .action((opts: LeasedMutationOptions) => {
      try {
        handleResult('execution-lease-heartbeat', heartbeatExecutionLease(resolve(opts.workflowRoot), {
          sessionId: opts.session,
          executionId: opts.execution,
          requestId: opts.requestId,
          expectedExecutionRevision: opts.expectedExecutionRevision,
          lease: executionLeaseClaim(opts),
        }), opts);
      } catch (error) { handleError('execution-lease-heartbeat', error, opts); }
    });

  addExecutionOutputOptions(addExecutionLeaseOptions(addExecutionRevisionOptions(lease
    .command('release')
    .description('Release the current lease'))))
    .action((opts: LeasedMutationOptions) => {
      try {
        handleResult('execution-lease-release', releaseExecutionLease(resolve(opts.workflowRoot), {
          sessionId: opts.session,
          executionId: opts.execution,
          requestId: opts.requestId,
          expectedExecutionRevision: opts.expectedExecutionRevision,
          lease: executionLeaseClaim(opts),
        }), opts);
      } catch (error) { handleError('execution-lease-release', error, opts); }
    });

  addExecutionOutputOptions(addAuditedExecutionOptions(addExecutionAcquireOptions(addExecutionRevisionOptions(lease
    .command('recover')
    .description('Replace a stale lease with a fenced higher epoch')
    .option('--stale-after-ms <n>', 'lease staleness threshold in milliseconds', parsePositiveInteger)))), true)
    .action((opts: AuditedAcquisitionOptions & { staleAfterMs?: number }) => {
      try {
        const projectRoot = resolve(opts.workflowRoot);
        prepareHumanClaimOutput(opts);
        assertExpectedLeaseEpoch(
          opts,
          latestExecutionLeaseEpoch(projectRoot, opts.session, opts.execution),
        );
        handleResult('execution-lease-recover', recoverExecutionLease(projectRoot, {
          sessionId: opts.session,
          executionId: opts.execution,
          requestId: opts.requestId,
          expectedExecutionRevision: opts.expectedExecutionRevision,
          ownerId: normalizedExecutionOwner(opts),
          ownerKind: opts.ownerKind,
          staleAfterMs: opts.staleAfterMs,
          expectedLeaseEpoch: opts.expectedLeaseEpoch,
          ...auditedDomainOptions(opts),
        } as Parameters<typeof recoverExecutionLease>[1]), opts);
      } catch (error) { handleError('execution-lease-recover', error, opts); }
    });
}
