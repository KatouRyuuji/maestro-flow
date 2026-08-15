import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { maestroCapabilitiesSchema } from '../run/protocol-schemas.js';
import { sessionSchemaSelectionSchema } from '../run/schemas.js';
import { registerCapabilitiesCommand } from './capabilities.js';
import { registerConfigCommand } from './config.js';

let root: string;
let stdout: string[];
let logs: string[];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'maestro-config-'));
  stdout = [];
  logs = [];
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
    stdout.push(String(chunk));
    return true;
  }) as typeof process.stdout.write);
  vi.spyOn(console, 'log').mockImplementation((value: unknown) => { logs.push(String(value)); });
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

function configProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeOut: () => undefined, writeErr: () => undefined });
  registerConfigCommand(program);
  return program;
}

function configPath(): string {
  return join(root, '.workflow', 'config.json');
}

function readConfig(): Record<string, unknown> {
  return JSON.parse(readFileSync(configPath(), 'utf8')) as Record<string, unknown>;
}

async function setWriter(writer: string): Promise<void> {
  logs = [];
  await configProgram().parseAsync(['node', 'maestro', 'config', 'session-schema', 'set', writer, '--workflow-root', root]);
}

async function showWriter(): Promise<string> {
  logs = [];
  await configProgram().parseAsync(['node', 'maestro', 'config', 'session-schema', 'show', '--workflow-root', root]);
  return logs[0];
}

async function capabilities(workflowRoot: string) {
  stdout = [];
  const program = new Command();
  program.exitOverride();
  registerCapabilitiesCommand(program);
  await program.parseAsync(['node', 'maestro', 'capabilities', '--json', '--workflow-root', workflowRoot]);
  expect(stdout).toHaveLength(1);
  return maestroCapabilitiesSchema.parse(JSON.parse(stdout[0]));
}

describe('maestro config session-schema set', () => {
  it('writes session/3.0 with session_statusless: false', async () => {
    await setWriter('session/3.0');
    expect(logs[0]).toContain('session schema writer set to session/3.0');
    const config = readConfig();
    expect(sessionSchemaSelectionSchema.parse(config.session_schema)).toEqual({
      schema_version: 'session-schema-selection/1.0',
      writer: 'session/3.0',
      features: { session_statusless: false },
    });
    expect(config).toEqual({
      session_schema: {
        schema_version: 'session-schema-selection/1.0',
        writer: 'session/3.0',
        features: { session_statusless: false },
      },
    });
  });

  it('writes session/2.0 with session_statusless: true', async () => {
    await setWriter('session/2.0');
    expect(readConfig()).toEqual({
      session_schema: {
        schema_version: 'session-schema-selection/1.0',
        writer: 'session/2.0',
        features: { session_statusless: true },
      },
    });
  });

  it('rejects an invalid writer via commander choices and does not write', async () => {
    await expect(configProgram().parseAsync([
      'node', 'maestro', 'config', 'session-schema', 'set', 'session/9.9', '--workflow-root', root,
    ])).rejects.toThrow(/expected one of/);
    expect(existsSync(configPath())).toBe(false);
  });

  it('preserves unrelated top-level fields in config.json (passthrough merge)', async () => {
    mkdirSync(join(root, '.workflow'), { recursive: true });
    writeFileSync(configPath(), JSON.stringify({ overlay: { mode: 'strict' }, legacy_marker: 'keep-me' }), 'utf8');

    await setWriter('session/3.0');

    expect(readConfig()).toEqual({
      overlay: { mode: 'strict' },
      legacy_marker: 'keep-me',
      session_schema: {
        schema_version: 'session-schema-selection/1.0',
        writer: 'session/3.0',
        features: { session_statusless: false },
      },
    });
  });
});

describe('maestro config session-schema show', () => {
  it('prints the default session/3.0 when no config exists', async () => {
    expect(await showWriter()).toBe('session/3.0');
    expect(existsSync(configPath())).toBe(false);
  });

  it('reads back the configured writer', async () => {
    await setWriter('session/2.0');
    expect(await showWriter()).toBe('session/2.0');
  });
});

describe('config session-schema set → capabilities integration', () => {
  it('session_schema_writes follows the selected writer', async () => {
    await setWriter('session/3.0');
    expect((await capabilities(root)).session_schema_writes).toEqual(['session/3.0']);

    await setWriter('session/2.0');
    expect((await capabilities(root)).session_schema_writes).toEqual(['session/1.3', 'session/2.0']);
  });
});
