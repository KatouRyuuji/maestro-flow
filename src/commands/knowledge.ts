import type { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { MaestroGraph } from '../graph/kg/engine.js';
import {
  buildKnowledgeUsageStats,
  type KnowledgeUsageConcentration,
} from '../graph/kg/knowledge-usage.js';
import {
  recordRunKnowledgeInputs,
  stageRunKnowledgeCandidate,
  summarizeSessionKnowledge,
  type KnowledgeInputSignal,
} from '../run/knowledge.js';
import { auditKnowledge, type KnowledgeAuditScope } from '../knowledge/audit.js';
import { SessionStore } from '../run/store.js';
import {
  persistActiveKnowledgeReconciliation,
  persistKnowledgeReconciliation,
  promoteReconciledSessionKnowledge,
  currentKnowledgeCorpusFingerprint,
  isKnowledgeReconciliationFresh,
  readKnowledgeReconciliation,
  reconcileRunKnowledge,
  resolveKnowledgeCandidate,
  type KnowledgeResolutionChoice,
} from '../knowledge/reconcile.js';
import type {
  KnowledgeCandidateReconciliation,
} from '../knowledge/reconciliation-schema.js';
import { readReportFrontmatter } from '../run/report.js';

const KNOWLEDGE_SOURCE_TYPES = ['spec', 'knowhow', 'issue', 'domain', 'codebase'] as const;
const KNOWLEDGE_INPUT_SIGNALS = ['consumed', 'cited', 'validated', 'contradicted'] as const;
const KNOWLEDGE_CANDIDATE_TARGETS = ['spec', 'knowhow'] as const;
const KNOWLEDGE_CANDIDATE_ACTIONS = ['propose', 'reaffirm', 'supersede', 'contest'] as const;
const KNOWLEDGE_RESOLUTIONS = ['duplicate', 'related', 'conflict', 'supersede', 'unique'] as const;

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function printConcentration(label: string, value: KnowledgeUsageConcentration): void {
  console.log(
    `${label}: ${value.totalEvents} events · ${value.positiveNodes} nodes · `
    + `top10 ${percent(value.top10Share)} · Gini ${value.gini.toFixed(3)} · `
    + `effective ${value.effectiveNodes.toFixed(1)}`,
  );
}

type KnowledgeSessionView = ReturnType<typeof buildKnowledgeSessionView>;

function uniqueRunIds(
  candidates: ReturnType<typeof summarizeSessionKnowledge>['candidates'],
): string[] {
  return [...new Set(candidates.flatMap(candidate => candidate.run_ids))].sort();
}

function resolutionChoices(
  candidateId: string,
  sessionId: string,
  policy: KnowledgeCandidateReconciliation,
): string[] {
  if (policy.promotion_eligibility !== 'review_required') return [];
  const target = policy.canonical_id ?? policy.matches[0]?.knowledge_id;
  const base = `maestro knowledge resolve ${candidateId} --session ${sessionId}`;
  const withTarget = (choice: string): string =>
    `${base} --as ${choice}${target ? ` --target ${target}` : ''} --reason "<reason>"`;
  switch (policy.disposition) {
    case 'semantic_duplicate':
      return [withTarget('duplicate'), withTarget('related'), `${base} --as unique --reason "<reason>"`];
    case 'potential_conflict':
      return [withTarget('conflict'), withTarget('related'), `${base} --as unique --reason "<reason>"`];
    case 'supersede_candidate':
      return [withTarget('supersede'), withTarget('related'), `${base} --as unique --reason "<reason>"`];
    case 'extends':
    case 'related':
      return [withTarget('related'), withTarget('supersede'), `${base} --as unique --reason "<reason>"`];
    default:
      return [];
  }
}

function buildKnowledgeSessionView(projectRoot: string, sessionId: string) {
  const summary = summarizeSessionKnowledge(projectRoot, sessionId);
  const store = new SessionStore(projectRoot);
  const expectedCorpusFingerprint = currentKnowledgeCorpusFingerprint(projectRoot);
  const receiptByRun = new Map(uniqueRunIds(summary.candidates).map(runId => {
    const receipt = readKnowledgeReconciliation(store, sessionId, runId, true);
    const fresh = receipt
      ? isKnowledgeReconciliationFresh(
          projectRoot,
          sessionId,
          runId,
          receipt,
          readReportFrontmatter(store.runDir(sessionId, runId)),
          expectedCorpusFingerprint,
        )
      : false;
    return [runId, { receipt, fresh }] as const;
  }));
  const candidates = summary.candidates.map(candidate => {
    const reconciliation = candidate.run_ids.flatMap(runId => {
      const state = receiptByRun.get(runId);
      const policy = state?.receipt?.candidates
        .find(item => item.candidate_id === candidate.candidate_id);
      return policy ? [{ policy, fresh: state!.fresh, runId }] : [];
    });
    const selected = reconciliation.find(
      item => item.policy.promotion_eligibility === 'suppressed',
    ) ?? reconciliation.find(
      item => item.policy.promotion_eligibility === 'review_required',
    ) ?? reconciliation[0]
      ?? null;
    const allSourcesPresent = candidate.run_ids.every(runId => {
      const receipt = receiptByRun.get(runId)?.receipt;
      return receipt?.candidates.some(item => item.candidate_id === candidate.candidate_id) === true;
    });
    const freshness = !allSourcesPresent
      ? 'missing' as const
      : reconciliation.every(item => item.fresh)
        ? 'fresh' as const
        : 'stale' as const;
    const reconcileCommands = candidate.run_ids
      .filter(runId => {
        const state = receiptByRun.get(runId);
        return !state?.receipt || !state.fresh
          || !state.receipt.candidates.some(item => item.candidate_id === candidate.candidate_id);
      })
      .map(runId => `maestro knowledge reconcile --run ${runId} --session ${sessionId}`);
    return {
      ...candidate,
      reconciliation: selected
        ? {
            ...selected.policy,
            freshness,
          }
        : null,
      review: {
        freshness,
        reconcile_commands: reconcileCommands,
        resolution_commands: selected
          ? resolutionChoices(candidate.candidate_id, sessionId, selected.policy)
          : [],
      },
    };
  });
  return { ...summary, candidates };
}

function printKnowledgeReview(view: KnowledgeSessionView): void {
  console.log(`Knowledge review: ${view.session_id}`);
  console.log(
    `${view.candidates.length} candidate(s) · `
    + `${view.candidates.filter(candidate => candidate.review.freshness === 'missing').length} missing · `
    + `${view.candidates.filter(candidate => candidate.review.freshness === 'stale').length} stale · `
    + `${view.candidates.filter(candidate =>
      candidate.reconciliation?.promotion_eligibility === 'review_required'
    ).length} review required`,
  );
  for (const candidate of view.candidates) {
    const policy = candidate.reconciliation;
    console.log(
      `\n${candidate.candidate_id} [${candidate.stage}/${candidate.status}] `
      + `${candidate.target}:${candidate.category ?? 'uncategorized'} · ${candidate.title}`,
    );
    console.log(
      `  reconciliation: ${policy?.disposition ?? 'missing'}/`
      + `${policy?.promotion_eligibility ?? 'unavailable'} · ${candidate.review.freshness}`,
    );
    for (const match of policy?.matches.slice(0, 3) ?? []) {
      console.log(
        `  match: ${match.knowledge_id} [${match.relation}] `
        + `score ${match.scores.composite.toFixed(3)} · ${match.title}`,
      );
      for (const evidence of match.evidence.slice(0, 2)) console.log(`    evidence: ${evidence}`);
    }
    for (const command of candidate.review.reconcile_commands) console.log(`  next: ${command}`);
    for (const command of candidate.review.resolution_commands) console.log(`  resolve: ${command}`);
    if (policy?.promotion_eligibility === 'eligible' && candidate.status === 'pending') {
      console.log(
        `  promote: maestro knowledge promote ${view.session_id} --candidate ${candidate.candidate_id}`,
      );
    }
  }
}

export function registerKnowledgeCommand(program: Command): void {
  const knowledge = program
    .command('knowledge')
    .description('Inspect project knowledge usage and lifecycle signals');

  knowledge
    .command('audit')
    .description('Audit knowledge health and optionally apply a safe soft-prune plan')
    .option('--scope <scope>', 'Audit scope: spec|knowhow|all', 'all')
    .option('--prune', 'Include a deterministic soft-prune plan')
    .option('--apply', 'Apply the prune plan after backups (requires --prune)')
    .option('--json', 'Output as JSON')
    .option('--workflow-root <path>', 'Project root containing .workflow', process.cwd())
    .action(async (opts: {
      scope?: string;
      prune?: boolean;
      apply?: boolean;
      json?: boolean;
      workflowRoot: string;
    }) => {
      try {
        if (!['spec', 'knowhow', 'all'].includes(opts.scope ?? 'all')) {
          throw new Error('--scope must be one of spec, knowhow, all');
        }
        const result = await auditKnowledge(resolve(opts.workflowRoot), {
          scope: (opts.scope ?? 'all') as KnowledgeAuditScope,
          prune: opts.prune,
          apply: opts.apply,
        });
        if (opts.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        console.log(`Knowledge audit: ${result.findings.length} finding(s)`);
        console.log(
          `Pipeline: ${result.pipeline.ledgers} ledgers · `
          + `${result.pipeline.pending_corroborated} corroborated pending · `
          + `${result.pipeline.pending_observed} observed pending · `
          + `${result.pipeline.promoted} promoted`,
        );
        if (result.usage) {
          console.log(
            `Exposure: top10 ${percent(result.usage.impressionConcentration.top10Share)} · `
            + `Gini ${result.usage.impressionConcentration.gini.toFixed(3)}`,
          );
        }
        for (const finding of result.findings) {
          console.log(
            `  ${finding.priority} ${finding.store}/${finding.subtype} `
            + `${finding.target}: ${finding.evidence}`,
          );
        }
        if (opts.prune) console.log(`Prune plan: ${result.prune_plan.length} soft action(s)`);
        if (opts.apply) {
          console.log(
            `Applied: ${result.applied.count} · backup: ${result.applied.backup_dir ?? 'not needed'}`,
          );
        }
      } catch (error) {
        console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
      }
    });

  knowledge
    .command('stage')
    .description('Stage a reviewable spec or knowhow candidate on the active Run')
    .argument('<target>', `Candidate target: ${KNOWLEDGE_CANDIDATE_TARGETS.join('|')}`)
    .argument('<title>', 'Candidate title')
    .argument('[content]', 'Candidate content (omit when using --content-file)')
    .option('--content-file <path>', 'Read candidate content from a file; "-" reads stdin')
    .option('--action <action>', `Candidate intent: ${KNOWLEDGE_CANDIDATE_ACTIONS.join('|')}`, 'propose')
    .option('--category <category>', 'Spec/knowhow category')
    .option('--evidence <refs>', 'Comma-separated evidence references')
    .option('--signal <signal>', `Also record a knowledge signal: ${KNOWLEDGE_INPUT_SIGNALS.join('|')}`)
    .option('--signal-ids <ids>', 'Comma-separated knowledge IDs for --signal')
    .option('--run <run-id>', 'Explicit active Run ID')
    .option('--session <session-id>', 'Explicit Session ID (requires --run)')
    .option('--json', 'Output as JSON')
    .option('--workflow-root <path>', 'Project root containing .workflow', process.cwd())
    .action(async (
      target: string,
      title: string,
      inlineContent: string | undefined,
      opts: {
        category?: string;
        action?: string;
        contentFile?: string;
        evidence?: string;
        signal?: string;
        signalIds?: string;
        run?: string;
        session?: string;
        json?: boolean;
        workflowRoot: string;
      },
    ) => {
      try {
        if (!KNOWLEDGE_CANDIDATE_TARGETS.includes(target as 'spec' | 'knowhow')) {
          throw new Error(`target must be one of ${KNOWLEDGE_CANDIDATE_TARGETS.join(', ')}`);
        }
        if (!KNOWLEDGE_CANDIDATE_ACTIONS.includes(
          opts.action as typeof KNOWLEDGE_CANDIDATE_ACTIONS[number],
        )) {
          throw new Error(`--action must be one of ${KNOWLEDGE_CANDIDATE_ACTIONS.join(', ')}`);
        }
        if (inlineContent && opts.contentFile) {
          throw new Error('Pass candidate content either positionally or with --content-file, not both');
        }
        if (!inlineContent && !opts.contentFile) {
          throw new Error('Candidate content is required positionally or with --content-file');
        }
        const content = inlineContent ?? readFileSync(
          opts.contentFile === '-' ? 0 : resolve(opts.workflowRoot, opts.contentFile!),
          'utf8',
        );
        if (opts.session && !opts.run) throw new Error('--session requires --run');
        const projectRoot = resolve(opts.workflowRoot);
        const store = new SessionStore(projectRoot);
        const active = opts.run
          ? { runId: opts.run, sessionId: opts.session }
          : store.findUniqueActiveRun();
        if (!active) throw new Error('No unique active Run found; pass --run and optionally --session');

        let signal: KnowledgeInputSignal | null = null;
        let signalIds: string[] = [];
        if (opts.signal && opts.signalIds) {
          if (!KNOWLEDGE_INPUT_SIGNALS.includes(opts.signal as KnowledgeInputSignal)) {
            throw new Error(`--signal must be one of ${KNOWLEDGE_INPUT_SIGNALS.join(', ')}`);
          }
          signal = opts.signal as KnowledgeInputSignal;
          signalIds = opts.signalIds.split(',').map(value => value.trim()).filter(Boolean);
        } else if (opts.signal && !opts.signalIds) {
          throw new Error('--signal requires --signal-ids');
        } else if (!opts.signal && opts.signalIds) {
          throw new Error('--signal-ids requires --signal');
        }

        const result = stageRunKnowledgeCandidate(
          projectRoot,
          active.runId,
          {
            target: target as 'spec' | 'knowhow',
            action: opts.action as typeof KNOWLEDGE_CANDIDATE_ACTIONS[number],
            title,
            content,
            category: opts.category,
            evidenceRefs: opts.evidence?.split(','),
          },
          active.sessionId,
        );
        const signalResult = signal
          ? recordRunKnowledgeInputs(
              projectRoot,
              active.runId,
              signalIds,
              signal,
              'manual',
              active.sessionId,
            )
          : null;
        if (opts.json) {
          console.log(JSON.stringify({ ...result, signal_recorded: signalResult?.recorded ?? 0 }, null, 2));
          return;
        }
        console.log(
          `Staged ${result.candidate_id} on ${result.session_id}/${result.run_id}`
          + (signalResult ? `; recorded ${signalResult.recorded} signal(s) as ${opts.signal}` : '')
          + `; review after completion with "maestro knowledge review ${result.session_id}".`,
        );
      } catch (error) {
        console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
      }
    });

  knowledge
    .command('reconcile')
    .description('[internal] Match Run candidates against existing knowledge (auto-run by check; use review --refresh)')
    .option('--run <run-id>', 'Explicit active or sealed Run ID')
    .option('--session <session-id>', 'Explicit Session ID (requires --run)')
    .option('--json', 'Output as JSON')
    .option('--workflow-root <path>', 'Project root containing .workflow', process.cwd())
    .action(async (opts: {
      run?: string;
      session?: string;
      json?: boolean;
      workflowRoot: string;
    }) => {
      try {
        if (opts.session && !opts.run) throw new Error('--session requires --run');
        const projectRoot = resolve(opts.workflowRoot);
        const store = new SessionStore(projectRoot);
        const active = opts.run
          ? { sessionId: store.findRun(opts.run, opts.session).sessionId, runId: opts.run }
          : store.findUniqueActiveRun();
        if (!active) throw new Error('No unique active Run found; pass --run and optionally --session');
        const receipt = await reconcileRunKnowledge(
          projectRoot,
          active.sessionId,
          active.runId,
        );
        if (opts.run) persistKnowledgeReconciliation(projectRoot, receipt);
        else persistActiveKnowledgeReconciliation(projectRoot, receipt);
        if (opts.json) {
          console.log(JSON.stringify(receipt, null, 2));
          return;
        }
        console.log(
          `Reconciled ${receipt.counts.candidates} candidate(s) on `
          + `${receipt.session_id}/${receipt.run_id}: `
          + `${receipt.counts.duplicates} duplicate · ${receipt.counts.related} related · `
          + `${receipt.counts.conflicts} conflict · ${receipt.counts.review_required} review required.`,
        );
        for (const candidate of receipt.candidates) {
          console.log(
            `  ${candidate.candidate_id} [${candidate.disposition}/`
            + `${candidate.promotion_eligibility}] → ${candidate.canonical_id ?? 'new knowledge'}`,
          );
        }
      } catch (error) {
        console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
      }
    });

  knowledge
    .command('resolve')
    .description('[alias] Confirm disposition (prefer: review --resolve <id> --as <choice> --reason "...")')
    .argument('<candidate-id>', 'Knowledge candidate ID')
    .requiredOption('--session <session-id>', 'Session identifier')
    .requiredOption('--as <resolution>', `Resolution: ${KNOWLEDGE_RESOLUTIONS.join('|')}`)
    .requiredOption('--reason <reason>', 'Human review reason')
    .option('--target <knowledge-id>', 'Evidence-backed canonical knowledge ID')
    .option('--json', 'Output as JSON')
    .option('--workflow-root <path>', 'Project root containing .workflow', process.cwd())
    .action((
      candidateId: string,
      opts: {
        session: string;
        as: string;
        reason: string;
        target?: string;
        json?: boolean;
        workflowRoot: string;
      },
    ) => {
      try {
        if (!KNOWLEDGE_RESOLUTIONS.includes(opts.as as KnowledgeResolutionChoice)) {
          throw new Error(`--as must be one of ${KNOWLEDGE_RESOLUTIONS.join(', ')}`);
        }
        const result = resolveKnowledgeCandidate(
          resolve(opts.workflowRoot),
          opts.session,
          candidateId,
          opts.as as KnowledgeResolutionChoice,
          { targetId: opts.target, reason: opts.reason },
        );
        if (opts.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        console.log(
          `Resolved ${result.candidate_id} as ${result.disposition}; `
          + `promotion ${result.promotion_eligibility}; `
          + `canonical ${result.canonical_id ?? 'new knowledge'}.`,
        );
      } catch (error) {
        console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
      }
    });

  knowledge
    .command('promote')
    .description('Promote selected pending Session knowledge with durable receipts')
    .argument('<session-id>', 'Session identifier')
    .option(
      '--candidate <id>',
      'Candidate ID; repeatable and comma-compatible',
      (value: string, previous: string[] = []) => [
        ...previous,
        ...value.split(',').map(id => id.trim()).filter(Boolean),
      ],
      [],
    )
    .option('--all', 'Promote all eligible pending candidates (observed-only emits a warning)')
    .option('--json', 'Output as JSON')
    .option('--workflow-root <path>', 'Project root containing .workflow', process.cwd())
    .action((
      sessionId: string,
      opts: {
        candidate: string[];
        all?: boolean;
        json?: boolean;
        workflowRoot: string;
      },
    ) => {
      try {
        const result = promoteReconciledSessionKnowledge(resolve(opts.workflowRoot), sessionId, {
          candidateIds: opts.candidate,
          all: opts.all,
        });
        if (opts.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        console.log(`Promoted ${result.promoted.length} knowledge candidate(s) from ${sessionId}:`);
        for (const item of result.promoted) {
          console.log(
            `  ${item.candidate_id} → ${item.promoted_id} `
            + `(${item.target}, ${item.outcome})`,
          );
        }
        if (result.already_promoted.length > 0) {
          console.log(`Already promoted: ${result.already_promoted.length} candidate(s).`);
        }
        if (result.skipped_observed.length > 0) {
          console.log(`Warning: ${result.skipped_observed.length} observed-only candidate(s) promoted without corroboration.`);
        }
        if (result.skipped_review_required.length > 0) {
          console.log(
            `Skipped ${result.skipped_review_required.length} candidate(s) requiring resolution.`,
          );
        }
        if (result.skipped_suppressed.length > 0) {
          console.log(`Skipped ${result.skipped_suppressed.length} suppressed candidate(s).`);
        }
      } catch (error) {
        console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
      }
    });

  knowledge
    .command('review')
    .description('Review Session candidates with evidence-backed matches and next commands')
    .argument('<session-id>', 'Session identifier')
    .option('--refresh', 'Refresh every candidate source Run before review')
    .option('--resolve <candidate-id>', 'Resolve a candidate before review')
    .option('--as <resolution>', `Resolution for --resolve: ${KNOWLEDGE_RESOLUTIONS.join('|')}`)
    .option('--target <knowledge-id>', 'Evidence-backed canonical knowledge ID for --resolve')
    .option('--reason <reason>', 'Human review reason for --resolve')
    .option('--json', 'Output as JSON')
    .option('--workflow-root <path>', 'Project root containing .workflow', process.cwd())
    .action(async (
      sessionId: string,
      opts: {
        refresh?: boolean;
        resolve?: string;
        as?: string;
        target?: string;
        reason?: string;
        json?: boolean;
        workflowRoot: string;
      },
    ) => {
      try {
        const projectRoot = resolve(opts.workflowRoot);
        if (opts.resolve) {
          if (!opts.as) throw new Error('--resolve requires --as');
          if (!opts.reason) throw new Error('--resolve requires --reason');
          if (!KNOWLEDGE_RESOLUTIONS.includes(opts.as as KnowledgeResolutionChoice)) {
            throw new Error(`--as must be one of ${KNOWLEDGE_RESOLUTIONS.join(', ')}`);
          }
          const resolved = resolveKnowledgeCandidate(
            projectRoot,
            sessionId,
            opts.resolve,
            opts.as as KnowledgeResolutionChoice,
            { targetId: opts.target, reason: opts.reason },
          );
          if (!opts.json) {
            console.log(
              `Resolved ${resolved.candidate_id} as ${resolved.disposition}; `
              + `promotion ${resolved.promotion_eligibility}; `
              + `canonical ${resolved.canonical_id ?? 'new knowledge'}.`,
            );
          }
        }
        let view = buildKnowledgeSessionView(projectRoot, sessionId);
        if (opts.refresh) {
          for (const runId of uniqueRunIds(view.candidates)) {
            const receipt = await reconcileRunKnowledge(projectRoot, sessionId, runId);
            persistKnowledgeReconciliation(projectRoot, receipt);
          }
          view = buildKnowledgeSessionView(projectRoot, sessionId);
        }
        if (opts.json) {
          console.log(JSON.stringify(view, null, 2));
          return;
        }
        printKnowledgeReview(view);
      } catch (error) {
        console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
      }
    });

  knowledge
    .command('stats')
    .description('[deprecated] Show knowledge exposure, explicit consumption, and concentration')
    .option('--type <type>', `Filter by source type: ${KNOWLEDGE_SOURCE_TYPES.join(', ')}`)
    .option('--limit <n>', 'Max top entries', '10')
    .option('--json', 'Output as JSON')
    .option('--workflow-root <path>', 'Project root containing .workflow', process.cwd())
    .action(async (opts: {
      type?: string;
      limit?: string;
      json?: boolean;
      workflowRoot: string;
    }) => {
      console.error('Warning: "maestro knowledge stats" is deprecated; credibility signals are write-only (see docs §1.1 X3). Use "maestro knowledge audit" instead.');
      if (opts.type && !KNOWLEDGE_SOURCE_TYPES.includes(opts.type as typeof KNOWLEDGE_SOURCE_TYPES[number])) {
        console.error(`Error: --type must be one of ${KNOWLEDGE_SOURCE_TYPES.join(', ')}`);
        process.exitCode = 1;
        return;
      }

      const projectRoot = resolve(opts.workflowRoot);
      if (!MaestroGraph.isInitialized(projectRoot)) {
        console.error('Knowledge graph not initialized — run "maestro kg init" first.');
        process.exitCode = 1;
        return;
      }

      const parsedLimit = Number.parseInt(opts.limit ?? '10', 10);
      const limit = Math.max(0, Math.min(Number.isFinite(parsedLimit) ? parsedLimit : 10, 100));
      const graph = await MaestroGraph.open(projectRoot);
      try {
        const stats = buildKnowledgeUsageStats(graph.rawDb, opts.type ?? null, limit);
        if (opts.json) {
          console.log(JSON.stringify(stats, null, 2));
          return;
        }

        console.log('Knowledge usage statistics');
        console.log('Impressions are returned/injected results; consumptions are explicit content loads.');
        console.log(
          'Neither changes relevance scores; impressions may fill one relevance-floored '
          + 'exploration slot, while consumptions never affect retrieval.\n',
        );

        for (const source of stats.bySource) {
          console.log(
            `${source.sourceType}: ${source.nodes} nodes · ${source.impressions} impressions `
            + `(${source.impressionNodes} nodes) · ${source.consumptions} consumptions `
            + `(${source.consumedNodes} nodes)`,
          );
        }

        console.log('');
        printConcentration('Impression concentration', stats.impressionConcentration);
        printConcentration('Consumption concentration', stats.consumptionConcentration);

        if (stats.topEntries.length > 0) {
          console.log('\nTop exposed knowledge:');
          for (const entry of stats.topEntries) {
            console.log(
              `  [${entry.sourceType}] ${entry.id} · ${entry.impressions} impressions `
              + `· ${entry.consumptions} consumptions · ${entry.name}`,
            );
          }
        }
      } finally {
        graph.close();
      }
    });
}
