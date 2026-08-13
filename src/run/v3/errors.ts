import {
  runResponseErrorDetailV12Schema,
  type RunResponseErrorCodeV12,
  type RunResponseV12,
  type TransitionReceiptV20,
} from '../protocol-schemas.js';

export type V3ErrorCode = RunResponseErrorCodeV12;
export type V3TransitionTargetType = TransitionReceiptV20['target_type'];
export type RunResponseV12ErrorDetail = NonNullable<RunResponseV12['error']>;

export interface V3StructuredErrorDetails {
  retryable?: boolean;
  details?: Readonly<Record<string, unknown>>;
  target_type?: V3TransitionTargetType | null;
  target_id?: string | null;
  expected_revision?: number | null;
  current_revision?: number | null;
  changed_by?: string | null;
  next_actions?: readonly string[];
}

export type V3StructuredErrorPayload = RunResponseV12ErrorDetail;

function normalizedActions(actions: readonly string[] | undefined): string[] {
  if (actions === undefined) return [];
  return actions.map(action => action.trim()).filter(Boolean);
}

function definedDetails(details: Readonly<Record<string, unknown>> | undefined): Record<string, unknown> {
  return Object.fromEntries(Object.entries(details ?? {}).filter(([, value]) => value !== undefined));
}

function stableSessionIds(sessionIds: readonly string[]): string[] {
  return [...new Set(sessionIds.map(sessionId => sessionId.trim()).filter(Boolean))].sort();
}

export class V3StructuredError extends Error {
  readonly code: V3ErrorCode;
  readonly retryable: boolean;
  readonly details: Readonly<Record<string, unknown>>;
  readonly target_type: V3TransitionTargetType | null;
  readonly target_id: string | null;
  readonly expected_revision: number | null;
  readonly current_revision: number | null;
  readonly changed_by: string | null;
  readonly next_actions: readonly string[];

  constructor(code: V3ErrorCode, message: string, details: V3StructuredErrorDetails = {}) {
    super(message);
    this.name = 'V3StructuredError';
    this.code = code;
    this.retryable = details.retryable ?? false;
    this.details = definedDetails(details.details);
    this.target_type = details.target_type ?? null;
    this.target_id = details.target_id ?? null;
    this.expected_revision = details.expected_revision ?? null;
    this.current_revision = details.current_revision ?? null;
    this.changed_by = details.changed_by ?? null;
    this.next_actions = normalizedActions(details.next_actions);
  }

  toRunResponseV12ErrorDetail(): RunResponseV12ErrorDetail {
    return runResponseErrorDetailV12Schema.parse({
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      details: { ...this.details },
      target_type: this.target_type,
      target_id: this.target_id,
      expected_revision: this.expected_revision,
      current_revision: this.current_revision,
      changed_by: this.changed_by,
      next_actions: [...this.next_actions],
    });
  }

  toJSON(): V3StructuredErrorPayload {
    return this.toRunResponseV12ErrorDetail();
  }
}

export function createRevisionConflictError(input: {
  code: Extract<V3ErrorCode, 'RUN_REVISION_CONFLICT' | 'ORCHESTRATION_REVISION_CONFLICT'>;
  targetType: Extract<V3TransitionTargetType, 'run' | 'orchestration'>;
  targetId: string;
  expectedRevision: number;
  currentRevision: number;
  changedBy: string;
  nextActions?: readonly string[];
}): V3StructuredError {
  return new V3StructuredError(input.code, `revision conflict for ${input.targetType} ${input.targetId}`, {
    retryable: true,
    target_type: input.targetType,
    target_id: input.targetId,
    expected_revision: input.expectedRevision,
    current_revision: input.currentRevision,
    changed_by: input.changedBy,
    next_actions: input.nextActions ?? ['reload-target', 're-evaluate-intent', 'resubmit-with-new-request-id'],
  });
}

export function createRequestConflictError(input: {
  requestId: string;
  changedBy?: string;
  nextActions?: readonly string[];
}): V3StructuredError {
  return new V3StructuredError('REQUEST_CONFLICT', `request ${input.requestId} conflicts with an existing receipt`, {
    details: {
      request_id: input.requestId,
      ...(input.changedBy !== undefined ? { changed_by: input.changedBy } : {}),
    },
    next_actions: input.nextActions ?? ['use-the-original-payload', 'submit-with-new-request-id'],
  });
}

export function createSessionAmbiguousError(input: {
  candidateSessionIds: readonly string[];
  source?: string | null;
  nextActions?: readonly string[];
}): V3StructuredError {
  const candidates = stableSessionIds(input.candidateSessionIds);
  return new V3StructuredError('SESSION_AMBIGUOUS', 'multiple Sessions match the current context', {
    details: {
      candidates,
      ...(input.source !== undefined ? { source: input.source } : {}),
    },
    next_actions: input.nextActions ?? candidates.map(sessionId => `select-session:${sessionId}`),
  });
}

export function createSessionSchemaUnsupportedError(input: {
  sessionId: string;
  schemaVersion: string;
  nextActions?: readonly string[];
}): V3StructuredError {
  return new V3StructuredError(
    'SESSION_SCHEMA_UNSUPPORTED',
    `Session ${input.sessionId} uses unsupported schema ${input.schemaVersion}`,
    {
      details: { session_id: input.sessionId, schema_version: input.schemaVersion },
      next_actions: input.nextActions ?? ['upgrade-maestro', 'use-a-schema-compatible-command'],
    },
  );
}
