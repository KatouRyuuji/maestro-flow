import { createHash } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';

import { readVerifiedContainedFile } from './artifacts.js';
import { createChainSession, type ChainDefinition } from './chain-admin.js';
import { bootstrapExecutionChain } from './execution.js';
import {
  assertExecutionLease,
  checkLease,
  hashExecutionLeaseId,
  type ExecutionLeaseClaim,
  type LeaseClaim,
} from './lease.js';
import {
  completeExecutionRun,
  completeRun,
  createExecutionRun,
  createRun,
  type CompleteNextSuggestion,
  type CompleteRunResult,
} from './runtime.js';
import type { CommandRun, CommandRunV14, SessionState } from './schemas.js';
import type { PersistedTransitionRecord, PersistedTransitionRecordV11 } from './protocol-schemas.js';
import { SessionStore, SessionStoreLock } from './store.js';
import { createTopicIdentity, sameTopicIdentity } from './topic-identity.js';
import {
  stableJsonUtf8,
  transitionMutationReceipt,
  TransitionReceiptError,
  validatePersistedTransitionRecord,
  type TransitionMutationReceipt,
} from './transition-receipts.js';

const PLAN_PUBLISH_COMMAND = 'plan-publish';
const PLAN_PUBLISH_INPUT_VERSION = 'plan-publish-input/1.0';
const PLAN_PUBLISH_EXECUTION_INPUT_VERSION = 'plan-publish-input/1.1';

const storedLeaseSchema = z.object({
  execution_owner: z.string().min(1).nullable(),
  owner_epoch: z.number().int().nonnegative().nullable(),
  lease_id: z.string().min(1).nullable(),
}).strict();

export const planPublishRunInputSchema = z.object({
  schema_version: z.literal(PLAN_PUBLISH_INPUT_VERSION),
  request_id: z.string().min(1),
  handoff_key: z.string().min(1),
  source_checksum: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  source_pi_session: z.string().min(1).nullable(),
  plan_revision: z.number().int().positive(),
  approved_at: z.string().min(1),
  expected_identity_revision: z.number().int().nonnegative(),
  expected_activity_revision: z.number().int().nonnegative(),
  lease: storedLeaseSchema,
}).strict();

const executionOwnerKindSchema = z.enum(['pi', 'claude', 'codex', 'agy', 'manual']);

export const planPublishExecutionRunInputSchema = planPublishRunInputSchema
  .omit({ schema_version: true, lease: true })
  .extend({
    schema_version: z.literal(PLAN_PUBLISH_EXECUTION_INPUT_VERSION),
    execution: z.object({
      execution_id: z.string().min(1),
      generation: z.number().int().positive(),
      expected_revision: z.number().int().nonnegative(),
    }).strict(),
    claim: z.object({
      owner_id: z.string().min(1),
      owner_kind: executionOwnerKindSchema,
      epoch: z.number().int().positive(),
      lease_id_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    }).strict(),
    audit: z.object({
      actor: z.string().min(1),
      reason: z.string().min(1),
      evidence: z.array(z.string().min(1)).min(1),
    }).strict(),
  })
  .strict();

export const planPublishInputReadSchema = z.union([
  planPublishExecutionRunInputSchema,
  planPublishRunInputSchema,
]);

export type LegacyPlanPublishRunInput = z.infer<typeof planPublishRunInputSchema>;
export type ExecutionPlanPublishRunInput = z.infer<typeof planPublishExecutionRunInputSchema>;
export type PlanPublishRunInput = z.infer<typeof planPublishInputReadSchema>;

export interface PublishPlanOptions {
  projectRoot: string;
  sourcePath: string;
  sourceRoot?: string;
  sessionId?: string;
  intent?: string;
  topic?: string;
  handoffKey: string;
  sourcePiSession?: string;
  planRevision?: number;
  approvedAt?: string;
  expectedIdentityRevision?: number;
  expectedActivityRevision?: number;
  requestId?: string;
  executionId?: string;
  generation?: number;
  expectedExecutionRevision?: number;
  executionOwner?: string;
  ownerKind?: z.infer<typeof executionOwnerKindSchema>;
  ownerEpoch?: number;
  leaseId?: string;
  actor?: string;
  reason?: string;
  evidence?: string[];
}

export interface PublishPlanHooks {
  afterExecutionChainBootstrapped?: (target: {
    sessionId: string;
    executionId: string;
    transitionId: string;
  }) => void;
  afterRunCreated?: (target: { sessionId: string; runId: string }) => void;
}

export interface LegacyPublishPlanResult {
  schema_version: 'plan-publish-result/1.0';
  session_id: string;
  run_id: string;
  artifact_id: string;
  artifact_path: string;
  handoff_key: string;
  source_checksum: string;
  request_id: string;
  created_session: boolean;
  replayed: boolean;
  transition: TransitionMutationReceipt;
  next: CompleteNextSuggestion;
}

export interface ExecutionPublishPlanResult extends Omit<LegacyPublishPlanResult, 'schema_version'> {
  schema_version: 'plan-publish-result/1.1';
  execution_id: string;
  generation: number;
  execution_revision: number;
  session_identity_revision: number;
  session_activity_revision: number;
  lease_epoch: number;
  claim: {
    owner_id: string;
    owner_kind: z.infer<typeof executionOwnerKindSchema>;
    epoch: number;
    lease_id_hash: string;
  };
}

export type PublishPlanResult = LegacyPublishPlanResult | ExecutionPublishPlanResult;

