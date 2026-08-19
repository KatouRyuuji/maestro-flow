import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveCodeReferences } from '../resolution/code-resolver.js';
import { makeFileNodeId, makeCodeNodeId } from '../extraction/code/tree-sitter-types.js';

// ---------------------------------------------------------------------------
// Fixture: 内存 DB 模拟一次 codegraph 同步后的状态
//   - 两个 file 节点 + 两个符号 (helper / refresh)
//   - unresolved_refs: imports (./helper) + calls (helper / refresh)
// ---------------------------------------------------------------------------

let db: DatabaseSync;
let projectRoot: string;
let indexFile: string;
let helperFile: string;

beforeAll(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'kg-code-resolver-'));
  // tsconfig 别名: @/* → ./src/*
  writeFileSync(join(projectRoot, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { paths: { '@/*': ['./src/*'] } },
  }));
  // 真实磁盘文件 — ImportResolver 基于 existsSync 解析相对路径
  mkdirSync(join(projectRoot, 'src'), { recursive: true });
  writeFileSync(join(projectRoot, 'src', 'index.ts'), 'export {}');
  writeFileSync(join(projectRoot, 'src', 'helper.ts'), 'export function helper() {}');

  const indexFileTmp = join(projectRoot, 'src', 'index.ts').replace(/\\/g, '/');
  const helperFileTmp = join(projectRoot, 'src', 'helper.ts').replace(/\\/g, '/');
  indexFile = indexFileTmp;
  helperFile = helperFileTmp;

  db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE nodes (
      id TEXT PRIMARY KEY, name TEXT, kind TEXT, file_path TEXT, source_type TEXT,
      is_exported INTEGER DEFAULT 0, status TEXT DEFAULT 'active', definition TEXT, body TEXT,
      aliases TEXT, keywords TEXT
    );
    CREATE TABLE edges (
      id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT, target TEXT, kind TEXT,
      metadata TEXT, line INTEGER, col INTEGER, provenance TEXT
    );
    CREATE TABLE unresolved_refs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, from_node_id TEXT, reference_name TEXT,
      reference_kind TEXT, line INTEGER, col INTEGER, candidates TEXT,
      file_path TEXT, language TEXT
    );
  `);

  const entryFile = makeFileNodeId(indexFile);
  const helperFileNode = makeFileNodeId(helperFile);
  const insert = db.prepare(
    `INSERT INTO nodes (id, name, kind, file_path, source_type, status) VALUES (?, ?, ?, ?, 'codegraph', 'active')`
  );
  insert.run(entryFile, 'index.ts', 'file', indexFile);
  insert.run(helperFileNode, 'helper.ts', 'file', helperFile);
  insert.run(makeCodeNodeId(helperFile, 'helper'), 'helper', 'function', helperFile);
  insert.run(makeCodeNodeId(indexFile, 'Engine.refresh'), 'refresh', 'method', indexFile);

  const ref = db.prepare(
    `INSERT INTO unresolved_refs (from_node_id, reference_name, reference_kind, line, col, file_path, language)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  // 相对导入 ./helper
  ref.run(entryFile, './helper', 'imports', 1, 1, indexFile, 'typescript');
  // 别名导入 @/services/thing (tsconfig paths) — 目标文件不存在 → 不建边
  ref.run(entryFile, '@/services/thing', 'imports', 2, 1, indexFile, 'typescript');
  // 外部包导入 react — 不解析
  ref.run(entryFile, 'react', 'imports', 3, 1, indexFile, 'typescript');
  // calls: helper (跨文件符号)
  ref.run(entryFile, 'helper', 'calls', 10, 5, indexFile, 'typescript');
  // calls: refresh (同文件方法)
  ref.run(entryFile, 'refresh', 'calls', 20, 5, indexFile, 'typescript');
  // calls: 无匹配符号 (外部/DOM) → 不建边
  ref.run(entryFile, 'document', 'calls', 30, 5, indexFile, 'typescript');
});

afterAll(() => {
  db.close();
  rmSync(projectRoot, { recursive: true, force: true });
});

