// ---------------------------------------------------------------------------
// command-source-order.test.ts — resolveCommandSource / resolveStepContent
// precedence: project-local definitions (prepare, .claude/commands, workflow
// associations) must always win over the user-global ~/.maestro library.
// Isolates MAESTRO_HOME (paths is frozen at import) via resetModules + a fresh
// dynamic import, so the order assertions are deterministic on every machine.
// ---------------------------------------------------------------------------

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const originalMaestroHome = process.env.MAESTRO_HOME;
const testHome = mkdtempSync(join(tmpdir(), 'maestro-cmd-order-'));
let contract: typeof import('./contract.js');

beforeAll(async () => {
  process.env.MAESTRO_HOME = testHome;
  vi.resetModules();
  contract = await import('./contract.js');
});

afterAll(() => {
  if (originalMaestroHome === undefined) delete process.env.MAESTRO_HOME;
  else process.env.MAESTRO_HOME = originalMaestroHome;
  rmSync(testHome, { recursive: true, force: true });
});

const roots: string[] = [];
function root(): string {
  const path = mkdtempSync(join(tmpdir(), 'maestro-cmd-order-'));
  roots.push(path);
  return path;
}
afterAll(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

const CONSUME_CONTRACT = `<contract>
consumes:
  - kind: verification
    alias: latest-verification
    required: true
produces: []
gates:
  entry: []
  exit: []
</contract>
`;

function globalPrepare(name: string, raw = CONSUME_CONTRACT.replace('required: true', 'required: false')): void {
  mkdirSync(join(testHome, 'prepare'), { recursive: true });
  writeFileSync(join(testHome, 'prepare', `${name}.md`), raw, 'utf8');
}

describe('resolveCommandSource precedence over the global prepare library', () => {
  it('project .claude/commands wins over a global ~/.maestro/prepare shadow', () => {
    const r = root();
    globalPrepare('zzgate');
    mkdirSync(join(r, '.claude', 'commands'), { recursive: true });
    writeFileSync(join(r, '.claude', 'commands', 'zzgate.md'), CONSUME_CONTRACT, 'utf8');

    const source = contract.resolveCommandSource(r, 'zzgate');
    expect(source.path).toBe(join(r, '.claude', 'commands', 'zzgate.md'));
    expect(source.contract.consumes[0]).toMatchObject({ kind: 'verification', required: true });
  });

  it('project <root>/prepare wins over the global prepare library', () => {
    const r = root();
    globalPrepare('zzgate');
    mkdirSync(join(r, 'prepare'), { recursive: true });
    writeFileSync(join(r, 'prepare', 'zzgate.md'), CONSUME_CONTRACT, 'utf8');

    const source = contract.resolveCommandSource(r, 'zzgate');
    expect(source.path).toBe(join(r, 'prepare', 'zzgate.md'));
    expect(source.contract.consumes[0].required).toBe(true);
  });

  it('project .workflow/prepare wins over <root>/prepare and the global library', () => {
    const r = root();
    globalPrepare('zzgate');
    mkdirSync(join(r, 'prepare'), { recursive: true });
    writeFileSync(join(r, 'prepare', 'zzgate.md'), CONSUME_CONTRACT.replace('required: true', 'required: false'), 'utf8');
    mkdirSync(join(r, '.workflow', 'prepare'), { recursive: true });
    writeFileSync(join(r, '.workflow', 'prepare', 'zzgate.md'), CONSUME_CONTRACT, 'utf8');

    const source = contract.resolveCommandSource(r, 'zzgate');
    expect(source.path).toBe(join(r, '.workflow', 'prepare', 'zzgate.md'));
    expect(source.contract.consumes[0].required).toBe(true);
  });

  it('workflow-association prepare falls back to global, then project prepare shadows it', () => {
    const r = root();
    globalPrepare('zzwf-prep');
    mkdirSync(join(r, '.workflow', 'workflows'), { recursive: true });
    writeFileSync(join(r, '.workflow', 'workflows', 'zzwf.md'), [
      '---', 'name: zzwf', 'prepare: zzwf-prep', 'commands: [zzwf]', 'session-mode: inherited', '---', '# wf', '',
    ].join('\n'), 'utf8');

    // Tier-2 step-content fallback: the association prepare resolves globally.
    expect(contract.resolveCommandSource(r, 'zzwf').path).toBe(join(testHome, 'prepare', 'zzwf-prep.md'));

    // A project prepare now shadows the global one for the same association base.
    mkdirSync(join(r, 'prepare'), { recursive: true });
    writeFileSync(join(r, 'prepare', 'zzwf-prep.md'), CONSUME_CONTRACT, 'utf8');
    expect(contract.resolveCommandSource(r, 'zzwf').path).toBe(join(r, 'prepare', 'zzwf-prep.md'));
  });

  it('falls back to the global prepare library when no project candidate exists', () => {
    const r = root();
    globalPrepare('zzgate');

    const source = contract.resolveCommandSource(r, 'zzgate');
    expect(source.path).toBe(join(testHome, 'prepare', 'zzgate.md'));
  });

  it('returns an empty contract when no candidate exists anywhere', () => {
    const source = contract.resolveCommandSource(root(), 'zz-nonexistent');
    expect(source.path).toBe('');
    expect(source.contract.consumes).toEqual([]);
  });
});

describe('resolveStepContent shares the same project-first prepare order', () => {
  it('project <root>/prepare wins over the global prepare for a plain step', () => {
    const r = root();
    globalPrepare('zzplain');
    mkdirSync(join(r, 'prepare'), { recursive: true });
    writeFileSync(join(r, 'prepare', 'zzplain.md'), CONSUME_CONTRACT, 'utf8');

    const content = contract.resolveStepContent(r, 'zzplain');
    expect(content.prepare?.path).toBe(join(r, 'prepare', 'zzplain.md'));
  });

  it('falls back to the global prepare for a plain step with no project file', () => {
    const r = root();
    globalPrepare('zzplain');

    const content = contract.resolveStepContent(r, 'zzplain');
    expect(content.prepare?.path).toBe(join(testHome, 'prepare', 'zzplain.md'));
  });
});
