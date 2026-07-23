import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';

import {
  assertPhaseSequence,
  assertMachineVerdict,
  builtSearchAdapterPath,
  dashboardRoot,
  DASHBOARD_TEST_PATHS,
  parseArguments,
  parseArtifactJson,
  parseVitestReport,
  readArtifact,
  repoRoot,
  resolveNpmInvocation,
  ROOT_TEST_PATHS,
  runNpmChild,
  runBuiltAdapterChild,
  runPhases,
  runSourcePhase,
  validatePackageWiring,
} from '../check-search-ranking-release-machine.mjs';

const temporaryRoots = [];
const originalNpmExecPath = process.env.npm_execpath;

function temporaryRoot(label) {
  const root = mkdtempSync(join(tmpdir(), `search-release-${label}-`));
  temporaryRoots.push(root);
  return root;
}

function write(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value);
}

function report(files, tests = files.length, failures = 0) {
  return {
    success: failures === 0,
    numTotalTests: tests,
    numFailedTests: failures,
    testResults: files.map(name => ({
      name,
      assertionResults: [{ status: failures > 0 ? 'failed' : 'passed' }],
    })),
  };
}

test.afterEach(() => {
  if (originalNpmExecPath === undefined) delete process.env.npm_execpath;
  else process.env.npm_execpath = originalNpmExecPath;
  while (temporaryRoots.length > 0) {
    rmSync(temporaryRoots.pop(), { recursive: true, force: true });
  }
});

test('resolveNpmInvocation uses process.execPath and preserves an absolute npm CLI path with spaces', () => {
  const root = temporaryRoot('npm path with spaces');
  const npmCli = join(root, 'npm cli.js');
  write(npmCli, '// fixture\n');
  process.env.npm_execpath = npmCli;

  assert.deepEqual(resolveNpmInvocation(['test', '--', 'fixture.test.ts']), {
    command: process.execPath,
    args: [npmCli, 'test', '--', 'fixture.test.ts'],
  });
});

test('resolveNpmInvocation fails closed and permits only an explicit valid fallback', () => {
  const root = temporaryRoot('npm-fallback');
  const npmCli = join(root, 'npm-cli.js');
  write(npmCli, '// fixture\n');

  for (const invalid of [undefined, 'relative/npm-cli.js', join(root, 'missing.js')]) {
    if (invalid === undefined) delete process.env.npm_execpath;
    else process.env.npm_execpath = invalid;
    assert.throws(
      () => resolveNpmInvocation(['test']),
      error => error.code === 'NPM_CLI_UNAVAILABLE',
    );
    assert.deepEqual(resolveNpmInvocation(['test'], { npmCliOverride: npmCli }), {
      command: process.execPath,
      args: [npmCli, 'test'],
    });
  }

  assert.deepEqual(parseArguments(['--npm-cli', npmCli]), {
    mode: 'standalone',
    npmCliOverride: npmCli,
  });
  assert.throws(
    () => parseArguments(['--source-only', '--npm-cli', npmCli]),
    error => error.code === 'INVALID_ARGUMENTS',
  );
  assert.throws(
    () => parseArguments(['--built', '--npm-cli', npmCli]),
    error => error.code === 'INVALID_ARGUMENTS',
  );
});

test('source phase owns exact root/dashboard suites with shell false and explicit cwd', () => {
  const tempRoot = temporaryRoot('source');
  const npmCli = join(tempRoot, 'npm cli.js');
  write(npmCli, '// fixture\n');
  process.env.npm_execpath = npmCli;
  const calls = [];

  const spawn = (command, args, options) => {
    calls.push({ command, args, options });
    const outputIndex = args.indexOf('--outputFile');
    assert.notEqual(outputIndex, -1);
    const reportPath = args[outputIndex + 1];
    const files = args.slice(outputIndex + 2).map(path => resolve(options.cwd, path));
    write(reportPath, JSON.stringify(report(files, files.length + 3)));
    return { status: 0, signal: null, stdout: 'ok', stderr: '' };
  };

  const result = runSourcePhase({ spawn, tempRoot });

  assert.equal(result.runners[0].cwd, repoRoot);
  assert.equal(result.runners[0].collectedFiles, ROOT_TEST_PATHS.length);
  assert.equal(result.runners[1].cwd, dashboardRoot);
  assert.equal(result.runners[1].collectedFiles, 2);
  assert.deepEqual(result.runners[1].files, [...DASHBOARD_TEST_PATHS].sort());
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.command, process.execPath);
    assert.equal(call.args[0], npmCli);
    assert.equal(call.options.shell, false);
    assert.equal(call.options.encoding, 'utf8');
  }
  assert.equal(calls[0].options.cwd, repoRoot);
  assert.equal(calls[1].options.cwd, dashboardRoot);
  assert.deepEqual(
    calls[1].args.slice(calls[1].args.indexOf('--outputFile') + 2),
    DASHBOARD_TEST_PATHS,
  );
  assert.equal(calls[1].args.some(arg => arg.startsWith('dashboard/')), false);
});

