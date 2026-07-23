import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { MaestroGraph } from '../engine.js';
import { scoreCandidate } from '../query/search.js';
import * as scoring from '../query/scoring.js';
import type {
  Language,
  SourceType,
  UnifiedNode,
  UnifiedNodeKind,
} from '../db/types.js';
import {
  evaluateRanking,
  loadRankingFixture,
  type RankingBaselineFixture,
  type RankingCorpusFixture,
  type RankingDocument,
  type RankingHoldoutsFixture,
} from '../../../search/evaluation/relevance-evaluator.js';

const FIXTURE_ROOT = resolve('src/search/evaluation/fixtures');
const CORPUS_PATH = join(FIXTURE_ROOT, 'search-ranking-corpus.json');
const QRELS_PATH = join(FIXTURE_ROOT, 'search-ranking-qrels.json');
const BASELINE_PATH = join(FIXTURE_ROOT, 'search-ranking-baseline.json');
const HOLDOUTS_PATH = join(FIXTURE_ROOT, 'search-ranking-holdouts.json');
const KG_WARM_P95_LIMIT_MS = 34.8;
const KG_WARM_MAX_LIMIT_MS = 50;

function sourceTypeFor(document: RankingDocument): SourceType {
  if (document.kind === 'code-symbol') return 'codegraph';
  if (document.kind === 'domain-term') return 'domain';
  if (document.kind === 'spec') return 'spec';
  return 'knowhow';
}

function nodeKindFor(document: RankingDocument): UnifiedNodeKind {
  if (document.kind === 'code-symbol') {
    return document.id.includes(':class:') ? 'class' : 'function';
  }
  if (document.kind === 'domain-term') return 'domain_term';
  if (document.kind === 'spec') return 'spec_entry';
  return 'knowhow_entry';
}

function makeNode(
  document: RankingDocument,
  overrides: Partial<UnifiedNode> = {},
): UnifiedNode {
  return {
    id: document.id,
    kind: nodeKindFor(document),
    name: document.title,
    qualifiedName: document.title,
    filePath: document.provenance?.path ?? '',
    language: 'typescript' as Language,
    startLine: 1,
    endLine: 1,
    startColumn: 1,
    endColumn: 1,
    docstring: document.summary,
    signature: '',
    visibility: '',
    isExported: true,
    isAsync: false,
    isStatic: false,
    isAbstract: false,
    decorators: [],
    typeParameters: [],
    sourceType: sourceTypeFor(document),
    definition: document.summary,
    aliases: [],
    keywords: document.tags,
    category: document.tags.join(' '),
    roles: [],
    priority: '',
    status: document.status ?? 'active',
    body: document.body,
    metadata: {},
    updatedAt: 0,
    ...overrides,
  };
}

function expandActiveCorpus(corpus: RankingCorpusFixture): RankingDocument[] {
  const documents = corpus.documents.filter(document => (
    document.status !== 'deprecated' && document.authorized !== false
  ));
  const vocabulary = corpus.latencyCorpus.vocabulary;
  for (let index = documents.length; index < corpus.latencyCorpus.size; index += 1) {
    const tokenA = vocabulary[index % vocabulary.length];
    const tokenB = vocabulary[(index * 7 + 3) % vocabulary.length];
    const suffix = String(index + 1).padStart(4, '0');
    documents.push({
      id: `${corpus.latencyCorpus.idPrefix}-${suffix}`,
      kind: 'latency-noise',
      title: `Synthetic ${tokenA} ${suffix}`,
      summary: `Deterministic ${tokenA} ${tokenB} latency document`,
      tags: ['latency', tokenA, tokenB],
      body: `${tokenA} ${tokenB} synthetic benchmark corpus entry ${suffix}`,
      status: 'active',
      workspace: 'local',
      authorized: true,
      provenance: { source: 'fixture', path: `latency/${suffix}.json` },
    });
  }
  return documents;
}

function assertKgLatencyBudget(latency: { p95Ms: number; maxMs: number }): void {
  if (latency.p95Ms > KG_WARM_P95_LIMIT_MS) {
    throw new Error(`kgWarmP95Ms ${latency.p95Ms} exceeds ${KG_WARM_P95_LIMIT_MS}`);
  }
  if (latency.maxMs >= KG_WARM_MAX_LIMIT_MS) {
    throw new Error(`kgWarmMaxMs ${latency.maxMs} must be below ${KG_WARM_MAX_LIMIT_MS}`);
  }
}

