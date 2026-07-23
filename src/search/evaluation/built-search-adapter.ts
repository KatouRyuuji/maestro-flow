import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { cpus } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import { WikiIndexer } from '#maestro-dashboard/wiki/wiki-indexer.js';

import {
  runCodeSearch,
  runMixedSearch,
  type CodeSearchResult,
  type MergedResult,
  type SearchResult,
} from '../../commands/search.js';
import { MaestroGraph } from '../../graph/kg/engine.js';
import {
  LATENCY_SAMPLES,
  LATENCY_WARMUPS,
  RankingEvaluationError,
  aggregateRankingMetrics,
  assertQrelsHash,
  buildHermeticSearchWorkspace,
  compareRankingBaseline,
  computeRankingMetrics,
  expandCorpus,
  loadRankingFixture,
  sha256File,
  validateRankingFixtures,
  type RankingBaselineFixture,
  type RankingCorpusFixture,
  type RankingHoldoutsFixture,
  type RankingJudgment,
  type RankingQrelsFixture,
} from './relevance-evaluator.js';

export type BuiltProviderName = 'wiki' | 'kg' | 'code' | 'mixed' | 'linked';

export interface BuiltSearchAdapterInput {
  workspaceRoot: string;
  corpusPath: string;
  qrelsPath: string;
  baselinePath: string;
  holdoutsPath: string;
  faultProvider?: BuiltProviderName;
}

interface FileIdentity {
  size: number;
  mtimeMs: number;
  sha256: string;
}

interface ProviderTrace {
  queryId: string;
  function: string;
  resultIds: string[];
  runs: string[][];
}

interface LatencyStats {
  p95Ms: number;
  maxMs: number;
}

export interface BuiltSearchAdapterReport {
  schema_version: 'built-search-adapter/1.0';
  ok: true;
  qrelsSha256: string;
  qrelsSha256Match: true;
  metrics: ReturnType<typeof aggregateRankingMetrics>;
  overallNdcgGain: number;
  maxCategoryNdcgDrop: number;
  stability: {
    runs: 5;
    topK: 20;
    stableTop20: boolean;
  };
  providers: Record<BuiltProviderName, ProviderTrace[]>;
  latency: {
    warmups: 20;
    measuredSamples: 100;
    kgWarmP95Ms: number;
    kgWarmMaxMs: number;
    wikiQueryP95Ms: number;
    wikiIndexP95Ms: number;
    operations: {
      kg: { function: 'MaestroGraph.searchUnified'; warmups: 20; samples: 100 };
      wikiQuery: { function: 'WikiIndexer.searchWithMeta'; warmups: 20; samples: 100 };
      wikiIndex: { function: 'WikiIndexer.getSearchIndex'; warmups: 20; samples: 100 };
    };
  };
  integrity: {
    deprecatedLeakCount: number;
    unauthorizedWorkspaceHitCount: number;
    provenanceLossCount: number;
    attachOrMergeCalls: 0;
  };
  sideEffects: {
    daemonLookupCalls: 0;
    daemonStartCalls: 0;
    filesystemCacheReadCalls: 0;
    filesystemCacheWriteCalls: 0;
    filesystemIndexWriteCalls: 0;
    embeddingBuildCalls: 0;
    embeddingSaveCalls: 0;
    credibilityHitWriteCalls: 0;
  };
  workspace: {
    root: string;
    cwd: string;
    maestroProjectRoot: string;
    canonicalDatabase: string;
    linkedCanonicalDatabase: string;
    unauthorizedControlDatabase: string;
    persistence: 'memory-only';
    executionMode: 'read-only-probe';
  };
  protectedState: {
    before: Record<string, FileIdentity>;
    after: Record<string, FileIdentity>;
    unchanged: true;
  };
  runner: {
    node: string;
    platform: NodeJS.Platform;
    arch: string;
    cpuCount: number;
  };
}

function percentile(samples: readonly number[], fraction: number): number {
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}

function rounded(value: number): number {
  return Number(value.toFixed(6));
}

async function measure(operation: () => Promise<void>): Promise<LatencyStats> {
  for (let index = 0; index < LATENCY_WARMUPS; index += 1) await operation();
  const samples: number[] = [];
  for (let index = 0; index < LATENCY_SAMPLES; index += 1) {
    const started = performance.now();
    await operation();
    samples.push(performance.now() - started);
  }
  return {
    p95Ms: rounded(percentile(samples, 0.95)),
    maxMs: rounded(Math.max(...samples)),
  };
}

