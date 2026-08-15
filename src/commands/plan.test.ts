import { Command } from 'commander';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerPlanCommand } from './plan.js';

function v2Workspace(root: string): void {
  mkdirSync(join(root, ".workflow"), { recursive: true });
  writeFileSync(join(root, ".workflow", "config.json"), JSON.stringify({
    session_schema: { schema_version: "session-schema-selection/1.0", writer: "session/1.3", features: { session_statusless: false } },
  }));
}

const roots: string[] = [];
const originalExitCode = process.exitCode;

function fixture(): { root: string; source: string } {
  const root = mkdtempSync(join(tmpdir(), 'maestro-plan-cli-'));

  v2Workspace(root);
  roots.push(root);
  mkdirSync(join(root, 'prepare'), { recursive: true });
  writeFileSync(join(root, 'prepare', 'plan-publish.md'), `---
name: plan-publish
session-mode: run
contract:
  contract_version: 2.1
  arguments: []
  consumes: []
  produces:
    - path: outputs/plan.json
      kind: plan
      alias: current-plan
      role: primary
      required: true
      schema: plan/1.0
  gates: { entry: [], exit: [] }
---
`, 'utf8');
  const source = join(root, 'approved.md');
  writeFileSync(source, '# Approved CLI Plan\n', 'utf8');
  return { root, source };
}

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = originalExitCode;
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('maestro plan publish CLI', () => {
  it('emits exactly one plan-publish machine envelope', async () => {
    const value = fixture();
    const writes: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    const program = new Command();
    program.name('maestro');
    registerPlanCommand(program);

    await program.parseAsync([
      'node', 'maestro', 'plan', 'publish', value.source,
      '--handoff-key', 'cli-handoff',
      '--intent', 'CLI approved Plan',
      '--json',
      '--workflow-root', value.root,
    ]);

    expect(writes).toHaveLength(1);
    expect(writes[0].trim().split(/\r?\n/)).toHaveLength(1);
    expect(JSON.parse(writes[0])).toMatchObject({
      schema_version: 'run-response/1.0',
      operation: 'plan-publish',
      ok: true,
      exit_code: 0,
      replay: { status: 'applied' },
      result: { handoff_key: 'cli-handoff', created_session: true },
    });
  });
});
