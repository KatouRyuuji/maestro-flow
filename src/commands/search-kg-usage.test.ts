import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { CredibilityStore } from '../graph/kg/credibility.js';
import { MaestroGraph } from '../graph/kg/engine.js';
import type {
  Language,
  UnifiedNode,
  UnifiedNodeKind,
} from '../graph/kg/db/types.js';
import { runKgSearch } from './search.js';

function node(id: string, overrides: Partial<UnifiedNode> = {}): UnifiedNode {
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
    ...overrides,
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

  it('returns valid KG results when impression persistence fails', async () => {
    const root = mkdtempSync(join(tmpdir(), 'maestro-kg-search-failure-'));
    try {
      const graph = await MaestroGraph.init(root);
      graph.getConnection().transaction(() =>
        graph.getQueryBuilder().insertNodes([node('spec:alpha')])
      );
      graph.close();
      const failure = vi.spyOn(CredibilityStore.prototype, 'incrementImpressions')
        .mockImplementation(() => {
          throw new Error('simulated usage write failure');
        });
      try {
        const output = await runKgSearch('alpha', 10, true, root);
        expect(output.results.map(result => result.id)).toContain('spec:alpha');
      } finally {
        failure.mockRestore();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('filters by source type and exposes a loadable canonical knowhow ID', async () => {
    const root = mkdtempSync(join(tmpdir(), 'maestro-kg-search-filter-'));
    try {
      const graph = await MaestroGraph.init(root);
      graph.getConnection().transaction(() =>
        graph.getQueryBuilder().insertNodes([
          node('spec:alpha'),
          node('code:alpha', {
            kind: 'function',
            sourceType: 'codegraph',
            filePath: 'src/alpha.ts',
            definition: 'function alpha() {}',
          }),
          node('knowhow:TIP-20260728-alpha', {
            kind: 'knowhow_entry',
            sourceType: 'knowhow',
            filePath: join(root, '.workflow', 'knowhow', 'TIP-20260728-alpha.md'),
          }),
        ])
      );
      graph.close();

      const output = await runKgSearch('alpha', 10, false, root, {
        type: 'knowhow',
      });

      expect(output.results).toEqual([
        expect.objectContaining({
          id: 'knowhow-tip-20260728-alpha',
          graphId: 'knowhow:TIP-20260728-alpha',
          aliases: ['knowhow:TIP-20260728-alpha'],
          sourceType: 'knowhow',
        }),
      ]);
      expect(output.summary).toMatchObject({
        codeSymbols: 0,
        specRules: 0,
        knowhowDocs: 1,
        total: 1,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('excludes deprecated KG knowledge unless explicitly requested', async () => {
    const root = mkdtempSync(join(tmpdir(), 'maestro-kg-search-lifecycle-'));
    try {
      const graph = await MaestroGraph.init(root);
      graph.getConnection().transaction(() =>
        graph.getQueryBuilder().insertNodes([
          node('knowhow:TIP-20260728-retired-alpha', {
            kind: 'knowhow_entry',
            sourceType: 'knowhow',
            status: 'deprecated',
            filePath: join(root, '.workflow', 'knowhow', 'TIP-20260728-retired-alpha.md'),
          }),
        ])
      );
      graph.close();

      expect((await runKgSearch('alpha', 10, false, root, {
        type: 'knowhow',
      })).results).toEqual([]);
      expect((await runKgSearch('alpha', 10, false, root, {
        type: 'knowhow',
        includeDeprecated: true,
      })).results).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