describe('resolveCodeReferences', () => {
  it('resolves relative imports into file→file edges', () => {
    const result = resolveCodeReferences(db, { projectPath: projectRoot });
    const imports = result.edges.filter(e => e.kind === 'imports');
    const relImport = imports.find(e => e.target === makeFileNodeId(helperFile));
    expect(relImport).toBeDefined();
    expect(relImport!.source).toBe(makeFileNodeId(indexFile));
    expect(relImport!.provenance).toBe('code-resolution');
  });

  it('does not create edges for unresolvable imports (alias miss / external package)', () => {
    const result = resolveCodeReferences(db, { projectPath: projectRoot });
    const imports = result.edges.filter(e => e.kind === 'imports');
    // 只有 ./helper 一条可解析 (别名目标文件不存在, react 是外部包)
    expect(imports.length).toBe(1);
  });

  it('creates calls edges only for symbols that exist in the graph', () => {
    const result = resolveCodeReferences(db, { projectPath: projectRoot });
    const calls = result.edges.filter(e => e.kind === 'calls');
    const targets = calls.map(c => c.target);
    expect(targets).toContain(makeCodeNodeId(helperFile, 'helper'));
    expect(targets).toContain(makeCodeNodeId(indexFile, 'Engine.refresh'));
    // document 无匹配符号 → 不建边
    expect(targets.some(t => t.includes('document'))).toBe(false);
  });

  it('is idempotent — re-running replaces old code-resolution edges', () => {
    resolveCodeReferences(db, { projectPath: projectRoot });
    const second = resolveCodeReferences(db, { projectPath: projectRoot });
    const count = db.prepare("SELECT COUNT(*) n FROM edges WHERE provenance = 'code-resolution'").get() as { n: number };
    expect(count.n).toBe(second.edgesCreated);
  });

  it('reports only persisted edges and unresolved references', () => {
    const result = resolveCodeReferences(db, { projectPath: projectRoot });
    expect(result).toMatchObject({
      edgesCreated: 3,
      importsEdges: 1,
      callsEdges: 2,
      unresolvedCount: 3,
    });
    expect(result.edges).toHaveLength(result.edgesCreated);
  });

  it('can participate in a caller-owned transaction without nesting BEGIN', () => {
    const before = db.prepare(
      "SELECT COUNT(*) n FROM edges WHERE provenance = 'code-resolution'"
    ).get() as { n: number };
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = resolveCodeReferences(db, {
        projectPath: projectRoot,
        transactionMode: 'caller-owned',
      });
      expect(result.edgesCreated).toBe(3);
    } finally {
      db.exec('ROLLBACK');
    }
    const after = db.prepare(
      "SELECT COUNT(*) n FROM edges WHERE provenance = 'code-resolution'"
    ).get() as { n: number };
    expect(after.n).toBe(before.n);
  });
});

