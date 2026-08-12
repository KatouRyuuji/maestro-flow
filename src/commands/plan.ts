import { InvalidArgumentError, type Command } from 'commander';
import { resolve } from 'node:path';

import { derivePlanPublishRequestId, publishPlan } from '../run/plan-publish.js';
import {
  parseOwnerKind,
  readExecutionAuthority,
  type ExecutionOwnerKind,
} from './execution-cli-shared.js';
import {
  createRunResponseError,
  createRunResponseSuccess,
  emitRunResponse,
  stableRunResponseErrorCode,
  stableRunResponseErrorCodeV11,
} from '../run/response.js';

function parseNonNegativeInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new InvalidArgumentError('expected a non-negative integer');
  }
  return parsed;
}

function parsePositiveInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new InvalidArgumentError('expected a positive integer');
  }
  return parsed;
}

function collectEvidence(value: string, previous: string[] = []): string[] {
  return previous.concat(value);
}

export function registerPlanCommand(program: Command): void {
  const plan = program
    .command('plan')
    .description('Publish approved external Plans into the canonical Run artifact lifecycle');

  plan
    .command('publish <path>')
    .description('Publish approved Pi Markdown as the sealed current-plan artifact')
    .option('--source-root <path>', 'trusted containment root for the approved Plan; defaults to workflow root')
    .option('--session <id>', 'existing running Session to receive the Plan')
    .option('--intent <text>', 'intent for an automatically created Session')
    .option('--topic <text>', 'command-independent topic for an automatically created Session')
    .requiredOption('--handoff-key <key>', 'Pi approval handoff key')
    .option('--source-pi-session <id>', 'source Pi session identifier')
    .option('--plan-revision <n>', 'approved Plan revision', parsePositiveInteger)
    .option('--approved-at <timestamp>', 'approval timestamp')
    .option('--expected-identity-revision <n>', 'expected Session identity revision', parseNonNegativeInteger)
    .option('--expected-activity-revision <n>', 'expected Session activity revision', parseNonNegativeInteger)
    .option('--request-id <id>', 'idempotent Plan publication request ID')
    .option('--execution <id>', 'exact current Execution ID')
    .option('--generation <n>', 'exact current Execution generation', parsePositiveInteger)
    .option('--expected-execution-revision <n>', 'expected Execution revision', parseNonNegativeInteger)
    .option('--execution-owner <owner>', 'lease execution owner')
    .option('--owner-kind <kind>', 'Execution lease owner kind', parseOwnerKind)
    .option('--owner-epoch <n>', 'lease owner epoch', parseNonNegativeInteger)
    .option('--lease-id <id>', 'lease identifier for concurrency safety')
    .option('--actor <name>', 'authorized actor')
    .option('--reason <text>', 'audit reason')
    .option('--evidence <ref>', 'audit evidence reference (repeatable)', collectEvidence)
    .option('--json', 'emit one run-response/1.0 or Execution-aware run-response/1.1 envelope on stdout')
    .option('--workflow-root <path>', 'project root containing .workflow', process.cwd())
    .action((sourcePath: string, opts: {
      session?: string;
      sourceRoot?: string;
      intent?: string;
      topic?: string;
      handoffKey: string;
      sourcePiSession?: string;
      planRevision?: number;
      approvedAt?: string;
      expectedIdentityRevision?: number;
      expectedActivityRevision?: number;
      requestId?: string;
      execution?: string;
      generation?: number;
      expectedExecutionRevision?: number;
      executionOwner?: string;
      ownerKind?: ExecutionOwnerKind;
      ownerEpoch?: number;
      leaseId?: string;
      actor?: string;
      reason?: string;
      evidence?: string[];
      json?: boolean;
      workflowRoot: string;
    }) => {
      let requestId: string | null = null;
      try {
        requestId = opts.requestId?.trim() || derivePlanPublishRequestId(opts.handoffKey);
        const result = publishPlan({
          projectRoot: resolve(opts.workflowRoot),
          sourcePath,
          sourceRoot: opts.sourceRoot ? resolve(opts.sourceRoot) : undefined,
          sessionId: opts.session,
          intent: opts.intent,
          topic: opts.topic,
          handoffKey: opts.handoffKey,
          sourcePiSession: opts.sourcePiSession,
          planRevision: opts.planRevision,
          approvedAt: opts.approvedAt,
          expectedIdentityRevision: opts.expectedIdentityRevision,
          expectedActivityRevision: opts.expectedActivityRevision,
          requestId: opts.requestId,
          executionId: opts.execution,
          generation: opts.generation,
          expectedExecutionRevision: opts.expectedExecutionRevision,
          executionOwner: opts.executionOwner,
          ownerKind: opts.ownerKind,
          ownerEpoch: opts.ownerEpoch,
          leaseId: opts.leaseId,
          actor: opts.actor,
          reason: opts.reason,
          evidence: opts.evidence,
        });
        if (opts.json) {
          if (result.schema_version === 'plan-publish-result/1.1') {
            emitRunResponse(createRunResponseSuccess({
              schema_version: 'run-response/1.1',
              operation: 'plan-publish',
              result,
              request_id: result.request_id,
              locator: {
                session_id: result.session_id,
                execution_id: result.execution_id,
                generation: result.generation,
                run_id: result.run_id,
              },
              fence: {
                session_identity_revision: result.session_identity_revision,
                session_activity_revision: result.session_activity_revision,
                execution_revision: result.execution_revision,
                lease_epoch: result.lease_epoch,
              },
              replay: {
                status: result.transition.status,
                transition_id: result.transition.transition_id,
              },
              next: {
                suggest_only: true,
                command: result.next.command,
                reason: result.next.reason,
              },
            }));
          } else {
            emitRunResponse(createRunResponseSuccess({
              operation: 'plan-publish',
              result,
              request_id: result.request_id,
              locator: { session_id: result.session_id, run_id: result.run_id },
              replay: {
                status: result.transition.status,
                transition_id: result.transition.transition_id,
              },
              next: {
                suggest_only: true,
                command: result.next.command,
                reason: result.next.reason,
              },
            }));
          }
        } else {
          console.log(JSON.stringify(result, null, 2));
        }
      } catch (error) {
        if (opts.json) {
          const executionAttempt = opts.execution !== undefined
            || opts.generation !== undefined
            || opts.expectedExecutionRevision !== undefined
            || opts.ownerKind !== undefined;
          if (executionAttempt) {
            const authority = opts.session && opts.execution
              ? readExecutionAuthority(resolve(opts.workflowRoot), opts.session, opts.execution)
              : null;
            emitRunResponse(createRunResponseError({
              schema_version: 'run-response/1.1',
              operation: 'plan-publish',
              exit_code: 1,
              disposition: 'domain_error',
              code: stableRunResponseErrorCodeV11(error),
              message: error instanceof Error ? error.message : String(error),
              request_id: requestId,
              locator: authority?.locator ?? {
                session_id: opts.session ?? null,
                execution_id: opts.execution ?? null,
                generation: opts.generation ?? null,
                run_id: null,
              },
              fence: authority?.fence ?? null,
            }));
          } else {
            emitRunResponse(createRunResponseError({
              operation: 'plan-publish',
              exit_code: 1,
              code: stableRunResponseErrorCode(error),
              message: error instanceof Error ? error.message : String(error),
              request_id: requestId,
              locator: { session_id: opts.session ?? null, run_id: null },
            }));
          }
        } else {
          console.error(`[maestro plan] ${error instanceof Error ? error.message : String(error)}`);
          process.exitCode = 1;
        }
      }
    });
}
