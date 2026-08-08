import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Command } from 'commander';
import {
  acceptRunReuse,
  briefRun,
  checkRun,
  completeRun,
  completeRunWithVerdict,
  createRun,
  ensureSessionProjectionOnDisk,
  prepareStep,
  rebindRunCommand,
  resolveTopicSessionId,
  skillContent,
  sealSession,
  type CompletionVerdict,
} from '../run/runtime.js';
import { runNextStep } from '../run/next.js';
import { resolveActiveRunTarget, resolveRunningRun } from '../run/resolve.js';
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
import { runDecide, type DecisionConfidence, type DecisionVerdict } from '../run/decide.js';
import { checkLease } from '../run/lease.js';
import { SessionStore } from '../run/store.js';
import { logMutation, readLedger } from '../run/mutation-ledger.js';
import type { TargetPlatform } from '../core/skill-converter.js';
import {
  createRunResponseError,
  createRunResponseSuccess,
  emitRunResponse,
  stableRunResponseErrorCode,
  type RunResponse,
  type RunResponseErrorCode,
} from '../run/response.js';
import { recallRuns } from '../run/recall.js';
import { issueRecallConfirmation } from '../run/recall-confirmation.js';
import { executeRecallAction } from '../run/recall-actions.js';
import { resolveCompatibleSession } from '../run/session-resolver.js';
import { summarizeSession } from '../run/session-status.js';
import { resolveSession, resumeSession } from '../run/session-transition.js';
import {
  continuationAfterDecide,
  continuationAfterBrief,
  continuationAfterCheck,
  continuationForNextFailure,
  inspectSessionContinuation,
} from '../run/continuation.js';

const VALID_VERDICTS: CompletionVerdict[] = ['done', 'done-with-concerns', 'needs-retry', 'blocked'];

/** Ready-vocabulary aliases (report frontmatter layer) mapped onto the
 * chain-advance vocabulary, so `--verdict ready|ready_with_concerns|failed`
 * is accepted at the CLI surface and mapped internally. `blocked` exists in
 * both vocabularies and needs no alias. */
const VERDICT_ALIASES: Readonly<Record<string, CompletionVerdict>> = {
  ready: 'done',
  'ready-with-concerns': 'done-with-concerns',
  failed: 'needs-retry',
};
const VERDICT_ALIAS_LABEL = 'aliases: ready|ready_with_concerns|failed';

/** Normalise a --verdict token: lowercase, accept DONE_WITH_CONCERNS spellings
 * and ready-vocabulary aliases. */
function parseVerdict(raw: string | undefined): CompletionVerdict | null {
  if (!raw) return 'done';
  const normalized = raw.trim().toLowerCase().replace(/_/g, '-');
  if ((VALID_VERDICTS as string[]).includes(normalized)) return normalized as CompletionVerdict;
  return VERDICT_ALIASES[normalized] ?? null;
}

const VALID_PLATFORMS: TargetPlatform[] = ['claude', 'codex', 'agy', 'agents-standard', 'pi'];