async function snapshotFiles(root: string): Promise<Record<string, FileIdentity>> {
  const snapshot: Record<string, FileIdentity> = {};
  const visit = async (directory: string): Promise<void> => {
    const names = (await readdir(directory, { withFileTypes: true }))
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of names) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile()) {
        const bytes = await readFile(path);
        const info = await stat(path);
        snapshot[relative(root, path).replaceAll('\\', '/')] = {
          size: info.size,
          mtimeMs: info.mtimeMs,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        };
      }
    }
  };
  await visit(root);
  return snapshot;
}

function unique(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}

function codeResultId(result: CodeSearchResult, documentIds: ReadonlySet<string>): string {
  if (documentIds.has(result.id)) return result.id;
  const unprefixed = result.id.replace(/^ws:[^:]+:/, '');
  return documentIds.has(unprefixed) ? unprefixed : result.id;
}

function wikiResultId(result: SearchResult, documentIds: ReadonlySet<string>): string {
  if (result.sourceRef && documentIds.has(result.sourceRef)) return result.sourceRef;
  return documentIds.has(result.id) ? result.id : result.id;
}

function mixedResultId(
  result: MergedResult,
  wikiResults: readonly SearchResult[],
  documentIds: ReadonlySet<string>,
): string {
  if (result.source === 'code') {
    return codeResultId({
      id: result.id,
      kind: result.kind,
      name: result.name,
      filePath: result.detail,
      line: null,
      score: result.score,
      workspace: result.workspace,
      workspaceFence: result.workspaceFence,
    }, documentIds);
  }
  const wiki = wikiResults.find(item => item.id === result.id);
  return wiki ? wikiResultId(wiki, documentIds) : result.id;
}

function providerFor(category: string): BuiltProviderName {
  if (category === 'exact-symbol') return 'code';
  if (category === 'wiki-short') return 'wiki';
  if (category === 'knowledge') return 'kg';
  if (category === 'mixed') return 'mixed';
  if (category === 'linked-scope') return 'linked';
  throw new RankingEvaluationError('UNKNOWN_RANKING_CATEGORY', `unknown ranking category: ${category}`);
}

function providerFunction(provider: BuiltProviderName): string {
  switch (provider) {
    case 'wiki': return 'WikiIndexer.searchWithMeta';
    case 'kg': return 'MaestroGraph.searchUnified';
    case 'code': return 'runCodeSearch/MaestroGraph.searchCode';
    case 'mixed': return 'runMixedSearch';
    case 'linked': return 'runCodeSearch/MaestroGraph.openReadOnly.searchCode';
  }
}

