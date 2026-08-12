import { randomUUID } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { InvalidArgumentError, type Command, type CommanderError } from 'commander';

import type { ExecutionLeaseClaim } from '../run/lease.js';
import type {
  ResponseFenceV11,
  ResponseLocatorV11,
  ResponseWarningV11,
  RunOperationV11,
  RunResponseErrorCodeV11,
} from '../run/protocol-schemas.js';
import {
  createRunResponseError,
  createRunResponseSuccess,
  emitRunResponse,
  stableRunResponseErrorCodeV11,
} from '../run/response.js';
import type { ExecutionState } from '../run/schemas.js';
import { SessionStore } from '../run/store.js';

export const EXECUTION_OWNER_KINDS = ['pi', 'claude', 'codex', 'agy', 'manual'] as const;
export type ExecutionOwnerKind = typeof EXECUTION_OWNER_KINDS[number];

export interface ExecutionLocatorOptions {
  session: string;
  execution: string;
}

export interface ExecutionRevisionOptions extends ExecutionLocatorOptions {
  requestId: string;
  expectedExecutionRevision: number;
}

export interface ExecutionOwnerOptions {
  executionOwner?: string;
  /** @deprecated Use executionOwner / --execution-owner. */
  ownerId?: string;
  ownerKind: ExecutionOwnerKind;
}

export interface ExecutionLeaseOptions extends ExecutionOwnerOptions {
  ownerEpoch?: number;
  /** @deprecated Use ownerEpoch / --owner-epoch. */
  leaseEpoch?: number;
  leaseId: string;
}

export interface ExecutionAcquireOptions extends ExecutionOwnerOptions {
  expectedLeaseEpoch: number;
}

export interface ExecutionSessionCasOptions {
  expectedIdentityRevision?: number;
  expectedActivityRevision?: number;
}

export interface AuditedExecutionOptions {
  actor: string;
  reason: string;
  evidence: string[];
}

export interface ExecutionOutputOptions {
  json?: boolean;
  workflowRoot: string;
  claimOutput?: string;
}

export function parseNonNegativeInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new InvalidArgumentError('expected a non-negative integer');
  return parsed;
}

export function parsePositiveInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new InvalidArgumentError('expected a positive integer');
  return parsed;
}

export function parseOwnerKind(value: string): ExecutionOwnerKind {
  if (!EXECUTION_OWNER_KINDS.includes(value as ExecutionOwnerKind)) {
    throw new InvalidArgumentError(`expected one of: ${EXECUTION_OWNER_KINDS.join(', ')}`);
  }
  return value as ExecutionOwnerKind;
}

const SECRET_LIKE_OPTION = /(?:^|-)(?:auth(?:orization)?|claim(?:-output|-path)?|cookie|credentials?|key|lease-id|password|passwd|secret|token)(?:$|-)/i;

/** Keep Commander machine errors useful without reflecting credential-bearing argv. */
export function sanitizeCommanderError(
  error: CommanderError,
  argv: readonly string[],
): { message: string; details: { commander_code: string } } {
  let message = error.message;
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    const equals = token.indexOf('=');
    const option = equals >= 0 ? token.slice(0, equals) : token;
    if (!SECRET_LIKE_OPTION.test(option.slice(2))) continue;

    if (equals >= 0) {
      message = message.split(token).join(`${option}=[REDACTED]`);
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) continue;
    message = message
      .split(`${option} ${value}`).join(`${option} [REDACTED]`)
      .split(`'${value}'`).join("'[REDACTED]'")
      .split(`"${value}"`).join('"[REDACTED]"');
    index++;
  }
  return { message, details: { commander_code: error.code } };
}

export function addExecutionLocatorOptions(command: Command): Command {
  return command
    .requiredOption('--session <id>', 'exact Session ID')
    .requiredOption('--execution <id>', 'exact Execution ID');
}

export function addExecutionRevisionOptions(command: Command): Command {
  return addExecutionLocatorOptions(command)
    .requiredOption('--request-id <id>', 'idempotent request ID')
    .requiredOption('--expected-execution-revision <n>', 'expected Execution revision', parseNonNegativeInteger);
}

export function addExecutionOwnerOptions(command: Command): Command {
  return command
    .option('--execution-owner <id>', 'Execution lease owner ID')
    .option('--owner-id <id>', 'deprecated alias for --execution-owner')
    .requiredOption('--owner-kind <kind>', `Execution lease owner kind: ${EXECUTION_OWNER_KINDS.join('|')}`, parseOwnerKind);
}

export function addExecutionAcquireOptions(command: Command): Command {
  return addExecutionOwnerOptions(command)
    .requiredOption('--expected-lease-epoch <n>', 'latest observed Execution lease epoch', parseNonNegativeInteger);
}

export function addExecutionLeaseOptions(command: Command): Command {
  return addExecutionOwnerOptions(command)
    .option('--owner-epoch <n>', 'Execution lease ownership epoch', parsePositiveInteger)
    .option('--lease-epoch <n>', 'deprecated alias for --owner-epoch', parsePositiveInteger)
    .requiredOption('--lease-id <token>', 'private Execution lease token');
}

