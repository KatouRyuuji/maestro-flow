import { z } from 'zod';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { InvalidArgumentError, type Command } from 'commander';
import { migrateAllSessions, migrateSession } from '../run/migrate.js';
import { SessionStore } from '../run/store.js';
import { completeExecutionRun, completeRunWithVerdict, createExecutionRun as createExecutionRunCore, createRun, ensureSessionProjectionOnDisk, pruneOrphanSessions, sealSession, type CompletionVerdict } from '../run/runtime.js';
import { runNextExecutionStep, runNextStep } from '../run/next.js';
import { runDecide, type DecisionConfidence, type DecisionVerdict } from '../run/decide.js';
import { continuationAfterDecide, inspectSessionContinuation } from '../run/continuation.js';
import { buildGraph, renderGraphHuman } from '../run/graph.js';
import { resolveActiveRunTarget, resolveRunningRun } from '../run/resolve.js';
import { sessionStateV20Schema, targetPlatformSchema, type SessionState } from '../run/schemas.js';
import {
  chainDefinitionSchema,
  createChainSession,
  deriveSessionId,
  insertChainStep,
  parseDecompositionInput,
  parsePositionInput,
  replaceChainStep,
  skipChainStep,
  updateSessionMeta,
  type ChainDefinition,
} from '../run/chain-admin.js';
import { archiveSession, resolveSession, resumeSession, unarchiveSession } from '../run/session-transition.js';
import { executionStatus, resolveExecution, resumeExecution, sealExecution, startExecution } from '../run/execution.js';
import { readResolvedSession, resolveCompatibleSession } from '../run/session-resolver.js';
import { summarizeSession } from '../run/session-status.js';
import { checkResolvedSession, summarizeSessionCheck } from '../run/session-check.js';
import {
  createRunResponseError,
  createRunResponseSuccess,
  emitRunResponse,
  stableRunResponseErrorCode,
  stableRunResponseErrorCodeV11,
  type RunResponse,
} from '../run/response.js';
import type { TransitionMutationReceipt } from '../run/transition-receipts.js';
import {
  deprecationWarning,
  emitExecutionError,
  emitExecutionSuccess,
  executionLeaseClaim,
  parseNonNegativeInteger,
  parseOwnerKind,
  parsePositiveInteger,
  printExecutionHuman,
  type ExecutionOwnerKind,
} from './execution-cli-shared.js';

function print(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function reportError(error: unknown): void {
  console.error(`[maestro session] ${(error as Error).message}`);
  process.exitCode = 1;
}

type SessionMachineOperation = Extract<
  RunResponse['operation'],
  'create' | 'resolve' | 'resume' | 'seal-session' | 'chain-insert' | 'chain-replace' | 'chain-skip' | 'meta-update'
>;

function machineSuccess(
  operation: SessionMachineOperation,
  result: unknown,
  sessionId: string,
  receipt?: TransitionMutationReceipt,
  next?: RunResponse['next'],
): void {
  emitRunResponse(createRunResponseSuccess({
    operation,
    result,
    request_id: receipt?.request_id ?? null,
    locator: { session_id: sessionId, run_id: null },
    next,
    replay: receipt
      ? { status: receipt.status, transition_id: receipt.transition_id }
      : null,
  }));
}

function machineError(
  operation: SessionMachineOperation,
  error: unknown,
  opts: { session?: string; requestId?: string },
): void {
  emitRunResponse(createRunResponseError({
    operation,
    exit_code: 1,
    code: stableRunResponseErrorCode(error),
    message: error instanceof Error ? error.message : String(error),
    request_id: opts.requestId ?? null,
    locator: { session_id: opts.session ?? null, run_id: null },
  }));
}

function statuslessMachineSuccess(
  operation: 'session-create' | 'session-archive' | 'session-unarchive',
  sessionId: string,
  result: unknown,
  revisions: { identity_revision: number; activity_revision: number },
  requestId: string | null = null,
  replay?: { replayed: boolean; transitionId: string },
): void {
  emitRunResponse(createRunResponseSuccess({
    schema_version: 'run-response/1.1',
    operation,
    result,
    request_id: requestId,
    locator: { session_id: sessionId, execution_id: null, generation: null, run_id: null },
    fence: {
      session_identity_revision: revisions.identity_revision,
      session_activity_revision: revisions.activity_revision,
      execution_revision: null,
      lease_epoch: null,
    },
    replay: replay
      ? { status: replay.replayed ? 'replayed' : 'applied', transition_id: replay.transitionId }
      : null,
    warnings: [],
  }));
}

function statuslessMachineError(
  operation: 'session-create' | 'session-archive' | 'session-unarchive',
  error: unknown,
  opts: { session?: string; requestId?: string },
): void {
  const message = error instanceof Error ? error.message : String(error);
  const code = /has (?:active|paused) current Execution/i.test(message)
    ? 'SESSION_ARCHIVE_BLOCKED'
    : stableRunResponseErrorCodeV11(error);
  emitRunResponse(createRunResponseError({
    schema_version: 'run-response/1.1',
    operation,
    exit_code: 1,
    disposition: 'domain_error',
    code,
    message,
    request_id: opts.requestId ?? null,
    locator: {
      session_id: opts.session ?? null,
      execution_id: null,
      generation: null,
      run_id: null,
    },
    fence: null,
    warnings: [],
  }));
}

function addCanonicalRecoveryHelp(command: Command, phase: 'resolve' | 'resume'): Command {
  const phaseDetail = phase === 'resolve'
    ? 'Resolve exactly one escalated decision or failed chain step. The Session remains paused.'
    : 'Resume only after every recovery blocker is cleared. Success changes paused to running only.';
  return command.addHelpText('after', `
Canonical paused recovery:
  ${phaseDetail}
  Recovery requires an exact Session ID plus audit, revision, and optional lease-triple guards.
  Neither phase creates a Run or binds a chain step. Run allocation remains an explicit maestro session next.
`);
}

async function readStdin(): Promise<string> {
  return new Promise((resolveStdin) => {
    if (process.stdin.isTTY) {
      resolveStdin('');
      return;
    }
    let data = '';
    process.stdin.setEncoding('utf8');
    const onReadable = (): void => {
      let chunk: unknown;
      while ((chunk = process.stdin.read()) !== null) {
        data += chunk as string;
      }
    };
    const onEnd = (): void => {
      process.stdin.off('readable', onReadable);
      process.stdin.off('end', onEnd);
      resolveStdin(data);
    };
    process.stdin.on('readable', onReadable);
    process.stdin.on('end', onEnd);
  });
}

function parseJsonText(raw: string, label: string): unknown {
  try {
    return JSON.parse(raw.replace(/^\uFEFF/, ''));
  } catch (error) {
    throw new Error(`invalid ${label} JSON: ${(error as Error).message}`);
  }
}

/** Load + validate a chain definition from a file path, or `-` for stdin. */
async function loadChainDefinition(chainFile: string): Promise<ChainDefinition> {
  const raw = chainFile === '-' ? await readStdin() : readFileSync(resolve(chainFile), 'utf-8');
  return parseChainDefinition(raw, 'chain-file');
}

/** Parse JSON + validate against chainDefinitionSchema; wraps both error layers with the file label and allowed shapes. */
function parseChainDefinition(raw: string, label: string): ChainDefinition {
  const parsed = parseJsonText(raw, label);
  try {
    return chainDefinitionSchema.parse(parsed);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const issues = error.issues
        .map(issue => `${issue.path.length ? issue.path.join('.') : '(root)'}: ${issue.message}`)
        .join('; ');
      throw new Error(
        `invalid ${label} (${issues}). Allowed shapes — `
        + `{ intent?, engine?: ralph|coordinator|manual, quality_mode?: quick|standard|full, auto_mode?: boolean, `
        + `steps: [{ command: string, ... }] (min 1), decision_points?, boundary_contract?, position?, decomposition?, executor? }`,
      );
    }
    throw error;
  }
}

/** Read + JSON-parse a file path (or `-` for stdin). Throws on malformed JSON. */
async function readJson(pathOrStdin: string, label: string): Promise<unknown> {
  const raw = pathOrStdin === '-' ? await readStdin() : readFileSync(resolve(pathOrStdin), 'utf-8');
  return parseJsonText(raw, label);
}

function chainSummary(steps: ChainDefinition['steps']): { total: number; steps: Array<{ command: string; decision: boolean }> } {
  return {
    total: steps.length,
    steps: steps.map(s => ({ command: s.command, decision: Boolean(s.decision_ref) })),
  };
}

function persistedChainSummary(session: { orchestration: { chain: Array<{ command: string; decision_ref: string | null }> } }): { total: number; steps: Array<{ command: string; decision: boolean }> } {
  return {
    total: session.orchestration.chain.length,
    steps: session.orchestration.chain.map(step => ({ command: step.command, decision: Boolean(step.decision_ref) })),
  };
}

function collect(value: string, prior: string[] = []): string[] { return prior.concat(value); }

function resolveSessionSealReplay(
  store: SessionStore,
  sessionId: string,
  requestId: string | undefined,
): string | undefined {
  if (!requestId) return undefined;
  const matches = store.listExecutions(sessionId).filter(execution => (
    store.readExecutionTransition(sessionId, execution.execution_id, requestId)?.payload.operation === 'execution-seal'
  ));
  if (matches.length > 1) {
    throw new Error(`request_id ${requestId} is ambiguous across Execution generations`);
  }
  return matches[0]?.execution_id;
}

interface AliasExecutionOptions {
  session?: string;
  execution?: string;
  generation?: number;
  requestId?: string;
  expectedExecutionRevision?: number;
  ownerId?: string;
  ownerKind?: ExecutionOwnerKind;
  leaseEpoch?: number;
  leaseId?: string;
}

interface AliasExecutionContext {
  protocol: boolean;
  sessionId?: string;
  execution?: ReturnType<SessionStore['readExecution']>;
}

function addAliasExecutionRunOptions(command: Command): Command {
  return command
    .option('--execution <id>', 'exact Execution ID; otherwise resolve the unique current Execution')
    .option('--generation <n>', 'exact Execution generation', parsePositiveInteger)
    .option('--request-id <id>', 'idempotent Execution transition request ID')
    .option('--expected-execution-revision <n>', 'expected Execution revision', parseNonNegativeInteger)
    .option('--owner-id <id>', 'Execution lease owner ID')
    .option('--owner-kind <kind>', 'Execution lease owner kind', parseOwnerKind)
    .option('--lease-epoch <n>', 'Execution lease epoch', parsePositiveInteger);
}

