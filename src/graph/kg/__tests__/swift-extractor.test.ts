import { describe, it, expect, beforeAll } from 'vitest';
import { CodeParseRunner } from '../extraction/code/worker-parser.js';
import { isTreeSitterAvailable } from '../extraction/code/tree-sitter.js';
import type { ExtractedSymbol, ExtractedReference, LanguageExtractionResult } from '../extraction/code/tree-sitter-types.js';

// ---------------------------------------------------------------------------
// Fixture — Swift source exercising classes, protocols, conformance, calls.
// ---------------------------------------------------------------------------

const SWIFT_SOURCE = `
import Foundation

/// A repository protocol.
protocol RepositoryProtocol {
  func find(id: String) -> String
}

/// User repository.
final class UserRepository: RepositoryProtocol, Hashable {
  private var items: [String] = []

  /// Finds an item.
  func find(id: String) -> String {
    return helper(id) + items.joined()
  }

  static let shared = UserRepository()

  func helper(_ id: String) -> String {
    return "user:" + id
  }
}

struct User: Codable {
  let name: String
}

enum Status: String {
  case active
  case inactive
}

extension UserRepository {
  func count() -> Int {
    return items.count
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
    const result = await runner.extract(SWIFT_SOURCE, 'swift', 'repo.swift');
    symbols = result?.symbols ?? [];
    references = result?.references ?? [];
    edges = result?.edges ?? [];
    parsed = result !== null;
  } finally {
    runner.dispose();
  }
});

describe.skipIf(!isTreeSitterAvailable())('swiftExtractor: symbols / edges / references', () => {
  it('parses the fixture (sanity)', () => {
    expect(parsed).toBe(true);
    expect(symbols.length).toBeGreaterThan(0);
  });

  it('extracts top-level types with correct kinds', () => {
    const names = new Map(symbols.map(s => [s.qualifiedName, s.kind]));
    expect(names.get('RepositoryProtocol')).toBe('protocol');
    expect(names.get('UserRepository')).toBe('class');
    expect(names.get('User')).toBe('struct');
    expect(names.get('Status')).toBe('enum');
    expect(names.get('Status.active')).toBe('enum_member');
  });

  it('extracts nested methods with qualified names', () => {
    expect(symbols.some(s => s.qualifiedName === 'UserRepository.find')).toBe(true);
    expect(symbols.some(s => s.qualifiedName === 'UserRepository.helper')).toBe(true);
    expect(symbols.some(s => s.qualifiedName === 'UserRepository.count')).toBe(true); // extension 成员
  });

  it('produces contains edges for class → method hierarchy', () => {
    const contains = edges.filter(e => e.kind === 'contains');
    expect(contains.some(e => e.source === 'code:repo.swift:UserRepository' && e.target === 'code:repo.swift:UserRepository.find')).toBe(true);
    expect(contains.some(e => e.source === 'code:repo.swift:UserRepository' && e.target === 'code:repo.swift:UserRepository.helper')).toBe(true);
    expect(contains.some(e => e.source === 'code:repo.swift:Status' && e.target === 'code:repo.swift:Status.active')).toBe(true);
  });

  it('collects imports references anchored to the file node', () => {
    const imports = references.filter(r => r.referenceKind === 'imports');
    expect(imports.length).toBeGreaterThanOrEqual(1);
    expect(imports[0]!.fromSymbolId).toBe('code:repo.swift:<file>');
    expect(imports[0]!.referenceName).toBe('Foundation');
  });

  it('collects calls references (helper inside find)', () => {
    const calls = references.filter(r => r.referenceKind === 'calls');
    expect(calls.some(c => c.referenceName === 'helper')).toBe(true);
    expect(calls.some(c => c.referenceName === 'joined')).toBe(true);
  });

  it('collects protocol conformance as extends references', () => {
    const extendsRefs = references.filter(r => r.referenceKind === 'extends');
    const names = extendsRefs.map(r => r.referenceName);
    expect(names).toContain('RepositoryProtocol');
    expect(names).toContain('Hashable');
    expect(names).toContain('Codable');
  });

  it('extracts JSDoc-style docstring (/// comment)', () => {
    const find = symbols.find(s => s.qualifiedName === 'UserRepository.find');
    expect(find).toBeDefined();
    expect(find!.docstring).toContain('Finds an item');
  });
});