export function addExecutionSessionCasOptions(
  command: Command,
  requirements: { identity?: boolean; activity?: boolean },
): Command {
  const identityMethod = requirements.identity ? 'requiredOption' : 'option';
  command[identityMethod](
    '--expected-identity-revision <n>',
    'expected Session identity revision',
    parseNonNegativeInteger,
  );
  const activityMethod = requirements.activity ? 'requiredOption' : 'option';
  return command[activityMethod](
    '--expected-activity-revision <n>',
    'expected Session activity revision',
    parseNonNegativeInteger,
  );
}

function collectEvidence(value: string, previous: string[] = []): string[] {
  return previous.concat(value);
}

export function addAuditedExecutionOptions(command: Command): Command {
  return command
    .requiredOption('--actor <name>', 'authorized actor')
    .requiredOption('--reason <text>', 'audit reason')
    .requiredOption('--evidence <ref>', 'evidence reference (repeatable)', collectEvidence);
}

export function addExecutionOutputOptions(command: Command, acquisition = false): Command {
  if (acquisition) command.option('--claim-output <path>', 'write the private acquisition claim to a mode-0600 file');
  return command
    .option('--json', 'emit one run-response/1.1 envelope on stdout')
    .option('--workflow-root <path>', 'project root containing .workflow', process.cwd());
}

export function executionLeaseClaim(options: ExecutionLeaseOptions): ExecutionLeaseClaim {
  return {
    ownerId: normalizedExecutionOwner(options),
    ownerKind: options.ownerKind,
    epoch: normalizedOwnerEpoch(options),
    leaseId: options.leaseId,
  };
}

export function normalizedExecutionOwner(options: ExecutionOwnerOptions): string {
  const canonical = options.executionOwner?.trim();
  const alias = options.ownerId?.trim();
  if (canonical && alias && canonical !== alias) {
    throw new InvalidArgumentError('--execution-owner conflicts with deprecated --owner-id');
  }
  const owner = canonical || alias;
  if (!owner) throw new InvalidArgumentError('--execution-owner is required');
  return owner;
}

export function normalizedOwnerEpoch(options: ExecutionLeaseOptions): number {
  const canonical = options.ownerEpoch;
  const alias = options.leaseEpoch;
  if (canonical !== undefined && alias !== undefined && canonical !== alias) {
    throw new InvalidArgumentError('--owner-epoch conflicts with deprecated --lease-epoch');
  }
  const epoch = canonical ?? alias;
  if (epoch === undefined) throw new InvalidArgumentError('--owner-epoch is required');
  return epoch;
}

export function executionLocator(execution: Pick<ExecutionState, 'session_id' | 'execution_id' | 'generation' | 'active_run_id'>): ResponseLocatorV11 {
  return {
    session_id: execution.session_id,
    execution_id: execution.execution_id,
    generation: execution.generation,
    run_id: execution.active_run_id,
  };
}

export function executionFence(
  projectRoot: string,
  execution: Pick<ExecutionState, 'session_id' | 'revision'> & { lease: { epoch: number } | null },
): ResponseFenceV11 {
  const session = new SessionStore(projectRoot).readBundle(execution.session_id).session;
  return {
    session_identity_revision: session.identity_revision,
    session_activity_revision: session.activity_revision,
    execution_revision: execution.revision,
    lease_epoch: execution.lease?.epoch ?? null,
  };
}

export function readExecutionAuthority(
  projectRoot: string,
  sessionId: string,
  executionId: string,
): { locator: ResponseLocatorV11; fence: ResponseFenceV11 } | null {
  try {
    const execution = new SessionStore(projectRoot).readExecution(sessionId, executionId);
    return { locator: executionLocator(execution), fence: executionFence(projectRoot, execution) };
  } catch {
    return null;
  }
}

export function emitExecutionSuccess(input: {
  operation: RunOperationV11;
  result: unknown;
  projectRoot: string;
  execution: Pick<ExecutionState, 'session_id' | 'execution_id' | 'generation' | 'active_run_id' | 'revision'> & {
    lease: { epoch: number } | null;
  };
  requestId?: string | null;
  replay?: { replayed: boolean; transition_id: string } | null;
  warnings?: ResponseWarningV11[];
}): void {
  emitRunResponse(createRunResponseSuccess({
    schema_version: 'run-response/1.1',
    operation: input.operation,
    result: input.result,
    request_id: input.requestId ?? null,
    locator: executionLocator(input.execution),
    fence: executionFence(input.projectRoot, input.execution),
    replay: input.replay
      ? { status: input.replay.replayed ? 'replayed' : 'applied', transition_id: input.replay.transition_id }
      : null,
    warnings: input.warnings ?? [],
  }));
}

function recoveryCommand(code: RunResponseErrorCodeV11, locator: ResponseLocatorV11 | null): string | null {
  if (!locator?.session_id || !locator.execution_id) return null;
  if (code.startsWith('LEASE_')) {
    return `maestro execution lease status --session ${locator.session_id} --execution ${locator.execution_id}`;
  }
  if (code === 'EXECUTION_PAUSED') {
    return `maestro execution status --session ${locator.session_id} --execution ${locator.execution_id}`;
  }
  return null;
}

