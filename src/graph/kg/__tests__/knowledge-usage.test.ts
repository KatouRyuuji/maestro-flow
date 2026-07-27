import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { CredibilityStore } from '../credibility.js';
import { MaestroGraph } from '../engine.js';
import {
  buildKnowledgeUsageStats,
  readKnowledgeUsageSignals,
  recordKnowledgeConsumptions,
} from '../knowledge-usage.js';
import type {
  Language,
  SourceType,
  UnifiedNode,
  UnifiedNodeKind,
} from '../db/types.js';

function makeKnowledgeNode(
  id: string,
  name: string,
  sourceType: SourceType,
): UnifiedNode {
  return {
    id,
    kind: `${sourceType}_entry` as UnifiedNodeKind,
    name,
    qualifiedName: name,
    filePath: `.workflow/${sourceType}/${id}.md`,
    language: 'markdown' as Language,
    startLine: 1,
    endLine: 1,
    startColumn: 1,
    endColumn: 1,
    docstring: '',
    signature: '',
    visibility: '',
    isExported: false,
    isAsync: false,
    isStatic: false,
    isAbstract: false,
    decorators: [],
    typeParameters: [],
    sourceType,
    definition: '',
    aliases: [],
    keywords: [],
    category: sourceType === 'spec' ? 'coding' : 'recipe',
    roles: [],
    priority: '',
    status: 'active',
    body: `${name} body`,
    metadata: {},
    updatedAt: Date.now(),
  };
}

describe('knowledge usage signals', () => {
  it('reports impressions and explicit consumptions as separate distributions', async () => {
    const root = mkdtempSync(join(tmpdir(), 'maestro-knowledge-usage-'));
    try {
      const graph = await MaestroGraph.init(root);
      try {
        const nodes = [
          makeKnowledgeNode('spec:a', 'Spec A', 'spec'),
          makeKnowledgeNode('spec:c', 'Spec C', 'spec'),
          makeKnowledgeNode('knowhow:b', 'Knowhow B', 'knowhow'),
        ];
        graph.getConnection().transaction(() => graph.getQueryBuilder().insertNodes(nodes));

        const store = new CredibilityStore(graph.rawDb);
        for (const node of nodes) store.upsert(node.id, node.id, 100);
        store.incrementImpressions(['spec:a', 'spec:a', 'spec:a', 'knowhow:b'], 200);
        store.incrementConsumptions(['spec:a', 'knowhow:b', 'knowhow:b'], 300);

        const stats = buildKnowledgeUsageStats(graph.rawDb);
        expect(stats.semantics).toEqual({
          impressions: 'returned-or-injected',
          consumptions: 'explicit-content-load',
          affectsRanking: false,
          impressionsMayFillExplorationSlot: true,
          consumptionsAffectRetrieval: false,
        });
        expect(stats.bySource).toEqual([
          {
            sourceType: 'knowhow',
            nodes: 1,
            tracked: 1,
            impressionNodes: 1,
            consumedNodes: 1,
            impressions: 1,
            consumptions: 2,
          },
          {
            sourceType: 'spec',
            nodes: 2,
            tracked: 2,
            impressionNodes: 1,
            consumedNodes: 1,
            impressions: 3,
            consumptions: 1,
          },
        ]);
        expect(stats.impressionConcentration).toMatchObject({
          positiveNodes: 2,
          totalEvents: 4,
          top1Share: 0.75,
          top5Share: 1,
          top10Share: 1,
        });
        expect(stats.impressionConcentration.gini).toBeCloseTo(0.25);
        expect(stats.impressionConcentration.effectiveNodes).toBeCloseTo(1.6);
        expect(stats.consumptionConcentration).toMatchObject({
          positiveNodes: 2,
          totalEvents: 3,
          top1Share: 2 / 3,
        });
        expect(stats.topEntries.map(entry => entry.id)).toEqual(['spec:a', 'knowhow:b']);
      } finally {
        graph.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('records each explicitly loaded node once and supports wiki id fallback', async () => {
    const root = mkdtempSync(join(tmpdir(), 'maestro-knowledge-consume-'));
    try {
      const graph = await MaestroGraph.init(root);
      try {
        const nodes = [
          makeKnowledgeNode('spec:a', 'Spec A', 'spec'),
          makeKnowledgeNode('knowhow:b', 'Knowhow B', 'knowhow'),
        ];
        graph.getConnection().transaction(() => graph.getQueryBuilder().insertNodes(nodes));
        const store = new CredibilityStore(graph.rawDb);
        for (const node of nodes) store.upsert(node.id, node.id, 100);
      } finally {
        graph.close();
      }

      expect(recordKnowledgeConsumptions(root, [
        { id: 'ignored', sourceRef: 'spec:a' },
        { id: 'knowhow-b' },
        { id: 'duplicate', sourceRef: 'spec:a' },
        { id: 'missing' },
      ], 500)).toBe(2);
      expect(readKnowledgeUsageSignals(root, [
        { id: 'spec-a' },
        { id: 'alias', sourceRef: 'knowhow:b' },
        { id: 'missing' },
      ])).toEqual(new Map([
        ['spec-a', { impressions: 0, consumptions: 1 }],
        ['alias', { impressions: 0, consumptions: 1 }],
      ]));

      const reopened = await MaestroGraph.open(root);
      try {
        const store = new CredibilityStore(reopened.rawDb);
        expect(store.get('spec:a')?.consumption_count).toBe(1);
        expect(store.get('knowhow:b')?.consumption_count).toBe(1);
        expect(store.get('spec:a')?.last_consumed_at).toBe(500);
      } finally {
        reopened.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
