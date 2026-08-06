// src/graph/kg/extraction/orchestrator.ts — 统一编排: code + knowledge → 同一 DB
// 参考: plan-maestrograph.md 第三节 Unified Extraction Pipeline

import { isAbsolute, relative, resolve } from 'node:path';
import { existsSync, realpathSync } from 'node:fs';
import type { MaestroGraph } from '../engine.js';
import { KnowledgeExtractorRegistry } from './knowledge-extractor-registry.js';
import { forEachCodeExtractionResult } from './code/code-extractor.js';
import { resolveKnowledgeEdges } from '../resolution/knowledge-resolver.js';
import { resolveCodeReferences } from '../resolution/code-resolver.js';
import type { SyncResult, SourceType } from '../db/types.js';
import { FileLock } from '../sync/file-lock.js';
import { writeSyncState, getGitHead } from '../sync-state.js';

export interface CodegraphSyncOptions {
  srcDirs?: string[];
  includeTests?: boolean;
  maxFileSize?: number;
  excludeDirs?: string[];
  excludeFiles?: string[];
  createMaestroIgnore?: boolean;
  allowExtractorScripts?: boolean;
}

export interface SyncKnowledgeGraphOptions {
  full?: boolean;
  sources?: SourceType[];
  codegraph?: CodegraphSyncOptions;
  /** Existing graph connection. The caller retains lifecycle ownership. */
  graph?: MaestroGraph;
}

export async function syncKnowledgeGraph(
  projectPath: string,
  options?: SyncKnowledgeGraphOptions,
): Promise<SyncResult[]> {
  const lockPath = resolve(projectPath, '.workflow', 'kg', 'maestro.db.lock');
  return new FileLock(lockPath).withLock(() => syncKnowledgeGraphUnlocked(projectPath, options));
}

