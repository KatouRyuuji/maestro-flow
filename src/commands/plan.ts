import { InvalidArgumentError, type Command } from 'commander';
import { resolve } from 'node:path';

import { derivePlanPublishRequestId, publishPlan } from '../run/plan-publish.js';
import {
  createRunResponseError,
  createRunResponseSuccess,
  emitRunResponse,
  stableRunResponseErrorCode,
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
    .option('--execution-owner <owner>', 'lease execution owner')
    .option('--owner-epoch <n>', 'lease owner epoch', parseNonNegativeInteger)
    .option('--lease-id <id>', 'lease identifier for concurrency safety')
    .option('--json', 'emit one run-response/1.0 envelope on stdout')
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
      executionOwner?: string;
      ownerEpoch?: number;
      leaseId?: string;
      json?: boolean;
      workflowRoot: string;
    }) => {
      let requestId: string | null = null;
      try {
        requestId = derivePlanPublishRequestId(opts.handoffKey);
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
          executionOwner: opts.executionOwner,
          ownerEpoch: opts.ownerEpoch,
          leaseId: opts.leaseId,
        });
        if (opts.json) {
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
        } else {
          console.log(JSON.stringify(result, null, 2));
        }
      } catch (error) {
        if (opts.json) {
          emitRunResponse(createRunResponseError({
            operation: 'plan-publish',
            exit_code: 1,
            code: stableRunResponseErrorCode(error),
            message: error instanceof Error ? error.message : String(error),
            request_id: requestId,
            locator: { session_id: opts.session ?? null, run_id: null },
          }));
        } else {
          console.error(`[maestro plan] ${error instanceof Error ? error.message : String(error)}`);
          process.exitCode = 1;
        }
      }
    });
}
