import { z } from 'zod';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Command } from 'commander';
import { migrateAllSessions, migrateSession } from '../run/migrate.js';
import { SessionStore } from '../run/store.js';
import { completeRunWithVerdict, createRun, sealSession, type CompletionVerdict } from '../run/runtime.js';
import { runNextStep } from '../run/next.js';
import { runDecide, type DecisionConfidence, type DecisionVerdict } from '../run/decide.js';
import { continuationAfterDecide, inspectSessionContinuation } from '../run/continuation.js';
import { buildGraph, renderGraphHuman } from '../run/graph.js';
import { resolveActiveRunTarget, resolveRunningRun } from '../run/resolve.js';
import { targetPlatformSchema, type SessionState } from '../run/schemas.js';
import {
  chainDefinitionSchema,
  createChainSession,
  insertChainStep,
  parseDecompositionInput,
  parsePositionInput,
  replaceChainStep,
  skipChainStep,
  updateSessionMeta,
  type ChainDefinition,
} from '../run/chain-admin.js';
import { resolveSession, resumeSession } from '../run/session-transition.js';
import { resolveCompatibleSession } from '../run/session-resolver.js';
import { summarizeSession } from '../run/session-status.js';
import { checkResolvedSession, summarizeSessionCheck } from '../run/session-check.js';
import {
  createRunResponseError,
  createRunResponseSuccess,
  emitRunResponse,
  stableRunResponseErrorCode,
  type RunResponse,
} from '../run/response.js';
import type { TransitionMutationReceipt } from '../run/transition-receipts.js';

