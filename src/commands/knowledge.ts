import type { Command } from 'commander';
import { resolve } from 'node:path';

import { MaestroGraph } from '../graph/kg/engine.js';
import {
  buildKnowledgeUsageStats,
  type KnowledgeUsageConcentration,
} from '../graph/kg/knowledge-usage.js';
import {
  recordActiveRunKnowledgeInputs,
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
  isKnowledgeReconciliationFresh,
  readKnowledgeReconciliation,
  reconcileRunKnowledge,
  resolveKnowledgeCandidate,
  type KnowledgeResolutionChoice,
} from '../knowledge/reconcile.js';
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
    .action(async (opts: {
      scope?: string;
      prune?: boolean;
      apply?: boolean;
      json?: boolean;
    }) => {
      try {
        if (!['spec', 'knowhow', 'all'].includes(opts.scope ?? 'all')) {
          throw new Error('--scope must be one of spec, knowhow, all');
        }
        const result = await auditKnowledge(resolve('.'), {
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
    .command('record')
    .description('Record an explicit relation between stable knowledge IDs and the active Run')
    .argument('<knowledge-ids...>', 'Stable knowledge IDs (space- or comma-separated)')
    .option('--signal <signal>', `Relation: ${KNOWLEDGE_INPUT_SIGNALS.join('|')}`, 'consumed')
    .option('--run <run-id>', 'Explicit active Run ID')
    .option('--session <session-id>', 'Explicit Session ID (requires --run)')
    .option('--json', 'Output as JSON')
    .action((
      rawIds: string[],
      opts: { signal?: string; run?: string; session?: string; json?: boolean },
    ) => {
      try {
        if (!KNOWLEDGE_INPUT_SIGNALS.includes(opts.signal as KnowledgeInputSignal)) {
          throw new Error(`--signal must be one of ${KNOWLEDGE_INPUT_SIGNALS.join(', ')}`);
        }
        if (opts.session && !opts.run) throw new Error('--session requires --run');
        const ids = rawIds.flatMap(value => value.split(',')).map(value => value.trim()).filter(Boolean);
        const result = opts.run
          ? recordRunKnowledgeInputs(
              resolve('.'),
              opts.run,
              ids,
              opts.signal as KnowledgeInputSignal,
              'manual',
              opts.session,
            )
          : recordActiveRunKnowledgeInputs(
              resolve('.'),
              ids,
              opts.signal as KnowledgeInputSignal,
              'manual',
            );
        if (!result) {
          throw new Error('No unique active Run found; pass --run and optionally --session');
        }
        if (opts.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        console.log(
          `Recorded ${result.recorded} knowledge relation(s) on `
          + `${result.session_id}/${result.run_id} as ${opts.signal}.`,
        );
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
    .argument('<content>', 'Candidate content')
    .option('--action <action>', `Candidate intent: ${KNOWLEDGE_CANDIDATE_ACTIONS.join('|')}`, 'propose')
    .option('--category <category>', 'Spec/knowhow category')
    .option('--evidence <refs>', 'Comma-separated evidence references')
    .option('--run <run-id>', 'Explicit active Run ID')
    .option('--session <session-id>', 'Explicit Session ID (requires --run)')
    .option('--json', 'Output as JSON')
    .action((
      target: string,
      title: string,
      content: string,
      opts: {
        category?: string;
        action?: string;
        evidence?: string;
        run?: string;
        session?: string;
        json?: boolean;
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
        if (opts.session && !opts.run) throw new Error('--session requires --run');
        const store = new SessionStore(resolve('.'));
        const active = opts.run
          ? { runId: opts.run, sessionId: opts.session }
          : store.findUniqueActiveRun();
        if (!active) throw new Error('No unique active Run found; pass --run and optionally --session');
        const result = stageRunKnowledgeCandidate(
          resolve('.'),
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
        if (opts.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        console.log(
          `Staged ${result.candidate_id} on ${result.session_id}/${result.run_id}; `
          + `review after completion with "maestro knowledge session ${result.session_id}".`,
        );
      } catch (error) {
        console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
      }
    });

  knowledge
    .command('reconcile')
    .description('Match Run candidates against existing knowledge before completion or review')
    .option('--run <run-id>', 'Explicit active or sealed Run ID')
    .option('--session <session-id>', 'Explicit Session ID (requires --run)')
    .option('--json', 'Output as JSON')
    .action(async (opts: { run?: string; session?: string; json?: boolean }) => {
      try {
        if (opts.session && !opts.run) throw new Error('--session requires --run');
        const store = new SessionStore(resolve('.'));
        const active = opts.run
          ? { sessionId: store.findRun(opts.run, opts.session).sessionId, runId: opts.run }
          : store.findUniqueActiveRun();
        if (!active) throw new Error('No unique active Run found; pass --run and optionally --session');
        const receipt = await reconcileRunKnowledge(
          resolve('.'),
          active.sessionId,
          active.runId,
        );
        if (opts.run) persistKnowledgeReconciliation(resolve('.'), receipt);
        else persistActiveKnowledgeReconciliation(resolve('.'), receipt);
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
    .description('Confirm duplicate, relation, conflict, supersession, or uniqueness')
    .argument('<candidate-id>', 'Knowledge candidate ID')
    .requiredOption('--session <session-id>', 'Session identifier')
    .requiredOption('--as <resolution>', `Resolution: ${KNOWLEDGE_RESOLUTIONS.join('|')}`)
    .requiredOption('--reason <reason>', 'Human review reason')
    .option('--target <knowledge-id>', 'Evidence-backed canonical knowledge ID')
    .option('--json', 'Output as JSON')
    .action((
      candidateId: string,
      opts: {
        session: string;
        as: string;
        reason: string;
        target?: string;
        json?: boolean;
      },
    ) => {
      try {
        if (!KNOWLEDGE_RESOLUTIONS.includes(opts.as as KnowledgeResolutionChoice)) {
          throw new Error(`--as must be one of ${KNOWLEDGE_RESOLUTIONS.join(', ')}`);
        }
        const result = resolveKnowledgeCandidate(
          resolve('.'),
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
    .option('--candidate <ids>', 'Comma-separated candidate IDs')
    .option('--all', 'Promote all corroborated pending candidates')
    .option('--include-observed', 'Allow --all to include single-Run candidates')
    .option('--json', 'Output as JSON')
    .action((
      sessionId: string,
      opts: { candidate?: string; all?: boolean; includeObserved?: boolean; json?: boolean },
    ) => {
      try {
        const candidateIds = opts.candidate
          ?.split(',')
          .map(id => id.trim())
          .filter(Boolean);
        const result = promoteReconciledSessionKnowledge(resolve('.'), sessionId, {
          candidateIds,
          all: opts.all,
          includeObserved: opts.includeObserved,
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
          console.log(`Skipped ${result.skipped_observed.length} observed-only candidate(s).`);
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
    .command('session')
    .description('Summarize knowledge inputs and pending candidates across a Session')
    .argument('<session-id>', 'Session identifier')
    .option('--json', 'Output as JSON')
    .action((sessionId: string, opts: { json?: boolean }) => {
      try {
        const projectRoot = resolve('.');
        const summary = summarizeSessionKnowledge(projectRoot, sessionId);
        const store = new SessionStore(projectRoot);
        const receiptByRun = new Map(summary.candidates.flatMap(candidate => candidate.run_ids)
          .filter((runId, index, runIds) => runIds.indexOf(runId) === index)
          .map(runId => {
            const receipt = readKnowledgeReconciliation(store, sessionId, runId, true);
            const fresh = receipt
              ? isKnowledgeReconciliationFresh(
                  projectRoot,
                  sessionId,
                  runId,
                  receipt,
                  readReportFrontmatter(store.runDir(sessionId, runId)),
                )
              : false;
            return [runId, { receipt, fresh }] as const;
          }));
        const candidates = summary.candidates.map(candidate => {
          const reconciliation = candidate.run_ids.flatMap(runId => {
            const state = receiptByRun.get(runId);
            const policy = state?.receipt?.candidates
              .find(item => item.candidate_id === candidate.candidate_id);
            return policy ? [{ policy, fresh: state!.fresh }] : [];
          });
          const selected = reconciliation.find(
            item => item.policy.promotion_eligibility === 'suppressed',
          ) ?? reconciliation.find(
            item => item.policy.promotion_eligibility === 'review_required',
          ) ?? reconciliation[0]
            ?? null;
          return {
            ...candidate,
            reconciliation: selected
              ? {
                  ...selected.policy,
                  freshness: reconciliation.every(item => item.fresh) ? 'fresh' : 'stale',
                }
              : null,
          };
        });
        const view = { ...summary, candidates };
        if (opts.json) {
          console.log(JSON.stringify(view, null, 2));
          return;
        }

        console.log(`Session knowledge: ${summary.session_id}`);
        console.log(
          `${summary.ledger_count}/${summary.run_count} run ledgers · `
          + `${summary.unique_inputs} unique inputs · `
          + `${candidates.length} candidates`,
        );
        console.log(
          `Signals: ${summary.input_totals.consumed} consumed · `
          + `${summary.input_totals.cited} cited · `
          + `${summary.input_totals.validated} validated · `
          + `${summary.input_totals.contradicted} contradicted`,
        );
        if (candidates.length > 0) {
          console.log('\nCandidates:');
          for (const candidate of candidates) {
            console.log(
              `  ${candidate.candidate_id} [${candidate.stage}/${candidate.status}] `
              + `${candidate.target}:${candidate.category ?? 'uncategorized'} · ${candidate.title}`
              + (candidate.reconciliation
                ? ` · ${candidate.reconciliation.disposition}/`
                  + `${candidate.reconciliation.promotion_eligibility}`
                : ' · reconciliation missing'),
            );
          }
        }
      } catch (error) {
        console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
      }
    });

  knowledge
    .command('stats')
    .description('Show knowledge exposure, explicit consumption, and concentration')
    .option('--type <type>', `Filter by source type: ${KNOWLEDGE_SOURCE_TYPES.join(', ')}`)
    .option('--limit <n>', 'Max top entries', '10')
    .option('--json', 'Output as JSON')
    .action(async (opts: { type?: string; limit?: string; json?: boolean }) => {
      if (opts.type && !KNOWLEDGE_SOURCE_TYPES.includes(opts.type as typeof KNOWLEDGE_SOURCE_TYPES[number])) {
        console.error(`Error: --type must be one of ${KNOWLEDGE_SOURCE_TYPES.join(', ')}`);
        process.exitCode = 1;
        return;
      }

      const projectRoot = resolve('.');
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
