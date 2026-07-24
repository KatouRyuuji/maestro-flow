import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { KgDatabaseConnection } from '../graph/kg/db/connection.js';
import type { UnifiedNode } from '../graph/kg/db/types.js';
import { MaestroGraph } from '../graph/kg/engine.js';
import {
  registerSearchCommand,
  runCodeSearch,
  runLinkedCodeSearch,
} from './search.js';

interface LinkedConfig {
  name: string;
  path: string;
  share: string[];
}

interface FileSnapshot {
  size: number;
  mtimeMs: number;
  sha256: string;
}

const temporaryRoots: string[] = [];

function temporaryRoot(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `maestro-${label}-`));
  temporaryRoots.push(root);
  return root;
}

function codeNode(id: string, name: string): UnifiedNode {
  return {
    id,
    kind: 'function',
    name,
    qualifiedName: name,
    filePath: `src/${name}.ts`,
    language: 'typescript',
    startLine: 7,
    endLine: 9,
    startColumn: 0,
    endColumn: 1,
    docstring: `${name} documentation`,
    signature: `function ${name}(): void`,
    visibility: 'public',
    isExported: true,
    isAsync: false,
    isStatic: false,
    isAbstract: false,
    decorators: [],
    typeParameters: [],
    sourceType: 'codegraph',
    definition: '',
    aliases: [],
    keywords: [name],
    category: '',
    roles: [],
    priority: '',
    status: 'active',
    body: '',
    metadata: {},
    updatedAt: 0,
  };
}

async function createGraph(root: string, name: string, id = 'code:function:shared'): Promise<string> {
  return createGraphWithNodes(root, [codeNode(id, name)]);
}

async function createGraphWithNodes(root: string, nodes: UnifiedNode[]): Promise<string> {
  mkdirSync(root, { recursive: true });
  const graph = await MaestroGraph.init(root);
  try {
    graph.getQueryBuilder().insertNodes(nodes);
  } finally {
    graph.close();
  }
  return join(root, '.workflow', 'kg', 'maestro.db');
}

function writeWorkspaceConfig(projectRoot: string, linked: LinkedConfig[]): void {
  const workflowRoot = join(projectRoot, '.workflow');
  mkdirSync(workflowRoot, { recursive: true });
  writeFileSync(
    join(workflowRoot, 'config.json'),
    JSON.stringify({ workspaces: { linked } }, null, 2),
    'utf8',
  );
}

