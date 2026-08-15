import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { WikiEntry } from '#maestro-dashboard/wiki/wiki-types.js';
import { CredibilityStore } from '../graph/kg/credibility.js';
import { MaestroGraph } from '../graph/kg/engine.js';
import type { Language, UnifiedNode, UnifiedNodeKind } from '../graph/kg/db/types.js';
import { readRunKnowledgeDelta } from '../run/knowledge.js';
import { createRun } from '../run/runtime.js';
import { SessionStore } from '../run/store.js';
import { recordLoadedKnowledge } from './load.js';

function v2Workspace(root: string): void {
  mkdirSync(join(root, ".workflow"), { recursive: true });
  writeFileSync(join(root, ".workflow", "config.json"), JSON.stringify({
    session_schema: { schema_version: "session-schema-selection/1.0", writer: "session/1.3", features: { session_statusless: false } },
  }));
}

let previousCwd = process.cwd();
let root = '';

afterEach(() => {
  process.chdir(previousCwd);
  if (root) rmSync(root, { recursive: true, force: true });
  root = '';
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

function wikiEntry(): WikiEntry {
  const now = new Date().toISOString();
  return {
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
}

describe('explicit knowledge load attribution', () => {
  it('records full-content loads as consumed on the unique active Run', async () => {
    root = mkdtempSync(join(tmpdir(), 'maestro-load-consumed-'));
    v2Workspace(root);
    previousCwd = process.cwd();
    const commandDir = join(root, '.claude', 'commands');
    mkdirSync(commandDir, { recursive: true });
    writeFileSync(
      join(commandDir, 'load-demo.md'),
      '<contract>\nconsumes: []\nproduces: []\ngates:\n  entry: []\n  exit: []\n</contract>\n',
      'utf8',
    );
    const created = createRun({
      projectRoot: root,
      command: 'load-demo',
      sessionId: 'load-consumed-session',
      intent: 'verify explicit load consumption',
    });
    const graph = await MaestroGraph.init(root);
    graph.getConnection().transaction(() => graph.getQueryBuilder().insertNodes([knowledgeNode()]));
    graph.close();
    process.chdir(root);

    await recordLoadedKnowledge([wikiEntry()]);

    const delta = readRunKnowledgeDelta(
      new SessionStore(root),
      created.session_id,
      created.run_id,
    );
    expect(delta.inputs).toEqual([
      expect.objectContaining({
        knowledge_id: 'spec:load-rule',
        signal: 'consumed',
        source: 'load',
        count: 1,
      }),
    ]);
    const reopened = await MaestroGraph.open(root);
    try {
      expect(new CredibilityStore(reopened.rawDb).get('spec:load-rule')?.consumption_count).toBe(1);
    } finally {
      reopened.close();
    }
  });
});
