import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CredibilityStore } from '../graph/kg/credibility.js';
import type { Language, UnifiedNode, UnifiedNodeKind } from '../graph/kg/db/types.js';
import { MaestroGraph } from '../graph/kg/engine.js';
import { readRunKnowledgeDelta } from '../run/knowledge.js';
import type { RunV30, SessionStateV30 } from '../run/schemas.js';
import { SessionStore } from '../run/store.js';
import { registerWikiCommand } from './wiki.js';

const fixture = vi.hoisted(() => {
  const now = '2026-08-16T00:00:00.000Z';
  const entry = {
    id: 'spec:project:coding-conventions-001',
    type: 'spec',
    title: 'Explicit load rule',
    summary: 'Explicitly loaded knowledge is consumed.',
    tags: ['load'],
    status: 'active',
    created: now,
    updated: now,
    related: [],
    source: { kind: 'file', path: 'specs/coding-conventions.md' },
    body: 'Explicitly loaded knowledge is consumed.',
    ext: {},
    scope: 'project',
    category: 'coding',
    specCategory: 'coding',
    createdBy: null,
    sourceRef: 'spec:load-rule',
    parent: null,
  };
  return { entry };
});

vi.mock('#maestro-dashboard/wiki/wiki-indexer.js', () => ({
  WikiIndexer: class {
    async get() {
      return {
        entries: [fixture.entry],
        byId: { [fixture.entry.id]: fixture.entry },
      };
    }

    async search() {
      return [fixture.entry];
    }

    async query() {
      return [fixture.entry];
    }
  },
}));

vi.mock('#maestro-dashboard/wiki/writer.js', () => ({
  WikiWriter: class {},
  WikiWriteError: class extends Error {},
}));

let projectRoot = '';
const originalCwd = process.cwd();

afterEach(() => {
  process.chdir(originalCwd);
  vi.restoreAllMocks();
  if (projectRoot) rmSync(projectRoot, { recursive: true, force: true });
  projectRoot = '';
});

function knowledgeNode(): UnifiedNode {
  return {
    id: 'spec:load-rule',
    kind: 'spec_entry' as UnifiedNodeKind,
    name: 'Explicit load rule',
    qualifiedName: 'Explicit load rule',
    filePath: '.workflow/specs/coding-conventions.md',
    language: 'markdown' as Language,
    startLine: 1,
    endLine: 3,
    startColumn: 1,
    endColumn: 1,
    docstring: '',
    signature: '',
    visibility: '',
    isExported: false,
    isAsync: false,
    isStatic: false,
    isAbstract: false,
    decorators: [],
    typeParameters: [],
    sourceType: 'spec',
    definition: 'Explicitly loaded knowledge is consumed.',
    aliases: [],
    keywords: ['load'],
    category: 'coding',
    roles: [],
    priority: '',
    status: 'active',
    body: 'Explicitly loaded knowledge is consumed.',
    metadata: {},
    updatedAt: Date.now(),
  };
}

async function setupV3Workspace(): Promise<{
  store: SessionStore;
  session: SessionStateV30;
  run: RunV30;
}> {
  projectRoot = mkdtempSync(join(tmpdir(), 'maestro-wiki-attribution-v3-'));
  mkdirSync(join(projectRoot, '.workflow'), { recursive: true });
  writeFileSync(join(projectRoot, '.workflow', 'config.json'), JSON.stringify({
    session_schema: {
      schema_version: 'session-schema-selection/1.0',
      writer: 'session/3.0',
      features: { session_statusless: false },
    },
  }), 'utf8');
  const session: SessionStateV30 = {
    schema_version: 'session/3.0',
    session_id: 'wiki-attribution-v3',
    objective: 'verify wiki consumption attribution',
    definition_of_done: 'load is consumed and search is exposure-only',
    status: 'open',
    orchestration_revision: 0,
    activity_revision: 0,
    chain: [{
      step_id: 'step-1',
      command: 'wiki-demo',
      args: [],
      status: 'running',
      run_ids: ['run-wiki-v3'],
      goal_ref: null,
      decision_ref: null,
      decision_refs: [],
    }],
    decisions: [],
    active_run_ids: ['run-wiki-v3'],
    artifacts_ref: 'artifacts.json',
    evidence_ref: 'evidence.json',
    created_at: '2026-08-16T00:00:00.000Z',
    updated_at: '2026-08-16T00:00:00.000Z',
    completed_at: null,
    archived_at: null,
  };
  const run: RunV30 = {
    schema_version: 'run/3.0',
    run_id: 'run-wiki-v3',
    session_id: session.session_id,
    step_id: 'step-1',
    parent_run_id: null,
    retry_of_run_id: null,
    attempt: 1,
    command: 'wiki-demo',
    args: [],
    goal: null,
    status: 'running',
    revision: 0,
    actor_id: 'actor-wiki-v3',
    input_refs: [],
    output_refs: [],
    primary_artifact_id: null,
    verdict: null,
    summary: null,
    legacy_execution_generation: null,
    created_at: '2026-08-16T00:00:00.000Z',
    started_at: '2026-08-16T00:00:30.000Z',
    ended_at: null,
    sealed_at: null,
  };
  const store = new SessionStore(projectRoot);
  store.writeSessionV30(session);
  store.writeRunV30(run);
  const graph = await MaestroGraph.init(projectRoot);
  graph.getConnection().transaction(() => graph.getQueryBuilder().insertNodes([knowledgeNode()]));
  graph.close();
  process.chdir(projectRoot);
  return { store, session, run };
}

async function consumptionCount(): Promise<number> {
  const graph = await MaestroGraph.open(projectRoot);
  try {
    return new CredibilityStore(graph.rawDb).get('spec:load-rule')?.consumption_count ?? 0;
  } finally {
    graph.close();
  }
}

async function runWiki(args: string[]): Promise<string[]> {
  const logs: string[] = [];
  vi.spyOn(console, 'log').mockImplementation(value => { logs.push(String(value)); });
  const program = new Command();
  program.exitOverride();
  registerWikiCommand(program);
  await program.parseAsync(['node', 'maestro', 'wiki', ...args]);
  return logs;
}

describe.sequential('wiki knowledge consumption attribution', () => {
  it('reuses explicit-load attribution exactly once for wiki load', async () => {
    const { store, session, run } = await setupV3Workspace();

    const logs = await runWiki(['load', fixture.entry.id, '--json']);

    expect(logs.at(-1)).toContain('"totalLoaded": 1');
    expect(await consumptionCount()).toBe(1);
    expect(readRunKnowledgeDelta(store, session.session_id, run.run_id, true).inputs).toEqual([
      expect.objectContaining({
        knowledge_id: 'spec:load-rule',
        signal: 'consumed',
        source: 'load',
        count: 1,
      }),
    ]);
  });

  it('keeps wiki search exposure-only', async () => {
    const { store, session, run } = await setupV3Workspace();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const deltaPath = join(store.runDir(session.session_id, run.run_id), 'knowledge-delta.json');

    const logs = await runWiki(['search', 'explicit', 'load', '--json']);

    expect(logs.at(-1)).toContain(fixture.entry.id);
    expect(await consumptionCount()).toBe(0);
    expect(readRunKnowledgeDelta(store, session.session_id, run.run_id, true).inputs).toEqual([]);
    expect(existsSync(deltaPath)).toBe(false);
  });
});