describe('KG score provenance', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('computes every code and knowledge LIKE candidate exactly once', async () => {
    const root = mkdtempSync(join(tmpdir(), 'maestro-kg-like-score-'));
    const graph = await MaestroGraph.init(root);
    try {
      graph.getConnection().transaction(() => graph.getQueryBuilder().insertNodes([
        makeNode({
          id: 'code:fixture:score-one',
          kind: 'code-symbol',
          title: '评分器一',
          summary: '评分候选',
          tags: ['评分'],
          body: '评分 code candidate',
        }),
        makeNode({
          id: 'code:fixture:score-two',
          kind: 'code-symbol',
          title: '评分器二',
          summary: '评分候选',
          tags: ['评分'],
          body: '评分 code candidate',
        }),
        makeNode({
          id: 'spec:fixture-score-one',
          kind: 'spec',
          title: '评分规范一',
          summary: '评分候选',
          tags: ['评分'],
          body: '评分 knowledge candidate',
        }),
        makeNode({
          id: 'knowhow:fixture-score-two',
          kind: 'knowhow',
          title: '评分知识二',
          summary: '评分候选',
          tags: ['评分'],
          body: '评分 knowledge candidate',
        }),
      ]));

      const computeScoreSpy = vi.spyOn(scoring, 'computeScore');
      const output = graph.searchUnified('评分', { limit: 20 });

      expect(output.directMatches).toHaveLength(4);
      expect(computeScoreSpy).toHaveBeenCalledTimes(output.directMatches.length);
      for (const result of output.directMatches) {
        const node = result.node as UnifiedNode & scoring.CandidateScoreMetadata;
        expect(node._computedScore).toBeTypeOf('number');
        expect(node._bm25Score).toBeUndefined();
        expect(result.score).toBe(node._computedScore);
      }
    } finally {
      graph.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('frozen KG ranking evaluator', () => {
  let root: string;
  let graph: MaestroGraph;
  let corpus: RankingCorpusFixture;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'maestro-kg-ranking-'));
    corpus = await loadRankingFixture<RankingCorpusFixture>(CORPUS_PATH);
    graph = await MaestroGraph.init(root);
    const nodes = expandActiveCorpus(corpus).map(document => makeNode(document));
    graph.getConnection().transaction(() => graph.getQueryBuilder().insertNodes(nodes));
    expect(nodes).toHaveLength(corpus.latencyCorpus.size);
  }, 30_000);

  afterAll(() => {
    graph.close();
    rmSync(root, { recursive: true, force: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps FTS BM25 as retrieval metadata and computes one final score', () => {
    const candidates = graph.getQueryBuilder().searchCodeFTS('AuthTokenValidator', { limit: 5 });
    expect(candidates.length).toBeGreaterThan(0);
    const candidate = candidates[0];
    expect(candidate._bm25Score).toBeGreaterThan(0);
    expect(candidate._computedScore).toBeUndefined();

    const computeScoreSpy = vi.spyOn(scoring, 'computeScore');
    const finalScore = scoreCandidate(candidate, 'AuthTokenValidator');
    expect(computeScoreSpy).toHaveBeenCalledTimes(1);
    expect(finalScore).not.toBe(candidate._bm25Score);
  });

  it('meets quality, stability, holdout, scanner, and warm latency gates', async () => {
    const report = await evaluateRanking({
      workspaceRoot: join(root, 'evaluation'),
      corpusPath: CORPUS_PATH,
      qrelsPath: QRELS_PATH,
      baselinePath: BASELINE_PATH,
      holdoutsPath: HOLDOUTS_PATH,
      runs: 5,
      topK: 20,
      ranker: (query, _documents, limit) => (
        graph.searchUnified(query, { limit }).directMatches
          .map(result => ({ id: result.node.id, score: result.score }))
      ),
      productionPaths: [
        resolve('src/graph/kg'),
      ],
    });
    const baseline = await loadRankingFixture<RankingBaselineFixture>(BASELINE_PATH);
    const holdouts = await loadRankingFixture<RankingHoldoutsFixture>(HOLDOUTS_PATH);

    expect(report.metrics.categories['exact-symbol'].mrrAt10).toBeGreaterThanOrEqual(0.95);
    expect(report.metrics.categories.knowledge.recallAt20).toBeGreaterThanOrEqual(0.90);
    for (const [category, metrics] of Object.entries(report.metrics.categories)) {
      expect(metrics.ndcgAt10, `${category} NDCG@10`).toBeGreaterThanOrEqual(
        baseline.metrics.categories[category].ndcgAt10 - 0.02,
      );
    }
    expect(report.stability).toMatchObject({ runs: 5, topK: 20, stableTop20: true });
    for (const query of report.stability.queries) {
      expect(query.top20Runs).toHaveLength(5);
      expect(query.top20Runs.every(run => (
        JSON.stringify(run) === JSON.stringify(query.top20Runs[0])
      ))).toBe(true);
    }

    for (const holdout of holdouts.queries.filter(query => query.category === 'kg')) {
      const ids = graph.searchUnified(holdout.query, { limit: 20 })
        .directMatches.map(result => result.node.id);
      expect(ids).toEqual(expect.arrayContaining(holdout.targetIds));
    }
    expect(report.scanner.querySpecialCaseHits).toBe(0);
    expect(report.latency).toMatchObject({
      warmups: 20,
      measuredSamples: 100,
      corpusSize: 2000,
    });
    assertKgLatencyBudget(report.latency);
  }, 30_000);

  it('hard-fails the independent P95 and max boundaries', () => {
    expect(() => assertKgLatencyBudget({ p95Ms: 34.8, maxMs: 49.999 })).not.toThrow();
    expect(() => assertKgLatencyBudget({ p95Ms: 34.9, maxMs: 49 })).toThrow('kgWarmP95Ms');
    expect(() => assertKgLatencyBudget({ p95Ms: 34, maxMs: 50.0 })).toThrow('kgWarmMaxMs');
  });
});
