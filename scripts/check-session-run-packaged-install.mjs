// ---------------------------------------------------------------------------
// `npm run check:session-run-packaged-install` — packaged-install smoke gate.
//
// Packs the current source into a tarball, installs it into an isolated prefix
// with an isolated HOME, and drives the canonical v3 smoke chain against the
// installed CLI: capabilities six-key contract -> session open -> chain insert
// -> run next (birth packet) -> run brief (Resume Packet) -> run check ->
// run complete --advance -> session complete. This proves the published
// artifact, not just the source tree (audit §14.3.4).
//
// Requires `npm run build` to have produced a current dist/.
// ---------------------------------------------------------------------------

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const repoRoot = resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const binPath = join(repoRoot, 'bin', 'maestro.js');

function run(args, options = {}) {
  const result = spawnSync(process.execPath, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });
  return result;
}

function invoke(args, options = {}) {
  const result = run([binPath, ...args], options);
  return result;
}

function assert(condition, message) {
  if (!condition) throw new Error(`packaged-install smoke failed: ${message}`);
}

function machineEnvelope(result, label) {
  assert(result.status === 0, `${label}: exit ${result.status}\n${result.stderr}`);
  const lines = result.stdout.trim().split(/\r?\n/).filter(Boolean);
  assert(lines.length === 1, `${label}: expected one JSON line, got ${lines.length}`);
  return JSON.parse(lines[0]);
}

