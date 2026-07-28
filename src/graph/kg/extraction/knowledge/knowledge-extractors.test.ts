import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { extractSpec } from './spec-extractor.js';
import { extractWiki } from './wiki-extractor.js';
import { wikiIdToNodeId } from '../../credibility.js';

const roots: string[] = [];

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'maestro-kg-knowledge-extract-'));
  roots.push(value);
  return value;
}

afterEach(() => {
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
});

describe('canonical KG knowledge identities', () => {
  it('aligns Spec graph IDs with loadable Wiki entry IDs', () => {
    const projectRoot = root();
    const workflowRoot = join(projectRoot, '.workflow');
    const specsDir = join(workflowRoot, 'specs');
    mkdirSync(specsDir, { recursive: true });
    writeFileSync(join(specsDir, 'coding-conventions.md'), `---
category: coding
---

<spec-entry category="coding" keywords="first" date="2026-07-28" sid="S-first" title="First rule">

### First rule

Use the first rule.

</spec-entry>

<spec-entry category="coding" keywords="second" date="2026-07-28" sid="S-second" title="Second rule">

### Second rule

Use the second rule.

</spec-entry>
`, 'utf8');

    const result = extractSpec(specsDir, workflowRoot);

    expect(result.nodes.map(node => node.id)).toEqual([
      'spec:project:coding-conventions-001',
      'spec:project:coding-conventions-002',
    ]);
    expect(result.nodes[0]).toMatchObject({
      name: 'First rule',
      metadata: {
        wikiId: 'spec:project:coding-conventions-001',
        sid: 'S-first',
      },
    });
    expect(wikiIdToNodeId('spec:project:coding-conventions-001'))
      .toBe('spec:project:coding-conventions-001');
  });

  it('normalizes Knowhow graph IDs to the canonical Wiki slug', () => {
    const projectRoot = root();
    const workflowRoot = join(projectRoot, '.workflow');
    const knowhowDir = join(workflowRoot, 'knowhow');
    mkdirSync(knowhowDir, { recursive: true });
    writeFileSync(join(knowhowDir, 'TIP-20260728-Identity.md'), `---
title: Identity recipe
type: tip
status: active
---

Keep one identity.
`, 'utf8');

    const result = extractWiki(knowhowDir, workflowRoot);

    expect(result.nodes).toEqual([
      expect.objectContaining({
        id: 'knowhow:tip-20260728-identity',
        metadata: expect.objectContaining({
          wikiId: 'knowhow-tip-20260728-identity',
        }),
      }),
    ]);
    expect(wikiIdToNodeId('knowhow-tip-20260728-identity'))
      .toBe('knowhow:tip-20260728-identity');
  });
});