type ExistingAttempt = {
  kind: 'complete' | 'dangling';
  sessionId: string;
  runId: string;
  run: CommandRun | CommandRunV14;
  record?: PersistedTransitionRecord;
  executionRecord?: PersistedTransitionRecordV11;
  executionId?: string;
};

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function nonEmpty(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} must be non-empty`);
  return normalized;
}

function optionalNonEmpty(value: string | undefined, label: string): string | undefined {
  return value === undefined ? undefined : nonEmpty(value, label);
}

function optionalRevision(value: number | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer`);
  return value;
}

function planRevision(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < 1) throw new Error('--plan-revision must be a positive integer');
  return value;
}

function approvedAt(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = nonEmpty(value, '--approved-at');
  if (!Number.isFinite(Date.parse(normalized))) throw new Error('--approved-at must be a valid timestamp');
  return normalized;
}

export function derivePlanPublishRequestId(handoffKey: string): string {
  return `req_plan_publish_${sha256(nonEmpty(handoffKey, '--handoff-key')).slice(0, 32)}`;
}

function executionBootstrapRequestId(requestId: string): string {
  return `${requestId}__bootstrap`;
}

function executionCreateRequestId(requestId: string): string {
  return `${requestId}__allocate`;
}

function executionCompleteRequestId(requestId: string): string {
  return `${requestId}__complete`;
}

function positiveInteger(value: number | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < 1) throw new Error(`${label} must be a positive integer`);
  return value;
}

function executionAuthorityWasSupplied(options: PublishPlanOptions): boolean {
  return [
    options.executionId,
    options.generation,
    options.expectedExecutionRevision,
    options.ownerKind,
    options.actor,
    options.reason,
    options.evidence,
  ].some(value => value !== undefined);
}

function executionAuthority(options: PublishPlanOptions): {
  executionId: string;
  generation: number;
  expectedExecutionRevision: number;
  lease: ExecutionLeaseClaim;
  actor: string;
  reason: string;
  evidence: string[];
} {
  const executionId = optionalNonEmpty(options.executionId, '--execution');
  const generation = positiveInteger(options.generation, '--generation');
  const expectedExecutionRevision = optionalRevision(
    options.expectedExecutionRevision,
    '--expected-execution-revision',
  );
  const ownerId = optionalNonEmpty(options.executionOwner, '--execution-owner');
  const ownerKind = options.ownerKind;
  const epoch = positiveInteger(options.ownerEpoch, '--owner-epoch');
  const leaseId = optionalNonEmpty(options.leaseId, '--lease-id');
  const actor = optionalNonEmpty(options.actor, '--actor');
  const reason = optionalNonEmpty(options.reason, '--reason');
  const evidence = options.evidence?.map(item => nonEmpty(item, '--evidence')) ?? [];
  const missing = [
    [executionId, '--execution'],
    [generation, '--generation'],
    [expectedExecutionRevision, '--expected-execution-revision'],
    [ownerId, '--execution-owner'],
    [ownerKind, '--owner-kind'],
    [epoch, '--owner-epoch'],
    [leaseId, '--lease-id'],
    [actor, '--actor'],
    [reason, '--reason'],
    [evidence.length > 0 ? evidence : undefined, '--evidence'],
  ].filter(([value]) => value === undefined).map(([, label]) => label);
  if (missing.length > 0) {
    throw new Error(`Execution-aware plan publish requires ${missing.join(', ')}`);
  }
  return {
    executionId: executionId!,
    generation: generation!,
    expectedExecutionRevision: expectedExecutionRevision!,
    lease: {
      ownerId: ownerId!,
      ownerKind: ownerKind!,
      epoch: epoch!,
      leaseId: leaseId!,
    },
    actor: actor!,
    reason: reason!,
    evidence,
  };
}

function automaticSessionId(requestId: string): string {
  const digest = sha256(requestId);
  const numericTail = [...digest.slice(0, 14)]
    .map(character => String(Number.parseInt(character, 16) % 10))
    .join('');
  return `plan-publish-${digest.slice(0, 16)}-${numericTail}`;
}

function leaseWasSupplied(options: PublishPlanOptions): boolean {
  return options.executionOwner !== undefined
    || options.ownerEpoch !== undefined
    || options.leaseId !== undefined;
}

function storedLease(options: PublishPlanOptions): LegacyPlanPublishRunInput['lease'] {
  const supplied = [options.executionOwner, options.ownerEpoch, options.leaseId]
    .filter(value => value !== undefined).length;
  if (supplied !== 0 && supplied !== 3) {
    throw new Error('lease claim requires --execution-owner, --owner-epoch, and --lease-id together');
  }
  return storedLeaseSchema.parse({
    execution_owner: optionalNonEmpty(options.executionOwner, '--execution-owner') ?? null,
    owner_epoch: optionalRevision(options.ownerEpoch, '--owner-epoch') ?? null,
    lease_id: optionalNonEmpty(options.leaseId, '--lease-id') ?? null,
  });
}

function leaseClaim(value: LegacyPlanPublishRunInput['lease']): LeaseClaim {
  return {
    ...(value.execution_owner ? { executionOwner: value.execution_owner } : {}),
    ...(value.owner_epoch !== null ? { ownerEpoch: value.owner_epoch } : {}),
    ...(value.lease_id ? { leaseId: value.lease_id } : {}),
  };
}

