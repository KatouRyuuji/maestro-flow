import {
  runErrorCodeSchema,
  runErrorCodeV11Schema,
  runErrorCodeV12Schema,
  runResponseSchema,
  runResponseV10Schema,
  runResponseV11Schema,
  runResponseV12Schema,
  type RunOperationV11,
  type RunOperationV12,
  type RunResponse,
  type RunResponseDisposition,
  type RunResponseErrorCode,
  type RunResponseErrorCodeV11,
  type RunResponseErrorCodeV12,
  type RunResponseRead,
  type RunResponseV10,
  type RunResponseV11,
  type RunResponseV12,
} from './protocol-schemas.js';

export interface RunResponseBaseInput {
  operation: RunResponseV10['operation'];
  request_id?: string | null;
  locator?: RunResponseV10['locator'];
  next?: RunResponseV10['next'];
  continuation?: RunResponseV10['continuation'];
  replay?: RunResponseV10['replay'];
}

export interface RunResponseV11BaseInput {
  schema_version: 'run-response/1.1';
  operation: RunOperationV11;
  request_id?: string | null;
  locator?: RunResponseV11['locator'];
  fence?: RunResponseV11['fence'];
  next?: RunResponseV11['next'];
  continuation?: RunResponseV11['continuation'];
  replay?: RunResponseV11['replay'];
  warnings?: RunResponseV11['warnings'];
}

export interface RunResponseV12BaseInput {
  schema_version: 'run-response/1.2';
  operation: RunOperationV12;
  request_id?: string | null;
  locator?: RunResponseV12['locator'];
  revision?: RunResponseV12['revision'];
  replay?: RunResponseV12['replay'];
  warnings?: RunResponseV12['warnings'];
}

/** Prefer typed domain codes, then map legacy message-only errors deterministically. */
export function stableRunResponseErrorCode(error: unknown): RunResponseErrorCode {
  const typedCode = (error as { code?: unknown })?.code;
  const parsedCode = runErrorCodeSchema.safeParse(typedCode);
  if (parsedCode.success) return parsedCode.data;

  const message = error instanceof Error ? error.message : String(error);
  if (/Run not found/i.test(message)) return 'RUN_NOT_FOUND';
  if (/session not found/i.test(message)) return 'SESSION_NOT_FOUND';
  if (/ambiguous/i.test(message)) return 'SESSION_AMBIGUOUS';
  if (/lease (?:conflict|is owned)|owner epoch|lease id/i.test(message)) return 'LEASE_CONFLICT';
  if (/stale (?:identity|activity) revision/i.test(message)) return 'FENCE_CONFLICT';
  if (/unresolved escalated decision|unresolved failed chain step|expected "paused"/i.test(message)) return 'RESUME_REQUIRED';
  if (/running chain step/i.test(message)) return 'RUNNING_STEP';
  if (/decision point not found|decision .* is (?:already|not escalated)/i.test(message)) return 'DECISION_REQUIRED';
  if (/chain step not found/i.test(message)) return 'PICK_NOT_FOUND';
  if (/only pending steps|chain step .* is not failed/i.test(message)) return 'PICK_NOT_PENDING';
  if (/unsealed Runs|claimed requests|Session gates are not complete/i.test(message)) return 'SESSION_SEAL_BLOCKED';
  if (/(unknown|invalid).*platform|platform.*(unknown|invalid)/i.test(message)) return 'PLATFORM_INVALID';
  if (/platform.*(mismatch|conflict)/i.test(message)) return 'PLATFORM_CONFLICT';
  if (/contract.*drift/i.test(message)) return 'CONTRACT_DRIFT';
  if (/chain[- ]proposal/i.test(message)) return 'CHAIN_PROPOSAL_INVALID';
  if (/immutable/i.test(message)) return 'RUN_IMMUTABLE';
  if (/confirmation token not found|invalid confirmation token/i.test(message)) return 'TOKEN_INVALID';
  if (/expired/i.test(message)) return 'TOKEN_EXPIRED';
  if (/already consumed/i.test(message)) return 'TOKEN_REPLAYED';
  if (/request mismatch|different action or request/i.test(message)) return 'REQUEST_CONFLICT';
  if (/required|invalid|must be|cannot insert|at least one|only one block/i.test(message)) return 'INVALID_ARGUMENT';
  return 'INTERNAL_ERROR';
}