// ---------------------------------------------------------------------------
// Function-granularity reattribution: when nodes carry start_line/end_line,
// a call edge's source is reattributed from the <file> node to the function
// that lexically encloses the call line. This is what enables per-function
// callers/callees/impact traversal (defensive-programming backward-slice +
// forward-propagate). Falls back to file-node source when columns are absent
// or no enclosing function spans the call line.
// ---------------------------------------------------------------------------
describe('resolveCodeReferences — function-granularity call reattribution', () => {
  let rdb: DatabaseSync;
  let rProjectRoot: string;
  let simFile: string;

  beforeAll(() => {
    rProjectRoot = mkdtempSync(join(tmpdir(), 'kg-reattrib-'));
    mkdirSync(join(rProjectRoot, 'src'), { recursive: true });
    writeFileSync(join(rProjectRoot, 'src', 'simulation_adapter.py'), '');
    simFile = join(rProjectRoot, 'src', 'simulation_adapter.py').replace(/\\/g, '/');

    rdb = new DatabaseSync(':memory:');
    rdb.exec(`
      CREATE TABLE nodes (
        id TEXT PRIMARY KEY, name TEXT, kind TEXT, file_path TEXT, source_type TEXT,
        is_exported INTEGER DEFAULT 0, status TEXT DEFAULT 'active', definition TEXT, body TEXT,
        aliases TEXT, keywords TEXT,
        start_line INTEGER, end_line INTEGER
      );
      CREATE TABLE edges (
        id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT, target TEXT, kind TEXT,
        metadata TEXT, line INTEGER, col INTEGER, provenance TEXT
      );
      CREATE TABLE unresolved_refs (
        id INTEGER PRIMARY KEY AUTOINCREMENT, from_node_id TEXT, reference_name TEXT,
        reference_kind TEXT, line INTEGER, col INTEGER, candidates TEXT,
        file_path TEXT, language TEXT
      );
    `);

    const fileNode = makeFileNodeId(simFile);
    const runSim = makeCodeNodeId(simFile, 'run_simulation');
    const adapter = makeCodeNodeId(simFile, 'simulation_adapter');
    const obj = makeCodeNodeId(simFile, 'objective');
    const evalFn = makeCodeNodeId(simFile, 'evaluate');
    const insert = rdb.prepare(
      `INSERT INTO nodes (id, name, kind, file_path, source_type, status, start_line, end_line) VALUES (?, ?, ?, ?, 'codegraph', 'active', ?, ?)`
    );
    insert.run(fileNode, 'simulation_adapter.py', 'file', simFile, null, null);
    insert.run(runSim, 'run_simulation', 'function', simFile, 15, 22);
    insert.run(adapter, 'simulation_adapter', 'function', simFile, 25, 32);
    insert.run(makeCodeNodeId(simFile, 'result_parser'), 'result_parser', 'function', simFile, 35, 38);
    insert.run(obj, 'objective', 'function', simFile, 41, 46);
    insert.run(evalFn, 'evaluate', 'function', simFile, 49, 51);

    // calls: simulation_adapter (L30) calls run_simulation; objective (L44) calls
    // simulation_adapter + result_parser; evaluate (L51) calls objective.
    const ref = rdb.prepare(
      `INSERT INTO unresolved_refs (from_node_id, reference_name, reference_kind, line, col, file_path, language) VALUES (?, ?, 'calls', ?, 1, ?, 'python')`
    );
    ref.run(fileNode, 'run_simulation', 30, simFile);
    ref.run(fileNode, 'result_parser', 44, simFile);
    ref.run(fileNode, 'simulation_adapter', 44, simFile);
    ref.run(fileNode, 'objective', 51, simFile);
  });

  afterAll(() => { try { rmSync(rProjectRoot, { recursive: true, force: true }); } catch { /* ignore */ } });

  it('reattributes call-edge source to the enclosing function node', () => {
    const result = resolveCodeReferences(rdb, { projectPath: rProjectRoot });
    const calls = result.edges.filter(e => e.kind === 'calls');
    // source should now be the enclosing function, not the <file> node
    const fileNode = makeFileNodeId(simFile);
    const byTarget = new Map(calls.map(c => [c.target, c.source]));
    // run_simulation called at L30 inside simulation_adapter (L25-32)
    expect(byTarget.get(makeCodeNodeId(simFile, 'run_simulation'))).toBe(makeCodeNodeId(simFile, 'simulation_adapter'));
    // result_parser called at L44 inside objective (L41-46)
    expect(byTarget.get(makeCodeNodeId(simFile, 'result_parser'))).toBe(makeCodeNodeId(simFile, 'objective'));
    // simulation_adapter called at L44 inside objective (L41-46)
    expect(byTarget.get(makeCodeNodeId(simFile, 'simulation_adapter'))).toBe(makeCodeNodeId(simFile, 'objective'));
    // objective called at L51 inside evaluate (L49-51)
    expect(byTarget.get(makeCodeNodeId(simFile, 'objective'))).toBe(makeCodeNodeId(simFile, 'evaluate'));
    // NONE of the call edges should still source from the <file> node
    expect(calls.every(c => c.source !== fileNode)).toBe(true);
  });

  it('enables function-level callers (backward slice)', () => {
    resolveCodeReferences(rdb, { projectPath: rProjectRoot });
    // callers of result_parser = [objective]
    const callers = rdb.prepare(
      `SELECT source FROM edges WHERE kind='calls' AND target=? AND provenance='code-resolution'`
    ).all(makeCodeNodeId(simFile, 'result_parser')) as Array<{ source: string }>;
    expect(callers.map(c => c.source)).toContain(makeCodeNodeId(simFile, 'objective'));
  });
});