test('Vitest reports reject zero collection, failed tests, wrong cwd ownership and dashboard prefixes', () => {
  const root = temporaryRoot('reports');
  const path = join(root, 'report.json');
  write(path, JSON.stringify(report([], 0)));
  assert.throws(
    () => parseVitestReport(path, {
      label: 'zero',
      cwd: dashboardRoot,
      expectedFiles: DASHBOARD_TEST_PATHS,
      exactCollectedFiles: 2,
    }),
    error => error.code === 'ZERO_TEST_COLLECTION',
  );

  write(path, JSON.stringify(report(
    DASHBOARD_TEST_PATHS.map(file => resolve(repoRoot, 'dashboard', 'dashboard', file)),
    2,
  )));
  assert.throws(
    () => parseVitestReport(path, {
      label: 'wrong cwd',
      cwd: dashboardRoot,
      expectedFiles: DASHBOARD_TEST_PATHS,
      exactCollectedFiles: 2,
    }),
    error => error.code === 'TEST_OWNERSHIP_MISMATCH',
  );

  write(path, JSON.stringify(report(
    DASHBOARD_TEST_PATHS.map(file => resolve(dashboardRoot, file)),
    2,
    1,
  )));
  assert.throws(
    () => parseVitestReport(path, {
      label: 'failure',
      cwd: dashboardRoot,
      expectedFiles: DASHBOARD_TEST_PATHS,
      exactCollectedFiles: 2,
    }),
    error => error.code === 'SOURCE_TEST_FAILURE',
  );
});

test('npm child failures preserve error/status/signal/stdout/stderr attribution', () => {
  const root = temporaryRoot('child-failure');
  const npmCli = join(root, 'npm-cli.js');
  write(npmCli, '// fixture\n');
  process.env.npm_execpath = npmCli;

  for (const result of [
    {
      status: 7,
      signal: null,
      stdout: 'partial stdout',
      stderr: 'child stderr',
    },
    {
      status: null,
      signal: 'SIGTERM',
      stdout: 'signal stdout',
      stderr: 'signal stderr',
      error: Object.assign(new Error('spawn failed'), { code: 'ENOENT' }),
    },
  ]) {
    assert.throws(
      () => runNpmChild('fixture-child', ['test'], repoRoot, { spawn: () => result }),
      error => {
        assert.equal(error.code, 'CHILD_PROCESS_FAILED');
        assert.equal(error.details.status, result.status);
        assert.equal(error.details.signal, result.signal);
        assert.equal(error.details.stdout, result.stdout);
        assert.equal(error.details.stderr, result.stderr);
        assert.equal(error.details.error?.code ?? null, result.error?.code ?? null);
        return true;
      },
    );
  }
});

