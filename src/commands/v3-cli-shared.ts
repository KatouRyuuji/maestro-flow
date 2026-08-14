import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { InvalidArgumentError, type Command } from 'commander';

import type { RunOperationV12, RunResponseV12, TransitionReceiptV20 } from '../run/protocol-schemas.js';
import { createRunResponseError, createRunResponseSuccess, emitRunResponse, stableRunResponseErrorCodeV12 } from '../run/response.js';
import { sessionStateV30Schema, type SessionStateV30 } from '../run/schemas.js';
import { SessionStore } from '../run/store.js';
import { createRevisionConflictError, V3StructuredError } from '../run/v3/errors.js';
import { sessionContextErrorToV3Error } from '../run/v3/resolve-context.js';
import { resolveSessionContextFromStore } from '../run/v3/resolve-context-store.js';
import type { V3MutationResult } from '../run/v3/mutation-engine.js';
import {
  canonicalPayloadHash,
  createRequestReceipt,
  createTransitionReceipt,
  replayRequestReceipt,
  transitionReceiptRef,
} from '../run/v3/receipts.js';
import { transitionSession, type SessionStatus } from '../run/v3/session-machine.js';

export interface V3CommonOptions {
  session?: string;
  participant: string;
  actor: string;
  requestId: string;
  expectedOrchestrationRevision?: number;
  expectedRunRevision?: number;
  reason: string;
  evidence: string[];
  json?: boolean;
  workflowRoot: string;
}

export type ResolvedV3CommonOptions = Omit<V3CommonOptions, 'session'> & { session: string };

export function collectV3(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

export function parseV3Revision(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new InvalidArgumentError('revision must be a non-negative safe integer');
  }
  return parsed;
}

export function addV3ReadOptions(command: Command): Command {
  return command
    .option('--session <id>', 'exact Session ID')
    .option('--json', 'emit run-response/1.2 JSON')
    .option('--workflow-root <path>', 'project root containing .workflow', process.cwd());
}

export function addV3MutationOptions(command: Command, target: 'run' | 'orchestration'): Command {
  const configured = addV3ReadOptions(command)
    .requiredOption('--participant <id>', 'participant performing the mutation')
    .requiredOption('--actor <id>', 'authorized actor')
    .requiredOption('--request-id <id>', 'idempotency request ID')
    .requiredOption('--reason <text>', 'audit reason')
    .option('--evidence <ref>', 'evidence reference (repeatable)', collectV3, []);
  return target === 'run'
    ? configured.requiredOption('--expected-run-revision <n>', 'expected Run revision', parseV3Revision)
    : configured.requiredOption('--expected-orchestration-revision <n>', 'expected Session orchestration revision', parseV3Revision);
}

export function v3Store(options: { workflowRoot: string }): SessionStore {
  const store = new SessionStore(resolve(options.workflowRoot));
  const writer = store.sessionSchemaSelection().writer;
  if (writer !== 'session/3.0') {
    throw new V3StructuredError('SESSION_SCHEMA_UNSUPPORTED', 'command requires the session/3.0 writer', {
      details: { writer },
      next_actions: ['select-session/3.0-writer'],
    });
  }
  return store;
}

export function resolveV3Options<T extends { session?: string; workflowRoot: string }>(
  options: T,
): { store: SessionStore; options: T & { session: string } } {
  const store = v3Store(options);
  const result = resolveSessionContextFromStore(store, { explicit_session_id: options.session });
  if (!result.ok) throw sessionContextErrorToV3Error(result.error);
  const resolvedOptions = options as T & { session: string };
  resolvedOptions.session = result.session_id;
  return { store, options: resolvedOptions };
}

export function mutationIdentity(options: ResolvedV3CommonOptions) {
  return {
    sessionId: options.session,
    actorId: options.actor,
    requestId: options.requestId,
    reason: options.reason,
    evidenceRefs: options.evidence,
  };
}

function responseRevision(receipt: TransitionReceiptV20): NonNullable<RunResponseV12['revision']> {
  return {
    target_type: receipt.target_type,
    target_id: receipt.target_id,
    revision: receipt.revision_after,
  };
}

export function emitV3Success(input: {
  operation: RunOperationV12;
  sessionId: string | null;
  runId?: string | null;
  requestId?: string | null;
  result: unknown;
  mutation?: V3MutationResult;
}): void {
  emitRunResponse(createRunResponseSuccess({
    schema_version: 'run-response/1.2',
    operation: input.operation,
    request_id: input.requestId ?? null,
    locator: { session_id: input.sessionId, run_id: input.runId ?? null },
    revision: input.mutation ? responseRevision(input.mutation.transition) : null,
    replay: input.mutation
      ? { status: input.mutation.status, transition_id: input.mutation.transition.transition_id }
      : null,
    warnings: [],
    result: input.result,
  }));
}

export function emitV3Error(
  operation: RunOperationV12,
  error: unknown,
  options: { session?: string; runId?: string; requestId?: string },
): void {
  const structured = error instanceof V3StructuredError ? error : null;
  const code = structured?.code ?? stableRunResponseErrorCodeV12(error);
  const conflict = structured && structured.target_type && structured.target_id
    && structured.expected_revision !== null && structured.current_revision !== null && structured.changed_by
    ? {
      target_type: structured.target_type,
      target_id: structured.target_id,
      expected_revision: structured.expected_revision,
      current_revision: structured.current_revision,
      changed_by: structured.changed_by,
      next_actions: [...structured.next_actions],
    }
    : undefined;
  emitRunResponse(createRunResponseError({
    schema_version: 'run-response/1.2',
    operation,
    exit_code: 1,
    disposition: 'domain_error',
    code,
    message: error instanceof Error ? error.message : String(error),
    details: structured ? { ...structured.details } : {},
    retryable: structured?.retryable ?? code === 'STORE_BUSY',
    conflict,
    next_actions: structured ? [...structured.next_actions] : [],
    request_id: options.requestId ?? null,
    locator: { session_id: options.session ?? null, run_id: options.runId ?? null },
    revision: null,
    replay: null,
    warnings: [],
  }));
}