function resolveAliasExecutionContext(
  projectRoot: string,
  requestedSessionId?: string,
  requestedExecutionId?: string,
): AliasExecutionContext {
  const store = new SessionStore(projectRoot);
  const inspect = (sessionId: string): AliasExecutionContext => {
    const record = store.readSessionRecord(sessionId);
    const executions = store.listExecutions(sessionId);
    if (requestedExecutionId) {
      return { protocol: true, sessionId, execution: store.readExecution(sessionId, requestedExecutionId) };
    }
    const current = store.readOpenExecution(sessionId);
    if (record.schema_version === 'session/2.0') {
      const identity = sessionStateV20Schema.parse(record);
      if (identity.current_execution_id !== (current?.execution_id ?? null)) {
        throw new Error(
          `Session ${sessionId} current Execution pointer is inconsistent: ${identity.current_execution_id ?? 'null'}`,
        );
      }
      return { protocol: true, sessionId, execution: current ?? undefined };
    }
    return executions.length > 0
      ? { protocol: true, sessionId, execution: current ?? undefined }
      : { protocol: false, sessionId };
  };

  if (requestedExecutionId && !requestedSessionId) {
    throw new InvalidArgumentError('--session is required with --execution');
  }
  if (requestedSessionId) {
    if (!store.sessionExists(requestedSessionId)) throw new Error(`Session not found: ${requestedSessionId}`);
    return inspect(requestedSessionId);
  }

  const current = store.listSessionsReadOnly().candidates.flatMap(candidate => {
    const context = inspect(candidate.sessionId);
    return context.execution ? [context] : [];
  });
  if (current.length > 1) {
    throw new Error(`current Execution is ambiguous across Sessions: ${current.map(item => item.sessionId).join(', ')}`);
  }
  if (current.length === 1) return current[0];

  const resolved = resolveCompatibleSession(projectRoot);
  return resolved ? inspect(resolved.sessionId) : { protocol: false };
}

function aliasExecutionAuthority(
  context: AliasExecutionContext,
  opts: AliasExecutionOptions,
): {
  sessionId: string;
  execution: NonNullable<AliasExecutionContext['execution']>;
  requestId: string;
  expectedExecutionRevision: number;
  lease: { ownerId: string; ownerKind: ExecutionOwnerKind; epoch: number; leaseId: string };
} {
  if (!context.sessionId || !context.execution) {
    throw new Error(`current Execution not found${context.sessionId ? ` for Session ${context.sessionId}` : ''}`);
  }
  if (opts.execution && opts.execution !== context.execution.execution_id) {
    throw new Error(`Execution locator mismatch: expected ${opts.execution}, current ${context.execution.execution_id}`);
  }
  if (opts.generation !== undefined && opts.generation !== context.execution.generation) {
    throw new Error(`Execution generation mismatch: expected ${opts.generation}, current ${context.execution.generation}`);
  }
  const missing = [
    ['--request-id', opts.requestId],
    ['--expected-execution-revision', opts.expectedExecutionRevision],
    ['--owner-id', opts.ownerId],
    ['--owner-kind', opts.ownerKind],
    ['--lease-epoch', opts.leaseEpoch],
    ['--lease-id', opts.leaseId],
  ].filter(([, value]) => value === undefined || value === '');
  if (missing.length > 0) {
    throw new InvalidArgumentError(`Execution alias requires ${missing.map(([flag]) => flag).join(', ')}`);
  }
  return {
    sessionId: context.sessionId,
    execution: context.execution,
    requestId: opts.requestId!,
    expectedExecutionRevision: opts.expectedExecutionRevision!,
    lease: {
      ownerId: opts.ownerId!, ownerKind: opts.ownerKind!, epoch: opts.leaseEpoch!, leaseId: opts.leaseId!,
    },
  };
}

function projectUsesExecutionProtocol(projectRoot: string, sessionId?: string): boolean {
  try {
    const store = new SessionStore(projectRoot);
    const sessionIds = sessionId
      ? [sessionId]
      : store.listSessionsReadOnly().candidates.map(candidate => candidate.sessionId);
    return sessionIds.some(id => store.sessionExists(id)
      && (store.readSessionRecord(id).schema_version === 'session/2.0' || store.listExecutions(id).length > 0));
  } catch {
    return false;
  }
}

function aliasExecutionReplay(
  projectRoot: string,
  authority: ReturnType<typeof aliasExecutionAuthority>,
  wasPresent: boolean,
): { replayed: boolean; transition_id: string } | null {
  const receipt = new SessionStore(projectRoot).readExecutionTransition(
    authority.sessionId,
    authority.execution.execution_id,
    authority.requestId,
  );
  return receipt ? { replayed: wasPresent, transition_id: receipt.outcome.transition_id } : null;
}

function createExecutionRun(
  options: Parameters<typeof createExecutionRunCore>[0],
): ReturnType<typeof createExecutionRunCore> {
  const store = new SessionStore(options.projectRoot);
  const existing = store.readExecutionTransition(options.sessionId!, options.executionId, options.requestId);
  try {
    return createExecutionRunCore(options);
  } catch (error) {
    if (existing?.payload.operation === 'create'
      && error instanceof Error
      && /outcome no longer matches current authority revisions/i.test(error.message)) {
      return structuredClone(existing.outcome.result.value) as ReturnType<typeof createExecutionRunCore>;
    }
    throw error;
  }
}

function slugifySessionTopic(text: string, fallback = 'session'): string {
  const slug = text
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return slug || fallback;
}

function simpleChainDefinition(intent: string, commands: string[] | undefined): ChainDefinition | undefined {
  const steps = (commands ?? []).map(command => command.trim()).filter(Boolean);
  if (steps.length === 0) return undefined;
  return chainDefinitionSchema.parse({
    intent,
    steps: steps.map(command => ({ command })),
  });
}

const SESSION_STATUS_VALUES: Array<SessionState['status']> = ['running', 'paused', 'sealed', 'archived', 'failed'];

function transitionOptions(opts: any, target?: any): any {
  return {
    requestId: opts.requestId, actor: opts.actor, reason: opts.reason, evidence: opts.evidence,
    expectedIdentityRevision: opts.expectedIdentityRevision,
    expectedActivityRevision: opts.expectedActivityRevision,
    leaseClaim: { executionOwner: opts.executionOwner, ownerEpoch: opts.ownerEpoch, leaseId: opts.leaseId },
    ...(target ? { target } : {}),
  };
}

function mutationTransitionOptions(opts: any): any {
  return {
    requestId: opts.requestId,
    expectedIdentityRevision: opts.expectedIdentityRevision,
    expectedActivityRevision: opts.expectedActivityRevision,
    leaseClaim: { executionOwner: opts.executionOwner, ownerEpoch: opts.ownerEpoch, leaseId: opts.leaseId },
  };
}

function addMutationOptions(command: Command): Command {
  return command
    .option('--request-id <id>', 'idempotent mutation request ID')
    .option('--expected-identity-revision <n>', 'expected Session identity revision', Number.parseInt)
    .option('--expected-activity-revision <n>', 'expected Session activity revision', Number.parseInt)
    .option('--execution-owner <owner>', 'lease owner')
    .option('--owner-epoch <n>', 'lease epoch', Number.parseInt)
    .option('--lease-id <id>', 'lease ID')
    .option('--json', 'emit one run-response/1.0 envelope on stdout');
}

