import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./search.js', async importOriginal => {
  const actual = await importOriginal<typeof import('./search.js')>();
  return {
    ...actual,
    searchBM25Planned: vi.fn(actual.searchBM25Planned),
  };
});

import {
  buildInvertedIndex,
  buildQueryPlan,
  searchBM25,
  searchBM25Planned,
} from './search.js';
import { WikiIndexer } from './wiki-indexer.js';
import type { WikiEntry, WikiNodeType } from './wiki-types.js';

interface CorpusDocument {
  id: string;
  kind: string;
  title: string;
  summary: string;
  tags: string[];
  body: string;
  status: 'active' | 'deprecated';
  workspace: string;
  authorized: boolean;
  provenance: { source: string; path: string };
}

interface CorpusFixture {
  documents: CorpusDocument[];
  latencyCorpus: {
    size: number;
    idPrefix: string;
    vocabulary: string[];
  };
}

interface QrelsFixture {
  queries: Array<{
    id: string;
    query: string;
    category: string;
    relevance: Record<string, number>;
  }>;
}

interface HoldoutsFixture {
  queries: Array<{
    id: string;
    query: string;
    targetIds: string[];
    category: string;
  }>;
}

interface RankingEvaluator {
  computeRankingMetrics(
    rankedIds: readonly string[],
    relevance: Readonly<Record<string, number>>,
  ): { ndcgAt10: number; mrrAt10: number; recallAt20: number };
  scanQuerySpecialCases(input: {
    queryFiles: readonly string[];
    productionPaths: readonly string[];
  }): Promise<{ querySpecialCaseHits: number }>;
}

const fixtureDir = resolve(
  import.meta.dirname,
  '../../../../src/search/evaluation/fixtures',
);
const qrelsPath = join(fixtureDir, 'search-ranking-qrels.json');
const holdoutsPath = join(fixtureDir, 'search-ranking-holdouts.json');
const corpusPath = join(fixtureDir, 'search-ranking-corpus.json');
const temporaryRoots: string[] = [];

async function loadRankingEvaluator(): Promise<RankingEvaluator> {
  const evaluatorUrl = pathToFileURL(resolve(
    import.meta.dirname,
    '../../../../src/search/evaluation/relevance-evaluator.ts',
  )).href;
  return import(/* @vite-ignore */ evaluatorUrl) as Promise<RankingEvaluator>;
}

function nodeType(kind: string): WikiNodeType {
  if (kind === 'knowhow') return 'knowhow';
  if (kind === 'spec') return 'spec';
  if (kind === 'domain-term' || kind === 'code-symbol') return 'domain';
  return 'project';
}

function wikiEntry(document: CorpusDocument): WikiEntry {
  return {
    id: document.id,
    type: nodeType(document.kind),
    title: document.title,
    summary: document.summary,
    tags: document.tags,
    status: document.status,
    created: '2026-07-23T00:00:00.000Z',
    updated: '2026-07-23T00:00:00.000Z',
    related: [],
    source: {
      kind: 'virtual',
      path: document.provenance.path,
      ...(document.workspace === 'local' ? {} : { workspace: document.workspace }),
    },
    body: document.body,
    ext: document.kind === 'code-symbol' ? { virtualKind: 'kg-node' } : {},
    scope: document.workspace === 'local' ? 'project' : 'linked',
    category: null,
    specCategory: null,
    createdBy: null,
    sourceRef: null,
    parent: null,
  };
}

function entry(
  id: string,
  title: string,
  body = title,
  overrides: Partial<WikiEntry> = {},
): WikiEntry {
  return {
    id,
    type: 'spec',
    title,
    summary: '',
    tags: [],
    status: 'active',
    created: '2026-07-23T00:00:00.000Z',
    updated: '2026-07-23T00:00:00.000Z',
    related: [],
    source: { kind: 'virtual', path: `${id}.md` },
    body,
    ext: {},
    scope: 'project',
    category: null,
    specCategory: null,
    createdBy: null,
    sourceRef: null,
    parent: null,
    ...overrides,
  };
}