export type SessionStatusOperation =
  | 'session-archive'
  | 'session-unarchive';

export function mutateSessionStatusV3(
  store: SessionStore,
  options: ResolvedV3CommonOptions,
  toStatus: Extract<SessionStatus, 'open' | 'archived'>,
  operation: SessionStatusOperation = toStatus === 'archived'
    ? 'session-archive'
    : 'session-unarchive',
): V3MutationResult {
  const recordedAt = new Date().toISOString();
  const payload = {
    operation,
    expected_orchestration_revision: options.expectedOrchestrationRevision,
    to_status: toStatus,
    actor_id: options.actor,
    reason: options.reason,
    evidence_refs: [...options.evidence].sort(),
  };
  const payloadHash = canonicalPayloadHash(payload);
  return store.withV30Transaction(options.session, tx => {
    const replayed = replayRequestReceipt({
      tx,
      sessionId: options.session,
      requestId: options.requestId,
      participantId: options.actor,
      payloadHash,
    });
    if (replayed) return { status: 'replayed', transition: replayed };

    const session = tx.readSession();
    const expected = options.expectedOrchestrationRevision;
    if (expected === undefined) throw new V3StructuredError('INVALID_ARGUMENT', 'expected orchestration revision is required');
    if (session.orchestration_revision !== expected) {
      throw createRevisionConflictError({
        code: 'ORCHESTRATION_REVISION_CONFLICT',
        targetType: 'orchestration',
        targetId: session.session_id,
        expectedRevision: expected,
        currentRevision: session.orchestration_revision,
        changedBy: 'unknown',
      });
    }

    const transitioned = transitionSession(session, toStatus);
    const nextSession: SessionStateV30 = {
      ...transitioned,
      orchestration_revision: session.orchestration_revision + 1,
      activity_revision: session.activity_revision + 1,
      updated_at: recordedAt,
      archived_at: toStatus === 'archived'
        ? recordedAt
        : operation === 'session-unarchive'
          ? null
          : session.archived_at,
    };
    const transition = createTransitionReceipt({
      transitionId: `tr_${randomUUID()}`,
      requestId: options.requestId,
      sessionId: options.session,
      activityRevision: nextSession.activity_revision,
      targetType: 'orchestration',
      targetId: options.session,
      revisionBefore: session.orchestration_revision,
      revisionAfter: nextSession.orchestration_revision,
      actorId: options.actor,
      participantId: options.actor,
      reason: options.reason,
      evidenceRefs: options.evidence,
      recordedAt,
      result: { status: nextSession.status, orchestration_revision: nextSession.orchestration_revision },
    });
    tx.writeSession(nextSession);
    tx.writeTransitionReceipt(transition);
    tx.writeRequestReceipt(createRequestReceipt({
      requestId: options.requestId,
      participantId: options.actor,
      payloadHash,
      transitionReceiptRef: transitionReceiptRef(transition.activity_revision, transition.transition_id),
    }));
    return { status: 'applied', transition };
  });
}

/**
 * Enumerate every canonical session/3.0 session.json under .workflow/sessions/.
 * Read-only: no lock acquisition, no recovery writes, no projection writes.
 * Non-v3 and unreadable entries are skipped so a listing never fails the batch.
 */
export function listV3Sessions(store: SessionStore): SessionStateV30[] {
  if (!existsSync(store.sessionsRoot)) return [];
  const sessions: SessionStateV30[] = [];
  for (const name of readdirSync(store.sessionsRoot).sort()) {
    const path = join(store.sessionsRoot, name, 'session.json');
    if (!existsSync(path)) continue;
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
      if (typeof raw !== 'object' || raw === null) continue;
      if ((raw as { schema_version?: unknown }).schema_version !== 'session/3.0') continue;
      sessions.push(sessionStateV30Schema.parse(raw));
    } catch {
      // skip corrupt or non-v3 session files
    }
  }
  return sessions;
}

/**
 * Enumerate every non-session/3.0 session.json under .workflow/sessions/ as a
 * batch migration candidate. Read-only: no lock acquisition, no writes.
 * Unreadable or path-mismatched entries are skipped so a batch migration never
 * fails on a corrupt sibling; every readable entry whose schema_version is not
 * session/3.0 is returned and its individual migration attempt may still fail
 * and be recorded per-session by the caller.
 */
export function listLegacyV3MigrationCandidates(store: SessionStore): Array<{
  session_id: string;
  source_schema_version: string;
}> {
  if (!existsSync(store.sessionsRoot)) return [];
  const candidates: Array<{ session_id: string; source_schema_version: string }> = [];
  for (const name of readdirSync(store.sessionsRoot).sort()) {
    const path = join(store.sessionsRoot, name, 'session.json');
    if (!existsSync(path)) continue;
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
      if (typeof raw !== 'object' || raw === null) continue;
      const schemaVersion = (raw as { schema_version?: unknown }).schema_version;
      if (typeof schemaVersion !== 'string' || schemaVersion === 'session/3.0') continue;
      if ((raw as { session_id?: unknown }).session_id !== name) continue;
      candidates.push({ session_id: name, source_schema_version: schemaVersion });
    } catch {
      // skip corrupt or unreadable session files
    }
  }
  return candidates;
}