function readRunInput(run: CommandRun | CommandRunV14): PlanPublishRunInput {
  if (run.command.name !== PLAN_PUBLISH_COMMAND || run.input.args.length !== 1) {
    throw new TransitionReceiptError(
      'INVALID_TRANSITION_RECEIPT',
      `Run ${run.run_id} is not a canonical ${PLAN_PUBLISH_COMMAND} Run`,
    );
  }
  try {
    return planPublishInputReadSchema.parse(JSON.parse(run.input.args[0]));
  } catch (error) {
    throw new TransitionReceiptError(
      'INVALID_TRANSITION_RECEIPT',
      `Run ${run.run_id} has invalid plan publish input: ${(error as Error).message}`,
    );
  }
}

function locateExistingAttempt(
  store: SessionStore,
  requestId: string,
  requestedSessionId?: string,
): ExistingAttempt | null {
  const attempts: ExistingAttempt[] = [];
  for (const candidate of store.listSessions().candidates) {
    const bundle = store.readBundle(candidate.sessionId);
    for (const request of bundle.session.requests.filter(item => item.request_id === requestId)) {
      if (request.type !== 'transition' || !('outcome' in request)) {
        throw new TransitionReceiptError(
          'REQUEST_CONFLICT',
          `request_id ${requestId} was already used by a non-transition request`,
        );
      }
      const record = validatePersistedTransitionRecord(request);
      if (record.payload.operation !== 'complete' || !record.payload.subject.run_id) {
        throw new TransitionReceiptError(
          'REQUEST_CONFLICT',
          `request_id ${requestId} was already used for ${record.payload.operation}`,
        );
      }
      const run = store.readRun(candidate.sessionId, record.payload.subject.run_id);
      if (run.command.name !== PLAN_PUBLISH_COMMAND) {
        throw new TransitionReceiptError(
          'REQUEST_CONFLICT',
          `request_id ${requestId} completed unrelated Run ${run.run_id}`,
        );
      }
      attempts.push({
        kind: 'complete',
        sessionId: candidate.sessionId,
        runId: run.run_id,
        run,
        record,
      });
    }

    for (const execution of store.listExecutions(candidate.sessionId)) {
      const record = store.readExecutionTransition(
        candidate.sessionId,
        execution.execution_id,
        executionCompleteRequestId(requestId),
      );
      if (!record) continue;
      if (record.payload.operation !== 'complete' || !record.payload.subject.run_id) {
        throw new TransitionReceiptError(
          'REQUEST_CONFLICT',
          `request_id ${requestId} was already used for ${record.payload.operation}`,
        );
      }
      const run = store.readExecutionRun(candidate.sessionId, record.payload.subject.run_id);
      if (run.command.name !== PLAN_PUBLISH_COMMAND) {
        throw new TransitionReceiptError(
          'REQUEST_CONFLICT',
          `request_id ${requestId} completed unrelated Execution Run ${run.run_id}`,
        );
      }
      if (!attempts.some(item => item.sessionId === candidate.sessionId && item.runId === run.run_id)) {
        attempts.push({
          kind: 'complete',
          sessionId: candidate.sessionId,
          runId: run.run_id,
          run,
          executionRecord: record,
          executionId: execution.execution_id,
        });
      }
      if (execution.active_run_id) {
        const active = store.readExecutionRun(candidate.sessionId, execution.active_run_id);
        if (active.creation_decision?.request_id === requestId
          && !attempts.some(item => item.sessionId === candidate.sessionId && item.runId === active.run_id)) {
          if (active.command.name !== PLAN_PUBLISH_COMMAND) {
            throw new TransitionReceiptError(
              'REQUEST_CONFLICT',
              `request_id ${requestId} allocated unrelated active Execution Run ${active.run_id}`,
            );
          }
          attempts.push({
            kind: 'dangling',
            sessionId: candidate.sessionId,
            runId: active.run_id,
            run: active,
            executionId: execution.execution_id,
          });
        }
      }
    }

    if (store.readSessionRecord(candidate.sessionId).schema_version !== 'session/2.0'
      && bundle.session.active_run_id) {
      const run = store.readRun(candidate.sessionId, bundle.session.active_run_id);
      if (run.creation_decision?.request_id === requestId) {
        if (run.command.name !== PLAN_PUBLISH_COMMAND) {
          throw new TransitionReceiptError(
            'REQUEST_CONFLICT',
            `request_id ${requestId} allocated unrelated active Run ${run.run_id}`,
          );
        }
        if (!attempts.some(item => item.sessionId === candidate.sessionId && item.runId === run.run_id)) {
          attempts.push({
            kind: 'dangling',
            sessionId: candidate.sessionId,
            runId: run.run_id,
            run,
          });
        }
      }
    }
  }
  if (attempts.length > 1) {
    throw new TransitionReceiptError(
      'REQUEST_CONFLICT',
      `request_id ${requestId} identifies multiple plan publish Runs`,
    );
  }
  const attempt = attempts[0] ?? null;
  if (attempt && requestedSessionId && attempt.sessionId !== requestedSessionId) {
    throw new TransitionReceiptError(
      'REQUEST_CONFLICT',
      `request_id ${requestId} belongs to Session ${attempt.sessionId}, not ${requestedSessionId}`,
    );
  }
  return attempt;
}

