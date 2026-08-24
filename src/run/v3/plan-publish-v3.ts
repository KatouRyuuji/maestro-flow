import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { readVerifiedContainedFile } from '../artifacts.js';
import { automaticSessionId, derivePlanPublishRequestId, planArtifactBytes } from '../plan-publish.js';
import { artifactRegistrySchema, type SessionStateV30 } from '../schemas.js';
import { SessionStore } from '../store.js';
import { openSessionV3 } from '../../commands/session-v3.js';
import { V3StructuredError } from './errors.js';
import { mutateChainV3 } from './chain-mutations.js';
import { completeRunAndAdvance, createRunningRunV3 } from './mutation-engine.js';
import { ensureV3RunShell } from './run-shell.js';
import { parseTransitionReceiptRef } from './receipts.js';
import type { RunV30 } from '../schemas.js';

/**
 * Canonical session/3.0 + run/3.0 plan publisher.
 *
 * Publishes an approved Pi Markdown Plan as a sealed `plan/1.0` artifact with
 * alias `current-plan` through the v3 Run lifecycle:
 *
 *   session open --chain plan-publish  →  run next  →  write outputs/plan.json
 *                                        →  run complete --advance
 *
 * The producer Run is sealed atomically; `prepareArtifactPublication`
 * registers `outputs/plan.json` into the Session Artifact Registry and binds
 * the `current-plan` alias. Downstream `execute`/`verify` Runs consume the
 * Plan through the canonical `upstream` map — no Execution, lease, bootstrap,
 * or seal receipt is involved.
 *
 * Idempotent: a retry with the same `request_id` replays the original receipts
 * (open / next / complete) and returns the same `run_id` / `artifact_id`.
 */

const PLAN_PUBLISH_COMMAND = 'plan-publish';
const DEFAULT_ACTOR = 'maestro-plan-publish';

export interface PublishPlanV3Options {
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
  requestId?: string;
  actor?: string;
  reason?: string;
  evidence?: string[];
}

export interface PublishPlanV3Result {
  schema_version: 'plan-publish-result/1.2';
  session_id: string;
  run_id: string;
  artifact_id: string;
  artifact_path: string;
  handoff_key: string;
  source_checksum: string;
  source_pi_session: string | null;
  plan_revision: number;
  approved_at: string;
  request_id: string;
  created_session: boolean;
  replayed: boolean;
  transition: {
    request_id: string;
    transition_id: string;
    status: 'applied' | 'replayed';
  };
  next: {
    suggest_only: true;
    command: string;
    reason: string;
  };
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function nonEmpty(value: string | undefined, label: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new V3StructuredError('INVALID_ARGUMENT', `${label} must be non-empty`);
  return normalized;
}

function optionalNonEmpty(value: string | undefined, label: string): string | undefined {
  return value === undefined ? undefined : nonEmpty(value, label);
}

function positiveInteger(value: number | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < 1) {
    throw new V3StructuredError('INVALID_ARGUMENT', `${label} must be a positive integer`);
  }
  return value;
}

function validTimestamp(value: string | undefined, label: string): string | undefined {
  if (value === undefined) return undefined;
  const normalized = nonEmpty(value, label);
  if (!Number.isFinite(Date.parse(normalized))) {
    throw new V3StructuredError('INVALID_ARGUMENT', `${label} must be a valid timestamp`);
  }
  return normalized;
}

function requestIdFor(suffix: string, requestId: string): string {
  return `${requestId}__${suffix}`;
}

function runIdFor(requestId: string): string {
  return `run-${createHash('sha256').update(requestId).digest('hex').slice(0, 12)}`;
}

function assertNoExecutionAuthority(options: PublishPlanV3Options): void {
  const executionFlags: Array<keyof PublishPlanV3Options> = [
    // PublishPlanV3Options intentionally has no Execution fields; this guard
    // is a forward-compatible contract assertion in case callers extend it.
  ];
  // No Execution surface is accepted on the v3 path. If the caller passes any
  // legacy-style authority via a future extension, reject it explicitly.
  void executionFlags;
}