function print(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function reportError(error: unknown): void {
  console.error(`[maestro session] ${(error as Error).message}`);
  process.exitCode = 1;
}

type SessionMachineOperation = Extract<
  RunResponse['operation'],
  'resolve' | 'resume' | 'seal-session' | 'chain-insert' | 'chain-replace' | 'chain-skip' | 'meta-update'
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
    .option('--decision <id>', 'escalated decision point ID')
    .option('--step <id>', 'failed chain step ID')
    .requiredOption('--disposition <value>', 'decision: proceed|retry; step: retry|skip')
    .action((opts: any) => {
      try {
        if (Boolean(opts.decision) === Boolean(opts.step)) throw new Error('exactly one of --decision or --step is required');
        const target = opts.decision
          ? { kind: 'decision' as const, id: opts.decision, disposition: opts.disposition }
          : { kind: 'step' as const, id: opts.step, disposition: opts.disposition };
        if (target.kind === 'decision' && !['proceed', 'retry'].includes(target.disposition)) throw new Error('decision disposition must be proceed|retry');
        if (target.kind === 'step' && !['retry', 'skip'].includes(target.disposition)) throw new Error('step disposition must be retry|skip');
        const result = resolveSession(resolve(opts.workflowRoot), opts.session, transitionOptions(opts, target));
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
      } catch (error) { if (opts.json) machineError('resolve', error, opts); else reportError(error); }
    });

  addCanonicalRecoveryHelp(
    addTransitionOptions(session.command('resume').description('Resume a canonical paused Session after every recovery blocker is cleared')),
    'resume',
  )
    .action((opts: any) => {
      try {
        const result = resumeSession(resolve(opts.workflowRoot), opts.session, transitionOptions(opts));
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
      } catch (error) { if (opts.json) machineError('resume', error, opts); else reportError(error); }
    });

  session
    .command('migrate')
    .description('Fold legacy ralph-meta.json into session.json and stamp session/1.3 (idempotent)')
    .option('--session <id>', 'migrate one Session; omit to migrate every Session under .workflow/sessions/')
    .option('--workflow-root <path>', 'project root containing .workflow', process.cwd())
    .action((opts: { session?: string; workflowRoot: string }) => {
      try {
        const root = resolve(opts.workflowRoot);
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
        const result = store.listSessions(status ? { statuses: [status] } : {});
        print(result.candidates.map(candidate => ({
          session_id: candidate.sessionId,
          status: candidate.session.status,
          engine: candidate.session.orchestration.engine,
          active_run_id: candidate.session.active_run_id,
          latest_completed_run_id: candidate.session.latest_completed_run_id,
          chain_total: candidate.session.orchestration.chain.length,
          pending_steps: candidate.session.orchestration.chain.filter(step => step.status === 'pending').length,
          intent: candidate.session.intent,
        })));
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
        print(store.readBundle(sessionId).session);
      } catch (error) {
        reportError(error);
      }
    });

  session
    .command('status [session-id]')
    .description('Show canonical status for an explicit or latest compatible Session')
    .option('--workflow-root <path>', 'project root containing .workflow', process.cwd())
    .action((sessionId: string | undefined, opts: { workflowRoot: string }) => {
      try {
        const projectRoot = resolve(opts.workflowRoot);
        const resolved = resolveCompatibleSession(projectRoot, sessionId);
        if (!resolved) throw new Error(sessionId ? `Session not found: ${sessionId}` : 'no compatible Session found');
        print(summarizeSession(projectRoot, resolved));
      } catch (error) {
        reportError(error);
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
    .command('seal <session-id>')
    .description('Seal a Session after all Runs and gates are complete')
    .option('--summary <text>', 'human-readable seal summary', '')
    .option('--json', 'emit one run-response/1.0 envelope on stdout')
    .option('--workflow-root <path>', 'project root containing .workflow', process.cwd())
    .action((sessionId: string, opts: { summary: string; json?: boolean; workflowRoot: string }) => {
      try {
        const result = sealSession(resolve(opts.workflowRoot), sessionId, opts.summary);
        if (opts.json) machineSuccess('seal-session', result, sessionId);
        else print(result);
      } catch (error) {
        if (opts.json) machineError('seal-session', error, { session: sessionId });
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
        const result = createChainSession(root, slug, {
          intent,
          engine: opts.engine as 'ralph' | 'coordinator' | 'manual' | undefined,
          qualityMode: opts.quality as 'quick' | 'standard' | 'full' | undefined,
          autoMode: opts.auto,
          executor: platform ? { platform, cli_tool: platform } : undefined,
          definition,
        });
        print({
          session_id: result.sessionId,
          session_dir: result.sessionDir,
          engine: result.session.orchestration.engine,
          chain: definition ? chainSummary(definition.steps) : persistedChainSummary(result.session),
          next: `maestro session next --session ${result.sessionId}`,
        });
      } catch (error) {
        reportError(error);
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
    .option('--workflow-root <path>', 'project root containing .workflow', process.cwd())
    .action((intentParts: string[], opts: {
      chain?: string[];
      chainFile?: string;
      id?: string;
      session?: string;
      topic?: string;
      arg: string[];
      platform?: string;
      dispatch: boolean;
      engine?: string;
      quality?: string;
      auto?: boolean;
      workflowRoot: string;
    }) => {
      try {
        const root = resolve(opts.workflowRoot);
        const intent = intentParts.join(' ').trim() || opts.topic || opts.chain?.join(' → ') || '';
        if (!intent && !opts.session) throw new Error('session start requires an intent or --session');
        const platform = opts.platform ? targetPlatformSchema.parse(opts.platform) : undefined;

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
        }
        print(result);
      } catch (error) {
        reportError(error);
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

  session
    .command('next')
    .description('Advance chain: create the next pending Run and emit a birth packet')
    .option('--session <id>', 'explicit Session ID')
    .option('--inline-brief', 'include full brief-level guidance in the response (normal forward flow)')
    .option('--pick <step-id>', 'advance a specific pending execution step instead of the queue head')
    .option('--json', 'emit structured JSON instead of the human-readable birth packet')
    .option('--execution-owner <owner>', 'lease execution owner')
    .option('--owner-epoch <epoch>', 'lease owner epoch', Number.parseInt)
    .option('--lease-id <id>', 'lease identifier for concurrency safety')
    .option('--workflow-root <path>', 'project root containing .workflow', process.cwd())
    .action((opts: {
      session?: string;
      inlineBrief?: boolean;
      pick?: string;
      json?: boolean;
      executionOwner?: string;
      ownerEpoch?: number;
      leaseId?: string;
      workflowRoot: string;
    }) => {
      try {
        const outcome = runNextStep(resolve(opts.workflowRoot), {
          sessionId: opts.session,
          pick: opts.pick,
          json: opts.json,
          inlineBrief: opts.inlineBrief,
          executionOwner: opts.executionOwner,
          ownerEpoch: opts.ownerEpoch,
          leaseId: opts.leaseId,
        });
        process.stdout.write(outcome.message + '\n');
        process.exitCode = outcome.exitCode;
      } catch (error) {
        reportError(error);
      }
    });

  session
    .command('done [run-id]')
    .description('Complete a Run step and advance the chain (returns continuation)')
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
    .option('--json', 'emit structured JSON')
    .option('--workflow-root <path>', 'project root containing .workflow', process.cwd())
    .action((runIdArg: string | undefined, opts: {
      session?: string;
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
      try {
        const projectRoot = resolve(opts.workflowRoot);
        const verdict = parseVerdict(opts.verdict);
        if (!verdict) throw new Error(`invalid --verdict "${opts.verdict}"; valid: ${VALID_VERDICTS.join(', ')} (${VERDICT_ALIAS_LABEL})`);
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
              next: {
                suggest_only: true,
                command: result.next.command,
                reason: result.next.reason,
              },
              continuation: inspectSessionContinuation(projectRoot, result.session_id),
            }));
          } else {
            emitRunResponse(createRunResponseError({
              operation: 'complete',
              exit_code: 1,
              code: 'RUN_GATES_BLOCKING',
              message: 'Run gates are blocking completion',
              details: { result },
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
        if (opts.json) {
          emitRunResponse(createRunResponseError({
            operation: 'complete',
            exit_code: 1,
            code: stableRunResponseErrorCode(error),
            message: error instanceof Error ? error.message : String(error),
            request_id: null,
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