async function loadFixture<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T;
}

function percentile(samples: number[], fraction: number): number {
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}

afterEach(async () => {
  vi.mocked(searchBM25Planned).mockClear();
  await Promise.all(temporaryRoots.splice(0).map(root =>
    rm(root, { recursive: true, force: true, maxRetries: 3 }),
  ));
});

describe('planned Wiki ranking', () => {
  it('plans short queries and applies coverage-aware scoring without a legacy bypass', () => {
    const entries = [
      entry('complete', 'Contract', 'cache invalidation'),
      entry('partial', 'Cache', 'cache'),
      entry('other', 'Release workflow'),
    ];
    const index = buildInvertedIndex(entries);
    const plan = buildQueryPlan('cache invalidation', index);
    const legacy = searchBM25(index, 'cache invalidation', 3);
    const planned = searchBM25Planned(index, 'cache invalidation', 3);
    const legacyNdcg = 1 / Math.log2(3);
    const plannedNdcg = 1;

    expect(plan.tokens.map(token => token.normalized)).toEqual(['cache', 'invalidation']);
    expect(plan.groups).toHaveLength(1);
    expect(legacy[0]?.docId).toBe('partial');
    expect(planned[0]?.docId).toBe('complete');
    expect(plannedNdcg).toBeGreaterThanOrEqual(legacyNdcg * 1.1);
  });

  it('keeps the undefined credibility golden and reorders with the supplied map', () => {
    const index = buildInvertedIndex([
      entry('alpha-a', 'Alpha contract'),
      entry('alpha-b', 'Alpha contract'),
    ]);

    expect(searchBM25Planned(index, 'alpha', 2).map(result => result.docId))
      .toEqual(['alpha-a', 'alpha-b']);

    const factors = new Map([
      ['alpha-a', 0.2],
      ['alpha-b', 1],
    ]);
    const ranked = searchBM25Planned(index, 'alpha', 2, factors);
    expect(ranked.map(result => result.docId)).toEqual(['alpha-b', 'alpha-a']);
    expect(ranked[1].score).toBeLessThan(ranked[0].score);
  });

  it('passes the identical credibility Map from WikiIndexer to planned search', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wiki-ranking-map-'));
    temporaryRoots.push(root);
    await mkdir(join(root, 'specs'), { recursive: true });
    await writeFile(
      join(root, 'specs', 'ranking.md'),
      '---\ntitle: Ranking contract\n---\n# Ranking contract\nStable ranking.',
      'utf8',
    );
    const factors = new Map([['spec:project:ranking', 0.8]]);

    await new WikiIndexer({ workflowRoot: root }).searchWithMeta(
      'ranking',
      5,
      { skipEmbedding: true, credibilityFactors: factors },
    );

    expect(vi.mocked(searchBM25Planned)).toHaveBeenCalledWith(
      expect.anything(),
      'ranking',
      60,
      factors,
      undefined,
    );
  });

  it('retains TASK-001 relevance and is deterministic across five runs', async () => {
    const [corpus, qrels, evaluator] = await Promise.all([
      loadFixture<CorpusFixture>(corpusPath),
      loadFixture<QrelsFixture>(qrelsPath),
      loadRankingEvaluator(),
    ]);
    const documents = corpus.documents
      .filter(document => document.authorized && document.status !== 'deprecated')
      .map(wikiEntry);
    const index = buildInvertedIndex(documents);
    const runs = Array.from({ length: 5 }, () =>
      qrels.queries.map(judgment =>
        searchBM25Planned(index, judgment.query, 20).map(result => result.docId),
      ),
    );

    expect(runs.slice(1)).toEqual(Array(4).fill(runs[0]));
    const ndcgByCategory = new Map<string, number[]>();
    for (let queryIndex = 0; queryIndex < qrels.queries.length; queryIndex++) {
      const judgment = qrels.queries[queryIndex];
      const metrics = evaluator.computeRankingMetrics(runs[0][queryIndex], judgment.relevance);
      expect(metrics.mrrAt10, judgment.id).toBe(1);
      const categoryMetrics = ndcgByCategory.get(judgment.category) ?? [];
      categoryMetrics.push(metrics.ndcgAt10);
      ndcgByCategory.set(judgment.category, categoryMetrics);
    }
    for (const [category, values] of ndcgByCategory) {
      const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
      expect(mean, category).toBeGreaterThanOrEqual(0.98);
    }
    expect(ndcgByCategory.get('wiki-short')).toEqual([1, 1, 1]);
  });

  it('answers two external paraphrase and word-order holdouts without query branches', async () => {
    const [holdouts, evaluator] = await Promise.all([
      loadFixture<HoldoutsFixture>(holdoutsPath),
      loadRankingEvaluator(),
    ]);
    const piHoldouts = holdouts.queries.filter(query => query.category === 'pi');
    const canonical = entry(
      piHoldouts[0].targetIds[0],
      'Canonical generation workflow for skills',
      'Pi skills are generated from a canonical source workflow.',
    );
    const index = buildInvertedIndex([
      canonical,
      entry('distractor', 'Manual plugin notes', 'Unrelated configuration details.'),
    ]);

    expect(piHoldouts).toHaveLength(2);
    for (const holdout of piHoldouts) {
      expect(searchBM25Planned(index, holdout.query, 5)[0]?.docId, holdout.id)
        .toBe(canonical.id);
    }

    const scan = await evaluator.scanQuerySpecialCases({
      queryFiles: [qrelsPath, holdoutsPath],
      productionPaths: [
        resolve(import.meta.dirname, 'search.ts'),
        resolve(import.meta.dirname, 'wiki-indexer.ts'),
      ],
    });
    expect(scan.querySpecialCaseHits).toBe(0);
  });

  it('meets the 2000-document index and query latency budgets', async () => {
    const corpus = await loadFixture<CorpusFixture>(corpusPath);
    const documents = corpus.documents
      .filter(document => document.authorized && document.status !== 'deprecated')
      .map(wikiEntry);
    for (let index = documents.length; index < corpus.latencyCorpus.size; index++) {
      const words = corpus.latencyCorpus.vocabulary;
      documents.push(entry(
        `${corpus.latencyCorpus.idPrefix}-${String(index).padStart(4, '0')}`,
        `${words[index % words.length]} ${words[(index + 1) % words.length]}`,
        `${words[(index + 2) % words.length]} ${words[(index + 3) % words.length]}`,
      ));
    }

    const indexStarted = performance.now();
    const index = buildInvertedIndex(documents);
    const indexMs = performance.now() - indexStarted;
    for (let warmup = 0; warmup < 20; warmup++) {
      searchBM25Planned(index, 'wiki architecture', 20);
    }
    const samples: number[] = [];
    for (let sample = 0; sample < 100; sample++) {
      const started = performance.now();
      searchBM25Planned(index, 'wiki architecture', 20);
      samples.push(performance.now() - started);
    }

    expect(index.totalDocs).toBe(2000);
    expect(indexMs).toBeLessThan(500);
    expect(percentile(samples, 0.95)).toBeLessThan(50);
  });

  it('keeps the planned blend distinct from legacy BM25 for multi-signal queries', () => {
    const index = buildInvertedIndex([
      entry('anchor', 'AuthTokenValidator', 'authentication callback validator'),
      entry('context', 'Dashboard authentication', 'validator callback'),
      entry('noise', 'Authentication guide'),
    ]);

    const legacy = searchBM25(index, 'AuthTokenValidator dashboard authentication callback', 3);
    const planned = searchBM25Planned(
      index,
      'AuthTokenValidator dashboard authentication callback',
      3,
    );

    expect(planned.map(result => result.docId)).not.toEqual([]);
    expect(planned.map(result => result.score)).not.toEqual(legacy.map(result => result.score));
    expect(planned[0].docId).toBe('anchor');
  });
});
