import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

import { issueRecallConfirmation } from './recall-confirmation.js';
import { executeRecallAction } from './recall-actions.js';
import { completeRun, createRun, sealSession } from './runtime.js';
import { SessionStore } from './store.js';
import { sha256Digest } from './transition-receipts.js';

function v2Workspace(root: string): void {
  mkdirSync(join(root, ".workflow"), { recursive: true });
  writeFileSync(join(root, ".workflow", "config.json"), JSON.stringify({
    session_schema: { schema_version: "session-schema-selection/1.0", writer: "session/1.3", features: { session_statusless: false } },
  }));
}

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'maestro-recall-action-')); roots.push(value);

  v2Workspace(value);
  mkdirSync(join(value, '.claude', 'commands'), { recursive: true });
  writeFileSync(join(value, '.claude', 'commands', 'demo.md'), '---\nsession-mode: run\n---\n# Demo\n');
  return value;
}

function enableV20(projectRoot: string): void {
  const workflowRoot = join(projectRoot, '.workflow');
  const configPath = join(workflowRoot, 'config.json');
  mkdirSync(workflowRoot, { recursive: true });
  const existing = existsSync(configPath)
    ? JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>
    : {};
  writeFileSync(configPath, JSON.stringify({
    ...existing,
    session_schema: {
      schema_version: 'session-schema-selection/1.0',
      writer: 'session/2.0',
      features: { session_statusless: true },
    },
  }, null, 2));
}

function writeLinkedConfig(projectRoot: string, name: string, linkedRoot: string, share: string[] = ['session']): void {
  const configPath = join(projectRoot, '.workflow', 'config.json');
  mkdirSync(join(projectRoot, '.workflow'), { recursive: true });
  const existing = existsSync(configPath)
    ? JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>
    : {};
  writeFileSync(configPath, JSON.stringify({
    ...existing,
    workspaces: { linked: [{ name, path: linkedRoot, share }] },
  }, null, 2));
}

function linkedSource(bytes = Buffer.from('linked payload')) {
  const sourceRoot = root();
  const created = createRun({ projectRoot: sourceRoot, command: 'demo', sessionId: 'source', intent: 'linked source' });
  const absoluteRunDir = join(sourceRoot, created.run_dir);
  const output = join(absoluteRunDir, 'outputs', 'payload.bin');
  mkdirSync(join(absoluteRunDir, 'outputs'), { recursive: true });
  writeFileSync(output, bytes);
  expect(completeRun(sourceRoot, created.run_id, created.session_id).sealed).toBe(true);
  sealSession(sourceRoot, created.session_id, 'sealed source');
  return { sourceRoot, sessionId: created.session_id, runId: created.run_id, bytes, output };
}

function importRequest(source: ReturnType<typeof linkedSource>, target = 'target') {
  return {
    action: 'import' as const,
    target_session_id: target,
    command: 'demo',
    intent: `import ${target}`,
    source_session_id: source.sessionId,
    source_run_id: source.runId,
    source_workspace: 'linked',
    args: [] as string[],
  };
}

