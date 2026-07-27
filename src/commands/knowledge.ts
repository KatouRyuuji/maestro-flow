import type { Command } from 'commander';
import { resolve } from 'node:path';

import { MaestroGraph } from '../graph/kg/engine.js';
import {
  buildKnowledgeUsageStats,
  type KnowledgeUsageConcentration,
} from '../graph/kg/knowledge-usage.js';

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