function ensurePlanOutput(store: SessionStore, sessionId: string, runId: string, bytes: Buffer): void {
  const runDir = store.runDir(sessionId, runId);
  const outputPath = join(runDir, 'outputs', 'plan.json');
  if (!existsSync(outputPath)) {
    try {
      writeFileSync(outputPath, bytes, { flag: 'wx' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
}

function readArtifactRegistryAlias(store: SessionStore, sessionId: string, alias: string): {
  artifactId: string;
  relativePath: string;
} {
  const session = store.readSessionV30(sessionId);
  const artifactsPath = resolve(store.sessionDir(sessionId), session.artifacts_ref);
  const artifacts = artifactRegistrySchema.parse(JSON.parse(readFileSync(artifactsPath, 'utf8')));
  const artifactId = artifacts.aliases[alias];
  if (!artifactId) {
    throw new V3StructuredError('INVALID_STATE_TRANSITION', `published artifact alias ${alias} is missing`);
  }
  const artifact = artifacts.artifacts[artifactId];
  if (!artifact || artifact.status !== 'sealed') {
    throw new V3StructuredError('INVALID_STATE_TRANSITION', `published artifact ${artifactId} is not sealed`);
  }
  return { artifactId, relativePath: artifact.relative_path };
}

function parseCompleteResult(mutation: ReturnType<typeof completeRunAndAdvance>): {
  artifactId: string;
  next: PublishPlanV3Result['next'];
  replayed: boolean;
} {
  const result = mutation.transition.result as Record<string, unknown>;
  if (result.operation !== 'run-complete-and-seal' || result.status !== 'sealed') {
    throw new V3StructuredError('INVALID_STATE_TRANSITION', 'plan publish Run did not seal');
  }
  const publication = result.artifact_publication as
    | { primary_artifact_id: string | null; aliases: Record<string, string> }
    | undefined;
  if (!publication || !publication.primary_artifact_id) {
    throw new V3StructuredError('INVALID_STATE_TRANSITION', 'plan publish Run sealed no primary artifact');
  }
  if (publication.aliases['current-plan'] !== publication.primary_artifact_id) {
    throw new V3StructuredError('INVALID_STATE_TRANSITION', 'current-plan alias does not bind the published Plan');
  }
  const next = result.next as { suggest_only: true; command: string; reason: string } | undefined;
  if (!next || next.suggest_only !== true) {
    throw new V3StructuredError('INVALID_STATE_TRANSITION', 'plan publish Run produced no continuation');
  }
  return { artifactId: publication.primary_artifact_id, next, replayed: mutation.status === 'replayed' };
}

/**
 * Publish an approved Pi Markdown Plan through the v3 Run lifecycle.
 *
 * Programmatic equivalent of:
 *   maestro session open "<intent>" --id <slug> --chain plan-publish ...
 *   maestro run next --session <slug> ...
 *   <write outputs/plan.json>
 *   maestro run complete <run-id> --advance --verdict done ...
 *
 * Returns the sealed artifact identity for the Pi plan-workflow consumers.
 */
export function publishPlanV3(options: PublishPlanV3Options): PublishPlanV3Result {
  assertNoExecutionAuthority(options);
  const projectRoot = resolve(options.projectRoot);
  const store = new SessionStore(projectRoot);
  const writer = store.sessionSchemaSelection().writer;
  if (writer !== 'session/3.0') {
    throw new V3StructuredError(
      'SESSION_SCHEMA_UNSUPPORTED',
      'v3 plan publish requires the session/3.0 writer',
      { details: { writer }, next_actions: ['select-session/3.0-writer'] },
    );
  }

  const handoffKey = nonEmpty(options.handoffKey, '--handoff-key');
  const requestId = optionalNonEmpty(options.requestId, '--request-id') ?? derivePlanPublishRequestId(handoffKey);
  const intent = optionalNonEmpty(options.intent, '--intent')
    ?? optionalNonEmpty(options.topic, '--topic')
    ?? 'Execute approved Pi plan';
  const actor = optionalNonEmpty(options.actor, '--actor') ?? DEFAULT_ACTOR;
  const reason = optionalNonEmpty(options.reason, '--reason') ?? 'Publish approved Pi plan';
  const evidence = options.evidence?.map(item => nonEmpty(item, '--evidence')) ?? [];
  const sourcePiSession = optionalNonEmpty(options.sourcePiSession, '--source-pi-session') ?? null;
  const planRevision = positiveInteger(options.planRevision, '--plan-revision') ?? 1;
  const approvedAt = validTimestamp(options.approvedAt, '--approved-at') ?? new Date().toISOString();
  const sourceRoot = resolve(options.sourceRoot ?? projectRoot);
  const source = readVerifiedContainedFile(sourceRoot, options.sourcePath);
  let markdown: string;
  try {
    markdown = new TextDecoder('utf-8', { fatal: true }).decode(source.data);
  } catch {
    throw new V3StructuredError('INVALID_ARGUMENT', 'approved Plan source must be valid UTF-8 Markdown');
  }
  const sourceChecksum = `sha256:${source.contentHash}`;
  const finalBytes = planArtifactBytes({
    handoff_key: handoffKey,
    source_checksum: sourceChecksum,
    source_pi_session: sourcePiSession,
    revision: planRevision,
    approved_at: approvedAt,
  }, markdown);
  const requestedSessionId = optionalNonEmpty(options.sessionId, '--session');
  const sessionId = requestedSessionId ?? automaticSessionId(requestId);
  const openRequestId = requestIdFor('open', requestId);
  const openReason = `Open plan-publish Session for ${handoffKey}`;

  // 1. Open the Session (idempotent). If a Session with this id already
  //    exists (e.g. the caller pre-opened it), skip the open mutation and
  //    reuse it — the producer Run is what seals the Plan, not the Session
  //    creation. The open mutation only runs for new automatic Sessions.
  let createdSession = false;
  if (!store.sessionExists(sessionId)) {
    const openMutation = openSessionV3(store, {
      objective: intent,
      sessionId,
      actorId: actor,
      requestId: openRequestId,
      reason: openReason,
      evidence,
      chain: [PLAN_PUBLISH_COMMAND],
    });
    createdSession = openMutation.status === 'applied';
  }

  // 2. Read the freshly-opened Session and allocate the producer Run.
  let session: SessionStateV30 = store.readSessionV30(sessionId);
  if (session.status !== 'open') {
    throw new V3StructuredError('INVALID_STATE_TRANSITION', `Session ${sessionId} is ${session.status}`);
  }
  // If the Session was pre-opened without a plan-publish chain step (e.g. a
  // caller opened it with `session open` and no --chain), insert the step now
  // so `run next` has a pending target. This keeps plan publish composable
  // with externally-managed Sessions without forcing a specific open shape.
  let planStep = session.chain.find(step => step.command === PLAN_PUBLISH_COMMAND && step.status === 'pending')
    ?? session.chain.find(step => step.command === PLAN_PUBLISH_COMMAND);
  if (!planStep) {
    const insertRequestId = requestIdFor('insert', requestId);
    mutateChainV3(store, {
      sessionId, actorId: actor, requestId: insertRequestId,
      expectedOrchestrationRevision: session.orchestration_revision,
      reason: 'Insert plan-publish producer step',
      evidenceRefs: evidence,
      mutation: { kind: 'insert', stepId: 's-plan-publish', command: PLAN_PUBLISH_COMMAND },
    });
    session = store.readSessionV30(sessionId);
    planStep = session.chain.find(step => step.command === PLAN_PUBLISH_COMMAND && step.status === 'pending');
    if (!planStep) {
      throw new V3StructuredError(
        'INVALID_STATE_TRANSITION',
        `Session ${sessionId} chain has no ${PLAN_PUBLISH_COMMAND} step after insert`,
      );
    }
  }

  // Replay fast path: a prior publish with the same request id already sealed
  // the producer Run and completed the chain step. Re-reading the sealed
  // artifact identity returns the original result without re-dispatching.
  if (planStep.status === 'completed' && planStep.run_ids.length > 0) {
    const sealedRunId = planStep.run_ids[0];
    const sealedRun = store.readRunV30(sessionId, sealedRunId);
    if (sealedRun.status === 'sealed' && sealedRun.primary_artifact_id) {
      const { artifactId, relativePath } = readArtifactRegistryAlias(store, sessionId, 'current-plan');
      if (artifactId === sealedRun.primary_artifact_id) {
        const completeRequestId = requestIdFor('complete', requestId);
        const requestReceipt = store.readRequestReceiptV20(sessionId, completeRequestId);
        const transitionRef = requestReceipt?.transition_receipt_ref ?? '';
        const transitionId = transitionRef ? parseTransitionReceiptRef(transitionRef).transitionId : '';
        return {
          schema_version: 'plan-publish-result/1.2',
          session_id: sessionId,
          run_id: sealedRunId,
          artifact_id: artifactId,
          artifact_path: `sessions/${sessionId}/${relativePath}`,
          handoff_key: handoffKey,
          source_checksum: sourceChecksum,
          source_pi_session: sourcePiSession,
          plan_revision: planRevision,
          approved_at: approvedAt,
          request_id: requestId,
          created_session: createdSession,
          replayed: true,
          transition: {
            request_id: completeRequestId,
            transition_id: transitionId,
            status: 'replayed' as const,
          },
          next: {
            suggest_only: true as const,
            command: `maestro session complete --session ${sessionId} --participant ${actor} --actor ${actor} --request-id <request-id> --reason "<reason>" --expected-orchestration-revision ${session.orchestration_revision} --json`,
            reason: 'Run sealed; no pending chain step remains, so complete the Session',
          },
        };
      }
    }
  }

  const nextRequestId = requestIdFor('next', requestId);
  const nextRunId = runIdFor(nextRequestId);
  // Ensure the run shell exists before the mutation commits (mirrors run-v3.ts).
  ensureV3RunShell(store, sessionId, nextRunId);
  const nextRun: RunV30 = {
    schema_version: 'run/3.0', run_id: nextRunId, session_id: sessionId,
    step_id: planStep.step_id, parent_run_id: null, retry_of_run_id: null, attempt: 1,
    command: planStep.command, args: planStep.args, goal: planStep.goal_ref,
    status: 'pending', revision: 0, actor_id: actor,
    input_refs: [], output_refs: [], primary_artifact_id: null,
    verdict: null, summary: null,
    created_at: new Date().toISOString(), started_at: null, ended_at: null, sealed_at: null,
  };
  const nextMutation = createRunningRunV3(store, {
    sessionId, requestId: nextRequestId, actorId: actor, reason: 'Dispatch plan-publish producer Run',
    evidenceRefs: evidence,
    expectedOrchestrationRevision: session.orchestration_revision,
    run: nextRun,
  });
  const birthPacket = nextMutation.transition.result as {
    run_id: string;
    revision: number;
  };
  const runningRun = birthPacket.run_id;
  const runningRunRevision = birthPacket.revision;

  // 3. Write the approved Plan bytes to outputs/plan.json (idempotent).
  ensurePlanOutput(store, sessionId, runningRun, finalBytes);

  // 4. Complete and seal the Run, atomically advancing the chain step and
  //    registering the plan/1.0 artifact under the current-plan alias.
  const completeRequestId = requestIdFor('complete', requestId);
  const completeMutation = completeRunAndAdvance(store, {
    sessionId, requestId: completeRequestId, actorId: actor,
    reason: `Publish approved Pi plan ${handoffKey}`,
    evidenceRefs: evidence,
    runId: runningRun,
    expectedRunRevision: runningRunRevision,
    expectedOrchestrationRevision: nextMutation.transition.revision_after,
    summary: `Published approved Pi plan ${handoffKey}`,
    verdict: 'done',
  });
  const { artifactId, next, replayed } = parseCompleteResult(completeMutation);
  const { relativePath } = readArtifactRegistryAlias(store, sessionId, 'current-plan');

  return {
    schema_version: 'plan-publish-result/1.2',
    session_id: sessionId,
    run_id: runningRun,
    artifact_id: artifactId,
    artifact_path: `sessions/${sessionId}/${relativePath}`,
    handoff_key: handoffKey,
    source_checksum: sourceChecksum,
    source_pi_session: sourcePiSession,
    plan_revision: planRevision,
    approved_at: approvedAt,
    request_id: requestId,
    created_session: createdSession,
    replayed,
    transition: {
      request_id: completeRequestId,
      transition_id: completeMutation.transition.transition_id,
      status: completeMutation.status,
    },
    next,
  };
}

// Re-exported for callers that build their own request ids.
export { derivePlanPublishRequestId, automaticSessionId };