/** V1.1 mapping recognizes execution/lease codes before falling back to legacy mappings. */
export function stableRunResponseErrorCodeV11(error: unknown): RunResponseErrorCodeV11 {
  const typedCode = (error as { code?: unknown })?.code;
  const parsedCode = runErrorCodeV11Schema.safeParse(typedCode);
  if (parsedCode.success) return parsedCode.data;

  const message = error instanceof Error ? error.message : String(error);
  if (/execution not found/i.test(message)) return 'EXECUTION_NOT_FOUND';
  if (/execution .*sealed/i.test(message)) return 'EXECUTION_SEALED';
  if (/execution .*paused/i.test(message)) return 'EXECUTION_PAUSED';
  if (/stale execution revision|execution revision conflict/i.test(message)) return 'EXECUTION_REVISION_CONFLICT';
  if (/handoff.*in progress/i.test(message)) return 'LEASE_HANDOFF_IN_PROGRESS';
  if (/handoff token/i.test(message)) return 'LEASE_HANDOFF_TOKEN_INVALID';
  if (/stale.*(?:recover|takeover)|recovery required/i.test(message)) return 'LEASE_STALE_RECOVERY_REQUIRED';
  if (/lease.*busy|lease is owned/i.test(message)) return 'LEASE_BUSY';
  if (/lease.*(?:epoch|token|fence)|owner epoch|lease id/i.test(message)) return 'LEASE_FENCE_CONFLICT';
  if (/session.*archived/i.test(message)) return 'SESSION_ARCHIVED';
  return stableRunResponseErrorCode(error);
}

/** V1.2 mapping recognizes entity-revision errors without importing Execution-era codes. */
export function stableRunResponseErrorCodeV12(error: unknown): RunResponseErrorCodeV12 {
  const typedCode = (error as { code?: unknown })?.code;
  const parsedCode = runErrorCodeV12Schema.safeParse(typedCode);
  if (parsedCode.success) return parsedCode.data;

  const message = error instanceof Error ? error.message : String(error);
  if (/run revision conflict|stale run revision/i.test(message)) return 'RUN_REVISION_CONFLICT';
  if (/orchestration revision conflict|stale orchestration revision/i.test(message)) {
    return 'ORCHESTRATION_REVISION_CONFLICT';
  }
  if (/session\/3\.0|session schema unsupported/i.test(message)) return 'SESSION_SCHEMA_UNSUPPORTED';
  if (/store (?:is )?busy|sessionstore locked/i.test(message)) return 'STORE_BUSY';
  if (/participant.*required/i.test(message)) return 'PARTICIPANT_REQUIRED';
  return stableRunResponseErrorCode(error);
}

export function createRunResponseSuccess(
  input: RunResponseBaseInput & { result: unknown },
): RunResponseV10;
export function createRunResponseSuccess(
  input: RunResponseV11BaseInput & { result: unknown },
): RunResponseV11;
export function createRunResponseSuccess(
  input: RunResponseV12BaseInput & { result: unknown },
): RunResponseV12;
export function createRunResponseSuccess(
  input: (RunResponseBaseInput | RunResponseV11BaseInput | RunResponseV12BaseInput) & { result: unknown },
): RunResponseRead {
  if ('schema_version' in input && input.schema_version === 'run-response/1.2') {
    return runResponseV12Schema.parse({
      schema_version: 'run-response/1.2',
      operation: input.operation,
      ok: true,
      exit_code: 0,
      disposition: 'success',
      request_id: input.request_id ?? null,
      locator: input.locator ?? null,
      revision: input.revision ?? null,
      replay: input.replay ?? null,
      warnings: input.warnings ?? [],
      result: input.result,
      error: null,
    });
  }
  if ('schema_version' in input && input.schema_version === 'run-response/1.1') {
    return runResponseV11Schema.parse({
      schema_version: 'run-response/1.1',
      operation: input.operation,
      ok: true,
      exit_code: 0,
      disposition: 'success',
      request_id: input.request_id ?? null,
      locator: input.locator ?? null,
      fence: input.fence ?? null,
      result: input.result,
      next: input.next ?? null,
      continuation: input.continuation ?? null,
      replay: input.replay ?? null,
      warnings: input.warnings ?? [],
      error: null,
    });
  }

  return runResponseV10Schema.parse({
    schema_version: 'run-response/1.0',
    operation: input.operation,
    ok: true,
    exit_code: 0,
    request_id: input.request_id ?? null,
    locator: input.locator ?? null,
    result: input.result,
    next: input.next ?? null,
    continuation: input.continuation ?? null,
    error: null,
    replay: input.replay ?? null,
  });
}

interface RunResponseErrorBaseInput {
  exit_code: 1 | 2 | 3;
  message: string;
  details?: Record<string, unknown>;
}

export interface RunResponseV12ConflictInput {
  target_type: NonNullable<RunResponseV12['error']>['target_type'];
  target_id: string;
  expected_revision: number;
  current_revision: number;
  changed_by: string;
  next_actions: string[];
}