test('phase runner enforces standalone, source-only and built-only counts and fail-fast order', () => {
  for (const [mode, expected] of [
    ['standalone', { source: 1, build: 1, built: 1 }],
    ['source', { source: 1, build: 0, built: 0 }],
    ['built', { source: 0, build: 0, built: 1 }],
  ]) {
    const counts = { source: 0, build: 0, built: 0 };
    const results = runPhases(mode, {
      'source-tests': () => {
        counts.source += 1;
        return 'source';
      },
      build: () => {
        counts.build += 1;
        return 'build';
      },
      'built-bin': () => {
        counts.built += 1;
        return 'built';
      },
    });
    assert.deepEqual(counts, expected);
    assert.deepEqual(
      results.map(item => item.phase),
      mode === 'standalone'
        ? ['source-tests', 'build', 'built-bin']
        : mode === 'source'
          ? ['source-tests']
          : ['built-bin'],
    );
  }

  let builtCalls = 0;
  assert.throws(() => runPhases('standalone', {
    'source-tests': () => 'source',
    build: () => {
      throw new Error('injected build failure');
    },
    'built-bin': () => {
      builtCalls += 1;
    },
  }), /injected build failure/);
  assert.equal(builtCalls, 0);

  for (const faulty of [
    ['source-tests', 'built-bin'],
    ['source-tests', 'build', 'build', 'built-bin'],
    ['build', 'source-tests', 'built-bin'],
  ]) {
    assert.throws(
      () => assertPhaseSequence(
        faulty,
        ['source-tests', 'build', 'built-bin'],
      ),
      error => error.code === 'PHASE_ORDER_MISMATCH',
    );
  }
});

test('package wiring requires exact commands and source -> unique build -> built prepublish order', () => {
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
  const result = validatePackageWiring(pkg);
  assert.deepEqual(result.counts, { source: 1, build: 1, built: 1 });

  const standalone = structuredClone(pkg);
  standalone.scripts.prepublishOnly = standalone.scripts.prepublishOnly.replace(
    'npm run check:search-ranking-release-machine:source',
    'npm run check:search-ranking-release-machine',
  );
  assert.throws(
    () => validatePackageWiring(standalone),
    error => error.code === 'PREPUBLISH_ORDER_MISMATCH',
  );

  const duplicateBuild = structuredClone(pkg);
  duplicateBuild.scripts.prepublishOnly = duplicateBuild.scripts.prepublishOnly.replace(
    'npm run check:search-ranking-release-machine:built',
    'npm run build && npm run check:search-ranking-release-machine:built',
  );
  assert.throws(
    () => validatePackageWiring(duplicateBuild),
    error => error.code === 'PREPUBLISH_ORDER_MISMATCH',
  );
});

const greenVerdict = Object.freeze({
  qrelsSha256Match: true,
  legacyRankGoldenMatch: true,
  exactMrrAt10: 0.95,
  overallNdcgGain: 0.10,
  maxCategoryNdcgDrop: 0.02,
  knowledgeRecallAt20: 0.90,
  piPrimaryTop5Pass: true,
  piHoldoutTop5Pass: true,
  deprecatedLeakCount: 0,
  unauthorizedWorkspaceHitCount: 0,
  provenanceLossCount: 0,
  stableTop20: true,
  kgWarmP95Ms: 34.8,
  kgWarmMaxMs: 49.999,
  wikiQueryP95Ms: 49.999,
  wikiIndexP95Ms: 499.999,
  querySpecialCaseHits: 0,
});

test('machine verdict enforces every independent ranking/lifecycle hard threshold', () => {
  assert.equal(assertMachineVerdict({ ...greenVerdict }).exactMrrAt10, 0.95);
  const faults = {
    qrelsSha256Match: false,
    legacyRankGoldenMatch: false,
    exactMrrAt10: 0.949,
    overallNdcgGain: 0.099,
    maxCategoryNdcgDrop: 0.021,
    knowledgeRecallAt20: 0.899,
    piPrimaryTop5Pass: false,
    piHoldoutTop5Pass: false,
    deprecatedLeakCount: 1,
    unauthorizedWorkspaceHitCount: 1,
    provenanceLossCount: 1,
    stableTop20: false,
    kgWarmP95Ms: 34.801,
    kgWarmMaxMs: 50,
    wikiQueryP95Ms: 50,
    wikiIndexP95Ms: 500,
    querySpecialCaseHits: 1,
  };
  for (const [metric, value] of Object.entries(faults)) {
    assert.throws(
      () => assertMachineVerdict({ ...greenVerdict, [metric]: value }),
      error => error.code === 'HARD_THRESHOLD_FAILED'
        && error.details.failed.includes(metric),
      metric,
    );
  }
});

test('metric fault injection exits non-zero in a real child process', () => {
  const modulePath = join(repoRoot, 'scripts', 'check-search-ranking-release-machine.mjs');
  const script = [
    `import { assertMachineVerdict } from ${JSON.stringify(`file:///${modulePath.replaceAll('\\', '/')}`)};`,
    `const verdict = ${JSON.stringify({ ...greenVerdict, querySpecialCaseHits: 1 })};`,
    'assertMachineVerdict(verdict);',
  ].join('\n');
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
    shell: false,
    cwd: repoRoot,
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /querySpecialCaseHits/);
});