function main() {
  const work = mkdtempSync(join(tmpdir(), 'maestro-packaged-install-'));
  try {
    // 1. Pack the current source.
    const pack = spawnSync('npm', ['pack', '--json', '--pack-destination', work], {
      cwd: repoRoot,
      encoding: 'utf8',
      shell: true,
    });
    assert(pack.status === 0, `npm pack failed:\n${pack.stderr}`);
    const packInfo = JSON.parse(pack.stdout.trim());
    const tarball = join(work, packInfo[0].filename);
    assert(existsSync(tarball), `packed tarball missing: ${tarball}`);

    // 2. Install into an isolated prefix with an isolated HOME.
    const prefix = join(work, 'install');
    const isolatedHome = join(work, 'home');
    mkdirSync(isolatedHome, { recursive: true });
    const install = spawnSync('npm', ['install', '--prefix', prefix, '--no-audit', '--no-fund', tarball], {
      cwd: repoRoot,
      encoding: 'utf8',
      shell: true,
      env: {
        ...process.env,
        HOME: isolatedHome,
        USERPROFILE: isolatedHome,
        APPDATA: join(isolatedHome, 'AppData', 'Roaming'),
        npm_config_cache: join(isolatedHome, '.npm'),
      },
    });
    assert(install.status === 0, `npm install failed:\n${install.stderr}`);

    const installedBin = join(prefix, 'node_modules', 'maestro-flow', 'bin', 'maestro.js');
    assert(existsSync(installedBin), `installed CLI missing: ${installedBin}`);

    const env = {
      ...process.env,
      HOME: isolatedHome,
      USERPROFILE: isolatedHome,
      APPDATA: join(isolatedHome, 'AppData', 'Roaming'),
    };
    const installedInvoke = (args) => run([installedBin, ...args], { env });

    // 3. v3 smoke chain in an isolated workspace under the isolated HOME.
    const workspace = join(isolatedHome, 'workspace');
    mkdirSync(join(workspace, '.claude', 'commands'), { recursive: true });
    writeFileSync(join(workspace, '.claude', 'commands', 'implement.md'), [
      '---',
      'session-mode: run',
      'contract:',
      '  consumes: []',
      '  produces:',
      '    - kind: artifact',
      '      path: outputs/result.json',
      '      alias: latest-result',
      '      role: primary',
      '      required: true',
      '      schema: artifacts/1.0',
      '  gates: { entry: [], exit: [] }',
      '---',
      '# Implement\n',
    ].join('\n'), 'utf8');

    const capabilities = machineEnvelope(installedInvoke(['capabilities', '--json', '--workflow-root', workspace]), 'capabilities');
    assert(JSON.stringify(capabilities.session_schema_writes) === JSON.stringify(['session/3.0']),
      `default writer is not session/3.0: ${JSON.stringify(capabilities.session_schema_writes)}`);
    assert(capabilities.features.session_run_minimal_v3 === true, 'session_run_minimal_v3 not advertised');
    assert(capabilities.features.entity_revision_cas === true, 'entity_revision_cas not advertised');
    assert(capabilities.features.participant_identity === true, 'participant_identity not advertised');
    assert(capabilities.features.request_receipts_v2 === true, 'request_receipts_v2 not advertised');
    assert(capabilities.features.execution_lease === false, 'execution_lease not retired');
    assert(capabilities.features.operation_registry === false, 'operation_registry not retired');
    assert(JSON.stringify(capabilities.execution_schema_writes) === JSON.stringify([]), 'execution writes not empty');
    assert(capabilities.run_response_writes.includes('run-response/1.2'), 'run-response/1.2 not writable');

    const open = machineEnvelope(installedInvoke([
      'session', 'open', 'packaged install smoke', '--id', 'packaged-smoke',
      '--participant', 'pi-packaged', '--actor', 'pi-packaged',
      '--request-id', 'req-packaged-open', '--reason', 'packaged smoke',
      '--json', '--workflow-root', workspace,
    ]), 'session open');
    assert(open.ok === true && open.operation === 'session-open', 'session open failed');

    const insert = machineEnvelope(installedInvoke([
      'session', 'chain', 'insert', '--step-id', 'step-1', '--command', 'implement',
      '--participant', 'pi-packaged', '--actor', 'pi-packaged',
      '--request-id', 'req-packaged-insert', '--reason', 'packaged smoke',
      '--expected-orchestration-revision', '1', '--json', '--workflow-root', workspace,
    ]), 'chain insert');
    assert(insert.ok === true && insert.operation === 'session-chain-insert', 'chain insert failed');

    const next = machineEnvelope(installedInvoke([
      'run', 'next', '--session', 'packaged-smoke',
      '--participant', 'pi-packaged', '--actor', 'pi-packaged',
      '--request-id', 'req-packaged-next', '--reason', 'packaged smoke',
      '--expected-orchestration-revision', '2', '--json', '--workflow-root', workspace,
    ]), 'run next');
    assert(next.ok === true && next.operation === 'next', 'run next failed');
    const birth = next.result ?? {};
    for (const field of ['run_id', 'run_dir', 'step_id', 'status', 'revision', 'upstream', 'guidance', 'knowledge_context', 'brief', 'run_already_created']) {
      assert(field in birth, `birth packet missing ${field}`);
    }
    assert(birth.run_already_created === true, 'run_already_created not true');

    const runId = birth.run_id;
    const brief = machineEnvelope(installedInvoke([
      'run', 'brief', runId, '--session', 'packaged-smoke', '--json', '--workflow-root', workspace,
    ]), 'run brief');
    assert(brief.ok === true && brief.operation === 'brief', 'run brief failed');
    assert(brief.result?.schema_version === 'brief-result/3.0', `unexpected brief schema ${brief.result?.schema_version}`);
    assert(brief.result?.session?.orchestration_revision === 3, `unexpected orchestration revision ${brief.result?.session?.orchestration_revision}`);
    assert(typeof brief.result?.knowledge_context?.path === 'string', 'Resume Packet knowledge_context missing');

    const check = machineEnvelope(installedInvoke([
      'run', 'check', runId, '--session', 'packaged-smoke', '--json', '--workflow-root', workspace,
    ]), 'run check');
    assert(check.ok === true, 'run check failed');

    // Produce the required artifact and complete.
    mkdirSync(join(workspace, '.workflow', 'sessions', 'packaged-smoke', 'runs', runId, 'outputs'), { recursive: true });
    writeFileSync(join(workspace, '.workflow', 'sessions', 'packaged-smoke', 'runs', runId, 'outputs', 'result.json'), JSON.stringify({ done: true }), 'utf8');
    writeFileSync(join(workspace, '.workflow', 'sessions', 'packaged-smoke', 'runs', runId, 'report.md'), [
      '---',
      'summary: "packaged install smoke completed"',
      'decisions:',
      '  - status: accepted',
      '    text: "packaged artifact passes the v3 smoke chain"',
      'constraints: []',
      '---',
    ].join('\n'), 'utf8');

    const complete = machineEnvelope(installedInvoke([
      'run', 'complete', runId, '--session', 'packaged-smoke',
      '--participant', 'pi-packaged', '--actor', 'pi-packaged',
      '--request-id', 'req-packaged-complete', '--reason', 'packaged smoke',
      '--expected-orchestration-revision', '3', '--expected-run-revision', '1',
      '--verdict', 'done', '--advance', '--json', '--workflow-root', workspace,
    ]), 'run complete');
    assert(complete.ok === true && complete.result?.status === 'sealed', `complete failed: ${JSON.stringify(complete.error)}`);
    assert(complete.result?.artifact_publication?.artifact_ids?.length === 1, 'artifact not published');

    const sessionComplete = machineEnvelope(installedInvoke([
      'session', 'complete', '--session', 'packaged-smoke',
      '--participant', 'pi-packaged', '--actor', 'pi-packaged',
      '--request-id', 'req-packaged-session-complete', '--reason', 'packaged smoke',
      '--expected-orchestration-revision', '4', '--json', '--workflow-root', workspace,
    ]), 'session complete');
    assert(sessionComplete.ok === true && sessionComplete.result?.status === 'completed', 'session complete failed');

    console.log(`packaged install smoke passed: ${packInfo[0].filename} -> v3 chain (open/insert/next/brief/check/complete/session-complete)`);
  } finally {
    rmSync(work, { recursive: true, force: true, maxRetries: 3 });
  }
}

try {
  main();
} catch (error) {
  console.error(String(error.message ?? error));
  process.exitCode = 1;
}