async function syncKnowledgeGraphUnlocked(
  projectPath: string,
  options?: SyncKnowledgeGraphOptions,
): Promise<SyncResult[]> {
  const workflowRoot = resolve(projectPath, '.workflow');
  const results: SyncResult[] = [];

  // 初始化或打开 DB。传入 graph 时由调用方持有生命周期。
  let mg = options?.graph;
  const ownsGraph = !mg;
  const dbPath = resolve(workflowRoot, 'kg', 'maestro.db');
  if (!mg) {
    const { MaestroGraph: MaestroGraphImpl } = await import('../engine.js');
    mg = existsSync(dbPath)
      ? await MaestroGraphImpl.open(projectPath)
      : await MaestroGraphImpl.init(projectPath);
  }

  try {
    const shouldSync = (source: string): boolean => {
      if (!options?.sources) return true;
      return options.sources.includes(source as SourceType);
    };

    // ── Knowledge sources (优先同步) ───────────────────────────────
    const queries = mg.getQueryBuilder();

    const changedKnowledgeNodes = new Map<string, string>();
    for (const entry of KnowledgeExtractorRegistry.getAll()) {
      if (!shouldSync(entry.sourceType)) continue;

      const startMs = Date.now();
      try {
        const sourcePath = entry.resolvePath(workflowRoot);
        const extractionResult = entry.extractFn(sourcePath, workflowRoot);
        for (const node of extractionResult.nodes) {
          if (node.body) changedKnowledgeNodes.set(node.id, node.body);
        }
        const removed = mg.getConnection().transaction(() => {
          const n = queries.deleteNodesBySourceType(entry.sourceType);
          if (extractionResult.nodes.length > 0) {
            queries.insertNodes(extractionResult.nodes);
            queries.insertEdges(extractionResult.edges);
            queries.upsertFile(extractionResult.fileRecord);
          }
          return n;
        });
        results.push({
          source: entry.sourceType,
          nodesAdded: extractionResult.nodes.length,
          nodesUpdated: 0,
          nodesRemoved: removed,
          edgesAdded: extractionResult.edges.length,
          edgesRemoved: 0,
          durationMs: Date.now() - startMs,
        });
      } catch (err) {
        process.stderr.write(`[MaestroGraph] Failed to sync ${entry.sourceType}: ${err instanceof Error ? err.message : String(err)}\n`);
        results.push({
          source: entry.sourceType,
          nodesAdded: 0,
          nodesUpdated: 0,
          nodesRemoved: 0,
          edgesAdded: 0,
          edgesRemoved: 0,
          durationMs: Date.now() - startMs,
        });
      }
    }

    // ── Code extraction (R3) ───────────────────────────────────────

    if (shouldSync('codegraph')) {
      const startMs = Date.now();
      const candidateDirs = options?.codegraph?.srcDirs?.length
        ? options.codegraph.srcDirs
        : [projectPath];
      const srcDirs = candidateDirs
        .map(d => resolveSourceDirectory(projectPath, d))
        .filter((d): d is string => d !== null);

      let totalNodes = 0;
      let totalEdges = 0;
      let stagedEdges = 0;
      let stagedRefs = 0;
      const connection = mg.getConnection();
      const removedCode = await connection.transactionAsync(async () => {
        const removed = queries.deleteNodesBySourceType('codegraph');
        // 同步清理 codegraph 的 files 行 — 修复 files 表残留 (已删文件/目录冒充/旧快照并集)
        connection.raw.exec("DELETE FROM files WHERE source_type = 'codegraph'");
        connection.raw.exec(`
          DROP TABLE IF EXISTS temp._kg_pending_edges;
          CREATE TEMP TABLE _kg_pending_edges (
            source TEXT NOT NULL,
            target TEXT NOT NULL,
            kind TEXT NOT NULL,
            metadata TEXT,
            line INTEGER,
            col INTEGER,
            provenance TEXT
          );
        `);
        const stageEdge = connection.raw.prepare(`
          INSERT INTO _kg_pending_edges (source, target, kind, metadata, line, col, provenance)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `);
        const stageRef = connection.raw.prepare(`
          INSERT INTO unresolved_refs (from_node_id, reference_name, reference_kind, line, col, file_path, language)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `);

        for (const srcDir of srcDirs) {
          await forEachCodeExtractionResult({
            projectRoot: projectPath,
            srcDir,
            includeTests: options?.codegraph?.includeTests ?? false,
            maxFileSize: options?.codegraph?.maxFileSize ?? 1024 * 1024,
            excludeDirs: options?.codegraph?.excludeDirs,
            excludeFiles: options?.codegraph?.excludeFiles,
            createMaestroIgnore: options?.codegraph?.createMaestroIgnore,
            allowExtractorScripts: options?.codegraph?.allowExtractorScripts,
          }, (result) => {
            if (result.nodes.length === 0) return;
            totalNodes += queries.insertNodes(result.nodes);
            queries.upsertFile(result.fileRecord);
            for (const edge of result.edges) {
              stageEdge.run(
                edge.source,
                edge.target,
                edge.kind,
                edge.metadata && Object.keys(edge.metadata).length > 0 ? JSON.stringify(edge.metadata) : null,
                edge.line ?? null,
                edge.column ?? null,
                edge.provenance ?? null,
              );
              stagedEdges++;
            }
            // 未解析引用 (imports/calls) → unresolved_refs, 供 resolveCodeReferences 解析为边
            for (const ref of result.references ?? []) {
              stageRef.run(
                ref.fromSymbolId,
                ref.referenceName,
                ref.referenceKind,
                ref.line ?? 0,
                ref.col ?? 0,
                ref.filePath,
                ref.language,
              );
              stagedRefs++;
            }
          });
        }

        totalEdges = Number(connection.raw.prepare(`
          INSERT INTO edges (source, target, kind, metadata, line, col, provenance)
          SELECT p.source, p.target, p.kind, p.metadata, p.line, p.col, p.provenance
          FROM _kg_pending_edges p
          JOIN nodes source_node ON source_node.id = p.source
          JOIN nodes target_node ON target_node.id = p.target
        `).run().changes);
        connection.raw.exec('DROP TABLE _kg_pending_edges');
        return removed;
      });
      if (totalEdges !== stagedEdges) {
        process.stderr.write(`[MaestroGraph] Skipped ${stagedEdges - totalEdges} unresolved code edge(s) during atomic replacement.\n`);
      }

      results.push({
        source: 'codegraph',
        nodesAdded: totalNodes,
        nodesUpdated: 0,
        nodesRemoved: removedCode,
        edgesAdded: totalEdges,
        edgesRemoved: 0,
        durationMs: Date.now() - startMs,
      });

      // 记录同步水位 — kg-sync hook 据此发现"已提交但未同步"的变更
      writeSyncState(projectPath, getGitHead(projectPath));
    }

    // ── Code reference resolution (unresolved_refs → edges) ────────
    // 接通两阶段模型: extraction → unresolved_refs → resolution → edges
    // 产 imports (file→file) 与 calls (file→symbol) 边, provenance='code-resolution'
    if (shouldSync('codegraph')) {
      const codeStartMs = Date.now();
      const codeResult = resolveCodeReferences(mg.getConnection().raw, { projectPath });
      results.push({
        source: 'code-resolution',
        nodesAdded: 0,
        nodesUpdated: 0,
        nodesRemoved: 0,
        edgesAdded: codeResult.edgesCreated,
        edgesRemoved: 0,
        durationMs: Date.now() - codeStartMs,
      });
    }

    // ── Cross-source edge resolution ────────────────────────────────

    const resolveStartMs = Date.now();
    const resolveResult = resolveKnowledgeEdges(mg.getConnection().raw, { projectPath });
    results.push({
      source: 'knowledge-resolution',
      nodesAdded: 0,
      nodesUpdated: 0,
      nodesRemoved: 0,
      edgesAdded: resolveResult.totalEdgesCreated,
      edgesRemoved: 0,
      durationMs: resolveResult.durationMs,
    });

    // ── Credibility hash sync (incremental) ────────────────────────
    try {
      const { CredibilityStore, contentHash } = await import('../credibility.js');
      const store = new CredibilityStore(mg.getConnection().raw);
      const knowledgeSources: SourceType[] = ['domain', 'spec', 'knowhow', 'codebase', 'issue'];
      const nowMs = Date.now();
      mg.getConnection().transaction(() => {
        for (const [nodeId, body] of changedKnowledgeNodes) {
          store.upsert(nodeId, contentHash(body), nowMs);
        }
        // 清理陈旧 codegraph 消费痕迹 — 指向已不存在节点的 credibility 记录
        mg.getConnection().raw.prepare(
          `DELETE FROM credibility WHERE node_id LIKE 'code:%' AND node_id NOT IN (SELECT id FROM nodes)`
        ).run();
        store.cleanOrphans();
      });
    } catch (err) {
      process.stderr.write(`[MaestroGraph] Credibility sync skipped: ${err instanceof Error ? err.message : String(err)}\n`);
    }

    // ── FTS 一致性校验 + 修复 (code_fts/knowledge_fts 必须按 source_type 过滤回填) ──
    // 历史版本曾无过滤全表回填导致两表各含全部节点 (99.6% 为跨类空壳), 此处重建为过滤版。
    try {
      ensureFtsConsistency(mg.getConnection().raw);
    } catch (err) {
      process.stderr.write(`[MaestroGraph] FTS consistency check failed: ${err instanceof Error ? err.message : String(err)}\n`);
    }

    // ── Project metadata (审计/健康度) ─────────────────────────────
    try {
      const now = Date.now();
      const upsertMeta = mg.getConnection().raw.prepare(
        `INSERT OR REPLACE INTO project_metadata (key, value, updated_at) VALUES (?, ?, ?)`
      );
      upsertMeta.run('last_sync_at', String(now), now);
      upsertMeta.run('last_sync_head', getGitHead(projectPath) ?? '', now);
      upsertMeta.run('schema_version', String(getSchemaVersion(mg.getConnection().raw)), now);
      const stats = mg.getStats();
      if (stats.detectedFrameworks.length > 0) {
        upsertMeta.run('detected_frameworks', JSON.stringify(stats.detectedFrameworks), now);
      }
    } catch (err) {
      process.stderr.write(`[MaestroGraph] project_metadata sync skipped: ${err instanceof Error ? err.message : String(err)}\n`);
    }

    return results;
  } finally {
    if (ownsGraph) mg.close();
  }
}