export function registerSessionCommand(program: Command): void {
  const session = program
    .command('session')
    .description('Session orchestration: chain stepping, Run management, decisions, and visualization');

  const addTransitionOptions = (command: Command): Command => command
    .requiredOption('--session <id>', 'exact Session ID')
    .requiredOption('--request-id <id>', 'idempotent request/transition ID')
    .requiredOption('--actor <name>', 'authorized actor')
    .requiredOption('--reason <text>', 'audit reason')
    .requiredOption('--evidence <ref>', 'evidence reference (repeatable)', collect)
    .requiredOption('--expected-identity-revision <n>', 'expected identity revision', Number.parseInt)
    .requiredOption('--expected-activity-revision <n>', 'expected activity revision', Number.parseInt)
    .option('--execution-owner <owner>', 'lease owner')
    .option('--owner-epoch <n>', 'lease epoch', Number.parseInt)
    .option('--lease-id <id>', 'lease ID')
    .option('--json', 'emit one run-response/1.0 envelope on stdout')
    .option('--workflow-root <path>', 'project root containing .workflow', process.cwd());

  addCanonicalRecoveryHelp(
    addTransitionOptions(session.command('resolve').description('Resolve one canonical paused recovery target; Session remains paused')),
    'resolve',
  )
    .option('--execution <id>', 'deprecated alias bridge to an exact Execution')
    .option('--expected-execution-revision <n>', 'expected Execution revision', parseNonNegativeInteger)
    .option('--decision <id>', 'escalated decision point ID')
    .option('--step <id>', 'failed chain step ID')
    .requiredOption('--disposition <value>', 'decision: proceed|retry; step: retry|skip')
    .action((opts: any) => {
      const root = resolve(opts.workflowRoot);
      let context: AliasExecutionContext | undefined;
      try {
        if (Boolean(opts.decision) === Boolean(opts.step)) throw new Error('exactly one of --decision or --step is required');
        const target = opts.decision
          ? { kind: 'decision' as const, id: opts.decision, disposition: opts.disposition }
          : { kind: 'step' as const, id: opts.step, disposition: opts.disposition };
        if (target.kind === 'decision' && !['proceed', 'retry'].includes(target.disposition)) throw new Error('decision disposition must be proceed|retry');
        if (target.kind === 'step' && !['retry', 'skip'].includes(target.disposition)) throw new Error('step disposition must be retry|skip');
        context = resolveAliasExecutionContext(root, opts.session, opts.execution);
        if (context.protocol) {
          if (!context.execution) throw new Error(`current Execution not found for Session ${context.sessionId}`);
          if (opts.expectedExecutionRevision === undefined) {
            throw new InvalidArgumentError('--expected-execution-revision is required for Execution resolve');
          }
          const result = resolveExecution(root, {
            sessionId: context.sessionId!,
            executionId: context.execution.execution_id,
            requestId: opts.requestId,
            expectedExecutionRevision: opts.expectedExecutionRevision,
            actor: opts.actor,
            reason: opts.reason,
            evidence: opts.evidence,
            target,
          });
          const warning = deprecationWarning('maestro session resolve', 'maestro execution resolve');
          if (opts.json) {
            emitExecutionSuccess({
              operation: 'execution-resolve', result, projectRoot: root, execution: result.execution,
              requestId: opts.requestId,
              replay: { replayed: result.replayed, transition_id: result.transition_id },
              warnings: [warning],
            });
          } else {
            console.error(`[maestro session] deprecated: ${warning.message}`);
            print(result);
          }
          return;
        }
        const result = resolveSession(root, opts.session, transitionOptions(opts, target));
        if (opts.json) {
          machineSuccess(
            'resolve',
            result,
            result.session_id,
            {
              request_id: result.request_id,
              transition_id: result.transition_id,
              status: result.replayed ? 'replayed' : 'applied',
            },
            result.next,
          );
        } else {
          print(result);
        }
      } catch (error) {
        const executionProtocol = context?.protocol ?? projectUsesExecutionProtocol(root, opts.session);
        if (opts.json && executionProtocol) {
          emitExecutionError({
            operation: 'execution-resolve', error, projectRoot: root,
            sessionId: context?.sessionId ?? opts.session,
            executionId: context?.execution?.execution_id ?? opts.execution,
            requestId: opts.requestId,
            ...(error instanceof InvalidArgumentError
              ? { exitCode: 2 as const, disposition: 'usage_error' as const, code: 'COMMANDER_USAGE' as const }
              : {}),
            warnings: [deprecationWarning('maestro session resolve', 'maestro execution resolve')],
          });
        } else if (opts.json) machineError('resolve', error, opts);
        else reportError(error);
      }
    });

  addCanonicalRecoveryHelp(
    addTransitionOptions(session.command('resume').description('Resume a canonical paused Session after every recovery blocker is cleared')),
    'resume',
  )
    .option('--execution <id>', 'deprecated alias bridge to an exact Execution')
    .option('--expected-execution-revision <n>', 'expected Execution revision', parseNonNegativeInteger)
    .option('--owner-id <id>', 'new Execution lease owner ID')
    .option('--owner-kind <kind>', 'new Execution lease owner kind', parseOwnerKind)
    .option('--expected-lease-epoch <n>', 'latest observed Execution lease epoch', parseNonNegativeInteger)
    .option('--claim-output <path>', 'write the private acquisition claim to a mode-0600 file')
    .action((opts: any) => {
      const root = resolve(opts.workflowRoot);
      let context: AliasExecutionContext | undefined;
      try {
        context = resolveAliasExecutionContext(root, opts.session, opts.execution);
        if (context.protocol) {
          if (!context.execution) throw new Error(`current Execution not found for Session ${context.sessionId}`);
          if (opts.expectedExecutionRevision === undefined || opts.expectedActivityRevision === undefined
            || opts.expectedLeaseEpoch === undefined || !opts.ownerId || !opts.ownerKind) {
            throw new InvalidArgumentError(
              '--expected-execution-revision, --expected-activity-revision, --expected-lease-epoch, '
              + '--owner-id, and --owner-kind are required for Execution resume',
            );
          }
          const result = resumeExecution(root, {
            sessionId: context.sessionId!,
            executionId: context.execution.execution_id,
            requestId: opts.requestId,
            expectedExecutionRevision: opts.expectedExecutionRevision,
            expectedActivityRevision: opts.expectedActivityRevision,
            expectedLeaseEpoch: opts.expectedLeaseEpoch,
            ownerId: opts.ownerId,
            ownerKind: opts.ownerKind,
            actor: opts.actor,
            reason: opts.reason,
            evidence: opts.evidence,
          });
          const warning = deprecationWarning('maestro session resume', 'maestro execution resume');
          if (opts.json) {
            emitExecutionSuccess({
              operation: 'execution-resume', result, projectRoot: root, execution: result.execution,
              requestId: opts.requestId,
              replay: { replayed: result.replayed, transition_id: result.transition_id },
              warnings: [warning],
            });
          } else {
            console.error(`[maestro session] deprecated: ${warning.message}`);
            printExecutionHuman(result, opts.claimOutput);
          }
          return;
        }
        const result = resumeSession(root, opts.session, transitionOptions(opts));
        if (opts.json) {
          machineSuccess(
            'resume',
            result,
            result.session_id,
            {
              request_id: result.request_id,
              transition_id: result.transition_id,
              status: result.replayed ? 'replayed' : 'applied',
            },
            result.next,
          );
        } else {
          print(result);
        }
      } catch (error) {
        const executionProtocol = context?.protocol ?? projectUsesExecutionProtocol(root, opts.session);
        if (opts.json && executionProtocol) {
          emitExecutionError({
            operation: 'execution-resume', error, projectRoot: root,
            sessionId: context?.sessionId ?? opts.session,
            executionId: context?.execution?.execution_id ?? opts.execution,
            requestId: opts.requestId,
            ...(error instanceof InvalidArgumentError
              ? { exitCode: 2 as const, disposition: 'usage_error' as const, code: 'COMMANDER_USAGE' as const }
              : {}),
            warnings: [deprecationWarning('maestro session resume', 'maestro execution resume')],
          });
        } else if (opts.json) machineError('resume', error, opts);
        else reportError(error);
      }
    });

  session
    .command('migrate')
    .description('Fold legacy ralph-meta.json and migrate to an explicitly selected Session schema')
    .option('--session <id>', 'migrate one Session; omit to migrate every Session under .workflow/sessions/')
    .option('--to <version>', 'target Session schema: session/1.3|session/2.0')
    .option('--workflow-root <path>', 'project root containing .workflow', process.cwd())
    .action((opts: { session?: string; to?: string; workflowRoot: string }) => {
      try {
        const root = resolve(opts.workflowRoot);
        if (opts.to && !['session/1.3', 'session/2.0'].includes(opts.to)) {
          throw new Error('--to must be session/1.3 or session/2.0');
        }
        const writer = new SessionStore(root).sessionSchemaSelection().writer;
        if (writer === 'session/2.0' && opts.to !== 'session/2.0') {
          throw new Error('session/2.0 migration requires explicit --to session/2.0');
        }
        if (opts.to === 'session/2.0' && writer !== 'session/2.0') {
          throw new Error('session/2.0 migration also requires explicit .workflow/config.json opt-in');
        }
        if (opts.to === 'session/1.3' && writer !== 'session/1.3') {
          throw new Error('project writer selection conflicts with --to session/1.3');
        }
        if (opts.session) {
          print(migrateSession(root, opts.session));
          return;
        }
        const results = migrateAllSessions(root);
        print(results);
        if (results.some(entry => entry.error)) process.exitCode = 1;
      } catch (error) {
        reportError(error);
      }
    });

  session
    .command('list')
    .description('List Sessions with compact chain/run status')
    .option('--status <status>', 'filter by status: running|paused|sealed|archived|failed')
    .option('--workflow-root <path>', 'project root containing .workflow', process.cwd())
    .action((opts: { status?: string; workflowRoot: string }) => {
      try {
        if (opts.status && !SESSION_STATUS_VALUES.includes(opts.status as SessionState['status'])) {
          throw new Error(`invalid --status "${opts.status}"`);
        }
        const status = opts.status as SessionState['status'] | undefined;
        const store = new SessionStore(resolve(opts.workflowRoot));
        const result: unknown[] = [];
        for (const candidate of store.listSessions().candidates) {
          const resolved = readResolvedSession(store, candidate.sessionId);
          if (status && resolved.derivedStatus !== status) continue;
          if (resolved.record.schema_version === 'session/2.0') {
            const identity = sessionStateV20Schema.parse(resolved.record);
            result.push({
              session_id: resolved.sessionId,
              schema_version: 'session/2.0',
              derived_status: resolved.derivedStatus,
              current_execution_id: identity.current_execution_id,
              latest_execution_id: identity.latest_execution_id,
              execution_status: (resolved.currentExecution ?? resolved.latestExecution)?.status ?? null,
              active_run_id: resolved.currentExecution?.active_run_id ?? null,
              archived_at: identity.archived_at,
              intent: identity.intent,
            });
            continue;
          }
          result.push({
            session_id: candidate.sessionId,
            schema_version: candidate.session.schema_version,
            status: candidate.session.status,
            engine: candidate.session.orchestration.engine,
            active_run_id: candidate.session.active_run_id,
            latest_completed_run_id: candidate.session.latest_completed_run_id,
            chain_total: candidate.session.orchestration.chain.length,
            pending_steps: candidate.session.orchestration.chain.filter(step => step.status === 'pending').length,
            intent: candidate.session.intent,
          });
        }
        print(result);
      } catch (error) {
        reportError(error);
      }
    });

  session
    .command('show <session-id>')
    .description('Show one Session state')
    .option('--workflow-root <path>', 'project root containing .workflow', process.cwd())
    .action((sessionId: string, opts: { workflowRoot: string }) => {
      try {
        const store = new SessionStore(resolve(opts.workflowRoot));
        const resolved = readResolvedSession(store, sessionId);
        print(resolved.record.schema_version === 'session/2.0'
          ? summarizeSession(resolve(opts.workflowRoot), resolved)
          : resolved.bundle.session);
      } catch (error) {
        reportError(error);
      }
    });

  const registerArchiveCommand = (operation: 'archive' | 'unarchive'): void => {
    session
      .command(operation)
      .description(`${operation === 'archive' ? 'Archive' : 'Unarchive'} a statusless session/2.0 identity with an audited CAS receipt`)
      .requiredOption('--session <id>', 'exact Session ID')
      .requiredOption('--request-id <id>', 'idempotent archive request ID')
      .requiredOption('--actor <name>', 'authorized actor')
      .requiredOption('--reason <text>', 'audit reason')
      .requiredOption('--evidence <ref>', 'nonempty evidence reference (repeatable)', collect)
      .requiredOption('--expected-identity-revision <n>', 'expected Session identity revision', parseNonNegativeInteger)
      .requiredOption('--expected-activity-revision <n>', 'expected Session activity revision', parseNonNegativeInteger)
      .option('--json', 'emit one run-response/1.1 envelope on stdout')
      .option('--workflow-root <path>', 'project root containing .workflow', process.cwd())
      .action((opts: {
        session: string;
        requestId: string;
        actor: string;
        reason: string;
        evidence: string[];
        expectedIdentityRevision: number;
        expectedActivityRevision: number;
        json?: boolean;
        workflowRoot: string;
      }) => {
        const root = resolve(opts.workflowRoot);
        try {
          const result = operation === 'archive'
            ? archiveSession(root, opts.session, opts)
            : unarchiveSession(root, opts.session, opts);
          const projectionWarning = ensureSessionProjectionOnDisk(root, opts.session, false);
          const output = {
            session: result.session,
            receipt: result.receipt,
            replayed: result.replayed,
            ...(projectionWarning ? { warning: projectionWarning } : {}),
          };
          if (opts.json) {
            statuslessMachineSuccess(
              operation === 'archive' ? 'session-archive' : 'session-unarchive',
              opts.session,
              output,
              result.session,
              opts.requestId,
              { replayed: result.replayed, transitionId: result.receipt.receipt_hash },
            );
          } else {
            print(output);
          }
        } catch (error) {
          if (opts.json) {
            statuslessMachineError(
              operation === 'archive' ? 'session-archive' : 'session-unarchive',
              error,
              opts,
            );
          } else {
            reportError(error);
          }
        }
      });
  };
  registerArchiveCommand('archive');
  registerArchiveCommand('unarchive');

  session
    .command('status [session-id]')
    .description('Show canonical status; --execution is a deprecated bridge to Execution status')
    .option('--execution <id>', 'exact Execution ID')
    .option('--stale-after-ms <n>', 'lease staleness threshold in milliseconds', parsePositiveInteger)
    .option('--json', 'emit run-response/1.1 only with --execution')
    .option('--workflow-root <path>', 'project root containing .workflow', process.cwd())
    .action((sessionId: string | undefined, opts: { execution?: string; staleAfterMs?: number; json?: boolean; workflowRoot: string }) => {
      try {
        const projectRoot = resolve(opts.workflowRoot);
        if (opts.execution) {
          if (!sessionId) throw new Error('[session-id] is required with --execution');
          const result = executionStatus(projectRoot, sessionId, opts.execution, { staleAfterMs: opts.staleAfterMs });
          const warning = deprecationWarning('maestro session status --execution', 'maestro execution status');
          if (opts.json) {
            emitExecutionSuccess({
              operation: 'execution-status', result, projectRoot, execution: result.execution,
              warnings: [warning],
            });
          } else {
            console.error(`[maestro session] deprecated: ${warning.message}`);
            print(result);
          }
          return;
        }
        if (opts.json) throw new Error('--json on session status requires --execution');
        const resolved = resolveCompatibleSession(projectRoot, sessionId);
        if (!resolved) throw new Error(sessionId ? `Session not found: ${sessionId}` : 'no compatible Session found');
        print(summarizeSession(projectRoot, resolved));
      } catch (error) {
        if (opts.json && opts.execution) {
          emitExecutionError({
            operation: 'execution-status', error, projectRoot: resolve(opts.workflowRoot),
            sessionId, executionId: opts.execution,
            warnings: [deprecationWarning('maestro session status --execution', 'maestro execution status')],
          });
        } else reportError(error);
      }
    });

  session
    .command('check [session-id]')
    .description('Validate canonical Session chain, Run bindings, and decision references')
    .option('--workflow-root <path>', 'project root containing .workflow', process.cwd())
    .action((sessionId: string | undefined, opts: { workflowRoot: string }) => {
      try {
        const root = resolve(opts.workflowRoot);
        const resolved = resolveCompatibleSession(root, sessionId);
        if (!resolved) throw new Error(sessionId ? `Session not found: ${sessionId}` : 'no compatible Session found');
        const findings = checkResolvedSession(root, resolved);
        const summary = summarizeSessionCheck(findings);
        print({ ok: summary.errors === 0, session_id: resolved.sessionId, ...summary, findings });
        if (summary.errors > 0) process.exitCode = 1;
      } catch (error) {
        reportError(error);
      }
    });

  session
    .command('evidence [session-id]')
    .description('Query the canonical Evidence Registry with resolved Artifact references')
    .option('--kind <kind>', 'filter by evidence kind')
    .option('--status <status>', 'filter by proposed|accepted|rejected|superseded')
    .option('--run <run-id>', 'filter by producer Run ID')
    .option('--point <point>', 'filter by decision/gate point')
    .option('--workflow-root <path>', 'project root containing .workflow', process.cwd())
    .action((sessionId: string | undefined, opts: {
      kind?: string;
      status?: string;
      run?: string;
      point?: string;
      workflowRoot: string;
    }) => {
      try {
        const resolved = resolveCompatibleSession(resolve(opts.workflowRoot), sessionId);
        if (!resolved) throw new Error(sessionId ? `Session not found: ${sessionId}` : 'no compatible Session found');
        if (opts.status && !['proposed', 'accepted', 'rejected', 'superseded'].includes(opts.status)) {
          throw new Error(`invalid --status "${opts.status}"`);
        }
        const records = Object.entries(resolved.bundle.evidence.records)
          .filter(([, record]) => !opts.kind || record.kind === opts.kind)
          .filter(([, record]) => !opts.status || record.status === opts.status)
          .filter(([, record]) => !opts.run || record.run_id === opts.run)
          .filter(([, record]) => !opts.point || record.point === opts.point)
          .map(([evidenceId, record]) => ({
            evidence_id: evidenceId,
            ...record,
            artifacts: record.artifact_refs.map(artifactId => ({
              artifact_id: artifactId,
              ...(resolved.bundle.artifacts.artifacts[artifactId] ?? { missing: true }),
            })),
          }));
        print({
          session_id: resolved.sessionId,
          registry_revision: resolved.bundle.evidence.revision,
          count: records.length,
          records,
        });
      } catch (error) {
        reportError(error);
      }
    });

  session
    .command('seal [session-id]')
    .description('Seal a legacy Session, auto-resolving the unique compatible Session, or bridge explicitly to Execution seal')
    .option('--summary <text>', 'human-readable seal summary', '')
    .option('--execution <id>', 'deprecated alias bridge to an exact Execution')
    .option('--request-id <id>', 'idempotent Execution seal request ID')
    .option('--expected-execution-revision <n>', 'expected Execution revision', parseNonNegativeInteger)
    .option('--expected-activity-revision <n>', 'expected Session activity revision', parseNonNegativeInteger)
    .option('--owner-id <id>', 'Execution lease owner ID')
    .option('--owner-kind <kind>', 'Execution lease owner kind', parseOwnerKind)
    .option('--lease-epoch <n>', 'Execution lease epoch', parsePositiveInteger)
    .option('--lease-id <token>', 'private Execution lease token')
    .option('--actor <name>', 'authorized actor')
    .option('--reason <text>', 'audit reason')
    .option('--evidence <ref>', 'evidence reference (repeatable)', collect)
    .option('--outcome <value>', 'done|done_with_concerns|failed', 'done')
    .option('--json', 'emit run-response/1.0, or 1.1 with --execution')
    .option('--workflow-root <path>', 'project root containing .workflow', process.cwd())
    .action((sessionId: string | undefined, opts: {
      summary: string;
      execution?: string;
      requestId?: string;
      expectedExecutionRevision?: number;
      expectedActivityRevision?: number;
      ownerId?: string;
      ownerKind?: ExecutionOwnerKind;
      leaseEpoch?: number;
      leaseId?: string;
      actor?: string;
      reason?: string;
      evidence?: string[];
      outcome: string;
      json?: boolean;
      workflowRoot: string;
    }) => {
      const root = resolve(opts.workflowRoot);
      let targetSessionId = sessionId;
      let executionId = opts.execution;
      let executionProtocol = false;
      const warning = deprecationWarning('maestro session seal', 'maestro execution seal');
      try {
        const resolved = resolveCompatibleSession(root, sessionId);
        if (!resolved) {
          throw new Error(sessionId ? `Session not found: ${sessionId}` : 'no unique compatible Session found');
        }
        targetSessionId = resolved.sessionId;
        const store = new SessionStore(root);
        const replayExecutionId = resolveSessionSealReplay(store, targetSessionId, opts.requestId);
        const sessionRecord = store.readSessionRecord(targetSessionId);
        if (opts.execution) {
          executionProtocol = true;
        } else if (sessionRecord.schema_version === 'session/2.0') {
          executionProtocol = true;
          const identity = sessionStateV20Schema.parse(sessionRecord);
          executionId = identity.current_execution_id ?? replayExecutionId;
          if (identity.current_execution_id) {
            const current = store.readOpenExecution(targetSessionId);
            if (!current || current.execution_id !== executionId) {
              throw new Error(
                `Session ${targetSessionId} current Execution pointer is inconsistent: ${executionId}`,
              );
            }
          }
        } else {
          const current = store.readOpenExecution(targetSessionId);
          executionId = current?.execution_id ?? replayExecutionId;
          executionProtocol = Boolean(executionId) || store.listExecutions(targetSessionId).length > 0;
        }

        if (executionProtocol) {
          if (!executionId) throw new Error(`Execution not found for Session ${targetSessionId}`);
          if (!opts.requestId || opts.expectedExecutionRevision === undefined
            || opts.expectedActivityRevision === undefined || !opts.ownerId || !opts.ownerKind
            || opts.leaseEpoch === undefined || !opts.leaseId || !opts.actor || !opts.reason
            || !opts.evidence?.length) {
            throw new InvalidArgumentError(
              '--request-id, --expected-execution-revision, --expected-activity-revision, '
              + 'the full lease tuple, --actor, --reason, and at least one --evidence are required',
            );
          }
          if (!['done', 'done_with_concerns', 'failed'].includes(opts.outcome)) {
            throw new InvalidArgumentError('outcome must be done|done_with_concerns|failed');
          }
          const result = sealExecution(root, {
            sessionId: targetSessionId,
            executionId,
            requestId: opts.requestId,
            expectedExecutionRevision: opts.expectedExecutionRevision,
            expectedActivityRevision: opts.expectedActivityRevision,
            lease: executionLeaseClaim({
              ownerId: opts.ownerId,
              ownerKind: opts.ownerKind,
              leaseEpoch: opts.leaseEpoch,
              leaseId: opts.leaseId,
            }),
            summary: opts.summary,
            outcome: opts.outcome as 'done' | 'done_with_concerns' | 'failed',
            actor: opts.actor,
            reason: opts.reason,
            evidence: opts.evidence,
          });
          if (opts.json) {
            emitExecutionSuccess({
              operation: 'execution-seal', result, projectRoot: root, execution: result.execution,
              requestId: opts.requestId,
              replay: { replayed: result.replayed, transition_id: result.transition_id },
              warnings: [warning],
            });
          } else {
            console.error(`[maestro session] deprecated: ${warning.message}`);
            print(result);
          }
          return;
        }

        const result = sealSession(root, targetSessionId, opts.summary);
        if (opts.json) machineSuccess('seal-session', result, targetSessionId);
        else print(result);
      } catch (error) {
        if (opts.json && executionProtocol) {
          emitExecutionError({
            operation: 'execution-seal', error, projectRoot: root, sessionId: targetSessionId, executionId,
            requestId: opts.requestId,
            ...(error instanceof InvalidArgumentError
              ? { exitCode: 2 as const, disposition: 'usage_error' as const, code: 'COMMANDER_USAGE' as const }
              : error instanceof Error && /different execution-seal inputs/i.test(error.message)
                ? { code: 'REQUEST_CONFLICT' as const }
                : {}),
            warnings: [warning],
          });
        } else if (opts.json) machineError('seal-session', error, { session: targetSessionId });
        else reportError(error);
      }
    });

  session
    .command('create <topic>')
    .description('Create a Session; use --chain <cmd...> for a simple command chain, --chain-file for advanced JSON')
    .option('--intent <text>', 'session intent; defaults to <topic>')
    .option('--id <slug>', 'explicit Session ID/slug; defaults to slugified <topic>')
    .option('--chain <commands...>', 'simple chain command names, e.g. --chain learn odyssey-planex odyssey-review')
    .option('--chain-file <path>', 'advanced chain definition JSON file; "-" reads stdin')
    .option('--platform <name>', 'target platform persisted for chain Runs')
    .option('--engine <name>', 'orchestration engine: ralph|coordinator|manual')
    .option('--quality <mode>', 'quality mode: quick|standard|full')
    .option('--auto', 'enable auto mode')
    .option('--request-id <id>', 'idempotent Execution start request ID')
    .option('--expected-identity-revision <n>', 'expected Session identity revision', parseNonNegativeInteger)
    .option('--expected-activity-revision <n>', 'expected Session activity revision', parseNonNegativeInteger)
    .option('--owner-id <id>', 'Execution lease owner ID')
    .option('--owner-kind <kind>', 'Execution lease owner kind', parseOwnerKind)
    .option('--expected-lease-epoch <n>', 'latest observed Execution lease epoch', parseNonNegativeInteger)
    .option('--actor <name>', 'authorized actor')
    .option('--reason <text>', 'audit reason')
    .option('--evidence <ref>', 'evidence reference (repeatable)', collect)
    .option('--claim-output <path>', 'write a human-mode acquisition claim to a private file')
    .option('--json', 'emit run-response/1.0, or 1.1 for session/2.0')
    .option('--workflow-root <path>', 'project root containing .workflow', process.cwd())
    .action(async (topic: string, opts: {
      intent?: string;
      id?: string;
      chain?: string[];
      chainFile?: string;
      platform?: string;
      engine?: string;
      quality?: string;
      auto?: boolean;
      requestId?: string;
      expectedIdentityRevision?: number;
      expectedActivityRevision?: number;
      ownerId?: string;
      ownerKind?: ExecutionOwnerKind;
      expectedLeaseEpoch?: number;
      actor?: string;
      reason?: string;
      evidence?: string[];
      claimOutput?: string;
      json?: boolean;
      workflowRoot: string;
    }) => {
      try {
        const root = resolve(opts.workflowRoot);
        if (opts.engine && !['ralph', 'coordinator', 'manual'].includes(opts.engine)) {
          throw new Error(`invalid --engine "${opts.engine}" (ralph|coordinator|manual)`);
        }
        if (opts.quality && !['quick', 'standard', 'full'].includes(opts.quality)) {
          throw new Error(`invalid --quality "${opts.quality}" (quick|standard|full)`);
        }
        const platform = opts.platform ? targetPlatformSchema.parse(opts.platform) : undefined;
        if (opts.chainFile && (opts.chain?.length ?? 0) > 0) {
          throw new Error('use either --chain or --chain-file, not both');
        }
        const intent = opts.intent ?? topic;
        const fallbackSlug = opts.chain?.length ? opts.chain.join('-') : 'session';
        const slug = opts.id ?? (opts.intent ? topic : slugifySessionTopic(topic, slugifySessionTopic(fallbackSlug)));
        const definition = opts.chainFile
          ? await loadChainDefinition(opts.chainFile)
          : simpleChainDefinition(intent, opts.chain);
        const store = new SessionStore(root);
        if (store.sessionSchemaSelection().writer === 'session/2.0') {
          if (definition) {
            const missing = [
              ['--request-id', opts.requestId],
              ['--expected-identity-revision', opts.expectedIdentityRevision],
              ['--expected-activity-revision', opts.expectedActivityRevision],
              ['--expected-lease-epoch', opts.expectedLeaseEpoch],
              ['--owner-id', opts.ownerId],
              ['--owner-kind', opts.ownerKind],
              ['--actor', opts.actor],
              ['--reason', opts.reason],
              ['--evidence', opts.evidence?.length ? opts.evidence : undefined],
            ].filter(([, value]) => value === undefined || value === '');
            if (missing.length > 0) {
              throw new InvalidArgumentError(`session create --chain requires ${missing.map(([flag]) => flag).join(', ')}`);
            }
            throw new InvalidArgumentError(
              'fresh session/2.0 multi-step chain initialization requires a canonical Execution chain operation',
            );
          }
          if (opts.engine || opts.quality || opts.auto || platform) {
            throw new Error(
              'session/2.0 create is identity-only; engine, quality, auto, and platform belong to an Execution',
            );
          }
          const sessionId = deriveSessionId(slug);
          store.createSession(sessionId, intent, { ifExists: 'error' });
          const rawRecord = store.readSessionRecord(sessionId);
          if (rawRecord.schema_version !== 'session/2.0') {
            throw new Error('statusless Session writer did not persist session/2.0');
          }
          const record = sessionStateV20Schema.parse(rawRecord);
          const projectionWarning = ensureSessionProjectionOnDisk(root, sessionId);
          const output = {
            session_id: sessionId,
            session_dir: store.sessionDir(sessionId),
            schema_version: record.schema_version,
            current_execution_id: record.current_execution_id,
            latest_execution_id: record.latest_execution_id,
            next: `maestro execution start --session ${sessionId}`,
            ...(projectionWarning ? { warning: projectionWarning } : {}),
          };
          if (opts.json) statuslessMachineSuccess('session-create', sessionId, output, record);
          else print(output);
          return;
        }
        if (definition && opts.requestId) {
          const missing = [
            ['--expected-identity-revision', opts.expectedIdentityRevision],
            ['--expected-activity-revision', opts.expectedActivityRevision],
            ['--expected-lease-epoch', opts.expectedLeaseEpoch],
            ['--owner-id', opts.ownerId],
            ['--owner-kind', opts.ownerKind],
            ['--actor', opts.actor],
            ['--reason', opts.reason],
            ['--evidence', opts.evidence?.length ? opts.evidence : undefined],
          ].filter(([, value]) => value === undefined || value === '');
          if (missing.length > 0) {
            throw new InvalidArgumentError(`session create --chain requires ${missing.map(([flag]) => flag).join(', ')}`);
          }
        }
        const result = createChainSession(root, slug, {
          intent,
          engine: opts.engine as 'ralph' | 'coordinator' | 'manual' | undefined,
          qualityMode: opts.quality as 'quick' | 'standard' | 'full' | undefined,
          autoMode: opts.auto,
          executor: platform ? { platform, cli_tool: platform } : undefined,
          definition,
        });
        if (definition && opts.requestId) {
          const started = startExecution(root, result.sessionId, {
            requestId: opts.requestId, ownerId: opts.ownerId!, ownerKind: opts.ownerKind!,
            expectedIdentityRevision: opts.expectedIdentityRevision,
            expectedActivityRevision: opts.expectedActivityRevision,
            expectedLeaseEpoch: opts.expectedLeaseEpoch,
            actor: opts.actor, reason: opts.reason, evidence: opts.evidence,
          });
          const output = {
            session_id: result.sessionId, session_dir: result.sessionDir,
            chain: chainSummary(definition.steps), execution: started.execution,
            lease_claim: started.lease_claim,
          };
          const warning = deprecationWarning(
            'maestro session create --chain',
            'maestro session create + maestro execution start',
          );
          if (opts.json) {
            emitExecutionSuccess({
              operation: 'execution-start', result: output, projectRoot: root, execution: started.execution,
              requestId: opts.requestId,
              replay: { replayed: started.replayed, transition_id: started.transition_id },
              warnings: [warning],
            });
          } else {
            console.error(`[maestro session] deprecated: ${warning.message}`);
            printExecutionHuman(output, opts.claimOutput, 'lease_claim', root);
          }
          return;
        }
        const projectionWarning = ensureSessionProjectionOnDisk(root, result.sessionId);
        const output = {
          session_id: result.sessionId,
          session_dir: result.sessionDir,
          engine: result.session.orchestration.engine,
          chain: definition ? chainSummary(definition.steps) : persistedChainSummary(result.session),
          next: `maestro session next --session ${result.sessionId}`,
          ...(projectionWarning ? { warning: projectionWarning } : {}),
        };
        if (opts.json) machineSuccess('create', output, result.sessionId);
        else print(output);
      } catch (error) {
        if (opts.json) {
          let statusless = false;
          try {
            statusless = new SessionStore(resolve(opts.workflowRoot)).sessionSchemaSelection().writer === 'session/2.0';
          } catch {
            // The invalid config error is still returned without stderr.
          }
          if (statusless && (opts.chainFile || (opts.chain?.length ?? 0) > 0)) {
            emitExecutionError({
              operation: 'execution-start', error, projectRoot: resolve(opts.workflowRoot),
              requestId: opts.requestId,
              ...(error instanceof InvalidArgumentError
                ? { exitCode: 2 as const, disposition: 'usage_error' as const, code: 'COMMANDER_USAGE' as const }
                : {}),
              warnings: [deprecationWarning(
                'maestro session create --chain',
                'maestro session create + maestro execution start',
              )],
            });
          } else if (statusless) statuslessMachineError('session-create', error, { session: opts.id });
          else machineError('create', error, { session: opts.id });
        } else {
          reportError(error);
        }
      }
    });

  session
    .command('start [intent...]')
    .description('Create a Session and dispatch the first step (single-step or chain)')
    .option('--chain <commands...>', 'command chain, e.g. --chain companion or --chain analyze execute review')
    .option('--chain-file <path>', 'advanced chain definition JSON; "-" reads stdin')
    .option('--id <slug>', 'explicit Session ID/slug')
    .option('--session <id>', 'existing Session ID for a single Run (no chain creation)')
    .option('--topic <text>', 'command-independent Session topic; defaults to intent')
    .option('--arg <value>', 'command input stored in Run input.args (repeatable)', (v: string, p: string[] = []) => [...p, v], [])
    .option('--platform <name>', 'target platform persisted for this Run')
    .option('--no-dispatch', 'create the Session but do not run the first step')
    .option('--engine <name>', 'orchestration engine: ralph|coordinator|manual')
    .option('--quality <mode>', 'quality mode: quick|standard|full')
    .option('--auto', 'enable auto mode')
    .option('--execution <id>', 'exact Execution ID; otherwise resolve the unique current Execution')
    .option('--generation <n>', 'exact Execution generation', parsePositiveInteger)
    .option('--request-id <id>', 'idempotent Execution transition request ID')
    .option('--expected-execution-revision <n>', 'expected current Execution revision', parseNonNegativeInteger)
    .option('--expected-identity-revision <n>', 'expected Session identity revision', parseNonNegativeInteger)
    .option('--expected-activity-revision <n>', 'expected Session activity revision', parseNonNegativeInteger)
    .option('--owner-id <id>', 'Execution lease owner ID')
    .option('--owner-kind <kind>', 'Execution lease owner kind', parseOwnerKind)
    .option('--lease-epoch <n>', 'current Execution lease epoch', parsePositiveInteger)
    .option('--lease-id <token>', 'private Execution lease token')
    .option('--expected-lease-epoch <n>', 'latest observed lease epoch when starting an Execution', parseNonNegativeInteger)
    .option('--actor <name>', 'authorized actor')
    .option('--reason <text>', 'audit reason')
    .option('--evidence <ref>', 'evidence reference (repeatable)', collect)
    .option('--claim-output <path>', 'write a human-mode acquisition claim to a private file')
    .option('--json', 'emit run-response/1.1 for Execution authority')
    .option('--workflow-root <path>', 'project root containing .workflow', process.cwd())
    .action((intentParts: string[], opts: any) => {
      const root = resolve(opts.workflowRoot);
      let context: AliasExecutionContext | undefined;
      try {
        const intent = intentParts.join(' ').trim() || opts.topic || opts.chain?.join(' -> ') || '';
        if (!intent && !opts.session) throw new Error('session start requires an intent or --session');
        const platform = opts.platform ? targetPlatformSchema.parse(opts.platform) : undefined;
        const storeBeforeResolution = new SessionStore(root);
        if (opts.session && !storeBeforeResolution.sessionExists(opts.session)) {
          throw new Error(
            `Session not found: ${opts.session}. `
            + '--session references an existing Session; to create a new Session with an explicit ID, use --id <slug>',
          );
        }
        const createStatuslessIdentity = storeBeforeResolution.sessionSchemaSelection().writer === 'session/2.0'
          && !opts.session && storeBeforeResolution.listSessionsReadOnly().candidates.length === 0;
        if (createStatuslessIdentity) {
          if (opts.chainFile || (opts.chain?.length ?? 0) > 1) {
            throw new InvalidArgumentError(
              'fresh statusless session start supports one command; multi-step chain initialization requires a canonical Execution chain operation',
            );
          }
          const missing = [
            ['--request-id', opts.requestId],
            ['--expected-identity-revision', opts.expectedIdentityRevision],
            ['--expected-activity-revision', opts.expectedActivityRevision],
            ['--expected-lease-epoch', opts.expectedLeaseEpoch],
            ['--owner-id', opts.ownerId],
            ['--owner-kind', opts.ownerKind],
            ['--actor', opts.actor],
            ['--reason', opts.reason],
            ['--evidence', opts.evidence?.length ? opts.evidence : undefined],
          ].filter(([, value]) => value === undefined || value === '');
          if (missing.length > 0) {
            throw new InvalidArgumentError(`Execution start requires ${missing.map(([flag]) => flag).join(', ')}`);
          }
          const fallbackSlug = opts.chain?.length ? opts.chain.join('-') : 'session';
          const slug = opts.id ?? slugifySessionTopic(intent, slugifySessionTopic(fallbackSlug));
          const sessionId = deriveSessionId(slug);
          storeBeforeResolution.createSession(sessionId, intent, { ifExists: 'error' });
          opts.session = sessionId;
        }
        context = resolveAliasExecutionContext(root, opts.session, opts.execution);

        if (context.protocol) {
          if (!context.sessionId) throw new Error('Execution Session could not be resolved');
          const startAliasReplay = Boolean(
            context.execution && opts.requestId
            && new SessionStore(root).readExecutionTransition(
              context.sessionId, context.execution.execution_id, opts.requestId,
            )?.payload.operation === 'execution-start',
          );
          if (opts.chainFile || (opts.chain?.length ?? 0) > 1) {
            throw new InvalidArgumentError('session start cannot replace the chain of a statusless/current Execution; use run next');
          }
          if (!context.execution || startAliasReplay) {
            const missing = [
              ['--request-id', opts.requestId],
              ['--expected-identity-revision', opts.expectedIdentityRevision],
              ['--expected-activity-revision', opts.expectedActivityRevision],
              ['--expected-lease-epoch', opts.expectedLeaseEpoch],
              ['--owner-id', opts.ownerId],
              ['--owner-kind', opts.ownerKind],
              ['--actor', opts.actor],
              ['--reason', opts.reason],
              ['--evidence', opts.evidence?.length ? opts.evidence : undefined],
            ].filter(([, value]) => value === undefined || value === '');
            if (missing.length > 0) {
              throw new InvalidArgumentError(`Execution start requires ${missing.map(([flag]) => flag).join(', ')}`);
            }
            const started = startExecution(root, context.sessionId, {
              requestId: opts.requestId, ownerId: opts.ownerId, ownerKind: opts.ownerKind,
              expectedIdentityRevision: opts.expectedIdentityRevision,
              expectedActivityRevision: opts.expectedActivityRevision,
              expectedLeaseEpoch: opts.expectedLeaseEpoch,
              actor: opts.actor, reason: opts.reason, evidence: opts.evidence,
            });
            let dispatched: unknown = null;
            if (opts.dispatch) {
              const lease = {
                ownerId: started.lease_claim.owner_id,
                ownerKind: started.lease_claim.owner_kind,
                epoch: started.lease_claim.epoch,
                leaseId: started.lease_claim.lease_id,
              };
              if (opts.chain?.length === 1) {
                dispatched = createExecutionRun({
                  projectRoot: root, command: opts.chain[0], sessionId: context.sessionId,
                  intent, topic: opts.topic, platform, args: opts.arg,
                  executionId: started.execution.execution_id, generation: started.execution.generation,
                  expectedExecutionRevision: 1, executionLease: lease,
                  requestId: `${opts.requestId}-create`,
                });
              } else {
                const next = runNextExecutionStep(root, {
                  sessionId: context.sessionId, executionId: started.execution.execution_id,
                  generation: started.execution.generation, expectedExecutionRevision: 1,
                  executionLease: lease, requestId: `${opts.requestId}-next`,
                  args: opts.arg.length > 0 ? opts.arg : undefined, json: opts.json,
                });
                if (next.exitCode !== 0) throw new Error(next.message);
                dispatched = next.result;
              }
            }
            const result = { ...started, dispatched };
            const execution = new SessionStore(root).readExecution(
              context.sessionId, started.execution.execution_id,
            );
            const warning = deprecationWarning('maestro session start', 'maestro execution start');
            if (opts.json) {
              emitExecutionSuccess({
                operation: 'execution-start', result, projectRoot: root, execution,
                requestId: opts.requestId,
                replay: { replayed: started.replayed, transition_id: started.transition_id },
                warnings: [warning],
              });
            } else {
              console.error(`[maestro session] deprecated: ${warning.message}`);
              printExecutionHuman(result, opts.claimOutput, 'lease_claim', root);
            }
            return;
          }

          const authority = aliasExecutionAuthority(context, opts);
          const store = new SessionStore(root);
          const wasPresent = Boolean(store.readExecutionTransition(
            authority.sessionId, authority.execution.execution_id, authority.requestId,
          ));
          const command = opts.chain?.length === 1 ? opts.chain[0] : null;
          const warning = deprecationWarning(
            'maestro session start', command ? 'maestro run create' : 'maestro run next',
          );
          if (command) {
            const result = createExecutionRun({
              projectRoot: root, command, sessionId: authority.sessionId, intent,
              topic: opts.topic, platform, args: opts.arg,
              executionId: authority.execution.execution_id,
              generation: authority.execution.generation,
              expectedExecutionRevision: authority.expectedExecutionRevision,
              executionLease: authority.lease, requestId: authority.requestId,
            });
            const execution = store.readExecution(authority.sessionId, authority.execution.execution_id);
            if (opts.json) {
              emitExecutionSuccess({
                operation: 'create', result, projectRoot: root, execution,
                requestId: authority.requestId,
                replay: aliasExecutionReplay(root, authority, wasPresent), warnings: [warning],
              });
            } else {
              console.error(`[maestro session] deprecated: ${warning.message}`);
              print(result);
            }
            return;
          }
          if (!opts.dispatch) throw new InvalidArgumentError('--no-dispatch is not valid for a current Execution');
          const next = runNextExecutionStep(root, {
            sessionId: authority.sessionId, executionId: authority.execution.execution_id,
            generation: authority.execution.generation,
            expectedExecutionRevision: authority.expectedExecutionRevision,
            executionLease: authority.lease, requestId: authority.requestId,
            args: opts.arg.length > 0 ? opts.arg : undefined, json: opts.json,
          });
          if (opts.json && next.exitCode === 0 && next.result) {
            emitExecutionSuccess({
              operation: 'next', result: next.result, projectRoot: root,
              execution: store.readExecution(authority.sessionId, authority.execution.execution_id),
              requestId: authority.requestId,
              replay: aliasExecutionReplay(root, authority, wasPresent), warnings: [warning],
            });
          } else if (opts.json) {
            emitExecutionError({
              operation: 'next', error: new Error(next.message), projectRoot: root,
              sessionId: authority.sessionId, executionId: authority.execution.execution_id,
              requestId: authority.requestId, exitCode: next.exitCode as 1 | 2 | 3,
              disposition: next.exitCode === 1 ? 'domain_error' : 'control_flow',
              code: next.reasonCode as never, warnings: [warning],
            });
          } else {
            console.error(`[maestro session] deprecated: ${warning.message}`);
            const stream = next.exitCode === 0 ? process.stdout : process.stderr;
            stream.write(`${next.message}\n`);
            if (next.exitCode !== 0) process.exitCode = next.exitCode;
          }
          return;
        }

        // Single-Run mode: --session + exactly one --chain command, no chain-file
        if (opts.session && opts.chain?.length === 1 && !opts.chainFile) {
          const result = createRun({
            projectRoot: root,
            command: opts.chain[0],
            sessionId: opts.session,
            intent,
            topic: opts.topic,
            platform,
            args: opts.arg,
          });
          print(result);
          return;
        }

        // Chain mode: create Session + optionally dispatch first step
        if (opts.chainFile && (opts.chain?.length ?? 0) > 0) {
          throw new Error('use either --chain or --chain-file, not both');
        }
        if (opts.session && ((opts.chain?.length ?? 0) > 0 || opts.chainFile)) {
          throw new Error('--session is for single Run start; use `maestro session chain insert` or `maestro run edit` to add steps to an existing Session');
        }
        if (opts.engine && !['ralph', 'coordinator', 'manual'].includes(opts.engine)) {
          throw new Error(`invalid --engine "${opts.engine}" (ralph|coordinator|manual)`);
        }
        if (opts.quality && !['quick', 'standard', 'full'].includes(opts.quality)) {
          throw new Error(`invalid --quality "${opts.quality}" (quick|standard|full)`);
        }
        const definition = opts.chainFile
          ? parseChainDefinition(
              opts.chainFile === '-' ? readFileSync(0, 'utf8') : readFileSync(resolve(opts.chainFile), 'utf8'),
              'chain-file',
            )
          : simpleChainDefinition(intent, opts.chain);
        const fallbackSlug = opts.chain?.length ? opts.chain.join('-') : 'session';
        const slug = opts.id ?? slugifySessionTopic(intent, slugifySessionTopic(fallbackSlug));
        const created = createChainSession(root, slug, {
          intent,
          topic: opts.topic,
          engine: opts.engine as 'ralph' | 'coordinator' | 'manual' | undefined,
          qualityMode: opts.quality as 'quick' | 'standard' | 'full' | undefined,
          autoMode: opts.auto,
          executor: platform ? { platform, cli_tool: platform } : undefined,
          definition,
        });
        const result: Record<string, unknown> = {
          session_id: created.sessionId,
          session_dir: created.sessionDir,
          engine: created.session.orchestration.engine,
          chain: definition ? chainSummary(definition.steps) : persistedChainSummary(created.session),
          next: `maestro session next --session ${created.sessionId}`,
        };
        if (opts.dispatch) {
          const next = runNextStep(root, { sessionId: created.sessionId, args: opts.arg.length > 0 ? opts.arg : undefined });
          result.dispatched = next.result;
          result.message = next.message;
          if (next.exitCode !== 0) process.exitCode = next.exitCode;
        } else {
          const projectionWarning = ensureSessionProjectionOnDisk(root, created.sessionId);
          if (projectionWarning) result.warning = projectionWarning;
        }
        print(result);
      } catch (error) {
        const executionProtocol = context?.protocol ?? projectUsesExecutionProtocol(root, opts.session);
        if (opts.json && executionProtocol) {
          const operation = context?.execution
            ? (opts.chain?.length === 1 ? 'create' : 'next')
            : 'execution-start';
          emitExecutionError({
            operation, error, projectRoot: root,
            sessionId: context?.sessionId ?? opts.session,
            executionId: context?.execution?.execution_id ?? opts.execution,
            requestId: opts.requestId,
            ...(error instanceof InvalidArgumentError
              ? { exitCode: 2 as const, disposition: 'usage_error' as const, code: 'COMMANDER_USAGE' as const }
              : {}),
            warnings: [deprecationWarning(
              'maestro session start', context?.execution
                ? (opts.chain?.length === 1 ? 'maestro run create' : 'maestro run next')
                : 'maestro execution start',
            )],
          });
        } else {
          reportError(error);
        }
      }
    });

  const chain = session
    .command('chain')
    .description('Edit a Session chain (insert / skip / replace pending steps)');

  addMutationOptions(chain
    .command('insert'))
    .description('Insert a pending step after another step (step_id or index). Cannot insert before the active position')
    .requiredOption('--session <id>', 'Session ID')
    .requiredOption('--after <step_id|index>', 'insert after this step (step_id or numeric index)')
    .requiredOption('--command <cmd>', 'command for the new step')
    .option('--args <text>', 'step args string')
    .option('--stage <name>', 'stage label')
    .option('--goal-ref <id>', 'goal reference id')
    .option('--decision-ref <id>', 'mark as a decision node gating this decision point')
    .option('--inserted-by <actor>', 'who inserted the step (e.g. a decision gate name)', 'manual')
    .option('--workflow-root <path>', 'project root containing .workflow', process.cwd())
    .action((opts: {
      session: string;
      after: string;
      command: string;
      args?: string;
      stage?: string;
      goalRef?: string;
      decisionRef?: string;
      insertedBy: string;
      json?: boolean;
      workflowRoot: string;
    }) => {
      try {
        const step = insertChainStep(resolve(opts.workflowRoot), opts.session, {
          after: opts.after,
          command: opts.command,
          args: opts.args,
          stage: opts.stage,
          goalRef: opts.goalRef,
          decisionRef: opts.decisionRef,
          insertedBy: opts.insertedBy,
          transition: mutationTransitionOptions(opts),
        });
        const result = { session_id: opts.session, inserted: step };
        if (opts.json) machineSuccess('chain-insert', result, opts.session, step.transition);
        else print(result);
      } catch (error) {
        if (opts.json) machineError('chain-insert', error, opts); else reportError(error);
      }
    });

  addMutationOptions(chain
    .command('skip'))
    .description('Skip a pending chain step (marks status=skipped; only pending steps)')
    .requiredOption('--session <id>', 'Session ID')
    .requiredOption('--step <step_id>', 'step to skip')
    .option('--workflow-root <path>', 'project root containing .workflow', process.cwd())
    .action((opts: { session: string; step: string; requestId?: string; json?: boolean; workflowRoot: string }) => {
      try {
        const step = skipChainStep(resolve(opts.workflowRoot), opts.session, opts.step, mutationTransitionOptions(opts));
        const result = { session_id: opts.session, skipped: step };
        if (opts.json) machineSuccess('chain-skip', result, opts.session, step.transition);
        else print(result);
      } catch (error) {
        if (opts.json) machineError('chain-skip', error, opts); else reportError(error);
      }
    });

  addMutationOptions(chain
    .command('replace'))
    .description('Replace fields of a pending chain step in place (only pending steps)')
    .requiredOption('--session <id>', 'Session ID')
    .requiredOption('--step <step_id>', 'step to replace')
    .option('--command <cmd>', 'new command (regenerates step_id)')
    .option('--args <text>', 'new args string')
    .option('--stage <name>', 'new stage label')
    .option('--goal-ref <id>', 'new goal reference id')
    .option('--workflow-root <path>', 'project root containing .workflow', process.cwd())
    .action((opts: {
      session: string;
      step: string;
      command?: string;
      args?: string;
      stage?: string;
      goalRef?: string;
      requestId?: string;
      json?: boolean;
      workflowRoot: string;
    }) => {
      try {
        const step = replaceChainStep(resolve(opts.workflowRoot), opts.session, opts.step, {
          command: opts.command,
          args: opts.args,
          stage: opts.stage,
          goalRef: opts.goalRef,
          transition: mutationTransitionOptions(opts),
        });
        const result = { session_id: opts.session, replaced: step };
        if (opts.json) machineSuccess('chain-replace', result, opts.session, step.transition);
        else print(result);
      } catch (error) {
        if (opts.json) machineError('chain-replace', error, opts); else reportError(error);
      }
    });

  const meta = session
    .command('meta')
    .description('Update session orchestration meta (position / decomposition)');

  addMutationOptions(meta
    .command('update'))
    .description('Integral-replace orchestration.position and/or decomposition (schema-validated). At least one --*-file required')
    .requiredOption('--session <id>', 'Session ID')
    .option('--position-file <path>', 'position block JSON file; "-" reads stdin')
    .option('--decomposition-file <path>', 'decomposition block JSON file; "-" reads stdin')
    .option('--workflow-root <path>', 'project root containing .workflow', process.cwd())
    .action(async (opts: {
      session: string;
      positionFile?: string;
      decompositionFile?: string;
      requestId?: string;
      json?: boolean;
      workflowRoot: string;
    }) => {
      try {
        if (!opts.positionFile && !opts.decompositionFile) {
          throw new Error('at least one of --position-file / --decomposition-file is required');
        }
        // `-` may appear at most once (a single stdin stream can not feed both).
        if (opts.positionFile === '-' && opts.decompositionFile === '-') {
          throw new Error('only one block may read stdin ("-"); pass a file path for the other');
        }
        const update: { position?: ReturnType<typeof parsePositionInput>; decomposition?: ReturnType<typeof parseDecompositionInput> } = {};
        if (opts.positionFile) {
          update.position = parsePositionInput(await readJson(opts.positionFile, 'position-file'));
        }
        if (opts.decompositionFile) {
          update.decomposition = parseDecompositionInput(await readJson(opts.decompositionFile, 'decomposition-file'));
        }
        const result = updateSessionMeta(resolve(opts.workflowRoot), opts.session, {
          ...update,
          transition: mutationTransitionOptions(opts),
        });
        if (opts.json) machineSuccess('meta-update', result, opts.session, result.transition);
        else print(result);
      } catch (error) {
        if (opts.json) machineError('meta-update', error, opts); else reportError(error);
      }
    });

  // ── Step-driving commands (migrated from maestro run) ─────────────────────

  const VALID_VERDICTS: CompletionVerdict[] = ['done', 'done-with-concerns', 'needs-retry', 'blocked'];
  /** Ready-vocabulary aliases (report frontmatter layer) mapped onto the
   * chain-advance vocabulary: ready→done, ready_with_concerns→done-with-concerns,
   * failed→needs-retry. `blocked` exists in both and needs no alias. */
  const VERDICT_ALIASES: Readonly<Record<string, CompletionVerdict>> = {
    ready: 'done',
    'ready-with-concerns': 'done-with-concerns',
    failed: 'needs-retry',
  };
  const VERDICT_ALIAS_LABEL = 'aliases: ready|ready_with_concerns|failed';
  const parseVerdict = (raw: string | undefined): CompletionVerdict | null => {
    if (!raw) return 'done';
    const normalized = raw.trim().toLowerCase().replace(/_/g, '-');
    if ((VALID_VERDICTS as string[]).includes(normalized)) return normalized as CompletionVerdict;
    return VERDICT_ALIASES[normalized] ?? null;
  };

  addAliasExecutionRunOptions(session
    .command('next')
    .description('Deprecated alias for run next; Execution authority is auto-resolved when present')
    .option('--session <id>', 'explicit Session ID')
    .option('--inline-brief', 'include full brief-level guidance in the response (normal forward flow)')
    .option('--pick <step-id>', 'advance a specific pending execution step instead of the queue head')
    .option('--json', 'emit run-response/1.1 for Execution authority, otherwise the legacy result')
    .option('--execution-owner <owner>', 'legacy Session lease execution owner')
    .option('--owner-epoch <epoch>', 'legacy Session lease owner epoch', Number.parseInt)
    .option('--lease-id <id>', 'lease identifier for concurrency safety')
    .option('--workflow-root <path>', 'project root containing .workflow', process.cwd()))
    .action((opts: AliasExecutionOptions & {
      inlineBrief?: boolean;
      pick?: string;
      json?: boolean;
      executionOwner?: string;
      ownerEpoch?: number;
      workflowRoot: string;
    }) => {
      const projectRoot = resolve(opts.workflowRoot);
      let context: AliasExecutionContext | undefined;
      try {
        context = resolveAliasExecutionContext(projectRoot, opts.session, opts.execution);
        if (context.protocol) {
          const authority = aliasExecutionAuthority(context, opts);
          const store = new SessionStore(projectRoot);
          const wasPresent = Boolean(store.readExecutionTransition(
            authority.sessionId, authority.execution.execution_id, authority.requestId,
          ));
          const outcome = runNextExecutionStep(projectRoot, {
            sessionId: authority.sessionId,
            executionId: authority.execution.execution_id,
            generation: authority.execution.generation,
            expectedExecutionRevision: authority.expectedExecutionRevision,
            executionLease: authority.lease,
            requestId: authority.requestId,
            pick: opts.pick,
            json: opts.json,
            inlineBrief: opts.inlineBrief,
          });
          const warning = deprecationWarning('maestro session next', 'maestro run next');
          if (opts.json) {
            if (outcome.exitCode === 0 && outcome.result) {
              const execution = store.readExecution(authority.sessionId, authority.execution.execution_id);
              emitExecutionSuccess({
                operation: 'next', result: outcome.result, projectRoot, execution,
                requestId: authority.requestId,
                replay: aliasExecutionReplay(projectRoot, authority, wasPresent),
                warnings: [warning],
              });
            } else {
              emitExecutionError({
                operation: 'next', error: new Error(outcome.message), projectRoot,
                sessionId: authority.sessionId, executionId: authority.execution.execution_id,
                requestId: authority.requestId, exitCode: outcome.exitCode as 1 | 2 | 3,
                disposition: outcome.exitCode === 1 ? 'domain_error' : 'control_flow',
                code: outcome.reasonCode as never, details: { reason_code: outcome.reasonCode },
                warnings: [warning],
              });
            }
          } else {
            console.error(`[maestro session] deprecated: ${warning.message}`);
            const stream = outcome.exitCode === 0 ? process.stdout : process.stderr;
            stream.write(`${outcome.message}\n`);
            if (outcome.exitCode !== 0) process.exitCode = outcome.exitCode;
          }
          return;
        }

        const outcome = runNextStep(projectRoot, {
          sessionId: opts.session,
          pick: opts.pick,
          json: opts.json,
          inlineBrief: opts.inlineBrief,
          executionOwner: opts.executionOwner,
          ownerEpoch: opts.ownerEpoch,
          leaseId: opts.leaseId,
        });
        if (opts.json) {
          if (outcome.exitCode === 0 && outcome.result) {
            machineSuccess(
              'next' as never,
              outcome.result,
              outcome.result.session_id,
              undefined,
              undefined,
            );
          } else {
            emitRunResponse(createRunResponseError({
              operation: 'next',
              exit_code: outcome.exitCode as 1 | 2 | 3,
              code: outcome.reasonCode as never,
              message: outcome.message,
              details: { reason_code: outcome.reasonCode },
            }));
          }
        } else {
          process.stdout.write(outcome.message + '\n');
          process.exitCode = outcome.exitCode;
        }
      } catch (error) {
        const executionProtocol = context?.protocol ?? projectUsesExecutionProtocol(projectRoot, opts.session);
        if (opts.json && executionProtocol) {
          emitExecutionError({
            operation: 'next', error, projectRoot,
            sessionId: context?.sessionId ?? opts.session,
            executionId: context?.execution?.execution_id ?? opts.execution,
            requestId: opts.requestId,
            ...(error instanceof InvalidArgumentError
              ? { exitCode: 2 as const, disposition: 'usage_error' as const, code: 'COMMANDER_USAGE' as const }
              : error instanceof Error && /ambiguous across Sessions/i.test(error.message)
                ? { code: 'EXECUTION_ALREADY_ACTIVE' as const }
                : {}),
            warnings: [deprecationWarning('maestro session next', 'maestro run next')],
          });
        } else if (opts.json) {
          machineError('next' as never, error, { session: opts.session, requestId: opts.requestId });
        } else {
          reportError(error);
        }
      }
    });

  addAliasExecutionRunOptions(session
    .command('done [run-id]')
    .description('Deprecated alias for run complete; Execution authority is auto-resolved when present')
    .option('--session <id>', 'explicit Session ID')
    .option('--skip-artifact-metadata-validation', 'downgrade artifact kind/schema/role/alias contract mismatches to warnings')
    .option('--verdict <verdict>', `completion verdict: ${VALID_VERDICTS.join('|')} (default done; ${VERDICT_ALIAS_LABEL})`)
    .option('--summary <text>', 'handoff.summary fallback when the report frontmatter left it empty')
    .option('--reason <text>', 'blocker reason (blocked) merged into handoff concerns')
    .option('--note <text>', 'supplementary concern merged into the handoff (repeatable)', collect, [])
    .option('--decision <text>', 'decision appended to handoff.decisions (repeatable)', collect, [])
    .option('--evidence <path>', 'run-relative evidence path (repeatable)', collect, [])
    .option('--artifact <path>', 'run-relative artifact path (repeatable)', collect, [])
    .option('--chain-proposal <path>', 'run-relative chain-proposal artifact applied atomically with completion')
    .option('--apply-proposal', 'apply the single validated chain-proposal discovered in this Run')
    .option('--lease-id <token>', 'private Execution lease token')
    .option('--json', 'emit run-response/1.1 for Execution authority, otherwise run-response/1.0')
    .option('--workflow-root <path>', 'project root containing .workflow', process.cwd()))
    .action((runIdArg: string | undefined, opts: AliasExecutionOptions & {
      skipArtifactMetadataValidation?: boolean;
      verdict?: string;
      summary?: string;
      reason?: string;
      note: string[];
      decision: string[];
      evidence: string[];
      artifact: string[];
      chainProposal?: string;
      applyProposal?: boolean;
      json?: boolean;
      workflowRoot: string;
    }) => {
      const projectRoot = resolve(opts.workflowRoot);
      let context: AliasExecutionContext | undefined;
      try {
        const verdict = parseVerdict(opts.verdict);
        if (!verdict) throw new Error(`invalid --verdict "${opts.verdict}"; valid: ${VALID_VERDICTS.join(', ')} (${VERDICT_ALIAS_LABEL})`);
        context = resolveAliasExecutionContext(projectRoot, opts.session, opts.execution);
        if (context.protocol) {
          const authority = aliasExecutionAuthority(context, opts);
          const runId = runIdArg ?? authority.execution.active_run_id;
          if (!runId) throw new InvalidArgumentError('Execution completion requires [run-id] or an active Execution Run');
          const result = completeExecutionRun(projectRoot, runId, {
            sessionId: authority.sessionId,
            executionId: authority.execution.execution_id,
            generation: authority.execution.generation,
            expectedExecutionRevision: authority.expectedExecutionRevision,
            executionLease: authority.lease,
            requestId: authority.requestId,
            chainVerdict: verdict,
            notes: opts.note,
            decisions: opts.decision,
            extraArtifacts: [...opts.artifact, ...opts.evidence],
            summaryFallback: opts.summary,
            chainProposal: opts.chainProposal,
            applyChainProposal: opts.applyProposal,
            skipArtifactMetadataValidation: opts.skipArtifactMetadataValidation,
          });
          const warning = deprecationWarning('maestro session done', 'maestro run complete');
          if (opts.json) {
            const execution = new SessionStore(projectRoot).readExecution(
              authority.sessionId, authority.execution.execution_id,
            );
            if (result.sealed) {
              emitExecutionSuccess({
                operation: 'complete', result, projectRoot, execution,
                requestId: authority.requestId,
                replay: {
                  replayed: result.transition.status === 'replayed',
                  transition_id: result.transition.transition_id,
                },
                warnings: [warning],
              });
            } else {
              emitExecutionError({
                operation: 'complete', error: new Error('Run gates are blocking completion'), projectRoot,
                sessionId: authority.sessionId, executionId: authority.execution.execution_id,
                requestId: authority.requestId, code: 'RUN_GATES_BLOCKING', details: { result },
                warnings: [warning],
              });
            }
          } else {
            console.error(`[maestro session] deprecated: ${warning.message}`);
            print(result);
            if (!result.sealed) process.exitCode = 1;
          }
          return;
        }

        const store = new SessionStore(projectRoot);
        let sessionId: string;
        let runId: string;
        if (runIdArg) {
          const located = store.findRun(runIdArg, opts.session);
          sessionId = located.sessionId;
          runId = runIdArg;
        } else {
          const resolved = resolveRunningRun(projectRoot, store, opts.session, 'session done');
          if (resolved.kind === 'ok') {
            sessionId = resolved.sessionId;
            runId = resolved.step.run_id;
          } else {
            const active = resolveActiveRunTarget(store, opts.session, 'session done');
            if (!active) throw new Error(resolved.message);
            sessionId = active.sessionId;
            runId = active.runId;
          }
        }
        const result = completeRunWithVerdict(projectRoot, runId, sessionId, {
          verdict,
          notes: opts.note,
          decisions: opts.decision,
          extraArtifacts: [...opts.artifact, ...opts.evidence],
          summaryFallback: opts.summary,
          reason: opts.reason,
          chainProposal: opts.chainProposal,
          applyChainProposal: opts.applyProposal,
          skipArtifactMetadataValidation: opts.skipArtifactMetadataValidation,
        });
        if (opts.json) {
          if (result.run_sealed) {
            emitRunResponse(createRunResponseSuccess({
              operation: 'complete',
              result,
              request_id: result.seal.transition.request_id,
              locator: { session_id: result.session_id, run_id: result.run_id },
              replay: {
                status: result.seal.transition.status,
                transition_id: result.seal.transition.transition_id,
              },
              next: { suggest_only: true, command: result.next.command, reason: result.next.reason },
              continuation: inspectSessionContinuation(projectRoot, result.session_id),
            }));
          } else {
            emitRunResponse(createRunResponseError({
              operation: 'complete', exit_code: 1, code: 'RUN_GATES_BLOCKING',
              message: 'Run gates are blocking completion', details: { result },
              next: { suggest_only: true, command: result.next.command, reason: result.next.reason },
              continuation: inspectSessionContinuation(projectRoot, result.session_id, { runId: result.run_id }),
            }));
          }
        } else {
          print(result);
          process.stderr.write(`next: ${result.next.command}\n      ${result.next.reason}\n`);
          if (!result.run_sealed) process.exitCode = 1;
        }
      } catch (error) {
        const executionProtocol = context?.protocol ?? projectUsesExecutionProtocol(projectRoot, opts.session);
        if (opts.json && executionProtocol) {
          emitExecutionError({
            operation: 'complete', error, projectRoot,
            sessionId: context?.sessionId ?? opts.session,
            executionId: context?.execution?.execution_id ?? opts.execution,
            requestId: opts.requestId,
            ...(error instanceof InvalidArgumentError
              ? { exitCode: 2 as const, disposition: 'usage_error' as const, code: 'COMMANDER_USAGE' as const }
              : {}),
            warnings: [deprecationWarning('maestro session done', 'maestro run complete')],
          });
        } else if (opts.json) {
          emitRunResponse(createRunResponseError({
            operation: 'complete', exit_code: 1, code: stableRunResponseErrorCode(error),
            message: error instanceof Error ? error.message : String(error), request_id: null,
            locator: { session_id: opts.session ?? null, run_id: runIdArg ?? null },
          }));
        } else {
          reportError(error);
        }
      }
    });

  session
    .command('decide <point-id>')
    .description('Record a decision point verdict and advance the chain')
    .requiredOption('--session <id>', 'Session ID')
    .requiredOption('--verdict <verdict>', 'decision verdict: proceed|fix|escalate')
    .requiredOption('--confidence <level>', 'evaluation confidence: high|medium|low')
    .option('--summary <text>', 'one-line rationale')
    .option('--evidence <path>', 'evidence path/reference')
    .option('--request-id <id>', 'idempotent decision request ID')
    .option('--expected-identity-revision <n>', 'expected Session identity revision', Number.parseInt)
    .option('--expected-activity-revision <n>', 'expected Session activity revision', Number.parseInt)
    .option('--execution-owner <owner>', 'lease execution owner')
    .option('--owner-epoch <epoch>', 'lease owner epoch', Number.parseInt)
    .option('--lease-id <id>', 'lease identifier')
    .option('--json', 'emit one run-response/1.0 envelope on stdout')
    .option('--workflow-root <path>', 'project root containing .workflow', process.cwd())
    .action((pointId: string, opts: {
      session: string;
      verdict: string;
      confidence: string;
      summary?: string;
      evidence?: string;
      requestId?: string;
      json?: boolean;
      workflowRoot: string;
    }) => {
      try {
        const verdict = opts.verdict.trim().toLowerCase();
        if (!['proceed', 'fix', 'escalate'].includes(verdict)) {
          throw new Error(`invalid --verdict "${opts.verdict}"; valid: proceed, fix, escalate`);
        }
        const confidence = opts.confidence.trim().toLowerCase();
        if (!['high', 'medium', 'low'].includes(confidence)) {
          throw new Error(`invalid --confidence "${opts.confidence}"; valid: high, medium, low`);
        }
        const result = runDecide(resolve(opts.workflowRoot), opts.session, pointId, {
          verdict: verdict as DecisionVerdict,
          confidence: confidence as DecisionConfidence,
          summary: opts.summary,
          evidence: opts.evidence,
          transition: mutationTransitionOptions(opts),
        });
        if (opts.json) {
          machineSuccess(
            'decide' as never,
            result,
            opts.session,
            { status: result.transition.status, transition_id: result.transition.transition_id, request_id: result.transition.request_id },
            { suggest_only: true, command: result.next.command, reason: result.next.reason },
          );
        } else {
          print(result);
          process.stderr.write(`next: ${result.next.command}\n      ${result.next.reason}\n`);
        }
      } catch (error) {
        if (opts.json) machineError('decide' as never, error, opts); else reportError(error);
      }
    });

  session
    .command('prune')
    .description('List or remove orphan Session directories (on disk, no state.json projection, no Runs); dry-run by default')
    .option('--apply', 'delete orphan directories and prune dangling projections')
    .option('--workflow-root <path>', 'project root containing .workflow', process.cwd())
    .action((opts: { apply?: boolean; workflowRoot: string }) => {
      try {
        print(pruneOrphanSessions(resolve(opts.workflowRoot), Boolean(opts.apply)));
      } catch (error) {
        reportError(error);
      }
    });

  session
    .command('graph [session-id]')
    .description('Show chain visualization: steps, decisions, goals, and position')
    .option('--json', 'emit structured JSON')
    .option('--workflow-root <path>', 'project root containing .workflow', process.cwd())
    .action((sessionId: string | undefined, opts: { json?: boolean; workflowRoot: string }) => {
      try {
        const graph = buildGraph(resolve(opts.workflowRoot), sessionId);
        if (opts.json) {
          print(graph);
        } else {
          console.log(renderGraphHuman(graph));
        }
      } catch (error) {
        reportError(error);
      }
    });
}
