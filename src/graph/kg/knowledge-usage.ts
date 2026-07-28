import type { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';

import { CredibilityStore, contentHash, wikiIdToNodeId } from './credibility.js';
import { validateNodeId } from './db/types.js';
import { MaestroGraph } from './engine.js';

export interface KnowledgeUsageRef {
  id: string;
  sourceRef?: string | null;
}

export interface KnowledgeConsumptionRecord {
  recorded: number;
  nodeIds: string[];
}

export interface KnowledgeUsageSignal {
  impressions: number;
  consumptions: number;
}

export interface KnowledgeUsageBySource {
  sourceType: string;
  nodes: number;
  tracked: number;
  impressionNodes: number;
  consumedNodes: number;
  impressions: number;
  consumptions: number;
}

export interface KnowledgeUsageConcentration {
  positiveNodes: number;
  totalEvents: number;
  top1Share: number;
  top5Share: number;
  top10Share: number;
  gini: number;
  hhi: number;
  effectiveNodes: number;
}

export interface KnowledgeUsageTopEntry {
  sourceType: string;
  id: string;
  name: string;
  impressions: number;
  consumptions: number;
  lastImpressionAt: number | null;
  lastConsumedAt: number | null;
}

export interface KnowledgeUsageStats {
  schemaVersion: 'knowledge-usage-stats/1.0';
  semantics: {
    impressions: 'returned-or-injected';
    consumptions: 'explicit-content-load';
    affectsRanking: false;
    impressionsMayFillExplorationSlot: true;
    consumptionsAffectRetrieval: false;
  };
  filter: { sourceType: string | null };
  bySource: KnowledgeUsageBySource[];
  impressionConcentration: KnowledgeUsageConcentration;
  consumptionConcentration: KnowledgeUsageConcentration;
  topEntries: KnowledgeUsageTopEntry[];
}

interface UsageValueRow {
  value: number;
}

interface UsageSourceRow {
  source_type: string;
  nodes: number;
  tracked: number;
  impression_nodes: number;
  consumed_nodes: number;
  impressions: number;
  consumptions: number;
}

interface UsageTopRow {
  source_type: string;
  id: string;
  name: string;
  impressions: number;
  consumptions: number;
  last_impression_at: number | null;
  last_consumed_at: number | null;
}

function resolveNodeId(ref: KnowledgeUsageRef): string | null {
  if (ref.sourceRef && validateNodeId(ref.sourceRef)) return ref.sourceRef;
  return wikiIdToNodeId(ref.id);
}

/**
 * Record only explicit content loads. Listing and search result exposure must
 * not call this function.
 */
export function recordKnowledgeConsumptionsDetailed(
  projectRoot: string,
  refs: KnowledgeUsageRef[],
  nowMs: number = Date.now(),
): KnowledgeConsumptionRecord {
  if (refs.length === 0) return { recorded: 0, nodeIds: [] };
  let graph: MaestroGraph | null = null;
  try {
    const root = resolve(projectRoot);
    if (!MaestroGraph.isInitialized(root)) return { recorded: 0, nodeIds: [] };
    graph = MaestroGraph.openSync(root);
    if (!graph) return { recorded: 0, nodeIds: [] };

    const candidateIds = [...new Set(
      refs.map(resolveNodeId).filter((id): id is string => Boolean(id)),
    )];
    if (candidateIds.length === 0) return { recorded: 0, nodeIds: [] };
    const existingNodes = graph.getQueryBuilder().getNodesByIds(candidateIds);
    const existingIds = [...existingNodes.keys()];
    if (existingIds.length === 0) return { recorded: 0, nodeIds: [] };

    const store = new CredibilityStore(graph.rawDb);
    graph.getConnection().transaction(() => {
      for (const [id, node] of existingNodes) {
        store.upsert(
          id,
          contentHash(`${node.name}\n${node.definition ?? ''}\n${node.body ?? ''}`),
          nowMs,
        );
      }
      store.incrementConsumptions(existingIds, nowMs);
    });
    return { recorded: existingIds.length, nodeIds: existingIds };
  } catch {
    return { recorded: 0, nodeIds: [] };
  } finally {
    graph?.close();
  }
}

export function recordKnowledgeConsumptions(
  projectRoot: string,
  refs: KnowledgeUsageRef[],
  nowMs: number = Date.now(),
): number {
  return recordKnowledgeConsumptionsDetailed(projectRoot, refs, nowMs).recorded;
}

/**
 * Read exposure/use counters for retrieval diversification. Signals are keyed
 * by the caller's Wiki id and are never folded into the relevance score.
 */
export function readKnowledgeUsageSignals(
  projectRoot: string,
  refs: KnowledgeUsageRef[],
): Map<string, KnowledgeUsageSignal> {
  const output = new Map<string, KnowledgeUsageSignal>();
  if (refs.length === 0) return output;
  let graph: MaestroGraph | null = null;
  try {
    const root = resolve(projectRoot);
    if (!MaestroGraph.isInitialized(root)) return output;
    graph = MaestroGraph.openSync(root);
    if (!graph) return output;
    const store = new CredibilityStore(graph.rawDb);
    const resolved = refs
      .map(ref => ({ ref, nodeId: resolveNodeId(ref) }))
      .filter((item): item is { ref: KnowledgeUsageRef; nodeId: string } => Boolean(item.nodeId));
    const rows = store.getMany([...new Set(resolved.map(item => item.nodeId))]);
    for (const item of resolved) {
      const row = rows.get(item.nodeId);
      if (!row) continue;
      output.set(item.ref.id, {
        impressions: row.search_hits,
        consumptions: row.consumption_count,
      });
    }
    return output;
  } catch {
    return output;
  } finally {
    graph?.close();
  }
}

function concentration(values: number[]): KnowledgeUsageConcentration {
  const positive = values.filter(value => value > 0).sort((a, b) => b - a);
  const total = positive.reduce((sum, value) => sum + value, 0);
  if (total === 0) {
    return {
      positiveNodes: 0,
      totalEvents: 0,
      top1Share: 0,
      top5Share: 0,
      top10Share: 0,
      gini: 0,
      hhi: 0,
      effectiveNodes: 0,
    };
  }

  const share = (count: number): number =>
    positive.slice(0, count).reduce((sum, value) => sum + value, 0) / total;
  const ascending = [...positive].sort((a, b) => a - b);
  const weighted = ascending.reduce((sum, value, index) => sum + (index + 1) * value, 0);
  const nodeCount = ascending.length;
  const gini = (2 * weighted) / (nodeCount * total) - (nodeCount + 1) / nodeCount;
  const hhi = positive.reduce((sum, value) => sum + (value / total) ** 2, 0);

  return {
    positiveNodes: positive.length,
    totalEvents: total,
    top1Share: share(1),
    top5Share: share(5),
    top10Share: share(10),
    gini,
    hhi,
    effectiveNodes: hhi > 0 ? 1 / hhi : 0,
  };
}

export function buildKnowledgeUsageStats(
  db: DatabaseSync,
  sourceType: string | null = null,
  topLimit: number = 10,
): KnowledgeUsageStats {
  const where = sourceType
    ? 'WHERE n.source_type = ?'
    : `WHERE n.source_type != 'codegraph'`;
  const params = sourceType ? [sourceType] : [];

  const sourceRows = db.prepare(`
    SELECT
      n.source_type,
      COUNT(*) AS nodes,
      SUM(CASE WHEN c.node_id IS NOT NULL THEN 1 ELSE 0 END) AS tracked,
      SUM(CASE WHEN COALESCE(c.search_hits, 0) > 0 THEN 1 ELSE 0 END) AS impression_nodes,
      SUM(CASE WHEN COALESCE(c.consumption_count, 0) > 0 THEN 1 ELSE 0 END) AS consumed_nodes,
      COALESCE(SUM(c.search_hits), 0) AS impressions,
      COALESCE(SUM(c.consumption_count), 0) AS consumptions
    FROM nodes n
    LEFT JOIN credibility c ON c.node_id = n.id
    ${where}
    GROUP BY n.source_type
    ORDER BY n.source_type
  `).all(...params) as unknown as UsageSourceRow[];

  const valuesWhere = sourceType
    ? 'WHERE n.source_type = ?'
    : `WHERE n.source_type != 'codegraph'`;
  const impressionValues = db.prepare(`
    SELECT COALESCE(c.search_hits, 0) AS value
    FROM nodes n
    LEFT JOIN credibility c ON c.node_id = n.id
    ${valuesWhere}
  `).all(...params) as unknown as UsageValueRow[];
  const consumptionValues = db.prepare(`
    SELECT COALESCE(c.consumption_count, 0) AS value
    FROM nodes n
    LEFT JOIN credibility c ON c.node_id = n.id
    ${valuesWhere}
  `).all(...params) as unknown as UsageValueRow[];

  const topRows = db.prepare(`
    SELECT
      n.source_type,
      n.id,
      n.name,
      COALESCE(c.search_hits, 0) AS impressions,
      COALESCE(c.consumption_count, 0) AS consumptions,
      c.last_hit_at AS last_impression_at,
      c.last_consumed_at AS last_consumed_at
    FROM nodes n
    LEFT JOIN credibility c ON c.node_id = n.id
    ${where}
      AND (COALESCE(c.search_hits, 0) > 0 OR COALESCE(c.consumption_count, 0) > 0)
    ORDER BY impressions DESC, consumptions DESC, n.id
    LIMIT ?
  `).all(...params, Math.max(0, topLimit)) as unknown as UsageTopRow[];

  return {
    schemaVersion: 'knowledge-usage-stats/1.0',
    semantics: {
      impressions: 'returned-or-injected',
      consumptions: 'explicit-content-load',
      affectsRanking: false,
      impressionsMayFillExplorationSlot: true,
      consumptionsAffectRetrieval: false,
    },
    filter: { sourceType },
    bySource: sourceRows.map(row => ({
      sourceType: row.source_type,
      nodes: Number(row.nodes),
      tracked: Number(row.tracked),
      impressionNodes: Number(row.impression_nodes),
      consumedNodes: Number(row.consumed_nodes),
      impressions: Number(row.impressions),
      consumptions: Number(row.consumptions),
    })),
    impressionConcentration: concentration(impressionValues.map(row => Number(row.value))),
    consumptionConcentration: concentration(consumptionValues.map(row => Number(row.value))),
    topEntries: topRows.map(row => ({
      sourceType: row.source_type,
      id: row.id,
      name: row.name,
      impressions: Number(row.impressions),
      consumptions: Number(row.consumptions),
      lastImpressionAt: row.last_impression_at,
      lastConsumedAt: row.last_consumed_at,
    })),
  };
}