function resolveSourceDirectory(projectPath: string, inputPath: string): string | null {
  const candidate = resolve(projectPath, inputPath);
  if (!existsSync(candidate)) return null;
  const root = realpathSync(projectPath);
  const actual = realpathSync(candidate);
  const rel = relative(root, actual);
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) return actual;
  throw new Error(`Code source directory must be inside project root: ${inputPath}`);
}

// ── FTS 一致性校验 + 重建 ───────────────────────────────────────────────
// 语义 (schema.sql): code_fts 只含 codegraph 节点, knowledge_fts 只含知识节点。
// 历史版本曾无过滤全表回填 (两表各 = 全部节点); 外部内容表模式又忽略触发器 WHERE。
// 现在 FTS 为内部存储表 + INSERT 触发器过滤; DELETE/REPLACE 不直接删 FTS
// (FTS5 delete 命令无法在触发器中按 source_type 过滤, 且内部表允许重复 rowid),
// 因此每次同步末尾无条件重建, 保证索引与 nodes 完全一致。
function ensureFtsConsistency(db: import('node:sqlite').DatabaseSync): void {
  const codeNodes = Number(db.prepare(
    "SELECT COUNT(*) FROM nodes WHERE source_type = 'codegraph'"
  ).get()?.['COUNT(*)'] ?? 0);
  const knowledgeNodes = Number(db.prepare(
    "SELECT COUNT(*) FROM nodes WHERE source_type != 'codegraph'"
  ).get()?.['COUNT(*)'] ?? 0);
  const codeFts = Number(db.prepare('SELECT COUNT(*) FROM code_fts').get()?.['COUNT(*)'] ?? -1);
  const knowledgeFts = Number(db.prepare('SELECT COUNT(*) FROM knowledge_fts').get()?.['COUNT(*)'] ?? -1);

  if (codeFts === codeNodes && knowledgeFts === knowledgeNodes) return;

  process.stderr.write(
    `[MaestroGraph] FTS drift detected (code_fts=${codeFts}/${codeNodes}, knowledge_fts=${knowledgeFts}/${knowledgeNodes}) — rebuilding filtered indexes\n`
  );
  db.exec(`
    DROP TABLE IF EXISTS code_fts;
    CREATE VIRTUAL TABLE code_fts USING fts5(
      id, name, qualified_name, docstring, signature, keywords,
      tokenize = 'unicode61 remove_diacritics 2'
    );
    INSERT INTO code_fts(rowid, id, name, qualified_name, docstring, signature, keywords)
    SELECT rowid, id, name, qualified_name, docstring, signature, keywords
    FROM nodes WHERE source_type = 'codegraph';

    DROP TABLE IF EXISTS knowledge_fts;
    CREATE VIRTUAL TABLE knowledge_fts USING fts5(
      id, name, definition, body, aliases, keywords,
      tokenize = 'trigram'
    );
    INSERT INTO knowledge_fts(rowid, id, name, definition, body, aliases, keywords)
    SELECT rowid, id, name, definition, body, aliases, keywords
    FROM nodes WHERE source_type != 'codegraph';
  `);
}

function getSchemaVersion(db: import('node:sqlite').DatabaseSync): number {
  try {
    const row = db.prepare(
      "SELECT version FROM schema_versions ORDER BY version DESC LIMIT 1"
    ).get() as { version?: number } | undefined;
    return row?.version ?? 0;
  } catch {
    return 0;
  }
}