function collect(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

function readJsonInput(pathOrStdin: string, label: string): unknown {
  const raw = readFileSync(pathOrStdin === '-' ? 0 : resolve(pathOrStdin), 'utf8');
  try {
    return JSON.parse(raw.replace(/^\uFEFF/, ''));
  } catch (error) {
    throw new Error(`invalid ${label} JSON: ${(error as Error).message}`);
  }
}
function print(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
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

function chainDefinitionFromCommands(intent: string, commands: string[]): ChainDefinition {
  const steps = commands.map(command => command.trim()).filter(Boolean);
  if (steps.length === 0) throw new Error('--chain requires at least one command');
  return {
    intent,
    steps: steps.map(command => ({ command })),
  };
}

function summarizeChain(definition: ChainDefinition): { total: number; steps: Array<{ command: string }> } {
  return {
    total: definition.steps.length,
    steps: definition.steps.map(step => ({ command: step.command })),
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

const ADMIN_COMPATIBILITY_PREFIX = '[DEPRECATED, ADMIN-ONLY]';

function addAdminCompatibilityHelp(command: Command, retainedFor: string): Command {
  return command.addHelpText('after', `
Compatibility boundary:
  ${retainedFor}
  This command is excluded from normal topic resolution, Session selection, sealed-output reuse,
  recall recommendations, and next-action routing.
  It is not a force operation or lifecycle bypass.
`);
}

function reportError(error: unknown): void {
  console.error(`[maestro run] ${(error as Error).message}`);
  process.exitCode = 1;
}

/** Deprecation notice for human-facing aliases migrating to `maestro session`. */
function sessionMigrationNotice(verb: string, sessionVerb?: string, machineMode = false): void {
  if (machineMode) return;
  const target = sessionVerb ?? verb;
  console.error(`[maestro run] deprecated: "maestro run ${verb}" is now "maestro session ${target}". This alias stays for backward compatibility.`);
}

type MachineOperation = RunResponse['operation'];
function machineError(
  operation: MachineOperation,
  error: unknown,
  options: {
    exitCode?: 1 | 2 | 3;
    code?: RunResponseErrorCode;
    details?: Record<string, unknown>;
    requestId?: string | null;
    locator?: RunResponse['locator'];
  } = {},
): void {
  emitRunResponse(createRunResponseError({
    operation,
    exit_code: options.exitCode ?? 1,
    code: options.code ?? stableRunResponseErrorCode(error),
    message: error instanceof Error ? error.message : String(error),
    details: options.details,
    request_id: options.requestId,
    locator: options.locator,
  }));
}
function machineSuccess(
  operation: MachineOperation,
  result: unknown,
  locator: { session_id: string | null; run_id: string | null } | null = null,
  replay?: { status: 'applied' | 'replayed'; transition_id: string },
  requestId?: string | null,
  next?: RunResponse['next'],
  continuation?: RunResponse['continuation'],
): void {
  emitRunResponse(createRunResponseSuccess({
    operation, result, locator, replay, request_id: requestId, next, continuation,
  }));
}

type RunRecallResult = Awaited<ReturnType<typeof recallRuns>>;

function readOnlyRecallProjection(result: RunRecallResult): RunRecallResult {
  const readOnlyExclusion = 'CLI_READ_ONLY_NO_MUTATION';
  return {
    ...result,
    exact_candidates: result.exact_candidates.map(candidate => ({
      ...candidate,
      eligible_actions: [],
      exclusions: [...new Set([...candidate.exclusions, readOnlyExclusion])],
      next_if_active: null,
    })),
    historical_candidates: result.historical_candidates.map(candidate => ({
      ...candidate,
      eligible_actions: [],
      exclusions: [...new Set([...candidate.exclusions, readOnlyExclusion])],
    })),
    recommendation: {
      action: null,
      candidate_id: result.recommendation.candidate_id,
      automatic: false,
      reason_codes: [...new Set([...result.recommendation.reason_codes, 'READ_ONLY_LOOKUP'])],
    },
    confirmation: { required: false, issuance_command: '', allowed_actions: [] },
    next: {
      suggest_only: true,
      command: null,
      reason: 'Recall is read-only; normal routing resolves a topic Session and reuses eligible same-Session sealed outputs.',
    },
  };
}

export function registerRunCommand(program: Command): void {
  const run = program
    .command('run')
    .description('Manage Runs inside topic-grouped Sessions; compatibility/admin commands are never routed automatically');

  run
    .command('start [intent...]')
    .description('Start a single Run or a command-chain Session')
    .option('--cmd <command>', 'single-run command to create')
    .option('--chain <commands...>', 'simple command chain, e.g. --chain learn odyssey-planex odyssey-review')
    .option('--chain-file <path>', 'advanced chain definition JSON; "-" reads stdin')
    .option('--id <slug>', 'explicit Session ID/slug when creating a chain Session')
    .option('--session <id>', 'explicit Session ID for a single Run')
    .option('--topic <text>', 'command-independent Session topic; defaults to intent')
    .option('--arg <value>', 'command input stored in Run input.args (repeatable)', collect, [])
    .option('--platform <name>', 'target platform persisted for this Run')
    .option('--no-dispatch', 'create the chain Session but do not run the first step')
    .option('--workflow-root <path>', 'project root containing .workflow', process.cwd())
    .action((intentParts: string[], opts: {
      cmd?: string;
      chain?: string[];
      chainFile?: string;
      id?: string;
      session?: string;
      topic?: string;
      arg: string[];
      platform?: string;
      dispatch: boolean;
      workflowRoot: string;
    }) => {
      sessionMigrationNotice('start', 'start');
      try {
        const projectRoot = resolve(opts.workflowRoot);
        const fileDefinition = opts.chainFile
          ? chainDefinitionSchema.parse(readJsonInput(opts.chainFile, 'chain-file'))
          : undefined;
        if (fileDefinition && (opts.chain?.length ?? 0) > 0) throw new Error('use either --chain or --chain-file, not both');
        const intent = intentParts.join(' ').trim() || fileDefinition?.intent || opts.topic || opts.cmd || opts.chain?.join(' -> ') || '';
        if (!intent) throw new Error('run start requires an intent, --cmd, --chain, or --chain-file');
        const platform = opts.platform as TargetPlatform | undefined;
        if (platform && !VALID_PLATFORMS.includes(platform)) {
          throw new Error(`unknown platform "${platform}", valid: ${VALID_PLATFORMS.join(', ')}`);
        }
        if ((opts.chain?.length ?? 0) > 0 || fileDefinition) {
          if (opts.cmd) throw new Error('use --cmd, --chain, or --chain-file; only one may be provided');
          if (opts.session) throw new Error('--session is for single Run start; use run edit to add steps to an existing Session');
          const definition = fileDefinition ?? chainDefinitionFromCommands(intent, opts.chain ?? []);
          const fallbackSlug = slugifySessionTopic(definition.steps.map(step => step.command).join('-'));
          const sessionSlug = opts.id ?? slugifySessionTopic(intent, fallbackSlug);
          const created = createChainSession(projectRoot, sessionSlug, {
            intent,
            topic: opts.topic,
            definition,
            engine: definition.engine,
            qualityMode: definition.quality_mode,
            autoMode: definition.auto_mode,
            boundaryContract: definition.boundary_contract,
            executor: platform ? { platform, cli_tool: platform } : undefined,
          });
          const result: Record<string, unknown> = {
            session_id: created.sessionId,
            session_dir: created.sessionDir,
            chain: summarizeChain(definition),
            next: `maestro session next --session ${created.sessionId}`,
          };
          if (opts.dispatch) {
            const next = runNextStep(projectRoot, { sessionId: created.sessionId, args: opts.arg.length > 0 ? opts.arg : undefined });
            result.dispatched = next.result;
            result.message = next.message;
            if (next.exitCode !== 0) process.exitCode = next.exitCode;
          } else {
            const projectionWarning = ensureSessionProjectionOnDisk(projectRoot, created.sessionId);
            if (projectionWarning) result.warning = projectionWarning;
          }
          print(result);
          return;
        }
        if (!opts.cmd) throw new Error('single-run start requires --cmd <command> or --chain <commands...>');
        const result = createRun({
          projectRoot,
          command: opts.cmd,
          sessionId: opts.session,
          intent,
          topic: opts.topic,
          platform,
          args: opts.arg,
        });
        if (result.session_created && opts.session) {
          console.error(
            `Warning: Session "${opts.session}" did not exist; created it for this Run. `
            + `If you meant an existing Session, use its exact ID (see "maestro session list").`,
          );
        }
        print(result);
      } catch (error) {
        reportError(error);
      }
    });

  run
    .command('status [session-id]')
    .description('Show canonical Session/Run chain status')
    .option('--workflow-root <path>', 'project root containing .workflow', process.cwd())
    .action((sessionId: string | undefined, opts: { workflowRoot: string }) => {
      sessionMigrationNotice('status');
      try {
        const projectRoot = resolve(opts.workflowRoot);
        const resolved = resolveCompatibleSession(projectRoot, sessionId);
        if (!resolved) throw new Error(sessionId ? `session not found: ${sessionId}` : 'no compatible Session found');
        print(summarizeSession(projectRoot, resolved));
      } catch (error) {
        reportError(error);
      }
    });

  run
    .command('recover')
    .description('Resolve one paused blocker or resume a cleared Session')
    .requiredOption('--session <id>', 'exact Session ID')
    .requiredOption('--request-id <id>', 'idempotent transition ID')
    .requiredOption('--actor <name>', 'authorized actor')
    .requiredOption('--reason <text>', 'audit reason')
    .requiredOption('--evidence <ref>', 'evidence reference (repeatable)', collect)
    .requiredOption('--expected-identity-revision <n>', 'expected identity revision', Number.parseInt)
    .requiredOption('--expected-activity-revision <n>', 'expected activity revision', Number.parseInt)
    .option('--decision <id>', 'resolve an escalated decision point')
    .option('--step <id>', 'resolve a failed chain step')
    .option('--disposition <value>', 'decision: proceed|retry; step: retry|skip')
    .option('--resume', 'resume after every blocker has been resolved')
    .option('--execution-owner <owner>', 'lease owner')
    .option('--owner-epoch <n>', 'lease epoch', Number.parseInt)
    .option('--lease-id <id>', 'lease ID')
    .option('--workflow-root <path>', 'project root containing .workflow', process.cwd())
    .action((opts: any) => {
      sessionMigrationNotice('recover');
      try {
        const projectRoot = resolve(opts.workflowRoot);
        const common = {
          requestId: opts.requestId,
          actor: opts.actor,
          reason: opts.reason,
          evidence: opts.evidence,
          expectedIdentityRevision: opts.expectedIdentityRevision,
          expectedActivityRevision: opts.expectedActivityRevision,
          leaseClaim: {
            executionOwner: opts.executionOwner,
            ownerEpoch: opts.ownerEpoch,
            leaseId: opts.leaseId,
          },
        };
        if (opts.resume) {
          if (opts.decision || opts.step || opts.disposition) {
            throw new Error('--resume cannot be combined with --decision, --step, or --disposition');
          }
          print(resumeSession(projectRoot, opts.session, common));
          return;
        }
        if (Boolean(opts.decision) === Boolean(opts.step)) {
          throw new Error('exactly one of --decision or --step is required unless --resume is used');
        }
        if (!opts.disposition) throw new Error('--disposition is required when resolving a blocker');
        const target = opts.decision
          ? { kind: 'decision' as const, id: opts.decision, disposition: opts.disposition }
          : { kind: 'step' as const, id: opts.step, disposition: opts.disposition };
        if (target.kind === 'decision' && !['proceed', 'retry'].includes(target.disposition)) {
          throw new Error('decision disposition must be proceed|retry');
        }
        if (target.kind === 'step' && !['retry', 'skip'].includes(target.disposition)) {
          throw new Error('step disposition must be retry|skip');
        }
        print(resolveSession(projectRoot, opts.session, { ...common, target }));
      } catch (error) {
        reportError(error);
      }
    });

  run
    .command('done [run-id]')
    .description('Check and complete the current Run (friendly alias for run complete --verdict)')
    .option('--session <id>', 'explicit Session ID')
    .option('--skip-artifact-metadata-validation', 'downgrade artifact kind/schema/role/alias contract mismatches to warnings')
    .option('--verdict <verdict>', `completion verdict: ${VALID_VERDICTS.join('|')} (default done; ${VERDICT_ALIAS_LABEL})`)
    .option('--summary <text>', 'handoff.summary fallback when the report frontmatter left it empty')
    .option('--reason <text>', 'blocker reason (blocked) merged into handoff concerns')
    .option('--note <text>', 'supplementary concern merged into the handoff (repeatable)', collect, [])
    .option('--decision <text>', 'decision appended to handoff.decisions (repeatable)', collect, [])
    .option('--evidence <path>', 'run-relative evidence path registered as an artifact (repeatable)', collect, [])
    .option('--artifact <path>', 'run-relative path registered as evidence beyond the outputs scan (repeatable)', collect, [])
    .option('--chain-proposal <path>', 'run-relative chain-proposal artifact applied atomically with completion')
    .option('--apply-proposal', 'apply the single validated chain-proposal discovered in this Run')
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
      workflowRoot: string;
    }) => {
      sessionMigrationNotice('done');
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
          const resolved = resolveRunningRun(projectRoot, store, opts.session, 'run done');
          if (resolved.kind === 'ok') {
            sessionId = resolved.sessionId;
            runId = resolved.step.run_id;
          } else {
            const active = resolveActiveRunTarget(store, opts.session);
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
        print(result);
        process.stderr.write(`next: ${result.next.command}\n      ${result.next.reason}\n`);
        if (!result.run_sealed) process.exitCode = 1;
      } catch (error) {
        reportError(error);
      }
    });

  run
    .command('edit [commands...]')
    .description('Edit future chain steps; adding commands inserts pending steps, never raw Runs')
    .option('--session <id>', 'explicit Session ID')
    .option('--after <selector>', 'insert after current|latest|start|step-id|index', 'current')
    .option('--replace <step-id>', 'replace a pending step with the first command')
    .option('--remove <step-id>', 'remove a pending step by marking it skipped')
    .option('--args <text>', 'step args string (only with one command)')
    .option('--stage <name>', 'stage label')
    .option('--goal-ref <id>', 'goal reference id')
    .option('--position-file <path>', 'replace orchestration.position from JSON; "-" reads stdin')
    .option('--decomposition-file <path>', 'replace orchestration.decomposition from JSON; "-" reads stdin')
    .option('--inserted-by <actor>', 'who inserted the step', 'manual')
    .option('--workflow-root <path>', 'project root containing .workflow', process.cwd())
    .action((commands: string[], opts: {
      session?: string;
      after: string;
      replace?: string;
      remove?: string;
      args?: string;
      stage?: string;
      goalRef?: string;
      positionFile?: string;
      decompositionFile?: string;
      insertedBy: string;
      workflowRoot: string;
    }) => {
      sessionMigrationNotice('edit', 'chain edit');
      try {
        const projectRoot = resolve(opts.workflowRoot);
        const store = new SessionStore(projectRoot);
        const selectedCommands = commands.map(command => command.trim()).filter(Boolean);
        if (opts.replace && opts.remove) throw new Error('use either --replace or --remove, not both');
        if (opts.positionFile === '-' && opts.decompositionFile === '-') {
          throw new Error('only one metadata input may read from stdin');
        }
        const resolveSessionId = (): string => {
          if (opts.session) {
            if (!store.sessionExists(opts.session)) throw new Error(`session not found: ${opts.session}`);
            return opts.session;
          }
          const resolved = resolveRunningRun(projectRoot, store, undefined, 'run edit');
          if (resolved.kind === 'ok') return resolved.sessionId;
          throw new Error(`${resolved.message}; pass --session <id>`);
        };
        const sessionId = resolveSessionId();
        if (opts.positionFile || opts.decompositionFile) {
          if (selectedCommands.length > 0 || opts.replace || opts.remove) {
            throw new Error('metadata replacement cannot be combined with chain edits');
          }
          const update: {
            position?: ReturnType<typeof parsePositionInput>;
            decomposition?: ReturnType<typeof parseDecompositionInput>;
          } = {};
          if (opts.positionFile) update.position = parsePositionInput(readJsonInput(opts.positionFile, 'position-file'));
          if (opts.decompositionFile) {
            update.decomposition = parseDecompositionInput(readJsonInput(opts.decompositionFile, 'decomposition-file'));
          }
          print(updateSessionMeta(projectRoot, sessionId, update));
          return;
        }
        if (opts.remove) {
          if (selectedCommands.length > 0) throw new Error('--remove does not accept commands');
          const skipped = skipChainStep(projectRoot, sessionId, opts.remove);
          print({ session_id: sessionId, removed: skipped, note: 'removed means skipped; sealed history is preserved' });
          return;
        }
        if (opts.replace) {
          if (selectedCommands.length !== 1) throw new Error('--replace requires exactly one replacement command');
          const replaced = replaceChainStep(projectRoot, sessionId, opts.replace, {
            command: selectedCommands[0],
            args: opts.args,
            stage: opts.stage,
            goalRef: opts.goalRef,
          });
          print({ session_id: sessionId, replaced });
          return;
        }
        if (selectedCommands.length === 0) {
          throw new Error('run edit requires commands, --replace, --remove, --position-file, or --decomposition-file');
        }
        if (opts.args && selectedCommands.length !== 1) throw new Error('--args can only be used when inserting one command');
        const resolveAfter = (): string => {
          const selector = opts.after.trim().toLowerCase();
          if (['start', 'head', 'beginning', 'none'].includes(selector)) return 'start';
          const session = store.readBundle(sessionId).session;
          if (selector === 'current') {
            const running = session.orchestration.chain.find(step => step.status === 'running' && step.run_id);
            if (running) return running.step_id;
            if (session.orchestration.chain.length === 0) return 'start';
            throw new Error(`session ${sessionId} has no running chain step; use --after latest, --after start, or a step id`);
          }
          if (selector === 'latest') {
            for (let i = session.orchestration.chain.length - 1; i >= 0; i--) {
              const step = session.orchestration.chain[i];
              if (step.status !== 'pending') return step.step_id;
            }
            return session.orchestration.chain.at(-1)?.step_id ?? 'start';
          }
          return opts.after;
        };
        let after = resolveAfter();
        const inserted = [];
        for (const command of selectedCommands) {
          const step = insertChainStep(projectRoot, sessionId, {
            after,
            command,
            args: opts.args,
            stage: opts.stage,
            goalRef: opts.goalRef,
            insertedBy: opts.insertedBy,
          });
          inserted.push(step);
          after = step.step_id;
        }
        print({ session_id: sessionId, inserted, next: `maestro session next --session ${sessionId}` });
      } catch (error) {
        reportError(error);
      }
    });

  run
    .command('prepare <step>')
    .description('Return prepare file + workflow metadata for pre-task thinking (read-only, stateless)')
    .option('--session <id>', 'attach prior-step context from a Session (read-only)')
    .option('--topic <text>', 'resolve prior-step context from the unique running topic Session (read-only)')
    .option('--workflow-root <path>', 'project root', process.cwd())
    .option('--platform <name>', 'target platform for tool substitution (claude|codex|agy|agents-standard|pi)')
    .action((step: string, opts: { session?: string; topic?: string; workflowRoot: string; platform?: string }) => {
      try {
        const platform = opts.platform as TargetPlatform | undefined;
        if (platform && !VALID_PLATFORMS.includes(platform)) {
          throw new Error(`unknown platform "${platform}", valid: ${VALID_PLATFORMS.join(', ')}`);
        }
        const projectRoot = resolve(opts.workflowRoot);
        const resolvedTopicSession = opts.topic
          ? resolveTopicSessionId(projectRoot, opts.topic, opts.session)
          : null;
        if (opts.session && opts.topic && resolvedTopicSession === null) {
          throw new Error(`Session not found: ${opts.session}`);
        }
        const sessionId = opts.topic ? resolvedTopicSession ?? undefined : opts.session;
        print(prepareStep(projectRoot, step, platform, sessionId));
      } catch (error) {
        reportError(error);
      }
    });

  run
    .command('next')
    .description('Advance a Session chain: create the next pending Run and emit a compact birth packet')
    .option('--session <id>', 'explicit Session ID')
    .option('--pick <step-id>', 'advance a specific pending execution step instead of the queue head')
    .option('--json', 'emit structured JSON instead of the human-readable birth packet')
    .option('--execution-owner <owner>', 'lease execution owner (checked against session.orchestration.lease)')
    .option('--owner-epoch <epoch>', 'lease owner epoch', Number.parseInt)
    .option('--lease-id <id>', 'lease identifier for concurrency safety')
    .option('--workflow-root <path>', 'project root containing .workflow', process.cwd())
    .action((opts: {
      session?: string;
      pick?: string;
      json?: boolean;
      executionOwner?: string;
      ownerEpoch?: number;
      leaseId?: string;
      workflowRoot: string;
    }) => {
      const projectRoot = resolve(opts.workflowRoot);
      sessionMigrationNotice('next', undefined, opts.json);
      try {
        const outcome = runNextStep(projectRoot, {
          sessionId: opts.session,
          pick: opts.pick,
          json: opts.json,
          executionOwner: opts.executionOwner,
          ownerEpoch: opts.ownerEpoch,
          leaseId: opts.leaseId,
        });
        if (opts.json) {
          if (outcome.exitCode === 0 && outcome.result) {
            machineSuccess(
              'next',
              outcome.result,
              { session_id: outcome.result.session_id, run_id: outcome.result.run_id },
              undefined,
              undefined,
              undefined,
              inspectSessionContinuation(projectRoot, outcome.result.session_id, { runId: outcome.result.run_id }),
            );
          } else {
            emitRunResponse(createRunResponseError({
              operation: 'next',
              exit_code: outcome.exitCode as 1 | 2 | 3,
              code: outcome.reasonCode as RunResponseErrorCode,
              message: outcome.message,
              details: { reason_code: outcome.reasonCode },
              continuation: continuationForNextFailure(
                projectRoot,
                opts.session,
                outcome.reasonCode,
                outcome.message,
              ),
            }));
          }
        } else {
          const stream = outcome.exitCode === 0 ? process.stdout : process.stderr;
          stream.write(outcome.message + '\n');
          if (outcome.exitCode !== 0) process.exitCode = outcome.exitCode;
        }
      } catch (error) {
        if (opts.json) machineError('next', error); else reportError(error);
      }
    });

  run
    .command('create <command> [args...]')
    .description('Create a Run in an existing or new Session')
    .option('--session <id>', 'explicit Session ID')
    .option('--intent <text>', 'Session metadata only (not passed to the command or Run input.args)')
    .option('--topic <text>', 'command-independent Session topic (Unicode supported)')
    .option('--retry-token <token>', 'opaque single-use token issued by a needs-retry transition')
    .option('--platform <name>', 'target platform persisted for this Run')
    .option('--arg <value>', 'command input stored in Run input.args (repeatable)', collect, [])
    .option('--json', 'emit one run-response/1.0 envelope on stdout')
    .option('--workflow-root <path>', 'project root containing .workflow', process.cwd())
    .action((command: string, positionalArgs: string[], opts: {
      session?: string;
      intent?: string;
      topic?: string;
      retryToken?: string;
      platform?: string;
      arg: string[];
      json?: boolean;
      workflowRoot: string;
    }) => {
      try {
        const platform = opts.platform as TargetPlatform | undefined;
        if (platform && !VALID_PLATFORMS.includes(platform)) {
          throw new Error(`unknown platform "${platform}", valid: ${VALID_PLATFORMS.join(', ')}`);
        }
        const result = createRun({
          projectRoot: resolve(opts.workflowRoot),
          command,
          sessionId: opts.session,
          intent: opts.intent,
          topic: opts.topic,
          retryToken: opts.retryToken,
          platform,
          args: [...opts.arg, ...positionalArgs],
        });
        if (!opts.json && result.session_created && opts.session) {
          console.error(
            `Warning: Session "${opts.session}" did not exist; created it for this Run. `
            + `If you meant an existing Session, use its exact ID (see "maestro session list").`,
          );
        }
        if (opts.json) machineSuccess('create', result, { session_id: result.session_id, run_id: result.run_id }); else print(result);
      } catch (error) {
        if (opts.json) machineError('create', error); else reportError(error);
      }
    });

  run
    .command('check [run-id]')
    .description('Scan outputs, evaluate Run gates, and refresh the knowledge reconciliation receipt')
    .option('--session <id>', 'explicit Session ID')
    .option('--skip-artifact-metadata-validation', 'downgrade artifact kind/schema/role/alias contract mismatches to warnings')
    .option('--json', 'emit one run-response/1.0 envelope on stdout')
    .option('--workflow-root <path>', 'project root containing .workflow', process.cwd())
    .action((runId: string | undefined, opts: {
      session?: string;
      skipArtifactMetadataValidation?: boolean;
      json?: boolean;
      workflowRoot: string;
    }) => {
      const projectRoot = resolve(opts.workflowRoot);
      try {
        const store = new SessionStore(projectRoot);
        let sessionId: string | undefined;
        if (!runId) {
          const resolved = resolveRunningRun(projectRoot, store, opts.session, 'run check');
          if (resolved.kind === 'ok') {
            sessionId = resolved.sessionId;
            runId = resolved.step.run_id;
          } else {
            const active = resolveActiveRunTarget(store, opts.session);
            if (!active) throw new Error(resolved.message);
            sessionId = active.sessionId;
            runId = active.runId;
          }
        }
        const result = checkRun(projectRoot, runId, sessionId ?? opts.session, {
          skipArtifactMetadataValidation: opts.skipArtifactMetadataValidation,
        });
        if (opts.json) {
          const next = result.next
            ? { suggest_only: true as const, command: result.next.command, reason: result.next.reason }
            : null;
          machineSuccess(
            'check',
            result,
            { session_id: result.session_id, run_id: result.run_id },
            undefined,
            null,
            next,
            result.next
              ? continuationAfterCheck(
                  projectRoot,
                  result.session_id,
                  result.run_id,
                  result.gates.blocking.length === 0 && result.errors.length === 0,
                  result.next,
                )
              : inspectSessionContinuation(projectRoot, result.session_id, { runId: result.run_id }),
          );
        } else {
          print(result);
        }
      } catch (error) {
        if (opts.json) {
          machineError('check', error, { locator: { session_id: opts.session ?? null, run_id: runId ?? null } });
        } else {
          reportError(error);
        }
      }
    });

  run
    .command('rebind <run-id>')
    .description(`${ADMIN_COMPATIBILITY_PREFIX} Audit compatible command binding drift for a legacy Run`)
    .option('--session <id>', 'explicit Session ID')
    .requiredOption('--reason <text>', 'required audited reason for accepting compatible drift')
    .option('--workflow-root <path>', 'project root containing .workflow', process.cwd())
    .addHelpText('after', `
Compatibility boundary:
  Rebind is retained only for audited recovery of legacy Run metadata.
  It is excluded from normal topic resolution, Session selection, sealed-output reuse,
  recall recommendations, and next-action routing.
  Rebind strictly validates gate and produce compatibility before updating the stored command binding.
  --reason is required and recorded in command-rebind.json.
  This is not a force operation or lifecycle bypass; incompatible or unprovable drift is rejected.
`)
    .action((runId: string, opts: { session?: string; reason: string; workflowRoot: string }) => {
      try {
        print(rebindRunCommand(resolve(opts.workflowRoot), runId, opts.reason, opts.session));
      } catch (error) {
        reportError(error);
      }
    });

  run
    .command('complete [run-id]')
    .description('Seal a Run and advance its chain step by verdict (免参: resolves the active step)')
    .option('--session <id>', 'explicit Session ID')
    .option('--skip-artifact-metadata-validation', 'downgrade artifact kind/schema/role/alias contract mismatches to warnings')
    .option('--verdict <verdict>', `chain-advance verdict: ${VALID_VERDICTS.join('|')} (default done; ${VERDICT_ALIAS_LABEL})`)
    .option('--summary <text>', 'handoff.summary fallback when the report frontmatter left it empty')
    .option('--reason <text>', 'blocker reason (blocked) merged into handoff concerns')
    .option('--note <text>', 'supplementary concern merged into the handoff (repeatable)', collect, [])
    .option('--decision <text>', 'decision appended to handoff.decisions (repeatable)', collect, [])
    .option('--evidence <path>', 'run-relative evidence path registered as an artifact (repeatable)', collect, [])
    .option('--artifact <path>', 'run-relative path registered as evidence beyond the outputs scan (repeatable)', collect, [])
    .option('--chain-proposal <path>', 'run-relative chain-proposal artifact applied atomically with completion')
    .option('--apply-proposal', 'apply the single validated chain-proposal discovered in this Run')
    .option('--execution-owner <owner>', 'lease execution owner (checked against session.orchestration.lease)')
    .option('--owner-epoch <epoch>', 'lease owner epoch', Number.parseInt)
    .option('--lease-id <id>', 'lease identifier for concurrency safety')
    .option('--request-id <id>', 'idempotent completion request ID')
    .option('--expected-identity-revision <n>', 'expected Session identity revision', Number.parseInt)
    .option('--expected-activity-revision <n>', 'expected Session activity revision', Number.parseInt)
    .option('--json', 'emit one run-response/1.0 envelope on stdout')
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
      executionOwner?: string;
      ownerEpoch?: number;
      leaseId?: string;
      json?: boolean;
      workflowRoot: string;
    }) => {
      sessionMigrationNotice('complete', 'done', opts.json);
      try {
        const projectRoot = resolve(opts.workflowRoot);

        // Backward-compatible fast path: an explicit run-id with no verbs stays on
        // the plain seal path (identical to the pre-M2 behaviour). Any verdict, or
        // 免参 (no run-id), routes through the chain-driving verdict path.
        const verbless = opts.verdict === undefined && (opts.decision?.length ?? 0) === 0
          && (opts.evidence?.length ?? 0) === 0 && !opts.reason
          && !opts.chainProposal
          && !opts.applyProposal
          && !opts.executionOwner && !opts.leaseId && opts.ownerEpoch === undefined;
        if (runIdArg && verbless) {
          const result = completeRun(projectRoot, runIdArg, opts.session, {
            notes: opts.note,
            extraArtifacts: opts.artifact,
            summaryFallback: opts.summary,
            skipArtifactMetadataValidation: opts.skipArtifactMetadataValidation,
            transition: mutationTransitionOptions(opts),
          });
          if (opts.json) {
            if (result.sealed) machineSuccess(
              'complete',
              result,
              { session_id: result.session_id, run_id: result.run_id },
              { status: result.transition.status, transition_id: result.transition.transition_id },
              result.transition.request_id,
              result.next_action
                ? {
                    suggest_only: true,
                    command: result.next_action.command,
                    reason: result.next_action.reason,
                  }
                : undefined,
              inspectSessionContinuation(projectRoot, result.session_id, { runId: result.run_id }),
            );
            else emitRunResponse(createRunResponseError({
              operation: 'complete',
              exit_code: 1,
              code: 'RUN_GATES_BLOCKING',
              message: 'Run gates are blocking completion',
              details: { result },
              continuation: inspectSessionContinuation(projectRoot, result.session_id, { runId: result.run_id }),
            }));
          } else { print(result); if (!result.sealed) process.exitCode = 1; }
          return;
        }

        const verdict = parseVerdict(opts.verdict);
        if (!verdict) {
          if (opts.json) emitRunResponse(createRunResponseError({ operation: 'complete', exit_code: 2, code: 'INVALID_VERDICT', message: `invalid --verdict "${opts.verdict}"`, details: { valid: VALID_VERDICTS } }));
          else { console.error(`[maestro run] invalid --verdict "${opts.verdict}"; valid: ${VALID_VERDICTS.join(', ')} (${VERDICT_ALIAS_LABEL})`); process.exitCode = 2; }
          return;
        }

        // Resolve the target run + session. 免参 uses the active chain step; an
        // explicit run-id needs its session located for the lease + chain drive.
        const store = new SessionStore(projectRoot);
        let sessionId: string;
        let runId: string;
        if (runIdArg) {
          const located = store.findRun(runIdArg, opts.session);
          sessionId = located.sessionId;
          runId = runIdArg;
        } else {
          const resolved = resolveRunningRun(projectRoot, store, opts.session, 'run complete');
          if (resolved.kind === 'error') {
            if (opts.json) machineError('complete', new Error(resolved.message));
            else { console.error(resolved.message); process.exitCode = 1; }
            return;
          }
          sessionId = resolved.sessionId;
          runId = resolved.step.run_id;
        }

        // Lease guard — mirrors the ralph rejection path (exit 1, "lease conflict").
        const lease = store.readBundle(sessionId).session.orchestration.lease;
        const conflict = checkLease(lease, {
          executionOwner: opts.executionOwner,
          ownerEpoch: opts.ownerEpoch,
          leaseId: opts.leaseId,
        });
        if (conflict) {
          if (opts.json) emitRunResponse(createRunResponseError({ operation: 'complete', exit_code: 1, code: 'LEASE_CONFLICT', message: conflict, details: {} }));
          else { console.error(`[maestro run] ${conflict}`); process.exitCode = 1; }
          return;
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
          leaseClaim: {
            executionOwner: opts.executionOwner,
            ownerEpoch: opts.ownerEpoch,
            leaseId: opts.leaseId,
          },
          transition: mutationTransitionOptions(opts),
        });
        if (opts.json) {
          if (result.run_sealed) machineSuccess(
            'complete',
            result,
            { session_id: result.session_id, run_id: result.run_id },
            { status: result.seal.transition.status, transition_id: result.seal.transition.transition_id },
            result.seal.transition.request_id,
            {
              suggest_only: true,
              command: result.next.command,
              reason: result.next.reason,
            },
            inspectSessionContinuation(projectRoot, result.session_id),
          );
          else emitRunResponse(createRunResponseError({
            operation: 'complete',
            exit_code: 1,
            code: 'RUN_GATES_BLOCKING',
            message: 'Run gates are blocking completion',
            details: { result },
            next: { suggest_only: true, command: result.next.command, reason: result.next.reason },
            continuation: inspectSessionContinuation(projectRoot, result.session_id, { runId: result.run_id }),
          }));
        } else { print(result); process.stderr.write(`next: ${result.next.command}\n      ${result.next.reason}\n`); if (!result.run_sealed) process.exitCode = 1; }
      } catch (error) {
        if (opts.json) machineError('complete', error); else reportError(error);
      }
    });

  run
    .command('brief <run-id>')
    .description('Return Resume Packet for a running Run (re-attach workflow + goals + gate status)')
    .option('--session <id>', 'explicit Session ID')
    .option('--platform <name>', 'target platform for tool substitution (claude|codex|agy|agents-standard|pi)')
    .option('--json', 'emit one run-response/1.0 envelope on stdout')
    .option('--workflow-root <path>', 'project root', process.cwd())
    .action((runId: string, opts: { session?: string; platform?: string; workflowRoot: string; json?: boolean }) => {
      const projectRoot = resolve(opts.workflowRoot);
      try {
        const platform = opts.platform as TargetPlatform | undefined;
        if (platform && !VALID_PLATFORMS.includes(platform)) {
          throw new Error(`unknown platform "${platform}", valid: ${VALID_PLATFORMS.join(', ')}`);
        }
        const result = briefRun(projectRoot, runId, opts.session, platform);
        if (opts.json) {
          machineSuccess(
            'brief',
            result,
            { session_id: result.session.session_id, run_id: result.run.run_id },
            undefined,
            undefined,
            result.recovery.next,
            continuationAfterBrief(
              projectRoot,
              result.session.session_id,
              result.run.run_id,
              result.recovery.next,
            ),
          );
        } else print(result);
      } catch (error) {
        if (opts.json) machineError('brief', error); else reportError(error);
      }
    });

  run
    .command('accept-reuse <run-id>')
    .description('Explicitly accept one exact REVIEW assessment and bind its artifact to run.input.consumes')
    .requiredOption('--session <id>', 'exact Session ID')
    .requiredOption('--assessment-hash <sha256>', 'exact reuse assessment hash shown by run brief')
    .requiredOption('--request-id <id>', 'idempotent acceptance request ID')
    .requiredOption('--actor <name>', 'operator accepting the REVIEW assessment')
    .requiredOption('--reason <text>', 'auditable acceptance reason')
    .requiredOption('--evidence <ref>', 'evidence reference supporting acceptance', collect, [])
    .requiredOption('--expected-identity-revision <n>', 'expected Session identity revision', Number.parseInt)
    .requiredOption('--expected-activity-revision <n>', 'expected Session activity revision', Number.parseInt)
    .option('--execution-owner <owner>', 'lease execution owner')
    .option('--owner-epoch <epoch>', 'lease owner epoch', Number.parseInt)
    .option('--lease-id <id>', 'lease identifier for concurrency safety')
    .option('--json', 'emit one run-response/1.0 envelope on stdout')
    .option('--workflow-root <path>', 'project root containing .workflow', process.cwd())
    .action((runId: string, opts: any) => {
      try {
        const result = acceptRunReuse(
          resolve(opts.workflowRoot),
          runId,
          opts.assessmentHash,
          opts.session,
          { ...mutationTransitionOptions(opts), actor: opts.actor, reason: opts.reason, evidence: opts.evidence },
        );
        if (opts.json) {
          machineSuccess(
            'accept-reuse', result, { session_id: result.session_id, run_id: result.run_id },
            { status: result.transition.status, transition_id: result.transition.transition_id },
            result.transition.request_id,
            undefined,
            inspectSessionContinuation(resolve(opts.workflowRoot), result.session_id, { runId: result.run_id }),
          );
        } else print(result);
      } catch (error) {
        if (opts.json) {
          machineError('accept-reuse', error, {
            requestId: opts.requestId,
            locator: { session_id: opts.session, run_id: runId },
          });
        } else reportError(error);
      }
    });

  run.command('recall <command> [args...]')
    .description('Read-only Session/topic lookup; historical similarity is evidence only and never routes or mutates')
    .requiredOption('--intent <text>', 'verbatim intent')
    .option('--topic <text>', 'command-independent Session topic; defaults to intent')
    .option('--limit <n>', 'maximum candidates', Number.parseInt, 20)
    .option('--as-of <iso>', 'canonical scoring timestamp')
    .option('--json', 'emit one run-response/1.0 envelope on stdout')
    .option('--workflow-root <path>', 'project root containing .workflow', process.cwd())
    .action(async (command: string, _args: string[], opts: { intent: string; topic?: string; limit: number; asOf?: string; json?: boolean; workflowRoot: string }) => {
      try {
        const result = readOnlyRecallProjection(await recallRuns(resolve(opts.workflowRoot), {
          command,
          intent: opts.intent,
          topic: opts.topic,
          limit: opts.limit,
          asOf: opts.asOf,
        }));
        if (opts.json) machineSuccess('recall', result); else print(result);
      } catch (error) { if (opts.json) machineError('recall', error); else reportError(error); }
    });

  addAdminCompatibilityHelp(
    run.command('recall-confirm <action>')
      .description(`${ADMIN_COMPATIBILITY_PREFIX} Issue a legacy recall-mutation confirmation token`)
      .requiredOption('--target-session <id>', 'new target Session ID')
      .requiredOption('--command <name>', 'target command')
      .requiredOption('--intent <text>', 'target intent')
      .option('--source-session <id>', 'immutable source Session')
      .option('--source-run <id>', 'immutable source Run')
      .option('--source-workspace <name>', 'linked source workspace (import-only)')
      .option('--arg <value>', 'target command arg (repeatable)', collect, [])
      .option('--json', 'emit one run-response/1.0 envelope on stdout')
      .option('--workflow-root <path>', 'project root containing .workflow', process.cwd()),
    'Retained temporarily to reconcile existing recall confirmation records.',
  )
    .action((action: string, opts: any) => {
      try {
        if (!['fork', 'import', 'new'].includes(action)) throw new Error('action must be fork|import|new');
        const typedAction = action as 'fork' | 'import' | 'new';
        const result = issueRecallConfirmation(resolve(opts.workflowRoot), { action: typedAction, target_session_id: opts.targetSession, command: opts.command, intent: opts.intent, source_session_id: opts.sourceSession, source_run_id: opts.sourceRun, source_workspace: opts.sourceWorkspace, args: opts.arg });
        const op = action === 'new' ? 'create' : action as MachineOperation;
        if (opts.json) machineSuccess(op, result); else print(result);
      } catch (error) { if (opts.json) machineError(action === 'new' ? 'create' : ['fork', 'import'].includes(action) ? action as MachineOperation : 'recall', error); else reportError(error); }
    });

  for (const action of ['fork', 'import', 'new'] as const) {
    addAdminCompatibilityHelp(
      run.command(action)
        .description(`${ADMIN_COMPATIBILITY_PREFIX} Execute legacy confirmed ${action} recovery`)
        .requiredOption('--confirmation-token <token>', 'single-use confirmation token')
        .requiredOption('--target-session <id>', 'new target Session ID')
        .requiredOption('--command <name>', 'target command')
        .requiredOption('--intent <text>', 'target intent')
        .option('--source-session <id>', 'immutable source Session')
        .option('--source-run <id>', 'immutable source Run')
        .option('--source-workspace <name>', 'linked source workspace (import-only)')
        .option('--arg <value>', 'target command arg (repeatable)', collect, [])
        .option('--json', 'emit one run-response/1.0 envelope on stdout')
        .option('--workflow-root <path>', 'project root containing .workflow', process.cwd()),
      `Retained temporarily to finish or reconcile an existing ${action} reservation.`,
    )
      .action((opts: any) => {
        try {
          const result = executeRecallAction(resolve(opts.workflowRoot), { action, confirmation_token: opts.confirmationToken, target_session_id: opts.targetSession, command: opts.command, intent: opts.intent, source_session_id: opts.sourceSession, source_run_id: opts.sourceRun, source_workspace: opts.sourceWorkspace, args: opts.arg });
          const op = action === 'new' ? 'create' : action;
          if (opts.json) machineSuccess(op, result, { session_id: result.session_id, run_id: result.run_id }, { status: result.replayed ? 'replayed' : 'applied', transition_id: result.reservation_id }); else print(result);
        } catch (error) { if (opts.json) machineError(action === 'new' ? 'create' : action, error); else reportError(error); }
      });
  }

  run
    .command('skill <step>')
    .description('Load prepare + workflow content for a step (stateless, no Session)')
    .option('--platform <name>', 'target platform for tool substitution (claude|codex|agy|agents-standard|pi)')
    .option('--workflow-root <path>', 'project root', process.cwd())
    .action((step: string, opts: { platform?: string; workflowRoot: string }) => {
      try {
        const platform = opts.platform as TargetPlatform | undefined;
        if (platform && !VALID_PLATFORMS.includes(platform)) {
          throw new Error(`unknown platform "${platform}", valid: ${VALID_PLATFORMS.join(', ')}`);
        }
        print(skillContent(resolve(opts.workflowRoot), step, platform));
      } catch (error) {
        reportError(error);
      }
    });

  run
    .command('decide <point-id>')
    .description('Record a decision point verdict and advance the chain (evaluation stays in the prompt layer)')
    .requiredOption('--session <id>', 'Session ID')
    .requiredOption('--verdict <verdict>', 'decision verdict: proceed|fix|escalate')
    .requiredOption('--confidence <level>', 'evaluation confidence: high|medium|low')
    .option('--summary <text>', 'one-line rationale, recorded in decisions.ndjson + evidence_ref fallback')
    .option('--evidence <path>', 'evidence path/reference recorded on decision_point.evidence_ref')
    .option('--request-id <id>', 'idempotent decision request ID')
    .option('--expected-identity-revision <n>', 'expected Session identity revision', Number.parseInt)
    .option('--expected-activity-revision <n>', 'expected Session activity revision', Number.parseInt)
    .option('--execution-owner <owner>', 'lease execution owner')
    .option('--owner-epoch <epoch>', 'lease owner epoch', Number.parseInt)
    .option('--lease-id <id>', 'lease identifier for concurrency safety')
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
      sessionMigrationNotice('decide', undefined, opts.json);
      try {
        const verdict = opts.verdict.trim().toLowerCase();
        if (!['proceed', 'fix', 'escalate'].includes(verdict)) {
          if (opts.json) {
            machineError('decide', new Error(`invalid --verdict "${opts.verdict}"; valid: proceed, fix, escalate`), {
              exitCode: 2,
              code: 'INVALID_VERDICT',
              requestId: opts.requestId,
              locator: { session_id: opts.session, run_id: null },
            });
          } else {
            console.error(`[maestro run] invalid --verdict "${opts.verdict}"; valid: proceed, fix, escalate`);
            process.exitCode = 2;
          }
          return;
        }
        const confidence = opts.confidence.trim().toLowerCase();
        if (!['high', 'medium', 'low'].includes(confidence)) {
          if (opts.json) {
            machineError('decide', new Error(`invalid --confidence "${opts.confidence}"; valid: high, medium, low`), {
              exitCode: 2,
              code: 'INVALID_ARGUMENT',
              requestId: opts.requestId,
              locator: { session_id: opts.session, run_id: null },
            });
          } else {
            console.error(`[maestro run] invalid --confidence "${opts.confidence}"; valid: high, medium, low`);
            process.exitCode = 2;
          }
          return;
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
            'decide',
            result,
            { session_id: result.session_id, run_id: null },
            { status: result.transition.status, transition_id: result.transition.transition_id },
            result.transition.request_id,
            { suggest_only: true, command: result.next.command, reason: result.next.reason },
            continuationAfterDecide(
              resolve(opts.workflowRoot),
              result.session_id,
              result.point_id,
              result.verdict,
              result.retry,
            ),
          );
        } else {
          print(result);
          process.stderr.write(`next: ${result.next.command}\n      ${result.next.reason}\n`);
          if (result.retry?.exhausted) {
            process.stderr.write(
              `warning: decision point ${pointId} retry ${result.retry.count}/${result.retry.max} exhausted `
              + `— the orchestrator (FSM) decides whether to force escalate\n`,
            );
          }
        }
      } catch (error) {
        if (opts.json) {
          machineError('decide', error, {
            requestId: opts.requestId,
            locator: { session_id: opts.session, run_id: null },
          });
        } else {
          reportError(error);
        }
      }
    });

  run
    .command('seal-session <session-id>')
    .description('Seal a Session after all Runs and Session gates are complete')
    .option('--summary <text>', 'human-readable seal summary', '')
    .option('--json', 'emit one run-response/1.0 envelope on stdout')
    .option('--workflow-root <path>', 'project root containing .workflow', process.cwd())
    .action((sessionId: string, opts: { summary: string; json?: boolean; workflowRoot: string }) => {
      sessionMigrationNotice('seal-session', 'seal', opts.json);
      try {
        const result = sealSession(resolve(opts.workflowRoot), sessionId, opts.summary);
        if (opts.json) machineSuccess('seal-session', result, { session_id: result.session_id, run_id: null });
        else print(result);
      } catch (error) {
        if (opts.json) machineError('seal-session', error, { locator: { session_id: sessionId, run_id: null } });
        else reportError(error);
      }
    });

  run
    .command('log-mutation <target>')
    .description('Record an out-of-run file mutation to the mutations ledger')
    .requiredOption('--actor <name>', 'command or hook that performed the mutation')
    .option('--type <type>', 'mutation type: write|append|delete|patch', 'write')
    .option('--hash <hash>', 'content hash of the written file')
    .option('--run-id <id>', 'associated run ID (if within a run)')
    .option('--workflow-root <path>', 'project root', process.cwd())
    .action((target: string, opts: { actor: string; type: string; hash?: string; runId?: string; workflowRoot: string }) => {
      try {
        if (!['write', 'append', 'delete', 'patch'].includes(opts.type)) {
          throw new Error(`invalid mutation type "${opts.type}" (write|append|delete|patch)`);
        }
        const root = resolve(opts.workflowRoot);
        logMutation(root, opts.actor, resolve(root, target), {
          contentHash: opts.hash,
          mutationType: opts.type as 'write' | 'append' | 'delete' | 'patch',
          runId: opts.runId,
        });
        print({ status: 'ok', target, actor: opts.actor });
      } catch (error) {
        reportError(error);
      }
    });

  run
    .command('mutations')
    .description('List recorded out-of-run mutations')
    .option('--workflow-root <path>', 'project root', process.cwd())
    .action((opts: { workflowRoot: string }) => {
      try {
        const entries = readLedger(resolve(opts.workflowRoot));
        if (entries.length === 0) { console.log('No mutations recorded.'); return; }
        for (const entry of entries) {
          console.log(`${entry.timestamp}  ${entry.actor.padEnd(20)}  ${entry.mutation_type.padEnd(7)}  ${entry.target}`);
        }
      } catch (error) {
        reportError(error);
      }
    });
}