function executionErrorCode(error: unknown): RunResponseErrorCodeV11 {
  const mapped = stableRunResponseErrorCodeV11(error);
  if (mapped !== 'INTERNAL_ERROR') return mapped;
  const message = error instanceof Error ? error.message : String(error);
  if (/generation (?:changed|mismatch)/i.test(message)) return 'EXECUTION_REVISION_CONFLICT';
  if (/already has an open Execution|multiple open Executions/i.test(message)) return 'EXECUTION_ALREADY_ACTIVE';
  if (/Execution has active Run/i.test(message)) return 'EXECUTION_PAUSE_BLOCKED';
  if (/Execution chain is not complete/i.test(message)) return 'EXECUTION_SEAL_BLOCKED';
  if (/lease is not stale/i.test(message)) return 'LEASE_BUSY';
  return mapped;
}

export function emitExecutionError(input: {
  operation: RunOperationV11;
  error: unknown;
  projectRoot: string;
  sessionId?: string;
  executionId?: string;
  requestId?: string | null;
  exitCode?: 1 | 2 | 3;
  disposition?: 'domain_error' | 'control_flow' | 'usage_error';
  code?: RunResponseErrorCodeV11;
  details?: Record<string, unknown>;
  warnings?: ResponseWarningV11[];
}): void {
  const authority = input.sessionId && input.executionId
    ? readExecutionAuthority(input.projectRoot, input.sessionId, input.executionId)
    : null;
  const code = input.code ?? executionErrorCode(input.error);
  const exitCode = input.exitCode ?? 1;
  emitRunResponse(createRunResponseError({
    schema_version: 'run-response/1.1',
    operation: input.operation,
    exit_code: exitCode,
    disposition: input.disposition ?? (exitCode === 1 ? 'domain_error' : 'control_flow'),
    code,
    message: input.error instanceof Error ? input.error.message : String(input.error),
    details: input.details,
    request_id: input.requestId ?? null,
    locator: authority?.locator ?? {
      session_id: input.sessionId ?? null,
      execution_id: input.executionId ?? null,
      generation: null,
      run_id: null,
    },
    fence: authority?.fence ?? null,
    retryable: code === 'LEASE_BUSY' || code === 'LEASE_STALE_RECOVERY_REQUIRED',
    recovery_command: recoveryCommand(code, authority?.locator ?? null),
    warnings: input.warnings ?? [],
  }));
}

export function prepareExecutionClaimOutput(
  claimOutput: string | undefined,
  projectRoot: string,
  secretField: 'lease_claim' | 'handoff_token' = 'lease_claim',
): string {
  const outputPath = claimOutput
    ? resolve(claimOutput)
    : join(resolve(projectRoot, '.workflow', 'tmp', 'claims'), `${secretField}-${randomUUID()}.json`);
  try {
    const directory = dirname(outputPath);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const directoryDetails = lstatSync(directory);
    if (directoryDetails.isSymbolicLink() || !directoryDetails.isDirectory()) {
      throw new Error('private claim parent is not a real directory');
    }
    if (process.platform !== 'win32') chmodSync(directory, 0o700);
    try {
      lstatSync(outputPath);
      throw new Error('private claim target already exists');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    return outputPath;
  } catch {
    throw new Error('Unable to prepare private claim output securely');
  }
}

export function printExecutionHuman(
  value: object,
  claimOutput?: string,
  secretField: 'lease_claim' | 'handoff_token' = 'lease_claim',
  projectRoot = process.cwd(),
): void {
  const record = value as Record<string, unknown>;
  if (!(secretField in record) || record[secretField] === null || record[secretField] === undefined) {
    console.log(JSON.stringify(value, null, 2));
    return;
  }
  const outputPath = prepareExecutionClaimOutput(claimOutput, projectRoot, secretField);
  const secret = secretField === 'lease_claim'
    ? record.lease_claim
    : { handoff_token: record.handoff_token };
  writePrivateClaim(outputPath, secret);
  const publicValue = { ...record, [secretField]: null, claim_output: outputPath };
  console.log(JSON.stringify(publicValue, null, 2));
}

function writePrivateClaim(outputPath: string, secret: unknown): void {
  try {
    writeFileSync(outputPath, `${JSON.stringify(secret, null, 2)}\n`, {
      encoding: 'utf8', flag: 'wx', mode: 0o600,
    });
    const fileDetails = lstatSync(outputPath);
    if (fileDetails.isSymbolicLink() || !fileDetails.isFile()) {
      throw new Error('private claim target is not a regular file');
    }
    if (process.platform !== 'win32') chmodSync(outputPath, 0o600);
  } catch {
    throw new Error('Unable to write private claim output securely');
  }
}

export function reportExecutionHuman(error: unknown): void {
  console.error(`[maestro execution] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}

export function deprecationWarning(command: string, replacement: string): ResponseWarningV11 {
  return {
    code: 'DEPRECATED_ALIAS',
    message: `"${command}" is deprecated; use "${replacement}"`,
    replacement_command: replacement,
  };
}