function assertStoredRequest(
  stored: PlanPublishRunInput,
  options: PublishPlanOptions,
  requestId: string,
  handoffKey: string,
  sourceChecksum: string,
): void {
  const explicitRequestId = optionalNonEmpty(options.requestId, '--request-id');
  if (explicitRequestId !== undefined && explicitRequestId !== stored.request_id) {
    throw new TransitionReceiptError('REQUEST_CONFLICT', 'request id changed for this publish request');
  }
  if (stored.request_id !== requestId || stored.handoff_key !== handoffKey) {
    throw new TransitionReceiptError(
      'REQUEST_CONFLICT',
      `request_id ${requestId} was already used for another plan approval`,
    );
  }
  if (stored.source_checksum !== sourceChecksum) {
    throw new TransitionReceiptError(
      'FENCE_CONFLICT',
      `approved Plan source bytes changed for handoff key ${handoffKey}`,
    );
  }
  const explicitSourceSession = optionalNonEmpty(options.sourcePiSession, '--source-pi-session');
  if (explicitSourceSession !== undefined && explicitSourceSession !== stored.source_pi_session) {
    throw new TransitionReceiptError('REQUEST_CONFLICT', 'source Pi session changed for this publish request');
  }
  const explicitPlanRevision = planRevision(options.planRevision);
  if (explicitPlanRevision !== undefined && explicitPlanRevision !== stored.plan_revision) {
    throw new TransitionReceiptError('REQUEST_CONFLICT', 'plan revision changed for this publish request');
  }
  const explicitApprovedAt = approvedAt(options.approvedAt);
  if (explicitApprovedAt !== undefined && explicitApprovedAt !== stored.approved_at) {
    throw new TransitionReceiptError('REQUEST_CONFLICT', 'approval timestamp changed for this publish request');
  }
  const explicitIdentityRevision = optionalRevision(
    options.expectedIdentityRevision,
    '--expected-identity-revision',
  );
  if (explicitIdentityRevision !== undefined
    && explicitIdentityRevision !== stored.expected_identity_revision) {
    throw new TransitionReceiptError(
      'FENCE_CONFLICT',
      `stale identity revision: expected ${explicitIdentityRevision}, original publish used ${stored.expected_identity_revision}`,
    );
  }
  const explicitActivityRevision = optionalRevision(
    options.expectedActivityRevision,
    '--expected-activity-revision',
  );
  if (stored.schema_version === PLAN_PUBLISH_INPUT_VERSION
    && explicitActivityRevision !== undefined
    && explicitActivityRevision !== stored.expected_activity_revision) {
    throw new TransitionReceiptError(
      'FENCE_CONFLICT',
      `stale activity revision: expected ${explicitActivityRevision}, original publish used ${stored.expected_activity_revision}`,
    );
  }
  if (stored.schema_version === PLAN_PUBLISH_INPUT_VERSION) {
    if (executionAuthorityWasSupplied(options)) {
      throw new TransitionReceiptError('REQUEST_CONFLICT', 'legacy publish cannot replay with Execution authority');
    }
    if (leaseWasSupplied(options)
      && stableJsonUtf8(storedLease(options)) !== stableJsonUtf8(stored.lease)) {
      throw new TransitionReceiptError('REQUEST_CONFLICT', 'lease claim changed for this publish request');
    }
    return;
  }

  if (!executionAuthorityWasSupplied(options)) {
    throw new TransitionReceiptError('REQUEST_CONFLICT', 'Execution authority is required to replay this publish request');
  }
  const authority = executionAuthority(options);
  const supplied = {
    execution: {
      execution_id: authority.executionId,
      generation: authority.generation,
    },
    claim: {
      owner_id: authority.lease.ownerId,
      owner_kind: authority.lease.ownerKind,
      epoch: authority.lease.epoch,
      lease_id_hash: hashExecutionLeaseId(authority.lease.leaseId),
    },
    audit: {
      actor: authority.actor,
      reason: authority.reason,
      evidence: authority.evidence,
    },
  };
  if (stableJsonUtf8(supplied) !== stableJsonUtf8({
    execution: {
      execution_id: stored.execution.execution_id,
      generation: stored.execution.generation,
    },
    claim: stored.claim,
    audit: stored.audit,
  })) {
    throw new TransitionReceiptError('REQUEST_CONFLICT', 'Execution authority or audit changed for this publish request');
  }
}

function assertTargetSession(
  session: SessionState,
  allowedActiveRunId: string | null,
  claim: LeaseClaim,
): void {
  if (session.status !== 'running') {
    throw Object.assign(
      new Error(`Session ${session.session_id} is ${session.status}; plan publish requires a running Session`),
      { code: 'SESSION_NOT_RUNNING' },
    );
  }
  if (session.active_run_id && session.active_run_id !== allowedActiveRunId) {
    throw Object.assign(
      new Error(`Session ${session.session_id} already has unrelated active Run ${session.active_run_id}`),
      { code: 'RUNNING_STEP' },
    );
  }
  if (claim.executionOwner && !session.orchestration.lease?.owner) {
    throw new Error(`Session ${session.session_id} has no active lease to verify`);
  }
  const conflict = checkLease(session.orchestration.lease, claim);
  if (conflict) throw new Error(conflict);
}