test('artifact reader hashes and parses the same contained Buffer', () => {
  const artifact = readArtifact('package.json');
  const parsed = parseArtifactJson(artifact);
  assert.equal(parsed.name, 'maestro-flow');
  assert.equal(artifact.buffer.equals(readFileSync(join(repoRoot, 'package.json'))), true);
  assert.match(artifact.sha256, /^[a-f0-9]{64}$/);
});

test('release machine source never spawns npm or npm.cmd directly', () => {
  const source = readFileSync(
    join(repoRoot, 'scripts', 'check-search-ranking-release-machine.mjs'),
    'utf8',
  );
  const tests = readFileSync(
    join(repoRoot, 'scripts', '__tests__', 'check-search-ranking-release-machine.test.mjs'),
    'utf8',
  );
  for (const text of [source, tests]) {
    assert.doesNotMatch(text, /spawnSync\(\s*['"]npm(?:\.cmd)?['"]/);
  }
  assert.match(source, /command:\s*process\.execPath/);
  assert.match(source, /shell:\s*false/);
});

test('runs every built probe in a hermetic workspace', () => {
  const root = temporaryRoot('built-probe');
  const adapterPath = join(root, 'compiled adapter.js');
  write(adapterPath, '// compiled fixture\n');
  const calls = [];
  const providers = Object.fromEntries(
    ['wiki', 'kg', 'code', 'mixed', 'linked'].map(name => [name, [{
      queryId: `${name}-query`,
      function: `${name}.production`,
      resultIds: [`${name}-result`],
      runs: [[`${name}-result`]],
    }]]),
  );
  const spawn = (command, args, options) => {
    calls.push({ command, args, options });
    return {
      status: 0,
      signal: null,
      stderr: '',
      stdout: JSON.stringify({
        schema_version: 'built-search-adapter/1.0',
        ok: true,
        providers,
        workspace: {
          root,
          cwd: root,
          maestroProjectRoot: root,
          persistence: 'memory-only',
          executionMode: 'read-only-probe',
        },
        protectedState: { unchanged: true },
      }),
    };
  };

  const result = runBuiltAdapterChild({ spawn, workspaceRoot: root, adapterPath });

  assert.equal(result.trace.command, process.execPath);
  assert.equal(result.trace.cwd, root);
  assert.equal(result.trace.shell, false);
  assert.equal(result.trace.maestroProjectRoot, root);
  assert.equal(calls[0].command, process.execPath);
  assert.equal(calls[0].args[0], adapterPath);
  assert.equal(calls[0].options.cwd, root);
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.env.MAESTRO_PROJECT_ROOT, root);
  assert.notEqual(root, repoRoot);
});

test('derives built fields only from compiled production adapter ownership', () => {
  assert.equal(resolve(builtSearchAdapterPath), builtSearchAdapterPath);
  const source = readFileSync(
    join(repoRoot, 'scripts', 'check-search-ranking-release-machine.mjs'),
    'utf8',
  );
  const builtPhase = source.slice(
    source.indexOf('export function runBuiltPhase'),
    source.indexOf('export function validatePackageWiring'),
  );
  assert.match(builtPhase, /adapter\.body/);
  assert.doesNotMatch(
    builtPhase,
    /rankPrepared|measurePreparedLatency|measureWikiLatency/,
  );
});

test('propagates a compiled production adapter fault as non-zero', () => {
  const root = temporaryRoot('built-fault');
  const adapterPath = join(root, 'compiled adapter.js');
  write(adapterPath, '// compiled fixture\n');

  assert.throws(
    () => runBuiltAdapterChild({
      workspaceRoot: root,
      adapterPath,
      spawn: () => ({
        status: 9,
        signal: null,
        stdout: '',
        stderr: '{"code":"BUILT_RANKING_GATE"}',
      }),
    }),
    error => error.code === 'CHILD_PROCESS_FAILED'
      && error.details.status === 9
      && error.details.stderr.includes('BUILT_RANKING_GATE'),
  );
});
