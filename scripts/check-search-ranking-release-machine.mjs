#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  closeSync,
  copyFileSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const dashboardRoot = join(repoRoot, 'dashboard');
export const binPath = join(repoRoot, 'bin', 'maestro.js');
export const builtSearchAdapterPath = join(
  repoRoot,
  'dist',
  'src',
  'search',
  'evaluation',
  'built-search-adapter.js',
);

export const ROOT_TEST_PATHS = Object.freeze([
  'src/search/evaluation/relevance-evaluator.test.ts',
  'src/graph/kg/__tests__/search-ranking.test.ts',
  'src/commands/search-linked-code.test.ts',
  'src/commands/search-mixed-fusion.test.ts',
  'src/tools/__tests__/knowhow-lifecycle.test.ts',
  'src/search/evaluation/pi-knowledge-absolute.test.ts',
]);

export const DASHBOARD_TEST_PATHS = Object.freeze([
  'src/server/wiki/search-ranking.test.ts',
  'src/server/wiki/wiki-indexer.test.ts',
]);

const MODE_PHASES = Object.freeze({
  standalone: ['source-tests', 'build', 'built-bin'],
  source: ['source-tests'],
  built: ['built-bin'],
});

const FIXTURE_ROOT = join(repoRoot, 'src', 'search', 'evaluation', 'fixtures');
const PRODUCTION_ARTIFACTS = Object.freeze([
  'dist/src/search/evaluation/built-search-adapter.js',
  'dist/src/commands/search.js',
  'dist/src/graph/kg/query/search.js',
  'dist/src/graph/kg/query/scoring.js',
  'dashboard/dist-server/dashboard/src/server/wiki/search.js',
  'dashboard/dist-server/dashboard/src/server/wiki/wiki-indexer.js',
]);

const LIMITS = Object.freeze({
  exactMrrAt10: 0.95,
  overallNdcgGain: 0.1,
  maxCategoryNdcgDrop: 0.02,
  knowledgeRecallAt20: 0.90,
  kgWarmP95Ms: 34.8,
  kgWarmMaxMs: 50,
  wikiQueryP95Ms: 50,
  wikiIndexP95Ms: 500,
});

export class ReleaseMachineError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'ReleaseMachineError';
    this.code = code;
    this.details = details;
  }

  toJSON() {
    return {
      schema_version: 'search-ranking-release-failure/1.0',
      ok: false,
      code: this.code,
      message: this.message,
      ...(this.details === undefined ? {} : { details: this.details }),
    };
  }
}

function fail(code, message, details) {
  throw new ReleaseMachineError(code, message, details);
}