function assertTargetExecution(
  store: SessionStore,
  sessionId: string,
  input: ExecutionPlanPublishRunInput,
  claim: ExecutionLeaseClaim,
  allowedActiveRunId: string | null,
  expectedExecutionRevision: number,
  expectedActivityRevision: number,
): void {
  const record = store.readSessionRecord(sessionId);
  if (record.schema_version !== 'session/2.0') {
    throw new Error(`Session ${sessionId} is ${record.schema_version}; Execution-aware plan publish requires session/2.0`);
  }
  if (record.current_execution_id !== input.execution.execution_id) {
    throw new Error(
      `Session ${sessionId} current Execution is ${record.current_execution_id ?? '<none>'}; `
      + `expected ${input.execution.execution_id}`,
    );
  }
  if (record.identity_revision !== input.expected_identity_revision) {
    throw new TransitionReceiptError(
      'FENCE_CONFLICT',
      `stale identity revision: expected ${input.expected_identity_revision}, current ${record.identity_revision}`,
    );
  }
  if (record.activity_revision !== expectedActivityRevision) {
    throw new TransitionReceiptError(
      'FENCE_CONFLICT',
      `stale activity revision: expected ${expectedActivityRevision}, current ${record.activity_revision}`,
    );
  }
  const execution = store.readExecution(sessionId, input.execution.execution_id);
  if (execution.generation !== input.execution.generation) {
    throw new Error(
      `Execution generation conflict: expected ${input.execution.generation}, current ${execution.generation}`,
    );
  }
  if (execution.revision !== expectedExecutionRevision) {
    throw new Error(
      `execution revision conflict: expected ${expectedExecutionRevision}, current ${execution.revision}`,
    );
  }
  if (execution.status !== 'active') {
    throw new Error(`Execution ${execution.execution_id} is ${execution.status}; plan publish requires active`);
  }
  if (execution.active_run_id !== allowedActiveRunId) {
    throw new Error(
      `Execution ${execution.execution_id} has active Run ${execution.active_run_id ?? '<none>'}; `
      + `expected ${allowedActiveRunId ?? '<none>'}`,
    );
  }
  assertExecutionLease(execution.lease, claim);
  if (allowedActiveRunId === null
    && !execution.chain.some(step => step.command === 'execute' && step.status === 'pending')) {
    throw new Error(`Execution ${execution.execution_id} has no pending execute step for approved Plan publication`);
  }
}

function automaticChain(intent: string): ChainDefinition {
  return {
    intent,
    engine: 'manual',
    steps: [{ command: 'execute' }, { command: 'verify' }],
  };
}

function ensureAutomaticSession(
  store: SessionStore,
  requestId: string,
  intent: string,
  topic: string,
): { sessionId: string; created: boolean } {
  const sessionId = automaticSessionId(requestId);
  if (!store.sessionExists(sessionId)) {
    const created = createChainSession(store.projectRoot, sessionId, {
      intent,
      engine: 'manual',
      definition: automaticChain(intent),
    });
    store.update(sessionId, draft => {
      draft.session.topic_identity = createTopicIdentity(store.projectRoot, topic);
      draft.session.identity_revision++;
    });
    return { sessionId: created.sessionId, created: true };
  }

  const session = store.readBundle(sessionId).session;
  const expectedTopic = createTopicIdentity(store.projectRoot, topic);
  const isRecoverableShell = session.intent === intent
    && session.topic_identity !== null
    && sameTopicIdentity(session.topic_identity, expectedTopic)
    && session.orchestration.engine === 'manual'
    && session.orchestration.chain.length === 2
    && session.orchestration.chain.every((step, index) => (
      step.command === (index === 0 ? 'execute' : 'verify')
      && step.status === 'pending'
      && step.run_id === null
    ));
  if (!isRecoverableShell) {
    throw new TransitionReceiptError(
      'REQUEST_CONFLICT',
      `automatic Session ${sessionId} already exists with unrelated authority`,
    );
  }
  return { sessionId, created: false };
}

function publishArtifactBytes(input: PlanPublishRunInput, markdown: string): Buffer {
  return Buffer.from(`${JSON.stringify({
    _meta: {
      kind: 'plan',
      schema: 'plan/1.0',
      role: 'primary',
      alias: 'current-plan',
    },
    source_format: 'pi-markdown',
    handoff_key: input.handoff_key,
    source_checksum: input.source_checksum,
    source_pi_session: input.source_pi_session,
    revision: input.plan_revision,
    approved_at: input.approved_at,
    markdown,
  }, null, 2)}\n`, 'utf8');
}

