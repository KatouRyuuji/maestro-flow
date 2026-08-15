import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { maestroCapabilitiesSchema } from '../run/protocol-schemas.js';
import { registerCapabilitiesCommand } from './capabilities.js';

let root: string;
let stdout: string[];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'maestro-capabilities-'));
  stdout = [];
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
    stdout.push(String(chunk));
    return true;
  }) as typeof process.stdout.write);
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

async function capabilities(workflowRoot: string) {
  stdout = [];
  const program = new Command();
  program.exitOverride();
  registerCapabilitiesCommand(program);
  await program.parseAsync(['node', 'maestro', 'capabilities', '--json', '--workflow-root', workflowRoot]);
  expect(stdout).toHaveLength(1);
  return maestroCapabilitiesSchema.parse(JSON.parse(stdout[0]));
}

function writeWriter(writer: 'session/1.3' | 'session/2.0' | 'session/3.0'): void {
  mkdirSync(join(root, '.workflow'), { recursive: true });
  writeFileSync(join(root, '.workflow', 'config.json'), JSON.stringify({
    session_schema: {
      schema_version: 'session-schema-selection/1.0',
      writer,
      features: { session_statusless: writer === 'session/2.0' },
    },
  }));
}

describe('maestro capabilities session_schema_writes', () => {
  it('declares only session/3.0 as writable for a session/3.0 workspace', async () => {
    writeWriter('session/3.0');
    const result = await capabilities(root);
    expect(result.session_schema_writes).toEqual(['session/3.0']);
    // The features block remains the hasCompleteV3Support authority: Pi reads
    // features, not session_schema_writes, so v3 readiness is unchanged.
    expect(result.features).toMatchObject({
      session_run_minimal_v3: true,
      entity_revision_cas: true,
      participant_identity: true,
      request_receipts_v2: true,
    });
    expect(result.execution_schema_writes).toEqual([]);
  });

  it('declares only session/3.0 as writable for the default session/3.0 workspace', async () => {
    // No .workflow/config.json → DEFAULT_SESSION_SCHEMA_SELECTION writer 3.0.
    const result = await capabilities(root);
    expect(result.session_schema_writes).toEqual(['session/3.0']);
    expect(result.features).toMatchObject({
      execution_generation: false,
      session_run_minimal_v3: true,
      entity_revision_cas: true,
      participant_identity: true,
      request_receipts_v2: true,
      execution_lease: false,
      operation_registry: false,
    });
    expect(result.execution_schema_writes).toEqual([]);
  });

  it('declares session/1.3 and session/2.0 as writable for a session/2.0 workspace', async () => {
    writeWriter('session/2.0');
    const result = await capabilities(root);
    expect(result.session_schema_writes).toEqual(['session/1.3', 'session/2.0']);
    expect(result.features).toMatchObject({ session_statusless: true });
  });
});
