import type { Command } from 'commander';
import { resolve } from 'node:path';

import { MaestroGraph } from '../graph/kg/engine.js';
import {
  buildKnowledgeUsageStats,
  type KnowledgeUsageConcentration,
} from '../graph/kg/knowledge-usage.js';
import {
  promoteSessionKnowledge,
  summarizeSessionKnowledge,
} from '../run/knowledge.js';

const KNOWLEDGE_SOURCE_TYPES = ['spec', 'knowhow', 'issue', 'domain', 'codebase'] as const;

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
        const result = promoteSessionKnowledge(resolve('.'), sessionId, {
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
        const summary = summarizeSessionKnowledge(resolve('.'), sessionId);
        if (opts.json) {
          console.log(JSON.stringify(summary, null, 2));
          return;
        }

        console.log(`Session knowledge: ${summary.session_id}`);
        console.log(
          `${summary.ledger_count}/${summary.run_count} run ledgers · `
          + `${summary.unique_inputs} unique inputs · `
          + `${summary.candidates.length} candidates`,
        );
        console.log(
          `Signals: ${summary.input_totals.consumed} consumed · `
          + `${summary.input_totals.cited} cited · `
          + `${summary.input_totals.validated} validated · `
          + `${summary.input_totals.contradicted} contradicted`,
        );
        if (summary.candidates.length > 0) {
          console.log('\nCandidates:');
          for (const candidate of summary.candidates) {
            console.log(
              `  ${candidate.candidate_id} [${candidate.stage}/${candidate.status}] `
              + `${candidate.target}:${candidate.category ?? 'uncategorized'} · ${candidate.title}`,
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
        console.log('Neither signal affects search ranking.\n');

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