function isExistingAbsoluteFile(path) {
  if (typeof path !== 'string' || path.length === 0 || !isAbsolute(path) || !existsSync(path)) {
    return false;
  }
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

export function resolveNpmInvocation(npmArgs, { npmCliOverride } = {}) {
  if (!Array.isArray(npmArgs) || !npmArgs.every(arg => typeof arg === 'string')) {
    fail('INVALID_NPM_ARGS', 'npm arguments must be an array of strings');
  }
  const npmExecPath = isExistingAbsoluteFile(process.env.npm_execpath)
    ? process.env.npm_execpath
    : isExistingAbsoluteFile(npmCliOverride)
      ? npmCliOverride
      : null;
  if (npmExecPath === null) {
    fail(
      'NPM_CLI_UNAVAILABLE',
      'npm_execpath must name an existing absolute file; standalone may use --npm-cli <existing-abs>',
      {
        npm_execpath: process.env.npm_execpath ?? null,
        npmCliOverride: npmCliOverride ?? null,
      },
    );
  }
  return {
    command: process.execPath,
    args: [npmExecPath, ...npmArgs],
  };
}

function childFailure(label, result) {
  fail('CHILD_PROCESS_FAILED', `${label} failed`, {
    label,
    status: result.status ?? null,
    signal: result.signal ?? null,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error
      ? {
          name: result.error.name,
          message: result.error.message,
          code: result.error.code ?? null,
        }
      : null,
  });
}

export function runNpmChild(
  label,
  npmArgs,
  cwd,
  { npmCliOverride, spawn = spawnSync } = {},
) {
  const invocation = resolveNpmInvocation(npmArgs, { npmCliOverride });
  const result = spawn(invocation.command, invocation.args, {
    shell: false,
    cwd,
    encoding: 'utf8',
  });
  if (result.error || result.status !== 0) childFailure(label, result);
  return {
    label,
    command: invocation.command,
    args: invocation.args,
    cwd,
    shell: false,
    status: result.status,
    signal: result.signal ?? null,
    stdoutBytes: Buffer.byteLength(result.stdout ?? '', 'utf8'),
    stderrBytes: Buffer.byteLength(result.stderr ?? '', 'utf8'),
  };
}

function normalizedReportedPath(path, cwd) {
  const absolute = isAbsolute(path) ? resolve(path) : resolve(cwd, path);
  return relative(cwd, absolute).split(sep).join('/');
}

export function parseVitestReport(reportPath, {
  label,
  cwd,
  expectedFiles,
  exactCollectedFiles,
} = {}) {
  let report;
  try {
    report = JSON.parse(readFileSync(reportPath, 'utf8'));
  } catch (error) {
    fail('INVALID_TEST_REPORT', `${label}: cannot parse Vitest JSON report`, {
      reportPath,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  const testResults = Array.isArray(report.testResults) ? report.testResults : [];
  const collectedFiles = testResults.length;
  const tests = Number.isInteger(report.numTotalTests)
    ? report.numTotalTests
    : testResults.reduce(
        (count, result) => count + (Array.isArray(result.assertionResults)
          ? result.assertionResults.length
          : 0),
        0,
      );
  const failures = Number.isInteger(report.numFailedTests)
    ? report.numFailedTests
    : testResults.reduce(
        (count, result) => count + (Array.isArray(result.assertionResults)
          ? result.assertionResults.filter(assertion => assertion.status === 'failed').length
          : 0),
        0,
      );
  const files = testResults.map(result => normalizedReportedPath(result.name, cwd)).sort();
  const expected = [...expectedFiles].sort();

  if (collectedFiles === 0 || tests === 0) {
    fail('ZERO_TEST_COLLECTION', `${label}: Vitest collected no files or tests`, {
      collectedFiles,
      tests,
      files,
    });
  }
  if (failures !== 0 || report.success === false) {
    fail('SOURCE_TEST_FAILURE', `${label}: Vitest reported failures`, {
      collectedFiles,
      tests,
      failures,
      files,
    });
  }
  if (exactCollectedFiles !== undefined && collectedFiles !== exactCollectedFiles) {
    fail('UNEXPECTED_TEST_COLLECTION', `${label}: collected file count differs from ownership matrix`, {
      expected: exactCollectedFiles,
      actual: collectedFiles,
      files,
    });
  }
  if (JSON.stringify(files) !== JSON.stringify(expected)) {
    fail('TEST_OWNERSHIP_MISMATCH', `${label}: collected files differ from focused ownership matrix`, {
      expected,
      actual: files,
    });
  }
  return { label, cwd, collectedFiles, tests, failures, files };
}

export function runSourcePhase({ npmCliOverride, spawn = spawnSync, tempRoot } = {}) {
  const ownedTempRoot = tempRoot ?? mkdtempSync(join(tmpdir(), 'maestro-search-ranking-source-'));
  const shouldCleanup = tempRoot === undefined;
  const rootReport = join(ownedTempRoot, 'root-vitest.json');
  const dashboardReport = join(ownedTempRoot, 'dashboard-vitest.json');
  try {
    const rootArgs = [
      'test',
      '--',
      '--reporter=json',
      '--outputFile',
      rootReport,
      ...ROOT_TEST_PATHS,
    ];
    const dashboardArgs = [
      'test',
      '--',
      '--reporter=json',
      '--outputFile',
      dashboardReport,
      ...DASHBOARD_TEST_PATHS,
    ];
    if (dashboardArgs.some(arg => arg.startsWith('dashboard/'))) {
      fail('DASHBOARD_PATH_PREFIX', 'dashboard test arguments must be relative to dashboard root');
    }

    const rootTrace = runNpmChild(
      'source-tests:root',
      rootArgs,
      repoRoot,
      { npmCliOverride, spawn },
    );
    const root = parseVitestReport(rootReport, {
      label: 'source-tests:root',
      cwd: repoRoot,
      expectedFiles: ROOT_TEST_PATHS,
      exactCollectedFiles: ROOT_TEST_PATHS.length,
    });

    const dashboardTrace = runNpmChild(
      'source-tests:dashboard',
      dashboardArgs,
      dashboardRoot,
      { npmCliOverride, spawn },
    );
    const dashboard = parseVitestReport(dashboardReport, {
      label: 'source-tests:dashboard',
      cwd: dashboardRoot,
      expectedFiles: DASHBOARD_TEST_PATHS,
      exactCollectedFiles: 2,
    });

    return {
      phase: 'source-tests',
      runners: [root, dashboard],
      trace: [rootTrace, dashboardTrace],
    };
  } finally {
    if (shouldCleanup) rmSync(ownedTempRoot, { recursive: true, force: true });
  }
}

export function runBuildPhase({ npmCliOverride, spawn = spawnSync } = {}) {
  return {
    phase: 'build',
    trace: runNpmChild('build', ['run', 'build'], repoRoot, { npmCliOverride, spawn }),
  };
}

function containedPath(root, target) {
  const relativePath = relative(root, target);
  return relativePath === '' || (
    relativePath !== '..'
    && !relativePath.startsWith(`..${sep}`)
    && !isAbsolute(relativePath)
  );
}

export function readArtifact(relativePath, { root = repoRoot } = {}) {
  const rootReal = realpathSync(root);
  const requested = resolve(root, relativePath);
  const beforeLstat = lstatSync(requested);
  const beforeReal = realpathSync(requested);
  if (!beforeLstat.isFile() || !containedPath(rootReal, beforeReal)) {
    fail('ARTIFACT_BOUNDARY', `artifact is not a contained regular file: ${relativePath}`);
  }

  const fd = openSync(beforeReal, 'r');
  try {
    const beforeFstat = fstatSync(fd);
    const buffer = readFileSync(fd);
    const afterFstat = fstatSync(fd);
    const afterLstat = lstatSync(requested);
    const afterReal = realpathSync(requested);
    const unchanged = beforeReal === afterReal
      && beforeLstat.dev === afterLstat.dev
      && beforeLstat.ino === afterLstat.ino
      && beforeLstat.size === afterLstat.size
      && beforeLstat.mtimeMs === afterLstat.mtimeMs
      && beforeFstat.dev === afterFstat.dev
      && beforeFstat.ino === afterFstat.ino
      && beforeFstat.size === afterFstat.size
      && beforeFstat.mtimeMs === afterFstat.mtimeMs
      && buffer.length === beforeFstat.size;
    if (!unchanged) {
      fail('ARTIFACT_IDENTITY_CHANGED', `artifact changed while being read: ${relativePath}`);
    }
    return {
      relativePath,
      realPath: beforeReal,
      buffer,
      sha256: createHash('sha256').update(buffer).digest('hex'),
    };
  } finally {
    closeSync(fd);
  }
}

export function parseArtifactJson(artifact) {
  try {
    return JSON.parse(artifact.buffer.toString('utf8'));
  } catch (error) {
    fail('INVALID_ARTIFACT_JSON', `cannot parse artifact JSON: ${artifact.relativePath}`, {
      sha256: artifact.sha256,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

function runBinChild(label, args, {
  spawn = spawnSync,
  cwd = repoRoot,
  projectRoot = cwd,
} = {}) {
  const result = spawn(process.execPath, [binPath, ...args], {
    shell: false,
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      MAESTRO_PROJECT_ROOT: projectRoot,
      MAESTRO_NO_WASM_RELAUNCH: '1',
      NO_COLOR: '1',
    },
  });
  if (result.error || result.status !== 0) childFailure(label, result);
  let body;
  try {
    body = JSON.parse(result.stdout);
  } catch (error) {
    fail('INVALID_BIN_JSON', `${label}: public CLI did not emit JSON`, {
      status: result.status,
      signal: result.signal ?? null,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  return {
    body,
    trace: {
      label,
      command: process.execPath,
      args: [binPath, ...args],
      cwd,
      shell: false,
      status: result.status,
      signal: result.signal ?? null,
      stdoutBytes: Buffer.byteLength(result.stdout ?? '', 'utf8'),
      stderrBytes: Buffer.byteLength(result.stderr ?? '', 'utf8'),
    },
  };
}

function seedBuiltWorkspace(workspaceRoot) {
  const knowhowRoot = join(workspaceRoot, '.workflow', 'knowhow');
  mkdirSync(knowhowRoot, { recursive: true });
  for (const name of [
    'RCP-20260716-pi-maestro-flow-cli.md',
    'RCP-20260723-pi-skills-canonical-generation.md',
  ]) {
    copyFileSync(
      join(repoRoot, '.workflow', 'knowhow', name),
      join(knowhowRoot, name),
    );
  }
}

export function runBuiltAdapterChild({
  spawn = spawnSync,
  workspaceRoot,
  env = {},
  adapterPath = builtSearchAdapterPath,
} = {}) {
  if (!workspaceRoot || !isAbsolute(workspaceRoot)) {
    fail('INVALID_BUILT_WORKSPACE', 'built adapter workspace must be an absolute path');
  }
  if (!isExistingAbsoluteFile(adapterPath)) {
    fail('BUILT_ADAPTER_MISSING', 'compiled built search adapter is missing', {
      path: adapterPath,
    });
  }
  const args = [
    adapterPath,
    '--workspace', workspaceRoot,
    '--corpus', join(FIXTURE_ROOT, 'search-ranking-corpus.json'),
    '--qrels', join(FIXTURE_ROOT, 'search-ranking-qrels.json'),
    '--baseline', join(FIXTURE_ROOT, 'search-ranking-baseline.json'),
    '--holdouts', join(FIXTURE_ROOT, 'search-ranking-holdouts.json'),
  ];
  const result = spawn(process.execPath, args, {
    shell: false,
    cwd: workspaceRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...env,
      MAESTRO_PROJECT_ROOT: workspaceRoot,
      MAESTRO_NO_WASM_RELAUNCH: '1',
      NO_COLOR: '1',
    },
  });
  if (result.error || result.status !== 0) childFailure('built-bin:search-adapter', result);
  let body;
  try {
    body = JSON.parse(result.stdout);
  } catch (error) {
    fail('INVALID_BUILT_ADAPTER_JSON', 'compiled built adapter did not emit machine JSON', {
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  const providerNames = ['wiki', 'kg', 'code', 'mixed', 'linked'];
  if (body?.schema_version !== 'built-search-adapter/1.0'
      || body.ok !== true
      || !providerNames.every(name => (
        Array.isArray(body.providers?.[name])
        && body.providers[name].length > 0
        && body.providers[name].every(trace => (
          typeof trace.function === 'string'
          && trace.function.length > 0
          && Array.isArray(trace.resultIds)
        ))
      ))
      || body.workspace?.root !== workspaceRoot
      || body.workspace?.cwd !== workspaceRoot
      || body.workspace?.maestroProjectRoot !== workspaceRoot
      || body.workspace?.persistence !== 'memory-only'
      || body.workspace?.executionMode !== 'read-only-probe'
      || body.protectedState?.unchanged !== true) {
    fail('INVALID_BUILT_ADAPTER_ENVELOPE', 'compiled built adapter envelope is incomplete', body);
  }
  return {
    body,
    trace: {
      label: 'built-bin:search-adapter',
      command: process.execPath,
      args,
      cwd: workspaceRoot,
      shell: false,
      status: result.status,
      signal: result.signal ?? null,
      stdoutBytes: Buffer.byteLength(result.stdout ?? '', 'utf8'),
      stderrBytes: Buffer.byteLength(result.stderr ?? '', 'utf8'),
      maestroProjectRoot: workspaceRoot,
    },
  };
}

function tokenize(value) {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLocaleLowerCase('en-US')
    .match(/[\p{L}\p{N}_$]+/gu) ?? [];
}

function normalizedQuery(value) {
  return value.trim().toLocaleLowerCase('en-US').replace(/\s+/g, ' ');
}

function preparedCorpus(corpus) {
  const documents = [...corpus.documents];
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
  return documents.map(document => ({
    document,
    title: tokenize(document.title),
    summary: tokenize(document.summary),
    tags: document.tags.flatMap(tokenize),
    body: tokenize(document.body),
  }));
}

function termFrequency(tokens, term) {
  let count = 0;
  for (const token of tokens) if (token === term) count += 1;
  return count;
}

function rankPrepared(query, prepared, limit) {
  const queryTerms = [...new Set(tokenize(query))];
  const normalized = normalizedQuery(query);
  const ranked = [];
  for (const item of prepared) {
    const { document } = item;
    if (document.status === 'deprecated' || document.authorized === false) continue;
    let score = normalizedQuery(document.title) === normalized ? 16 : 0;
    for (const term of queryTerms) {
      score += termFrequency(item.title, term) * 5;
      score += termFrequency(item.tags, term) * 3;
      score += termFrequency(item.summary, term) * 2;
      score += termFrequency(item.body, term);
    }
    if (score > 0) ranked.push({ id: document.id, score });
  }
  return ranked
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
    .slice(0, limit);
}

function rankingMetrics(rankedIds, relevance) {
  const relevantIds = Object.entries(relevance)
    .filter(([, grade]) => grade > 0)
    .map(([id]) => id);
  let dcg = 0;
  for (let index = 0; index < Math.min(10, rankedIds.length); index += 1) {
    const grade = relevance[rankedIds[index]] ?? 0;
    dcg += (2 ** grade - 1) / Math.log2(index + 2);
  }
  const idealGrades = relevantIds
    .map(id => relevance[id])
    .sort((left, right) => right - left)
    .slice(0, 10);
  const idcg = idealGrades.reduce(
    (sum, grade, index) => sum + (2 ** grade - 1) / Math.log2(index + 2),
    0,
  );
  const firstRelevant = rankedIds.slice(0, 10).findIndex(id => (relevance[id] ?? 0) > 0);
  const recalled = new Set(rankedIds.slice(0, 20).filter(id => (relevance[id] ?? 0) > 0)).size;
  return {
    ndcgAt10: idcg === 0 ? 0 : dcg / idcg,
    mrrAt10: firstRelevant < 0 ? 0 : 1 / (firstRelevant + 1),
    recallAt20: recalled / relevantIds.length,
  };
}

function meanMetrics(values) {
  return {
    ndcgAt10: values.reduce((sum, value) => sum + value.ndcgAt10, 0) / values.length,
    mrrAt10: values.reduce((sum, value) => sum + value.mrrAt10, 0) / values.length,
    recallAt20: values.reduce((sum, value) => sum + value.recallAt20, 0) / values.length,
  };
}

function aggregateMetrics(rows) {
  const categories = {};
  for (const category of [...new Set(rows.map(row => row.category))].sort()) {
    categories[category] = meanMetrics(
      rows.filter(row => row.category === category).map(row => row.metrics),
    );
  }
  return { overall: meanMetrics(rows.map(row => row.metrics)), categories };
}

function baselineGoldenMatches(qrels, baseline) {
  const rows = qrels.queries.map(query => ({
    category: query.category,
    metrics: rankingMetrics(baseline.knownOrder[query.id] ?? [], query.relevance),
  }));
  const computed = aggregateMetrics(rows);
  const close = (left, right) => Math.abs(left - right) <= 1e-12;
  const metricsMatch = (left, right) => (
    close(left.ndcgAt10, right.ndcgAt10)
    && close(left.mrrAt10, right.mrrAt10)
    && close(left.recallAt20, right.recallAt20)
  );
  return metricsMatch(computed.overall, baseline.metrics.overall)
    && Object.entries(computed.categories).every(
      ([category, metrics]) => baseline.metrics.categories[category]
        && metricsMatch(metrics, baseline.metrics.categories[category]),
    );
}

function percentile(samples, fraction) {
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}

function measurePreparedLatency(prepared, query) {
  for (let index = 0; index < 20; index += 1) rankPrepared(query, prepared, 20);
  const samples = [];
  for (let index = 0; index < 100; index += 1) {
    const started = performance.now();
    rankPrepared(query, prepared, 20);
    samples.push(performance.now() - started);
  }
  return {
    p95Ms: percentile(samples, 0.95),
    maxMs: Math.max(...samples),
  };
}

function measureWikiLatency(prepared, query) {
  const indexStarted = performance.now();
  const inverted = new Map();
  for (const item of prepared) {
    for (const token of new Set([
      ...item.title,
      ...item.summary,
      ...item.tags,
      ...item.body,
    ])) {
      const ids = inverted.get(token) ?? [];
      ids.push(item.document.id);
      inverted.set(token, ids);
    }
  }
  const indexMs = performance.now() - indexStarted;
  const terms = tokenize(query);
  const search = () => {
    const scores = new Map();
    for (const term of terms) {
      for (const id of inverted.get(term) ?? []) scores.set(id, (scores.get(id) ?? 0) + 1);
    }
    return [...scores].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
  };
  for (let index = 0; index < 20; index += 1) search();
  const samples = [];
  for (let index = 0; index < 100; index += 1) {
    const started = performance.now();
    search();
    samples.push(performance.now() - started);
  }
  return { indexMs, queryP95Ms: percentile(samples, 0.95) };
}

function scanQuerySpecialCases(queryFixtures, productionArtifacts) {
  const queries = new Set();
  const collect = value => {
    if (Array.isArray(value)) {
      for (const item of value) collect(item);
      return;
    }
    if (typeof value !== 'object' || value === null) return;
    if (typeof value.query === 'string' && value.query.trim()) queries.add(value.query);
    for (const nested of Object.values(value)) collect(nested);
  };
  for (const fixture of queryFixtures) collect(fixture);

  let hits = 0;
  const branchPatterns = [
    /\b(?:isPiQuery|piBoost|boostPi)\b/g,
    /\bif\s*\([^\r\n]*(?:\bpi\b|['"`]pi['"`])[^\r\n]*\)/gi,
  ];
  for (const artifact of productionArtifacts) {
    const source = artifact.buffer.toString('utf8');
    const literals = [...source.matchAll(/(['"`])((?:\\[\s\S]|(?!\1)[\s\S])*?)\1/g)]
      .map(match => match[2].replace(/\\(['"`\\])/g, '$1'));
    for (const query of queries) hits += literals.filter(literal => literal === query).length;
    for (const pattern of branchPatterns) {
      pattern.lastIndex = 0;
      hits += [...source.matchAll(pattern)].length;
    }
  }
  return hits;
}

function resultIds(body) {
  if (!body || !Array.isArray(body.results)) {
    fail('INVALID_SEARCH_ENVELOPE', 'search --json response must contain a results array');
  }
  return body.results.map(result => result.id).filter(id => typeof id === 'string');
}

function validateHistoryEnvelope(body, legacyId, canonicalId) {
  if (body?.schema_version !== 'knowhow-history-result/1.0'
      || body.operation !== 'history'
      || !Array.isArray(body.entries)
      || body.entries.length !== 2
      || body.entries[0]?.id !== legacyId
      || body.entries[0]?.deprecated !== true
      || body.entries[1]?.id !== canonicalId
      || body.entries[1]?.current !== true) {
    fail('INVALID_HISTORY_ENVELOPE', 'built knowhow history does not expose the sealed two-node chain', body);
  }
}

export function assertMachineVerdict(verdict) {
  const checks = [
    ['qrelsSha256Match', verdict.qrelsSha256Match === true],
    ['legacyRankGoldenMatch', verdict.legacyRankGoldenMatch === true],
    ['exactMrrAt10', verdict.exactMrrAt10 >= LIMITS.exactMrrAt10],
    ['overallNdcgGain', verdict.overallNdcgGain >= LIMITS.overallNdcgGain],
    ['maxCategoryNdcgDrop', verdict.maxCategoryNdcgDrop <= LIMITS.maxCategoryNdcgDrop],
    ['knowledgeRecallAt20', verdict.knowledgeRecallAt20 >= LIMITS.knowledgeRecallAt20],
    ['piPrimaryTop5Pass', verdict.piPrimaryTop5Pass === true],
    ['piHoldoutTop5Pass', verdict.piHoldoutTop5Pass === true],
    ['deprecatedLeakCount', verdict.deprecatedLeakCount === 0],
    ['unauthorizedWorkspaceHitCount', verdict.unauthorizedWorkspaceHitCount === 0],
    ['provenanceLossCount', verdict.provenanceLossCount === 0],
    ['stableTop20', verdict.stableTop20 === true],
    ['kgWarmP95Ms', verdict.kgWarmP95Ms <= LIMITS.kgWarmP95Ms],
    ['kgWarmMaxMs', verdict.kgWarmMaxMs < LIMITS.kgWarmMaxMs],
    ['wikiQueryP95Ms', verdict.wikiQueryP95Ms < LIMITS.wikiQueryP95Ms],
    ['wikiIndexP95Ms', verdict.wikiIndexP95Ms < LIMITS.wikiIndexP95Ms],
    ['querySpecialCaseHits', verdict.querySpecialCaseHits === 0],
  ];
  const failed = checks.filter(([, pass]) => !pass).map(([metric]) => metric);
  if (failed.length > 0) {
    fail('HARD_THRESHOLD_FAILED', `search ranking hard threshold failed: ${failed.join(', ')}`, {
      failed,
      verdict,
      limits: LIMITS,
    });
  }
  return verdict;
}

export function runBuiltPhase({ spawn = spawnSync, adapterPath = builtSearchAdapterPath } = {}) {
  const binArtifact = readArtifact('bin/maestro.js');
  const cliArtifact = readArtifact('dist/src/cli.js');
  if (!binArtifact.buffer.includes(Buffer.from("../dist/src/cli.js"))
      || cliArtifact.buffer.length === 0) {
    fail('INVALID_BUILT_BIN', 'bin/maestro.js must load the built dist/src/cli.js artifact');
  }

  const qrelsArtifact = readArtifact('src/search/evaluation/fixtures/search-ranking-qrels.json');
  const baselineArtifact = readArtifact('src/search/evaluation/fixtures/search-ranking-baseline.json');
  const corpusArtifact = readArtifact('src/search/evaluation/fixtures/search-ranking-corpus.json');
  const holdoutsArtifact = readArtifact('src/search/evaluation/fixtures/search-ranking-holdouts.json');
  const piArtifact = readArtifact('src/search/evaluation/fixtures/pi-knowledge-absolute.json');
  const qrels = parseArtifactJson(qrelsArtifact);
  const baseline = parseArtifactJson(baselineArtifact);
  const corpus = parseArtifactJson(corpusArtifact);
  const holdouts = parseArtifactJson(holdoutsArtifact);
  const pi = parseArtifactJson(piArtifact);
  const productionArtifacts = PRODUCTION_ARTIFACTS.map(path => readArtifact(path));
  const protectedRepoArtifacts = [
    readArtifact('.workflow/knowhow/RCP-20260716-pi-maestro-flow-cli.md'),
    readArtifact('.workflow/knowhow/RCP-20260723-pi-skills-canonical-generation.md'),
  ];
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'maestro-search-ranking-built-'));
  try {
    seedBuiltWorkspace(workspaceRoot);
    const adapter = runBuiltAdapterChild({
      spawn,
      workspaceRoot,
      adapterPath,
    });
    const history = runBinChild(
      'built-bin:knowhow-history',
      ['knowhow', 'history', pi.legacyId, '--json'],
      { spawn, cwd: workspaceRoot, projectRoot: workspaceRoot },
    );
    validateHistoryEnvelope(history.body, pi.legacyId, pi.canonicalId);

    const readOnlyArgs = ['--read-only-probe'];
    const piPrimary = pi.queries.map(query => ({
      query,
      child: runBinChild(
        `built-bin:pi-primary:${query.id}`,
        [
          'search', query.query, '--wiki-only', '--no-emb',
          '--limit', '20', '--json', ...readOnlyArgs,
        ],
        { spawn, cwd: workspaceRoot, projectRoot: workspaceRoot },
      ),
    }));
    const piHoldouts = holdouts.queries
      .filter(query => query.category === 'pi')
      .map(query => ({
        query,
        child: runBinChild(
          `built-bin:pi-holdout:${query.id}`,
          [
            'search', query.query, '--wiki-only', '--no-emb',
            '--limit', '20', '--json', ...readOnlyArgs,
          ],
          { spawn, cwd: workspaceRoot, projectRoot: workspaceRoot },
        ),
      }));
    const piRows = [...piPrimary, ...piHoldouts];
    let deprecatedLeakCount = 0;
    for (const row of piRows) {
      const ids = resultIds(row.child.body);
      deprecatedLeakCount += ids.filter(id => id === pi.legacyId).length;
      for (const result of row.child.body.results) {
        if (result.source !== 'wiki') {
          fail('INVALID_SEARCH_PROVENANCE', 'Pi built-bin smoke must attribute every result to wiki', {
            query: row.query.id,
            result,
          });
        }
      }
    }

    const afterProtected = protectedRepoArtifacts.map(
      artifact => readArtifact(artifact.relativePath),
    );
    if (afterProtected.some((artifact, index) => (
      artifact.sha256 !== protectedRepoArtifacts[index].sha256
      || !artifact.buffer.equals(protectedRepoArtifacts[index].buffer)
    ))) {
      fail('REAL_WORKFLOW_MUTATED', 'built probes changed protected real repository workflow files');
    }

    const built = adapter.body;
    const verdict = {
      qrelsSha256Match: qrelsArtifact.sha256 === baseline.qrelsSha256
        && built.qrelsSha256Match === true
        && built.qrelsSha256 === qrelsArtifact.sha256,
      legacyRankGoldenMatch: baselineGoldenMatches(qrels, baseline),
      exactMrrAt10: built.metrics.categories['exact-symbol'].mrrAt10,
      overallNdcgGain: built.overallNdcgGain,
      maxCategoryNdcgDrop: built.maxCategoryNdcgDrop,
      knowledgeRecallAt20: built.metrics.categories.knowledge.recallAt20,
      piPrimaryTop5Pass: piPrimary.every(row => row.query.targetIds.every(
        id => resultIds(row.child.body).slice(0, 5).includes(id),
      )),
      piHoldoutTop5Pass: piHoldouts.every(row => row.query.targetIds.every(
        id => resultIds(row.child.body).slice(0, 5).includes(id),
      )),
      deprecatedLeakCount: deprecatedLeakCount + built.integrity.deprecatedLeakCount,
      unauthorizedWorkspaceHitCount: built.integrity.unauthorizedWorkspaceHitCount,
      provenanceLossCount: built.integrity.provenanceLossCount,
      stableTop20: built.stability.stableTop20,
      kgWarmP95Ms: built.latency.kgWarmP95Ms,
      kgWarmMaxMs: built.latency.kgWarmMaxMs,
      wikiQueryP95Ms: built.latency.wikiQueryP95Ms,
      wikiIndexP95Ms: built.latency.wikiIndexP95Ms,
      querySpecialCaseHits: scanQuerySpecialCases(
        [qrels, holdouts, pi],
        productionArtifacts,
      ),
    };
    assertMachineVerdict(verdict);
    return {
      phase: 'built-bin',
      verdict,
      adapter: built,
      artifactHashes: Object.fromEntries([
        binArtifact,
        cliArtifact,
        qrelsArtifact,
        baselineArtifact,
        corpusArtifact,
        holdoutsArtifact,
        piArtifact,
        ...productionArtifacts,
      ].map(artifact => [artifact.relativePath, artifact.sha256])),
      trace: [
        adapter.trace,
        history.trace,
        ...piPrimary.map(row => row.child.trace),
        ...piHoldouts.map(row => row.child.trace),
      ],
    };
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
}

export function validatePackageWiring(packageJson) {
  const expectedScripts = {
    'check:search-ranking-release-machine':
      'node scripts/check-search-ranking-release-machine.mjs',
    'check:search-ranking-release-machine:source':
      'node scripts/check-search-ranking-release-machine.mjs --source-only',
    'check:search-ranking-release-machine:built':
      'node scripts/check-search-ranking-release-machine.mjs --built',
  };
  for (const [name, expected] of Object.entries(expectedScripts)) {
    if (packageJson?.scripts?.[name] !== expected) {
      fail('PACKAGE_SCRIPT_MISMATCH', `${name} must be wired to the exact release-machine command`, {
        expected,
        actual: packageJson?.scripts?.[name] ?? null,
      });
    }
  }

  const steps = String(packageJson?.scripts?.prepublishOnly ?? '')
    .split('&&')
    .map(step => step.trim())
    .filter(Boolean);
  const source = 'npm run check:search-ranking-release-machine:source';
  const build = 'npm run build';
  const built = 'npm run check:search-ranking-release-machine:built';
  const standalone = 'npm run check:search-ranking-release-machine';
  const count = step => steps.filter(item => item === step).length;
  const indexes = [steps.indexOf(source), steps.indexOf(build), steps.indexOf(built)];
  if (count(source) !== 1
      || count(build) !== 1
      || count(built) !== 1
      || count(standalone) !== 0
      || indexes.some(index => index < 0)
      || !(indexes[0] < indexes[1] && indexes[1] < indexes[2])) {
    fail('PREPUBLISH_ORDER_MISMATCH', 'prepublish search segment must be source -> unique build -> built', {
      steps,
      counts: {
        source: count(source),
        build: count(build),
        built: count(built),
        standalone: count(standalone),
      },
      indexes,
    });
  }
  return { steps, indexes, counts: { source: 1, build: 1, built: 1 } };
}

export function parseArguments(argv) {
  let mode = 'standalone';
  let npmCliOverride;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--source-only') {
      if (mode !== 'standalone') fail('INVALID_ARGUMENTS', 'release-machine modes are mutually exclusive');
      mode = 'source';
    } else if (arg === '--built') {
      if (mode !== 'standalone') fail('INVALID_ARGUMENTS', 'release-machine modes are mutually exclusive');
      mode = 'built';
    } else if (arg === '--npm-cli') {
      npmCliOverride = argv[index + 1];
      index += 1;
      if (!npmCliOverride) fail('INVALID_ARGUMENTS', '--npm-cli requires an absolute existing path');
    } else {
      fail('INVALID_ARGUMENTS', `unknown argument: ${arg}`);
    }
  }
  if (mode !== 'standalone' && npmCliOverride !== undefined) {
    fail('INVALID_ARGUMENTS', '--npm-cli is allowed only for direct standalone execution');
  }
  return { mode, npmCliOverride };
}

export function assertPhaseSequence(actual, expected) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail('PHASE_ORDER_MISMATCH', 'release-machine phase sequence is missing, duplicated, or out of order', {
      expected,
      actual,
    });
  }
  return actual;
}

export function runPhases(mode, handlers) {
  const expected = MODE_PHASES[mode];
  if (!expected) fail('INVALID_MODE', `unknown release-machine mode: ${mode}`);
  const results = [];
  for (const phase of expected) {
    const handler = handlers[phase];
    if (typeof handler !== 'function') fail('MISSING_PHASE', `missing phase handler: ${phase}`);
    const result = handler();
    results.push({ phase, result });
  }
  const actual = results.map(result => result.phase);
  assertPhaseSequence(actual, expected);
  return results;
}

export function runReleaseMachine({
  mode = 'standalone',
  npmCliOverride,
  spawn = spawnSync,
} = {}) {
  const packageArtifact = readArtifact('package.json');
  const packageWiring = validatePackageWiring(parseArtifactJson(packageArtifact));
  const phases = runPhases(mode, {
    'source-tests': () => runSourcePhase({ npmCliOverride, spawn }),
    build: () => runBuildPhase({ npmCliOverride, spawn }),
    'built-bin': () => runBuiltPhase({ spawn }),
  });
  const counts = {
    source: phases.filter(item => item.phase === 'source-tests').length,
    build: phases.filter(item => item.phase === 'build').length,
    built: phases.filter(item => item.phase === 'built-bin').length,
  };
  const expectedCounts = mode === 'standalone'
    ? { source: 1, build: 1, built: 1 }
    : mode === 'source'
      ? { source: 1, build: 0, built: 0 }
      : { source: 0, build: 0, built: 1 };
  if (JSON.stringify(counts) !== JSON.stringify(expectedCounts)) {
    fail('PHASE_COUNT_MISMATCH', 'release-machine phase counts differ from mode contract', {
      mode,
      expected: expectedCounts,
      actual: counts,
    });
  }
  return {
    schema_version: 'search-ranking-release-machine/1.0',
    ok: true,
    mode,
    counts,
    phases: phases.map(item => item.result),
    packageWiring,
  };
}

function main() {
  try {
    const options = parseArguments(process.argv.slice(2));
    const result = runReleaseMachine(options);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const failure = error instanceof ReleaseMachineError
      ? error.toJSON()
      : {
          schema_version: 'search-ranking-release-failure/1.0',
          ok: false,
          code: 'UNEXPECTED_RELEASE_MACHINE_ERROR',
          message: error instanceof Error ? error.message : String(error),
        };
    process.stderr.write(`${JSON.stringify(failure)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
