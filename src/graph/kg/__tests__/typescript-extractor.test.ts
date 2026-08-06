import { describe, it, expect, beforeAll } from 'vitest';
import { CodeParseRunner } from '../extraction/code/worker-parser.js';
import { isTreeSitterAvailable } from '../extraction/code/tree-sitter.js';
import type { ExtractedSymbol, ExtractedReference, LanguageExtractionResult } from '../extraction/code/tree-sitter-types.js';

// ---------------------------------------------------------------------------
// Fixture — TS source exercising JSDoc, decorators, and generics.
// ---------------------------------------------------------------------------

const SOURCE = `
/**
 * A generic repository.
 * Manages entities.
 */
@Injectable
@Component({ selector: 'app' })
export class Repository<T, U extends Entity> {
  /** Find an item by id. */
  async findById(id: string): Promise<T> {
    return null as unknown as T;
  }
}

/**
 * Standalone transform function.
 */
export function transform<Input, Output>(input: Input): Output {
  return null as unknown as Output;
}
`;

const CALLBACK_SOURCE = `
import { helper } from './helper';
import { service } from '@/services/thing';

export function run(items: Array<{ id: string }>) {
  // 箭头回调 — 参数名绝不产生符号
  const names = items.map(item => item.id);
  const doubled = items.map((entry) => entry.id + entry.id);

  // 具名箭头函数
  const pick = (entry: { id: string }) => entry.id;

  // 调用引用
  helper(names);
  service.get();
  this.refresh();

  return names;
}

class Engine {
  refresh(): void {
    this.tick();
  }
  tick(): void {
    /* noop */
  }
}
`;

let symbols: ExtractedSymbol[] = [];
let references: ExtractedReference[] = [];
let edges: LanguageExtractionResult['edges'] = [];
let parsed = false;

beforeAll(async () => {
  if (!isTreeSitterAvailable()) return;
  const runner = new CodeParseRunner();
  try {
    const result = await runner.extract(SOURCE, 'typescript', 'repo.ts');
    symbols = result?.symbols ?? [];
    references = result?.references ?? [];
    edges = result?.edges ?? [];
    parsed = result !== null;
  } finally {
    runner.dispose();
  }
});

function findSymbol(name: string): ExtractedSymbol | undefined {
  return symbols.find((s) => s.name === name);
}

// Skip the whole suite when the WASM runtime is unavailable in this env.
describe.skipIf(!isTreeSitterAvailable())('typescriptExtractor: JSDoc / decorator / typeParameters', () => {
  it('parses the fixture (sanity)', () => {
    expect(parsed).toBe(true);
    expect(symbols.length).toBeGreaterThan(0);
  });

  it('extracts a multi-line JSDoc docstring for an exported class', () => {
    const repo = findSymbol('Repository');
    expect(repo).toBeDefined();
    expect(repo!.docstring).toContain('A generic repository');
    expect(repo!.docstring).toContain('Manages entities');
    // Comment markers must be stripped.
    expect(repo!.docstring).not.toContain('/**');
    expect(repo!.docstring).not.toContain('*/');
  });

  it('extracts decorator names (without @ or arguments)', () => {
    const repo = findSymbol('Repository');
    expect(repo).toBeDefined();
    expect(repo!.decorators).toContain('Injectable');
    expect(repo!.decorators).toContain('Component');
  });

  it('extracts generic type parameter names from a class', () => {
    const repo = findSymbol('Repository');
    expect(repo).toBeDefined();
    expect(repo!.typeParameters).toEqual(['T', 'U']);
  });

  it('extracts JSDoc + type parameters for an exported function', () => {
    const transform = findSymbol('transform');
    expect(transform).toBeDefined();
    expect(transform!.docstring).toContain('Standalone transform function');
    expect(transform!.typeParameters).toEqual(['Input', 'Output']);
  });

  it('extracts a single-line JSDoc for a class method', () => {
    const findById = findSymbol('findById');
    expect(findById).toBeDefined();
    expect(findById!.docstring).toContain('Find an item by id');
  });

  it('leaves docstring/decorators/typeParameters empty when absent', () => {
    const findById = findSymbol('findById');
    expect(findById).toBeDefined();
    expect(findById!.decorators).toEqual([]);
    expect(findById!.typeParameters).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 回归断言: 边缺失 / 伪符号 / 引用收集 (本次修复引入)
// ---------------------------------------------------------------------------

describe.skipIf(!isTreeSitterAvailable())('typescriptExtractor: edges / references / arrow fix', () => {
  let cbSymbols: ExtractedSymbol[] = [];
  let cbReferences: ExtractedReference[] = [];
  let cbEdges: LanguageExtractionResult['edges'] = [];

  beforeAll(async () => {
    const runner = new CodeParseRunner();
    try {
      const result = await runner.extract(CALLBACK_SOURCE, 'typescript', 'callback.ts');
      cbSymbols = result?.symbols ?? [];
      cbReferences = result?.references ?? [];
      cbEdges = result?.edges ?? [];
    } finally {
      runner.dispose();
    }
  });

  it('produces contains edges for nested symbols (class → method)', () => {
    const contains = edges.filter(e => e.kind === 'contains');
    expect(contains.length).toBeGreaterThan(0);
    // Repository → findById
    const repoToMethod = contains.find(e =>
      e.source === 'code:repo.ts:Repository' && e.target === 'code:repo.ts:Repository.findById');
    expect(repoToMethod).toBeDefined();
  });

  it('collects imports references anchored to the file node', () => {
    const imports = cbReferences.filter(r => r.referenceKind === 'imports');
    expect(imports.length).toBeGreaterThanOrEqual(2);
    expect(imports[0]!.fromSymbolId).toBe('code:callback.ts:<file>');
  });

  it('collects calls references (direct, member, this-method)', () => {
    const calls = cbReferences.filter(r => r.referenceKind === 'calls');
    const names = calls.map(c => c.referenceName);
    expect(names).toContain('helper');
    expect(names).toContain('get');
    expect(names).toContain('refresh');
    expect(names).toContain('tick');
  });

  it('never treats arrow function parameters as symbol names', () => {
    // item / entry 是回调参数 — 绝不产生同名符号
    expect(cbSymbols.some(s => s.name === 'item')).toBe(false);
    expect(cbSymbols.some(s => s.name === 'entry' && s.kind === 'function')).toBe(false);
  });

  it('keeps named arrow functions as symbols (const pick = ...)', () => {
    const pick = cbSymbols.find(s => s.name === 'pick');
    expect(pick).toBeDefined();
    expect(pick!.kind).toBe('function');
  });

  it('produces contains edges for named arrow function body symbols', () => {
    // run → 具名箭头函数 pick (父级 run 之下)
    const runPick = cbEdges.find(e =>
      e.kind === 'contains' && e.source === 'code:callback.ts:run' && e.target === 'code:callback.ts:run.pick');
    expect(runPick).toBeDefined();
  });
});