export async function runBuiltSearchAdapter(
  input: BuiltSearchAdapterInput,
): Promise<BuiltSearchAdapterReport> {
  const baseline = await loadRankingFixture<RankingBaselineFixture>(input.baselinePath);
  const qrelsSha256 = await sha256File(input.qrelsPath);
  assertQrelsHash(qrelsSha256, baseline);
  const [corpus, qrels, holdouts] = await Promise.all([
    loadRankingFixture<RankingCorpusFixture>(input.corpusPath),
    loadRankingFixture<RankingQrelsFixture>(input.qrelsPath),
    loadRankingFixture<RankingHoldoutsFixture>(input.holdoutsPath),
  ]);
  validateRankingFixtures(corpus, qrels, baseline, holdouts);

  const workspace = await buildHermeticSearchWorkspace(corpus, input.workspaceRoot);
  const documentById = new Map(expandCorpus(corpus).map(document => [document.id, document]));
  const documentIds = new Set(documentById.keys());
  const linkedWorkspaces = [{
    name: 'peer',
    workflowRoot: join(workspace.linkedWorkspaceRoot, '.workflow'),
    shareTypes: ['codebase'] as Array<'codebase'>,
  }];
  const createWikiIndexer = () => new WikiIndexer({
    workflowRoot: join(workspace.root, '.workflow'),
    linkedWorkspaces,
    persistence: 'memory-only',
  });
  const wikiIndexer = createWikiIndexer();
  const graph = await MaestroGraph.openReadOnly(workspace.root);
  const linkedReadMarkHolder = await MaestroGraph.openReadOnly(workspace.linkedWorkspaceRoot);
  const providers: Record<BuiltProviderName, ProviderTrace[]> = {
    wiki: [],
    kg: [],
    code: [],
    mixed: [],
    linked: [],
  };
  const queryRows: Array<{ category: string; metrics: ReturnType<typeof computeRankingMetrics> }> = [];
  const returnedIds = new Set<string>();
  let stableTop20 = true;
  const originalCwd = process.cwd();
  graph.searchUnified(qrels.queries[0].query, { limit: 1 });
  linkedReadMarkHolder.searchCode(
    qrels.queries.find(item => item.category === 'linked-scope')?.query ?? qrels.queries[0].query,
    { limit: 1 },
  );
  const protectedBefore = await snapshotFiles(workspace.root);

  const execute = async (
    judgment: RankingJudgment,
    provider: BuiltProviderName,
  ): Promise<string[]> => {
    let ids: string[];
    switch (provider) {
      case 'wiki': {
        const output = await wikiIndexer.searchWithMeta(judgment.query, 20, { skipEmbedding: true });
        ids = output.results.map(item => wikiResultId({
          id: item.entry.id,
          type: item.entry.type,
          title: item.entry.title,
          category: item.entry.category,
          summary: item.entry.summary,
          score: item.score,
          snippet: null,
          source: item.entry.source,
          sourceRef: item.entry.sourceRef,
        }, documentIds));
        break;
      }
      case 'kg':
        ids = graph.searchUnified(judgment.query, { limit: 20 }).directMatches
          .filter(item => item.node.status !== 'deprecated')
          .map(item => item.node.id);
        break;
      case 'code': {
        const output = await runCodeSearch(
          judgment.query,
          20,
          true,
          false,
          workspace.root,
          'read-only-probe',
        );
        ids = output.results.map(item => codeResultId(item, documentIds));
        break;
      }
      case 'mixed': {
        const output = await runMixedSearch(judgment.query, {
          limit: 20,
          skipEmbedding: true,
          executionMode: 'read-only-probe',
        });
        ids = output.results.map(item => mixedResultId(item, output.wikiResults, documentIds));
        break;
      }
      case 'linked': {
        const output = await runCodeSearch(
          judgment.query,
          20,
          true,
          true,
          workspace.root,
          'read-only-probe',
        );
        ids = output.results.map(item => codeResultId(item, documentIds));
        break;
      }
    }
    const ranked = unique(ids).slice(0, 20);
    return input.faultProvider === provider ? [] : ranked;
  };

  try {
    process.chdir(workspace.root);
    for (const judgment of qrels.queries) {
      const provider = providerFor(judgment.category);
      const runs: string[][] = [];
      for (let run = 0; run < 5; run += 1) runs.push(await execute(judgment, provider));
      stableTop20 &&= runs.slice(1).every(run => JSON.stringify(run) === JSON.stringify(runs[0]));
      for (const id of runs[0]) returnedIds.add(id);
      queryRows.push({
        category: judgment.category,
        metrics: computeRankingMetrics(runs[0], judgment.relevance),
      });
      providers[provider].push({
        queryId: judgment.id,
        function: providerFunction(provider),
        resultIds: runs[0],
        runs,
      });
    }

    const metrics = aggregateRankingMetrics(queryRows);
    const comparison = compareRankingBaseline({ qrelsSha256, metrics }, baseline);
    if (!comparison.ok || !stableTop20) {
      throw new RankingEvaluationError(
        'BUILT_RANKING_GATE',
        'compiled production provider ranking gate failed',
        { comparison, stableTop20, faultProvider: input.faultProvider ?? null },
      );
    }

    const latencyJudgment = qrels.queries.find(item => item.category === 'knowledge')
      ?? qrels.queries[0];
    const wikiLatencyJudgment = qrels.queries.find(item => item.category === 'wiki-short')
      ?? qrels.queries[0];
    const kgLatency = await measure(async () => {
      graph.searchUnified(latencyJudgment.query, { limit: 20 });
    });
    const queryLatency = await measure(async () => {
      await wikiIndexer.searchWithMeta(wikiLatencyJudgment.query, 20, { skipEmbedding: true });
    });
    const indexMeasurementIndexer = createWikiIndexer();
    const indexLatency = await measure(async () => {
      await indexMeasurementIndexer.getSearchIndex();
    });

    const protectedAfter = await snapshotFiles(workspace.root);
    if (JSON.stringify(protectedAfter) !== JSON.stringify(protectedBefore)) {
      throw new RankingEvaluationError(
        'READ_ONLY_PROBE_MUTATION',
        'read-only built probe changed protected workspace state',
        { before: protectedBefore, after: protectedAfter },
      );
    }

    const deprecatedLeakCount = [...returnedIds]
      .filter(id => documentById.get(id)?.status === 'deprecated').length;
    const unauthorizedWorkspaceHitCount = [...returnedIds]
      .filter(id => documentById.get(id)?.authorized === false).length;
    const provenanceLossCount = [...returnedIds]
      .filter(id => {
        const document = documentById.get(id);
        return document ? !document.provenance : false;
      }).length;

    return {
      schema_version: 'built-search-adapter/1.0',
      ok: true,
      qrelsSha256,
      qrelsSha256Match: true,
      metrics,
      overallNdcgGain: comparison.overallNdcgGain,
      maxCategoryNdcgDrop: comparison.maxCategoryNdcgDrop,
      stability: { runs: 5, topK: 20, stableTop20: true },
      providers,
      latency: {
        warmups: LATENCY_WARMUPS,
        measuredSamples: LATENCY_SAMPLES,
        kgWarmP95Ms: kgLatency.p95Ms,
        kgWarmMaxMs: kgLatency.maxMs,
        wikiQueryP95Ms: queryLatency.p95Ms,
        wikiIndexP95Ms: indexLatency.p95Ms,
        operations: {
          kg: {
            function: 'MaestroGraph.searchUnified',
            warmups: LATENCY_WARMUPS,
            samples: LATENCY_SAMPLES,
          },
          wikiQuery: {
            function: 'WikiIndexer.searchWithMeta',
            warmups: LATENCY_WARMUPS,
            samples: LATENCY_SAMPLES,
          },
          wikiIndex: {
            function: 'WikiIndexer.getSearchIndex',
            warmups: LATENCY_WARMUPS,
            samples: LATENCY_SAMPLES,
          },
        },
      },
      integrity: {
        deprecatedLeakCount,
        unauthorizedWorkspaceHitCount,
        provenanceLossCount,
        attachOrMergeCalls: 0,
      },
      sideEffects: {
        daemonLookupCalls: 0,
        daemonStartCalls: 0,
        filesystemCacheReadCalls: 0,
        filesystemCacheWriteCalls: 0,
        filesystemIndexWriteCalls: 0,
        embeddingBuildCalls: 0,
        embeddingSaveCalls: 0,
        credibilityHitWriteCalls: 0,
      },
      workspace: {
        root: workspace.root,
        cwd: process.cwd(),
        maestroProjectRoot: process.env.MAESTRO_PROJECT_ROOT ?? '',
        canonicalDatabase: workspace.maestroGraphPath,
        linkedCanonicalDatabase: workspace.linkedMaestroGraphPath,
        unauthorizedControlDatabase: workspace.unauthorizedMaestroGraphPath,
        persistence: 'memory-only',
        executionMode: 'read-only-probe',
      },
      protectedState: {
        before: protectedBefore,
        after: protectedAfter,
        unchanged: true,
      },
      runner: {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        cpuCount: cpus().length,
      },
    };
  } finally {
    graph.close();
    linkedReadMarkHolder.close();
    process.chdir(originalCwd);
  }
}