export function createRunResponseError(
  input: RunResponseBaseInput & RunResponseErrorBaseInput & { code: RunResponseErrorCode },
): RunResponseV10;
export function createRunResponseError(
  input: RunResponseV11BaseInput & RunResponseErrorBaseInput & {
    code: RunResponseErrorCodeV11;
    disposition: Exclude<RunResponseDisposition, 'success'>;
    retryable?: boolean;
    recovery_command?: string | null;
  },
): RunResponseV11;
export function createRunResponseError(
  input: RunResponseV12BaseInput & RunResponseErrorBaseInput & {
    code: RunResponseErrorCodeV12;
    disposition: Exclude<RunResponseDisposition, 'success'>;
    retryable?: boolean;
    conflict?: RunResponseV12ConflictInput;
    next_actions?: string[];
  },
): RunResponseV12;
export function createRunResponseError(
  input: (RunResponseBaseInput | RunResponseV11BaseInput | RunResponseV12BaseInput) & RunResponseErrorBaseInput & {
    code: RunResponseErrorCodeV11 | RunResponseErrorCodeV12;
    disposition?: Exclude<RunResponseDisposition, 'success'>;
    retryable?: boolean;
    recovery_command?: string | null;
    conflict?: RunResponseV12ConflictInput;
    next_actions?: string[];
  },
): RunResponseRead {
  if ('schema_version' in input && input.schema_version === 'run-response/1.2') {
    const conflict = input.conflict;
    return runResponseV12Schema.parse({
      schema_version: 'run-response/1.2',
      operation: input.operation,
      ok: false,
      exit_code: input.exit_code,
      disposition: input.disposition,
      request_id: input.request_id ?? null,
      locator: input.locator ?? null,
      revision: input.revision ?? null,
      replay: input.replay ?? null,
      warnings: input.warnings ?? [],
      result: null,
      error: {
        code: input.code,
        message: input.message,
        retryable: input.retryable ?? false,
        details: input.details ?? {},
        target_type: conflict?.target_type ?? null,
        target_id: conflict?.target_id ?? null,
        expected_revision: conflict?.expected_revision ?? null,
        current_revision: conflict?.current_revision ?? null,
        changed_by: conflict?.changed_by ?? null,
        next_actions: conflict?.next_actions ?? input.next_actions ?? [],
      },
    });
  }
  if ('schema_version' in input && input.schema_version === 'run-response/1.1') {
    return runResponseV11Schema.parse({
      schema_version: 'run-response/1.1',
      operation: input.operation,
      ok: false,
      exit_code: input.exit_code,
      disposition: input.disposition,
      request_id: input.request_id ?? null,
      locator: input.locator ?? null,
      fence: input.fence ?? null,
      result: null,
      next: input.next ?? null,
      continuation: input.continuation ?? null,
      replay: input.replay ?? null,
      warnings: input.warnings ?? [],
      error: {
        code: input.code,
        message: input.message,
        retryable: input.retryable ?? false,
        details: input.details ?? {},
        recovery_command: input.recovery_command ?? null,
      },
    });
  }

  return runResponseV10Schema.parse({
    schema_version: 'run-response/1.0',
    operation: input.operation,
    ok: false,
    exit_code: input.exit_code,
    request_id: input.request_id ?? null,
    locator: input.locator ?? null,
    result: null,
    next: input.next ?? null,
    continuation: input.continuation ?? null,
    error: {
      code: input.code,
      message: input.message,
      details: input.details ?? {},
    },
    replay: input.replay ?? null,
  });
}

function redactLeaseIds(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactLeaseIds);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key !== 'lease_id')
      .map(([key, item]) => [key, redactLeaseIds(item)]),
  );
}

/** Remove raw lease tokens before logging, persistence, UI projection, or transcript capture. */
export function redactRunResponseLeaseTokens<T extends RunResponseRead>(response: T): T {
  const validated = runResponseSchema.parse(response);
  return runResponseSchema.parse(redactLeaseIds(validated)) as T;
}

/** Validate before writing so machine mode never emits a partial envelope. */
export function emitRunResponse(
  response: RunResponseRead,
  options: { redactLeaseTokens?: boolean } = {},
): void {
  const validated = runResponseSchema.parse(response);
  const output = options.redactLeaseTokens ? redactRunResponseLeaseTokens(validated) : validated;
  process.stdout.write(`${JSON.stringify(output)}\n`);
  process.exitCode = output.exit_code;
}

export {
  runResponseSchema,
  runResponseV10Schema,
  runResponseV11Schema,
  runResponseV12Schema,
  type RunResponse,
  type RunResponseErrorCode,
  type RunResponseErrorCodeV11,
  type RunResponseRead,
  type RunResponseV10,
  type RunResponseV11,
  type RunResponseV12,
} from './protocol-schemas.js';