function ensurePlanOutput(runDir: string, bytes: Buffer): void {
  const outputPath = join(runDir, 'outputs', 'plan.json');
  if (!existsSync(outputPath)) {
    try {
      writeFileSync(outputPath, bytes, { flag: 'wx' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  const verified = readVerifiedContainedFile(runDir, outputPath);
  if (!verified.data.equals(bytes)) {
    throw new TransitionReceiptError(
      'FENCE_CONFLICT',
      `dangling plan publish output differs from the approved source: ${outputPath}`,
    );
  }
}

function normalizeExistingInput(
  attempt: ExistingAttempt,
  options: PublishPlanOptions,
  requestId: string,
  handoffKey: string,
  sourceChecksum: string,
): PlanPublishRunInput {
  const input = readRunInput(attempt.run);
  if (attempt.run.creation_decision?.request_id !== requestId) {
    throw new TransitionReceiptError(
      'INVALID_TRANSITION_RECEIPT',
      `Run ${attempt.runId} creation decision does not bind request ${requestId}`,
    );
  }
  assertStoredRequest(input, options, requestId, handoffKey, sourceChecksum);
  return input;
}

function replayedCompletion(attempt: ExistingAttempt): CompleteRunResult {
  if (attempt.kind !== 'complete' || !attempt.record) {
    throw new Error(`plan publish attempt ${attempt.runId} has no completed transition receipt`);
  }
  const value = structuredClone(attempt.record.outcome.result.value) as Omit<CompleteRunResult, 'transition'>;
  return {
    ...value,
    transition: transitionMutationReceipt(attempt.record.payload, attempt.record.outcome, true),
  };
}

function replayedExecutionCompletion(attempt: ExistingAttempt): CompleteRunResult {
  if (attempt.kind !== 'complete' || !attempt.executionRecord) {
    throw new Error(`plan publish attempt ${attempt.runId} has no completed Execution transition receipt`);
  }
  const value = structuredClone(attempt.executionRecord.outcome.result.value) as Omit<CompleteRunResult, 'transition'>;
  return {
    ...value,
    transition: {
      request_id: attempt.executionRecord.request_id,
      transition_id: attempt.executionRecord.outcome.transition_id,
      status: 'replayed',
    },
  };
}

function publishedResult(
  store: SessionStore,
  input: PlanPublishRunInput,
  completed: CompleteRunResult,
  createdSession: boolean,
): PublishPlanResult {
  if (!completed.sealed || !completed.primary_artifact_id || !completed.next_action) {
    throw new Error(`plan publish Run ${completed.run_id} did not seal a primary artifact with a next action`);
  }
  const artifact = store.readBundle(completed.session_id).artifacts.artifacts[completed.primary_artifact_id];
  if (!artifact) throw new Error(`published artifact is missing: ${completed.primary_artifact_id}`);
  if (artifact.producer_run_id !== completed.run_id
    || (artifact.status !== 'sealed' && artifact.status !== 'superseded')) {
    throw new TransitionReceiptError(
      'INVALID_TRANSITION_RECEIPT',
      `published artifact ${completed.primary_artifact_id} is not retained by Run ${completed.run_id}`,
    );
  }
  const producer = store.readRun(completed.session_id, completed.run_id);
  if (producer.status !== 'sealed' || producer.output.primary_artifact_id !== completed.primary_artifact_id) {
    throw new TransitionReceiptError(
      'INVALID_TRANSITION_RECEIPT',
      `plan publish Run ${completed.run_id} does not own primary artifact ${completed.primary_artifact_id}`,
    );
  }
  const artifactFile = readVerifiedContainedFile(
    store.workflowRoot,
    join(store.workflowRoot, 'sessions', completed.session_id, artifact.relative_path),
  );
  if (artifactFile.contentHash !== artifact.content_hash) {
    throw new TransitionReceiptError(
      'FENCE_CONFLICT',
      `published artifact bytes changed: ${completed.primary_artifact_id}`,
    );
  }
  const base: Omit<LegacyPublishPlanResult, 'schema_version'> = {
    session_id: completed.session_id,
    run_id: completed.run_id,
    artifact_id: completed.primary_artifact_id,
    artifact_path: `sessions/${completed.session_id}/${artifact.relative_path}`,
    handoff_key: input.handoff_key,
    source_checksum: input.source_checksum,
    request_id: input.request_id,
    created_session: createdSession,
    replayed: completed.transition.status === 'replayed',
    transition: completed.transition,
    next: completed.next_action,
  };
  if (input.schema_version === PLAN_PUBLISH_INPUT_VERSION) {
    return { schema_version: 'plan-publish-result/1.0', ...base };
  }
  const execution = store.readExecution(completed.session_id, input.execution.execution_id);
  if (execution.generation !== input.execution.generation || !execution.lease) {
    throw new TransitionReceiptError(
      'INVALID_TRANSITION_RECEIPT',
      `published Plan Execution authority changed for ${input.execution.execution_id}`,
    );
  }
  const session = store.readBundle(completed.session_id).session;
  return {
    schema_version: 'plan-publish-result/1.1',
    ...base,
    execution_id: execution.execution_id,
    generation: execution.generation,
    execution_revision: execution.revision,
    session_identity_revision: session.identity_revision,
    session_activity_revision: session.activity_revision,
    lease_epoch: execution.lease.epoch,
    claim: input.claim,
  };
}

function publishPlanLocked(
  options: PublishPlanOptions,
  hooks: PublishPlanHooks = {},
): PublishPlanResult {
  const projectRoot = resolve(options.projectRoot);
  const handoffKey = nonEmpty(options.handoffKey, '--handoff-key');
  const requestId = optionalNonEmpty(options.requestId, '--request-id') ?? derivePlanPublishRequestId(handoffKey);
  const requestedSessionId = optionalNonEmpty(options.sessionId, '--session');
  const sourceRoot = resolve(options.sourceRoot ?? projectRoot);
  const source = readVerifiedContainedFile(sourceRoot, options.sourcePath);
  let markdown: string;
  try {
    markdown = new TextDecoder('utf-8', { fatal: true }).decode(source.data);
  } catch {
    throw new Error('approved Plan source must be valid UTF-8 Markdown');
  }
  const sourceChecksum = `sha256:${source.contentHash}`;
  const store = new SessionStore(projectRoot);
  if (requestedSessionId && !store.sessionExists(requestedSessionId)) {
    throw Object.assign(new Error(`Session not found: ${requestedSessionId}`), { code: 'SESSION_NOT_FOUND' });
  }

  const attempt = locateExistingAttempt(store, requestId, requestedSessionId);
  const intent = optionalNonEmpty(options.intent, '--intent')
    ?? optionalNonEmpty(options.topic, '--topic')
    ?? 'Execute approved Pi plan';
  const topic = optionalNonEmpty(options.topic, '--topic') ?? intent;
  if (!requestedSessionId
    && store.sessionSchemaSelection().writer === 'session/2.0'
    && !attempt) {
    throw new Error(
      'Statusless Plan publication requires an explicit current Session and canonical Execution start/lease acquisition',
    );
  }
  const target = attempt
    ? { sessionId: attempt.sessionId, created: false }
    : requestedSessionId
      ? { sessionId: requestedSessionId, created: false }
      : ensureAutomaticSession(store, requestId, intent, topic);

  let runId: string | undefined;
  let input: PlanPublishRunInput | undefined;
  if (attempt) {
    input = normalizeExistingInput(attempt, options, requestId, handoffKey, sourceChecksum);
    if (attempt.kind === 'complete') {
      if (input.schema_version === PLAN_PUBLISH_EXECUTION_INPUT_VERSION) {
        const authority = executionAuthority(options);
        const execution = store.readExecution(target.sessionId, input.execution.execution_id);
        assertExecutionLease(execution.lease, authority.lease);
        return publishedResult(store, input, replayedExecutionCompletion(attempt), false);
      }
      return publishedResult(store, input, replayedCompletion(attempt), false);
    }
  } else {
    const record = store.readSessionRecord(target.sessionId);
    const executionMode = record.schema_version === 'session/2.0' || executionAuthorityWasSupplied(options);
    if (executionMode) {
      if (record.schema_version !== 'session/2.0') {
        throw new Error(`Session ${target.sessionId} is ${record.schema_version}; Execution authority is only valid for session/2.0`);
      }
      if (!options.requestId) throw new Error('Execution-aware plan publish requires --request-id');
      const authority = executionAuthority(options);
      const identityRevision = optionalRevision(
        options.expectedIdentityRevision,
        '--expected-identity-revision',
      );
      const activityRevision = optionalRevision(
        options.expectedActivityRevision,
        '--expected-activity-revision',
      );
      if (identityRevision === undefined || activityRevision === undefined) {
        throw new Error(
          'Execution-aware plan publish requires --expected-identity-revision and --expected-activity-revision',
        );
      }
      let executionRevision = authority.expectedExecutionRevision;
      let publishActivityRevision = activityRevision;
      const bootstrapRequestId = executionBootstrapRequestId(requestId);
      const executionBeforeBootstrap = store.readExecution(target.sessionId, authority.executionId);
      const bootstrapReceipt = store.readExecutionTransition(
        target.sessionId,
        authority.executionId,
        bootstrapRequestId,
      );
      if (executionBeforeBootstrap.chain.length === 0 || bootstrapReceipt) {
        let bootstrapIdentityRevision = identityRevision;
        let bootstrapActivityRevision = activityRevision;
        let bootstrapExecutionRevision = authority.expectedExecutionRevision;
        if (bootstrapReceipt) {
          const before = bootstrapReceipt.payload.preconditions;
          const after = bootstrapReceipt.outcome.postconditions;
          const suppliedMatchesBefore = authority.expectedExecutionRevision === before.execution_revision
            && activityRevision === before.session_activity_revision;
          const suppliedMatchesAfter = authority.expectedExecutionRevision === after.execution_revision
            && activityRevision === after.session_activity_revision;
          if (identityRevision !== before.session_identity_revision
            || before.session_identity_revision !== after.session_identity_revision
            || before.execution_id !== authority.executionId
            || before.execution_generation !== authority.generation
            || after.execution_id !== authority.executionId
            || after.execution_generation !== authority.generation
            || before.execution_revision === null
            || after.execution_revision !== before.execution_revision + 1
            || after.session_activity_revision !== before.session_activity_revision + 1
            || (!suppliedMatchesBefore && !suppliedMatchesAfter)) {
            throw new TransitionReceiptError(
              'FENCE_CONFLICT',
              `Plan publication bootstrap fence changed for request_id ${requestId}`,
            );
          }
          bootstrapIdentityRevision = before.session_identity_revision;
          bootstrapActivityRevision = before.session_activity_revision;
          bootstrapExecutionRevision = before.execution_revision;
          executionRevision = after.execution_revision;
          publishActivityRevision = after.session_activity_revision;
        } else {
          executionRevision++;
          publishActivityRevision++;
        }
        const bootstrapped = bootstrapExecutionChain(projectRoot, {
          sessionId: target.sessionId,
          executionId: authority.executionId,
          generation: authority.generation,
          requestId: bootstrapRequestId,
          expectedIdentityRevision: bootstrapIdentityRevision,
          expectedActivityRevision: bootstrapActivityRevision,
          expectedExecutionRevision: bootstrapExecutionRevision,
          lease: authority.lease,
          actor: authority.actor,
          reason: authority.reason,
          evidence: authority.evidence,
        });
        if (!bootstrapped.replayed) {
          hooks.afterExecutionChainBootstrapped?.({
            sessionId: target.sessionId,
            executionId: authority.executionId,
            transitionId: bootstrapped.transition_id,
          });
        }
      }
      input = planPublishExecutionRunInputSchema.parse({
        schema_version: PLAN_PUBLISH_EXECUTION_INPUT_VERSION,
        request_id: requestId,
        handoff_key: handoffKey,
        source_checksum: sourceChecksum,
        source_pi_session: optionalNonEmpty(options.sourcePiSession, '--source-pi-session') ?? null,
        plan_revision: planRevision(options.planRevision) ?? 1,
        approved_at: approvedAt(options.approvedAt) ?? new Date().toISOString(),
        expected_identity_revision: identityRevision,
        expected_activity_revision: publishActivityRevision,
        execution: {
          execution_id: authority.executionId,
          generation: authority.generation,
          expected_revision: executionRevision,
        },
        claim: {
          owner_id: authority.lease.ownerId,
          owner_kind: authority.lease.ownerKind,
          epoch: authority.lease.epoch,
          lease_id_hash: hashExecutionLeaseId(authority.lease.leaseId),
        },
        audit: {
          actor: authority.actor,
          reason: authority.reason,
          evidence: authority.evidence,
        },
      });
      assertTargetExecution(
        store,
        target.sessionId,
        input,
        authority.lease,
        null,
        executionRevision,
        publishActivityRevision,
      );
      const created = createExecutionRun({
        projectRoot,
        command: PLAN_PUBLISH_COMMAND,
        sessionId: target.sessionId,
        intent,
        topic: options.topic,
        platform: 'pi',
        args: [stableJsonUtf8(input)],
        expectedIdentityRevision: identityRevision,
        expectedActivityRevision: publishActivityRevision,
        executionId: authority.executionId,
        generation: authority.generation,
        expectedExecutionRevision: executionRevision,
        executionLease: authority.lease,
        requestId: executionCreateRequestId(requestId),
        creation: {
          requestId,
          mode: 'explicit-create',
          authority: 'explicit-command',
          confirmationTokenHash: null,
          provenance: {
            schema_version: 'creation-provenance/1.0',
            provenance: 'native-v2',
            source_workspace_id: null,
            source_session_id: null,
            source_run_id: null,
            imported_artifact_hashes: [],
          },
        },
      });
      runId = created.run_id;
      hooks.afterRunCreated?.({ sessionId: target.sessionId, runId });
    } else {
      const session = store.readBundle(target.sessionId).session;
      const identityRevision = optionalRevision(
        options.expectedIdentityRevision,
        '--expected-identity-revision',
      ) ?? session.identity_revision;
      const activityRevision = optionalRevision(
        options.expectedActivityRevision,
        '--expected-activity-revision',
      ) ?? session.activity_revision;
      const lease = storedLease(options);
      const claim = leaseClaim(lease);
      assertTargetSession(session, null, claim);
      input = planPublishRunInputSchema.parse({
        schema_version: PLAN_PUBLISH_INPUT_VERSION,
        request_id: requestId,
        handoff_key: handoffKey,
        source_checksum: sourceChecksum,
        source_pi_session: optionalNonEmpty(options.sourcePiSession, '--source-pi-session') ?? null,
        plan_revision: planRevision(options.planRevision) ?? 1,
        approved_at: approvedAt(options.approvedAt) ?? new Date().toISOString(),
        expected_identity_revision: identityRevision,
        expected_activity_revision: activityRevision,
        lease,
      });
      const created = createRun({
        projectRoot,
        command: PLAN_PUBLISH_COMMAND,
        sessionId: target.sessionId,
        intent,
        topic: requestedSessionId ? options.topic : topic,
        platform: 'pi',
        args: [stableJsonUtf8(input)],
        expectedIdentityRevision: identityRevision,
        expectedActivityRevision: activityRevision,
        leaseClaim: claim,
        requireRunningSession: true,
        creation: {
          requestId,
          mode: 'explicit-create',
          authority: 'explicit-command',
          confirmationTokenHash: null,
          provenance: {
            schema_version: 'creation-provenance/1.0',
            provenance: 'native-v2',
            source_workspace_id: null,
            source_session_id: null,
            source_run_id: null,
            imported_artifact_hashes: [],
          },
        },
      });
      runId = created.run_id;
      hooks.afterRunCreated?.({ sessionId: target.sessionId, runId });
    }
  }

  if (!input) throw new Error('plan publish input was not initialized');
  runId ??= attempt?.runId;
  if (!runId) throw new Error('plan publish Run was not initialized');
  const runDir = store.runDir(target.sessionId, runId);
  ensurePlanOutput(runDir, publishArtifactBytes(input, markdown));

  if (input.schema_version === PLAN_PUBLISH_EXECUTION_INPUT_VERSION) {
    const authority = executionAuthority(options);
    assertTargetExecution(
      store,
      target.sessionId,
      input,
      authority.lease,
      runId,
      input.execution.expected_revision + 1,
      input.expected_activity_revision + 1,
    );
    const completed = completeExecutionRun(projectRoot, runId, {
      sessionId: target.sessionId,
      executionId: input.execution.execution_id,
      generation: input.execution.generation,
      expectedExecutionRevision: input.execution.expected_revision + 1,
      executionLease: authority.lease,
      requestId: executionCompleteRequestId(requestId),
      summaryFallback: `Published approved Pi plan ${handoffKey}`,
    });
    return publishedResult(store, input, completed, target.created);
  }

  const claim = leaseClaim(input.lease);
  const beforeComplete = store.readBundle(target.sessionId).session;
  assertTargetSession(beforeComplete, runId, claim);
  const completed = completeRun(projectRoot, runId, target.sessionId, {
    summaryFallback: `Published approved Pi plan ${handoffKey}`,
    leaseClaim: claim,
    requireRunningSession: true,
    transition: {
      requestId,
      expectedIdentityRevision: beforeComplete.identity_revision,
      expectedActivityRevision: beforeComplete.activity_revision,
      leaseClaim: claim,
    },
  });
  return publishedResult(store, input, completed, target.created);
}

export function publishPlan(
  options: PublishPlanOptions,
  hooks: PublishPlanHooks = {},
): PublishPlanResult {
  const projectRoot = resolve(options.projectRoot);
  const lock = new SessionStoreLock(join(projectRoot, '.workflow', '.plan-publish.lock'));
  lock.acquire();
  try {
    return publishPlanLocked({ ...options, projectRoot }, hooks);
  } finally {
    lock.release();
  }
}
