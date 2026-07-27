import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { CredibilityStore } from '../graph/kg/credibility.js';
import { MaestroGraph } from '../graph/kg/engine.js';
import type {
  Language,
  UnifiedNode,
  UnifiedNodeKind,
} from '../graph/kg/db/types.js';
import { runKgSearch } from './search.js';

function node(id: string): UnifiedNode {
  return {
    id,
    kind: 'spec_entry' as UnifiedNodeKind,
    name: 'Alpha knowledge rule',
    qualifiedName: 'Alpha knowledge rule',
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
    definition: 'Alpha canonical behavior',
    aliases: [],
    keywords: ['alpha'],
    category: 'coding',
    roles: [],
    priority: '',
    status: 'active',
    body: 'Alpha canonical behavior',
    metadata: {},
    updatedAt: Date.now(),
  };
}

describe('KG search usage attribution', () => {
  it('records returned knowledge as impressions and honors read-only mode', async () => {
    const root = mkdtempSync(join(tmpdir(), 'maestro-kg-search-usage-'));
    try {
      const graph = await MaestroGraph.init(root);
      graph.getConnection().transaction(() =>
        graph.getQueryBuilder().insertNodes([node('spec:alpha')])
      );
      new CredibilityStore(graph.rawDb).upsert('spec:alpha', 'alpha', 100);
      graph.close();

      expect((await runKgSearch('alpha', 10, true, root)).results.map(result => result.id))
        .toContain('spec:alpha');
      let reopened = await MaestroGraph.open(root);
      expect(new CredibilityStore(reopened.rawDb).get('spec:alpha')?.search_hits).toBe(1);
      reopened.close();

      await runKgSearch('alpha', 10, false, root);
      reopened = await MaestroGraph.open(root);
      expect(new CredibilityStore(reopened.rawDb).get('spec:alpha')?.search_hits).toBe(1);
      reopened.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