function childAction(
  projectRoot: string,
  input: Record<string, unknown>,
  options: Record<string, unknown> = {},
): Promise<{ status: number; body: any | null; stderr: string }> {
  return new Promise((resolveChild, reject) => {
    const encoded = Buffer.from(JSON.stringify({ input, options })).toString('base64url');
    const child = spawn(process.execPath, [resolve('src/run/__fixtures__/recall-action-child.mjs'), projectRoot, encoded], {
      cwd: resolve('.'), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    let stdout = ''; let stderr = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolveChild({
      status: code ?? 1,
      body: stdout.trim() ? JSON.parse(stdout) : null,
      stderr,
    }));
  });
}

describe('confirmed recall actions', () => {
  it('creates once and durably replays the identical completed request', () => {
    const projectRoot = root();
    const request = { action: 'new' as const, target_session_id: 'target', command: 'demo', intent: 'new target', args: [] };
    const issued = issueRecallConfirmation(projectRoot, request);
    const result = executeRecallAction(projectRoot, { ...request, confirmation_token: issued.token });
    const replay = executeRecallAction(projectRoot, { ...request, confirmation_token: issued.token });
    const store = new SessionStore(projectRoot);
    expect(result).toMatchObject({ session_id: 'target', replayed: false });
    expect(replay).toMatchObject({ session_id: 'target', run_id: result.run_id, replayed: true });
    expect(store.readSessionRecord('target').schema_version).toBe('session/1.3');
    expect(store.readRun('target', result.run_id).schema_version).toBe('command-run/1.3');
  });

  it.each(['new', 'fork', 'import'] as const)(
    'creates confirmed %s targets with generation-1 Execution authority under a session/2.0 writer',
    action => {
      const projectRoot = root();
      let source: ReturnType<typeof linkedSource> | null = null;
      if (action === 'fork') {
        const created = createRun({
          projectRoot,
          command: 'demo',
          sessionId: 'local-source',
          intent: 'local fork source',
        });
        expect(completeRun(projectRoot, created.run_id, created.session_id).sealed).toBe(true);
        sealSession(projectRoot, created.session_id, 'sealed local source');
        source = {
          sourceRoot: projectRoot,
          sessionId: created.session_id,
          runId: created.run_id,
          bytes: Buffer.alloc(0),
          output: '',
        };
      } else if (action === 'import') {
        source = linkedSource(Buffer.from('v2 import payload'));
        writeLinkedConfig(projectRoot, 'linked', source.sourceRoot);
      }
      enableV20(projectRoot);

      const request = {
        action,
        target_session_id: `v2-${action}`,
        command: 'demo',
        intent: `v2 ${action} target`,
        source_session_id: source?.sessionId,
        source_run_id: source?.runId,
        source_workspace: action === 'import' ? 'linked' : undefined,
        args: [] as string[],
      };
      const issued = issueRecallConfirmation(projectRoot, request);
      const result = executeRecallAction(projectRoot, { ...request, confirmation_token: issued.token });
      const store = new SessionStore(projectRoot);
      const identity = store.readSessionRecord(result.session_id);
      expect(identity).toMatchObject({
        schema_version: 'session/2.0',
        current_execution_id: 'execution-001',
        latest_execution_id: 'execution-001',
      });
      const run = store.readExecutionRun(result.session_id, result.run_id);
      expect(run).toMatchObject({
        schema_version: 'command-run/1.4',
        execution_id: 'execution-001',
        generation: 1,
      });
      const execution = store.readExecution(result.session_id, 'execution-001');
      expect(execution).toMatchObject({
        generation: 1,
        status: 'active',
        active_run_id: result.run_id,
        lease: { owner_id: 'maestro-recall-core', owner_kind: 'manual', epoch: 1 },
      });
      expect(store.readBundle(result.session_id).session.intent_identity).not.toBeNull();
      const createTransition = store.readExecutionTransition(
        result.session_id,
        'execution-001',
        `recall-${result.reservation_id}-run-create`,
      );
      expect(createTransition).toMatchObject({
        payload: {
          operation: 'create',
          subject: { execution_id: 'execution-001', generation: 1 },
          preconditions: { execution_revision: 1, lease_epoch: 1 },
          payload: {
            lease: {
              owner_id: 'maestro-recall-core',
              owner_kind: 'manual',
              epoch: 1,
              lease_id_hash: expect.stringMatching(/^sha256:/),
            },
          },
        },
        outcome: { postconditions: { execution_revision: 2, lease_epoch: 1 } },
      });
      const privateLeaseId = execution.lease!.lease_id;
      expect(JSON.stringify(result)).not.toContain(privateLeaseId);
      expect(JSON.stringify(store.listExecutionTransitions(result.session_id, 'execution-001'))).not.toContain(privateLeaseId);
      if (action === 'import') expect(result.import_manifest?.artifacts).toHaveLength(1);
      else expect(result.import_manifest).toBeNull();
    },
  );

  it('rejects linked source session, artifact-byte, and share-fence drift with zero target', () => {
    for (const drift of ['session', 'artifact', 'share'] as const) {
      const source = linkedSource(Buffer.from(`payload-${drift}`));
      const projectRoot = root();
      writeLinkedConfig(projectRoot, 'linked', source.sourceRoot);
      const request = importRequest(source, `target-${drift}`);
      const issued = issueRecallConfirmation(projectRoot, request);
      if (drift === 'session') {
        const path = join(source.sourceRoot, '.workflow', 'sessions', source.sessionId, 'session.json');
        const session = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
        session.activity_revision = Number(session.activity_revision) + 1;
        writeFileSync(path, JSON.stringify(session, null, 2));
      } else if (drift === 'artifact') {
        writeFileSync(source.output, 'drifted bytes');
      } else {
        writeLinkedConfig(projectRoot, 'linked', source.sourceRoot, []);
      }
      expect(() => executeRecallAction(projectRoot, { ...request, confirmation_token: issued.token })).toThrow(/source|workspace|shared|fence|artifact/i);
      expect(existsSync(new SessionStore(projectRoot).sessionDir(request.target_session_id))).toBe(false);
    }
  });

  it('imports linked bytes and records exact live validated/copied provenance hashes', () => {
    const source = linkedSource(Buffer.from([0, 1, 2, 3, 254, 255]));
    const projectRoot = root();
    writeLinkedConfig(projectRoot, 'linked', source.sourceRoot);
    const request = importRequest(source);
    const issued = issueRecallConfirmation(projectRoot, request);
    const result = executeRecallAction(projectRoot, { ...request, confirmation_token: issued.token });
    const item = result.import_manifest!.artifacts[0];
    const copied = join(new SessionStore(projectRoot).sessionDir(result.session_id), item.target_path);
    expect(readFileSync(copied)).toEqual(source.bytes);
    expect(item.source_hash).toBe(sha256Digest(source.bytes));
    const artifact = new SessionStore(projectRoot).readBundle(result.session_id).artifacts.artifacts[item.target_artifact_id];
    expect(`sha256:${artifact.content_hash}`).toBe(item.source_hash);
    expect(artifact.derived_from).toEqual([]);
  });

  it('revalidates the linked source immediately before finalize and leaves complete authority fenced on drift', () => {
    const source = linkedSource(Buffer.from('pre-finalize drift'));
    const projectRoot = root();
    writeLinkedConfig(projectRoot, 'linked', source.sourceRoot);
    const request = importRequest(source, 'drift-before-finalize');
    const issued = issueRecallConfirmation(projectRoot, request);
    expect(() => executeRecallAction(projectRoot, { ...request, confirmation_token: issued.token }, {
      afterArtifactCopy: () => { writeFileSync(source.output, 'changed after validated copy'); },
    })).toThrow(/source|artifact|fence/i);
    const record = new SessionStore(projectRoot).readRecallConfirmation(issued.token);
    expect(record?.consumed_at).toBeNull();
    expect(record?.outcome).toBeNull();
    expect(new SessionStore(projectRoot).sessionExists(request.target_session_id)).toBe(true);
  });

  it('recovers crash-after-claim and crash-after-partial-copy by bounded rollback and retry', async () => {
    const scenarios = [
      { crash: 'after-claim', linked: false },
      { crash: 'after-artifact-copy', linked: true },
    ] as const;
    for (const [index, scenario] of scenarios.entries()) {
      const projectRoot = root();
      const source = scenario.linked ? linkedSource(Buffer.from(`crash-${index}`)) : null;
      if (source) writeLinkedConfig(projectRoot, 'linked', source.sourceRoot);
      const request = source
        ? importRequest(source, `crash-target-${index}`)
        : { action: 'new' as const, target_session_id: `crash-target-${index}`, command: 'demo', intent: `crash ${index}`, args: [] };
      const issued = issueRecallConfirmation(projectRoot, request);
      const started = new Date();
      const crashed = await childAction(projectRoot, { ...request, confirmation_token: issued.token }, {
        crashPoint: scenario.crash, now: started.toISOString(), reservationTtlMs: 50,
      });
      expect(crashed.status).toBe(86);
      const recovered = executeRecallAction(projectRoot, { ...request, confirmation_token: issued.token }, {
        now: new Date(started.getTime() + 1_000), reservationTtlMs: 50,
      });
      expect(recovered).toMatchObject({ session_id: request.target_session_id, replayed: false });
      expect(readdirSync(join(new SessionStore(projectRoot).sessionDir(request.target_session_id), 'runs'))).toHaveLength(1);
    }
  });

  it('resumes finalize after a crash with a complete target and never creates a second Run', async () => {
    const source = linkedSource(Buffer.from('resume finalize'));
    const projectRoot = root();
    writeLinkedConfig(projectRoot, 'linked', source.sourceRoot);
    const request = importRequest(source, 'resume-target');
    const issued = issueRecallConfirmation(projectRoot, request);
    const started = new Date();
    const crashed = await childAction(projectRoot, { ...request, confirmation_token: issued.token }, {
      crashPoint: 'after-create', now: started.toISOString(), reservationTtlMs: 50,
    });
    expect(crashed.status).toBe(86);
    const recovered = executeRecallAction(projectRoot, { ...request, confirmation_token: issued.token }, {
      now: new Date(started.getTime() + 1_000), reservationTtlMs: 50,
    });
    expect(recovered).toMatchObject({ session_id: 'resume-target', replayed: false });
    const runs = readdirSync(join(new SessionStore(projectRoot).sessionDir('resume-target'), 'runs'));
    expect(runs).toHaveLength(1);
    expect(recovered.import_manifest?.artifacts[0].source_hash).toBe(sha256Digest(source.bytes));
  });

  it('fails closed on a foreign core marker and leaves the target untouched', async () => {
    const projectRoot = root();
    const request = { action: 'new' as const, target_session_id: 'foreign-target', command: 'demo', intent: 'foreign', args: [] };
    const issued = issueRecallConfirmation(projectRoot, request);
    const started = new Date();
    expect((await childAction(projectRoot, { ...request, confirmation_token: issued.token }, {
      crashPoint: 'after-claim', now: started.toISOString(), reservationTtlMs: 50,
    })).status).toBe(86);
    const markerPath = join(new SessionStore(projectRoot).sessionDir('foreign-target'), '.recall-reservation.json');
    const marker = JSON.parse(readFileSync(markerPath, 'utf8')) as Record<string, unknown>;
    marker.reservation_id = 'rsv_foreign-marker-123456789';
    writeFileSync(markerPath, JSON.stringify(marker, null, 2));
    expect(() => executeRecallAction(projectRoot, { ...request, confirmation_token: issued.token }, {
      now: new Date(started.getTime() + 1_000), reservationTtlMs: 50,
    })).toThrow(/marker|conflict|reservation/i);
    expect(existsSync(markerPath)).toBe(true);
  });

  it('keeps one mutation and an intact winner across repeated two-process races', async () => {
    const projectRoot = root();
    for (let round = 0; round < 5; round++) {
      const request = { action: 'new' as const, target_session_id: `race-${round}`, command: 'demo', intent: `race ${round}`, args: [] };
      const issued = issueRecallConfirmation(projectRoot, request);
      const input = { ...request, confirmation_token: issued.token };
      const attempts = await Promise.all([childAction(projectRoot, input), childAction(projectRoot, input)]);
      expect(attempts.filter(item => item.body?.ok && item.body.result.replayed === false), JSON.stringify(attempts)).toHaveLength(1);
      const store = new SessionStore(projectRoot);
      const runIds = readdirSync(join(store.sessionDir(request.target_session_id), 'runs'))
        .filter(id => existsSync(join(store.runDir(request.target_session_id, id), 'run.json')));
      expect(runIds).toHaveLength(1);
      expect(executeRecallAction(projectRoot, input)).toMatchObject({ run_id: runIds[0], replayed: true });
    }
  });
});