function fileSnapshot(path: string): FileSnapshot {
  const bytes = readFileSync(path);
  const stats = statSync(path);
  return {
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

function databaseSnapshot(dbPath: string): Record<string, FileSnapshot> {
  return Object.fromEntries(
    [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]
      .filter(path => existsSync(path))
      .map(path => [basename(path), fileSnapshot(path)]),
  );
}

async function primeWalReadMark(root: string, query: string): Promise<void> {
  const graph = await MaestroGraph.openReadOnly(root);
  try {
    graph.searchCode(query, { limit: 1 });
  } finally {
    graph.close();
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.MAESTRO_DEBUG;
  while (temporaryRoots.length > 0) {
    const root = temporaryRoots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

describe('linked CodeGraph search', () => {
  it('is disabled by default and registers an explicit opt-in flag', async () => {
    const projectRoot = temporaryRoot('linked-default');
    const linkedRoot = join(projectRoot, 'linked');
    await createGraph(projectRoot, 'LocalNeedle', 'code:function:local');
    await createGraph(linkedRoot, 'LinkedNeedle');
    writeWorkspaceConfig(projectRoot, [
      { name: 'linked', path: linkedRoot, share: ['codebase'] },
    ]);
    const openReadOnly = vi.spyOn(MaestroGraph, 'openReadOnly');

    const outcome = await runCodeSearch('LocalNeedle', 20, true, false, projectRoot);

    expect(openReadOnly).not.toHaveBeenCalled();
    expect(outcome.results.map(result => result.id)).toEqual(['code:function:local']);
    expect(outcome.results[0].workspace).toBeUndefined();
    const program = new Command();
    registerSearchCommand(program);
    const search = program.commands.find(command => command.name() === 'search');
    expect(search?.options.some(option => option.long === '--include-linked-code')).toBe(true);
    expect(search?.options.some(option => option.long === '--workspace')).toBe(true);
  });

  it('keeps linked results opt-in for adapter-style read-only probes', async () => {
    const projectRoot = temporaryRoot('linked-adapter-probe');
    const linkedRoot = join(projectRoot, 'linked');
    await createGraph(projectRoot, 'ProbeNeedle', 'code:function:local');
    await createGraph(linkedRoot, 'ProbeNeedle', 'code:function:linked');
    writeWorkspaceConfig(projectRoot, [
      { name: 'linked', path: linkedRoot, share: ['codebase'] },
    ]);

    const localOnly = await runCodeSearch(
      'ProbeNeedle',
      20,
      true,
      false,
      projectRoot,
      'read-only-probe',
    );
    const optedIn = await runCodeSearch(
      'ProbeNeedle',
      20,
      true,
      true,
      projectRoot,
      'read-only-probe',
    );

    expect(localOnly.results.map(result => result.id)).toEqual(['code:function:local']);
    expect(localOnly.results.every(result => result.workspace === undefined)).toBe(true);
    expect(optedIn.results.map(result => result.id)).toEqual([
      'code:function:local',
      'ws:linked:code:function:linked',
    ]);
  });

  it('only searches valid workspaces explicitly sharing codebase', async () => {
    const projectRoot = temporaryRoot('linked-auth');
    const authorizedRoot = join(projectRoot, 'authorized');
    const unsharedRoot = join(projectRoot, 'unshared');
    const invalidRoot = join(projectRoot, 'invalid');
    await createGraph(authorizedRoot, 'PermissionNeedle');
    await createGraph(unsharedRoot, 'PermissionNeedle');
    writeWorkspaceConfig(projectRoot, [
      { name: 'unshared', path: unsharedRoot, share: ['spec'] },
      { name: 'invalid', path: invalidRoot, share: ['codebase'] },
      { name: 'authorized', path: authorizedRoot, share: ['codebase'] },
    ]);

    const outcome = await runLinkedCodeSearch('PermissionNeedle', 20, projectRoot);

    expect(outcome.failures).toEqual([]);
    expect(outcome.results).toHaveLength(1);
    expect(outcome.results[0]).toMatchObject({
      id: 'ws:authorized:code:function:shared',
      workspace: 'authorized',
      workspaceFence: 'linked:authorized',
    });
  });

  it('queries workspace names in order with one live linked handle', async () => {
    const projectRoot = temporaryRoot('linked-order');
    const wsA = join(projectRoot, 'ws-a');
    const wsB = join(projectRoot, 'ws-b');
    await createGraph(wsA, 'CollisionNeedle');
    await createGraph(wsB, 'CollisionNeedle');
    writeWorkspaceConfig(projectRoot, [
      { name: 'ws-b', path: wsB, share: ['codebase'] },
      { name: 'ws-a', path: wsA, share: ['codebase'] },
    ]);
    const events: string[] = [];
    let liveHandles = 0;
    let peakHandles = 0;
    const originalOpen = MaestroGraph.openReadOnly.bind(MaestroGraph);
    vi.spyOn(MaestroGraph, 'openReadOnly').mockImplementation(async root => {
      const workspace = basename(root);
      events.push(`open(${workspace})`);
      const graph = await originalOpen(root);
      liveHandles += 1;
      peakHandles = Math.max(peakHandles, liveHandles);
      const originalSearch = graph.searchCode.bind(graph);
      vi.spyOn(graph, 'searchCode').mockImplementation((query, options) => {
        events.push(`query(${workspace})`);
        return originalSearch(query, options);
      });
      const originalClose = graph.close.bind(graph);
      vi.spyOn(graph, 'close').mockImplementation(() => {
        events.push(`close(${workspace})`);
        liveHandles -= 1;
        originalClose();
      });
      return graph;
    });

    const outcome = await runLinkedCodeSearch('CollisionNeedle', 20, projectRoot);

    expect(events).toEqual([
      'open(ws-a)', 'query(ws-a)', 'close(ws-a)',
      'open(ws-b)', 'query(ws-b)', 'close(ws-b)',
    ]);
    expect(peakHandles).toBe(1);
    expect(liveHandles).toBe(0);
    expect(outcome.results.map(result => result.id)).toEqual([
      'ws:ws-a:code:function:shared',
      'ws:ws-b:code:function:shared',
    ]);
    expect(new Set(outcome.results.map(result => result.id)).size).toBe(2);
    expect(runLinkedCodeSearch.toString()).not.toMatch(/Promise\.all(?:Settled)?|ATTACH/i);
  });

  it('preserves database and existing sidecar bytes, size, and mtime', async () => {
    const projectRoot = temporaryRoot('linked-fence');
    const linkedRoot = join(projectRoot, 'readonly');
    const dbPath = await createGraph(linkedRoot, 'ReadonlyNeedle');
    writeWorkspaceConfig(projectRoot, [
      { name: 'readonly', path: linkedRoot, share: ['codebase'] },
    ]);
    const sync = vi.spyOn(MaestroGraph.prototype, 'sync');
    const hybrid = vi.spyOn(MaestroGraph.prototype, 'searchHybrid');
    const embeddings = vi.spyOn(MaestroGraph.prototype, 'buildCodeEmbeddings');
    const readMarkHolder = await MaestroGraph.openReadOnly(linkedRoot);
    try {
      readMarkHolder.searchCode('ReadonlyNeedle', { limit: 1 });
      const before = databaseSnapshot(dbPath);

      const outcome = await runLinkedCodeSearch('ReadonlyNeedle', 20, projectRoot);

      expect(outcome.results).toHaveLength(1);
      expect(databaseSnapshot(dbPath)).toEqual(before);
      expect(sync).not.toHaveBeenCalled();
      expect(hybrid).not.toHaveBeenCalled();
      expect(embeddings).not.toHaveBeenCalled();
    } finally {
      readMarkHolder.close();
    }
  });

  it('sees committed active-WAL data before writer close', async () => {
    const linkedRoot = temporaryRoot('linked-active-wal');
    mkdirSync(linkedRoot, { recursive: true });
    const writer = await MaestroGraph.init(linkedRoot);
    const dbPath = join(linkedRoot, '.workflow', 'kg', 'maestro.db');
    try {
      writer.rawDb.exec('PRAGMA wal_autocheckpoint = 0');
      writer.getConnection().transaction(() => {
        writer.getQueryBuilder().insertNodes([
          codeNode('code:function:active-wal', 'ActiveWalNeedle'),
        ]);
      });
      expect(existsSync(`${dbPath}-wal`)).toBe(true);
      expect(existsSync(`${dbPath}-shm`)).toBe(true);

      const migration = vi.spyOn(KgDatabaseConnection.prototype, 'getSchemaVersion');
      const sync = vi.spyOn(MaestroGraph.prototype, 'sync');
      const embeddings = vi.spyOn(MaestroGraph.prototype, 'buildCodeEmbeddings');
      const exec = vi.spyOn(DatabaseSync.prototype, 'exec');
      await primeWalReadMark(linkedRoot, 'ActiveWalNeedle');
      const before = databaseSnapshot(dbPath);
      const reader = await MaestroGraph.openReadOnly(linkedRoot);
      let results: UnifiedNode[];
      try {
        results = reader.searchCode('ActiveWalNeedle', { limit: 5 });
      } finally {
        reader.close();
      }

      expect(results.map(result => result.id)).toEqual(['code:function:active-wal']);
      expect(databaseSnapshot(dbPath)).toEqual(before);
      expect(migration).not.toHaveBeenCalled();
      expect(sync).not.toHaveBeenCalled();
      expect(embeddings).not.toHaveBeenCalled();
      expect(exec).not.toHaveBeenCalled();
    } finally {
      writer.close();
    }
  });

  it('preserves linked providers when local candidates saturate limit', async () => {
    const projectRoot = temporaryRoot('linked-saturation');
    const wsA = join(projectRoot, 'ws-a');
    const wsB = join(projectRoot, 'ws-b');
    await createGraphWithNodes(
      projectRoot,
      Array.from({ length: 5 }, (_, index) =>
        codeNode(`code:function:local-${index}`, 'SaturationNeedle')),
    );
    await createGraphWithNodes(
      wsA,
      Array.from({ length: 2 }, (_, index) =>
        codeNode(`code:function:ws-a-${index}`, 'SaturationNeedle')),
    );
    await createGraphWithNodes(
      wsB,
      Array.from({ length: 2 }, (_, index) =>
        codeNode(`code:function:ws-b-${index}`, 'SaturationNeedle')),
    );
    writeWorkspaceConfig(projectRoot, [
      { name: 'ws-b', path: wsB, share: ['codebase'] },
      { name: 'ws-a', path: wsA, share: ['codebase'] },
    ]);

    const outcome = await runCodeSearch('SaturationNeedle', 5, true, true, projectRoot);

    expect(outcome.results.map(result => result.id)).toEqual([
      'code:function:local-0',
      'ws:ws-a:code:function:ws-a-0',
      'ws:ws-b:code:function:ws-b-0',
      'code:function:local-1',
      'ws:ws-a:code:function:ws-a-1',
    ]);
    expect(outcome.results.filter(result => result.workspace).map(result => ({
      workspace: result.workspace,
      workspaceFence: result.workspaceFence,
    }))).toEqual([
      { workspace: 'ws-a', workspaceFence: 'linked:ws-a' },
      { workspace: 'ws-b', workspaceFence: 'linked:ws-b' },
      { workspace: 'ws-a', workspaceFence: 'linked:ws-a' },
    ]);
  });

  it('isolates missing databases and attributes debug failures by workspace', async () => {
    const projectRoot = temporaryRoot('linked-failure');
    const healthyRoot = join(projectRoot, 'healthy');
    const missingRoot = join(projectRoot, 'missing');
    await createGraph(projectRoot, 'IsolationNeedle', 'code:function:local');
    await createGraph(healthyRoot, 'IsolationNeedle');
    mkdirSync(join(missingRoot, '.workflow'), { recursive: true });
    writeWorkspaceConfig(projectRoot, [
      { name: 'missing-db', path: missingRoot, share: ['codebase'] },
      { name: 'healthy', path: healthyRoot, share: ['codebase'] },
    ]);
    process.env.MAESTRO_DEBUG = '1';
    const debug = vi.spyOn(console, 'error').mockImplementation(() => {});

    const outcome = await runCodeSearch('IsolationNeedle', 20, true, true, projectRoot);

    expect(outcome.results.map(result => result.id)).toEqual([
      'code:function:local',
      'ws:healthy:code:function:shared',
    ]);
    expect(outcome.linkedFailures).toEqual([
      expect.objectContaining({ workspace: 'missing-db' }),
    ]);
    expect(debug).toHaveBeenCalledWith(expect.stringContaining('workspace "missing-db"'));
  });
});
