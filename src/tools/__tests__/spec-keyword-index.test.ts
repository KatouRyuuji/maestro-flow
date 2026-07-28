/**
 * Spec Keyword Index — comprehensive tests
 *
 * Covers: buildKeywordIndex, lookupKeyword, lookupKeywords
 * Guide coverage: Keyword 系统 (keyword index building, lookup, dedup)
 */

import { describe, it, beforeEach, afterEach, expect } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { buildKeywordIndex, lookupKeyword, lookupKeywords } from '../spec-keyword-index.js';

// ---------------------------------------------------------------------------
// Test lifecycle
// ---------------------------------------------------------------------------

let testDir: string;

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), 'maestro-test-kw-index-'));
  mkdirSync(join(testDir, '.workflow', 'specs'), { recursive: true });
});

afterEach(() => {
  if (testDir && existsSync(testDir)) {
    rmSync(testDir, { recursive: true, force: true });
  }
});

function writeSpecFile(filename: string, content: string): void {
  writeFileSync(join(testDir, '.workflow', 'specs', filename), content, 'utf-8');
}

// ---------------------------------------------------------------------------
// buildKeywordIndex
// ---------------------------------------------------------------------------

describe('buildKeywordIndex', () => {
  it('builds index from spec entries with keywords', () => {
    writeSpecFile('coding-conventions.md', `# Coding Conventions

<spec-entry category="coding" keywords="auth,token,jwt" date="2026-04-21">

### Token Rotation

Rotate tokens on each refresh.

</spec-entry>

<spec-entry category="coding" keywords="naming,camelcase" date="2026-04-20">

### Use camelCase

Always use camelCase for variables.

</spec-entry>
`);

    const index = buildKeywordIndex(testDir);

    expect(index.size).toBeGreaterThan(0);
    expect(index.has('auth')).toBe(true);
    expect(index.has('token')).toBe(true);
    expect(index.has('jwt')).toBe(true);
    expect(index.has('naming')).toBe(true);
    expect(index.has('camelcase')).toBe(true);
  });

  it('returns empty map when no specs directory exists', () => {
    const index = buildKeywordIndex('/nonexistent/path');
    expect(index.size).toBe(0);
  });

  it('returns empty map when specs directory has no entries', () => {
    writeSpecFile('coding-conventions.md', '# Coding Conventions\n\nNo entries here.');
    const index = buildKeywordIndex(testDir);
    expect(index.size).toBe(0);
  });

  it('indexes entries across multiple files', () => {
    writeSpecFile('coding-conventions.md', `
<spec-entry category="coding" keywords="imports,esm" date="2026-04-21">

### Use ESM imports

Always use ESM.

</spec-entry>
`);
    writeSpecFile('learnings.md', `
<spec-entry category="learning" keywords="auth,bug" date="2026-04-21">

### Auth Bug Found

Off-by-one error in auth.

</spec-entry>
`);

    const index = buildKeywordIndex(testDir);
    expect(index.has('imports')).toBe(true);
    expect(index.has('esm')).toBe(true);
    expect(index.has('auth')).toBe(true);
    expect(index.has('bug')).toBe(true);
  });

  it('maps same keyword to multiple entries', () => {
    writeSpecFile('coding-conventions.md', `
<spec-entry category="coding" keywords="auth,token" date="2026-04-21">

### Token Rotation

Rotate tokens.

</spec-entry>

<spec-entry category="coding" keywords="auth,session" date="2026-04-22">

### Session Management

Manage sessions properly.

</spec-entry>
`);

    const index = buildKeywordIndex(testDir);
    const authEntries = index.get('auth');
    expect(authEntries).toBeDefined();
    expect(authEntries!.length).toBe(2);
  });

  it('lowercases keywords for consistent matching', () => {
    writeSpecFile('coding-conventions.md', `
<spec-entry category="coding" keywords="Auth,TOKEN,JwT" date="2026-04-21">

### Mixed case keywords

Content.

</spec-entry>
`);

    const index = buildKeywordIndex(testDir);
    expect(index.has('auth')).toBe(true);
    expect(index.has('token')).toBe(true);
    expect(index.has('jwt')).toBe(true);
    // Should NOT have uppercase versions
    expect(index.has('Auth')).toBe(false);
    expect(index.has('TOKEN')).toBe(false);
  });

  it('stores correct metadata in indexed entries', () => {
    writeSpecFile('learnings.md', `
<spec-entry category="learning" keywords="cache,invalidation" date="2026-04-21">

### Cache Invalidation

Distributed lock required.

</spec-entry>
`);

    const index = buildKeywordIndex(testDir);
    const entries = index.get('cache');
    expect(entries).toBeDefined();
    expect(entries![0].file).toBe('learnings.md');
    expect(entries![0].category).toBe('learning');
    expect(entries![0].title).toBe('Cache Invalidation');
    expect(entries![0].keywords).toContain('cache');
    expect(entries![0].keywords).toContain('invalidation');
    expect(entries![0].id).toMatch(/^learnings\.md:\d+$/);
  });

  it('strips frontmatter before parsing', () => {
    writeSpecFile('coding-conventions.md', `---
title: Coding Conventions
category: coding
---

<spec-entry category="coding" keywords="format,indent" date="2026-04-21">

### Use 2 spaces

Two spaces for indentation.

</spec-entry>
`);

    const index = buildKeywordIndex(testDir);
    expect(index.has('format')).toBe(true);
    expect(index.has('indent')).toBe(true);
  });

  it('excludes deprecated entries from the keyword injection index', () => {
    writeSpecFile('coding-conventions.md', `
<spec-entry category="coding" keywords="active-rule" date="2026-07-28" status="active">

### Active Rule

Current guidance.

</spec-entry>

<spec-entry category="coding" keywords="retired-rule" date="2026-07-27" status="deprecated" superseded-by="S-current">

### Retired Rule

Outdated guidance.

</spec-entry>
`);

    const index = buildKeywordIndex(testDir);
    expect(index.has('active-rule')).toBe(true);
    expect(index.has('retired-rule')).toBe(false);
    expect([...index.values()].flat().map(entry => entry.title)).not.toContain('Retired Rule');
  });

  it('ignores non-md files', () => {
    writeFileSync(join(testDir, '.workflow', 'specs', 'notes.txt'), 'not a spec');
    writeSpecFile('coding-conventions.md', `
<spec-entry category="coding" keywords="test" date="2026-04-21">

### Entry

Content.

</spec-entry>
`);

    const index = buildKeywordIndex(testDir);
    expect(index.size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// lookupKeyword
// ---------------------------------------------------------------------------

describe('lookupKeyword', () => {
  it('returns matching entries for existing keyword', () => {
    writeSpecFile('coding-conventions.md', `
<spec-entry category="coding" keywords="auth,security" date="2026-04-21">

### Auth Guard

Implement auth guards.

</spec-entry>
`);

    const index = buildKeywordIndex(testDir);
    const results = lookupKeyword(index, 'auth');
    expect(results.length).toBe(1);
    expect(results[0].title).toBe('Auth Guard');
  });

  it('returns empty array for non-existing keyword', () => {
    writeSpecFile('coding-conventions.md', `
<spec-entry category="coding" keywords="auth" date="2026-04-21">

### Entry

Content.

</spec-entry>
`);

    const index = buildKeywordIndex(testDir);
    const results = lookupKeyword(index, 'nonexistent');
    expect(results.length).toBe(0);
  });

  it('is case-insensitive in lookup (lowercases input)', () => {
    writeSpecFile('coding-conventions.md', `
<spec-entry category="coding" keywords="auth" date="2026-04-21">

### Entry

Content.

</spec-entry>
`);

    const index = buildKeywordIndex(testDir);
    // lookupKeyword lowercases input, so 'AUTH' → 'auth' → matches
    expect(lookupKeyword(index, 'AUTH').length).toBe(1);
    expect(lookupKeyword(index, 'auth').length).toBe(1);
    expect(lookupKeyword(index, 'Auth').length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// lookupKeywords (multiple keywords, dedup)
// ---------------------------------------------------------------------------

describe('lookupKeywords', () => {
  it('returns entries matching any of the provided keywords', () => {
    writeSpecFile('coding-conventions.md', `
<spec-entry category="coding" keywords="auth" date="2026-04-21">

### Auth Entry

Content A.

</spec-entry>

<spec-entry category="coding" keywords="cache" date="2026-04-22">

### Cache Entry

Content B.

</spec-entry>

<spec-entry category="coding" keywords="naming" date="2026-04-23">

### Naming Entry

Content C.

</spec-entry>
`);

    const index = buildKeywordIndex(testDir);
    const results = lookupKeywords(index, ['auth', 'cache']);
    expect(results.length).toBe(2);
    expect(results.map(e => e.title)).toContain('Auth Entry');
    expect(results.map(e => e.title)).toContain('Cache Entry');
  });

  it('deduplicates entries matched by multiple keywords', () => {
    writeSpecFile('coding-conventions.md', `
<spec-entry category="coding" keywords="auth,token,security" date="2026-04-21">

### Multi-keyword Entry

Content.

</spec-entry>
`);

    const index = buildKeywordIndex(testDir);
    // Entry matches both 'auth' and 'token' but should appear only once
    const results = lookupKeywords(index, ['auth', 'token', 'security']);
    expect(results.length).toBe(1);
    expect(results[0].title).toBe('Multi-keyword Entry');
  });

  it('returns empty for empty keyword list', () => {
    writeSpecFile('coding-conventions.md', `
<spec-entry category="coding" keywords="test" date="2026-04-21">

### Entry

Content.

</spec-entry>
`);

    const index = buildKeywordIndex(testDir);
    const results = lookupKeywords(index, []);
    expect(results.length).toBe(0);
  });
});