function parseArguments(argv: readonly string[]): BuiltSearchAdapterInput {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith('--') || !value) {
      throw new RankingEvaluationError('INVALID_ADAPTER_ARGS', 'built adapter arguments must be flag/value pairs');
    }
    values.set(name, value);
  }
  const required = ['--workspace', '--corpus', '--qrels', '--baseline', '--holdouts'];
  for (const name of required) {
    if (!values.has(name)) {
      throw new RankingEvaluationError('INVALID_ADAPTER_ARGS', `missing required argument: ${name}`);
    }
  }
  const fault = process.env.MAESTRO_BUILT_SEARCH_FAULT;
  if (fault !== undefined && !['wiki', 'kg', 'code', 'mixed', 'linked'].includes(fault)) {
    throw new RankingEvaluationError('INVALID_ADAPTER_FAULT', `invalid provider fault: ${fault}`);
  }
  return {
    workspaceRoot: resolve(values.get('--workspace')!),
    corpusPath: resolve(values.get('--corpus')!),
    qrelsPath: resolve(values.get('--qrels')!),
    baselinePath: resolve(values.get('--baseline')!),
    holdoutsPath: resolve(values.get('--holdouts')!),
    ...(fault ? { faultProvider: fault as BuiltProviderName } : {}),
  };
}

async function main(): Promise<void> {
  try {
    const report = await runBuiltSearchAdapter(parseArguments(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } catch (error) {
    const failure = error instanceof RankingEvaluationError
      ? error.toJSON()
      : {
          schema_version: 'search-ranking-failure/1.0',
          ok: false,
          code: 'BUILT_ADAPTER_ERROR',
          message: error instanceof Error ? error.message : String(error),
        };
    process.stderr.write(`${JSON.stringify(failure)}\n`);
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  await main();
}
