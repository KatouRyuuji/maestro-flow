// src/graph/kg/db/migrations.ts — Schema 版本迁移

import type { KgDatabaseConnection } from './connection.js';
import { CREDIBILITY_MIGRATION_SQL } from '../credibility.js';

export interface MigrationStep {
  version: number;
  description: string;
  sql: string;
}

const MIGRATIONS: MigrationStep[] = [
  {
    version: 1,
    description: 'Initial CodeGraph-compatible schema',
    sql: '',
  },
  {
    version: 2,
    description: 'MaestroGraph unified schema v2 — knowledge extensions + dual FTS5',
    sql: '',
  },
  {
    version: 3,
    description: 'Credibility tracking — decay scoring + usage counters',
    sql: CREDIBILITY_MIGRATION_SQL,
  },
  {
    version: 4,
    description: 'code_fts adds keywords column for camelCase sub-word search',
    sql: `
      -- Drop old triggers and FTS table
      DROP TRIGGER IF EXISTS nodes_ai;
      DROP TRIGGER IF EXISTS nodes_ad;
      DROP TRIGGER IF EXISTS nodes_au;
      DROP TABLE IF EXISTS code_fts;

      -- Recreate code_fts with keywords column
      CREATE VIRTUAL TABLE code_fts USING fts5(
        id, name, qualified_name, docstring, signature, keywords,
        tokenize = 'unicode61 remove_diacritics 2'
      );

      -- Backfill existing codegraph nodes
      INSERT INTO code_fts(rowid, id, name, qualified_name, docstring, signature, keywords)
      SELECT rowid, id, name, qualified_name, docstring, signature, keywords
      FROM nodes WHERE source_type = 'codegraph';

      -- Recreate triggers with keywords column
      CREATE TRIGGER nodes_ai AFTER INSERT ON nodes BEGIN
        INSERT INTO code_fts(rowid, id, name, qualified_name, docstring, signature, keywords)
        SELECT NEW.rowid, NEW.id, NEW.name, NEW.qualified_name, NEW.docstring, NEW.signature, NEW.keywords
        WHERE NEW.source_type = 'codegraph';
        INSERT INTO knowledge_fts(rowid, id, name, definition, body, aliases, keywords)
        SELECT NEW.rowid, NEW.id, NEW.name, NEW.definition, NEW.body, NEW.aliases, NEW.keywords
        WHERE NEW.source_type != 'codegraph';
      END;

      CREATE TRIGGER nodes_ad AFTER DELETE ON nodes BEGIN
        INSERT INTO code_fts(code_fts, rowid, id, name, qualified_name, docstring, signature, keywords)
        SELECT 'delete', OLD.rowid, OLD.id, OLD.name, OLD.qualified_name, OLD.docstring, OLD.signature, OLD.keywords
        WHERE OLD.source_type = 'codegraph';
        INSERT INTO knowledge_fts(knowledge_fts, rowid, id, name, definition, body, aliases, keywords)
        SELECT 'delete', OLD.rowid, OLD.id, OLD.name, OLD.definition, OLD.body, OLD.aliases, OLD.keywords
        WHERE OLD.source_type != 'codegraph';
      END;

      CREATE TRIGGER nodes_au AFTER UPDATE ON nodes BEGIN
        INSERT INTO code_fts(code_fts, rowid, id, name, qualified_name, docstring, signature, keywords)
        SELECT 'delete', OLD.rowid, OLD.id, OLD.name, OLD.qualified_name, OLD.docstring, OLD.signature, OLD.keywords
        WHERE OLD.source_type = 'codegraph';
        INSERT INTO code_fts(rowid, id, name, qualified_name, docstring, signature, keywords)
        SELECT NEW.rowid, NEW.id, NEW.name, NEW.qualified_name, NEW.docstring, NEW.signature, NEW.keywords
        WHERE NEW.source_type = 'codegraph';
        INSERT INTO knowledge_fts(knowledge_fts, rowid, id, name, definition, body, aliases, keywords)
        SELECT 'delete', OLD.rowid, OLD.id, OLD.name, OLD.definition, OLD.body, OLD.aliases, OLD.keywords
        WHERE OLD.source_type != 'codegraph';
        INSERT INTO knowledge_fts(rowid, id, name, definition, body, aliases, keywords)
        SELECT NEW.rowid, NEW.id, NEW.name, NEW.definition, NEW.body, NEW.aliases, NEW.keywords
        WHERE NEW.source_type != 'codegraph';
      END;
    `,
  },
  {
    version: 5,
    description: 'Dual FTS5 converted to internal storage — external content tables ignore trigger WHERE filters, indexing every node',
    sql: `
      -- content='nodes' 外部内容表模式下 FTS5 忽略触发器 WHERE 过滤 (按 rowid 读 content 表),
      -- 导致 code_fts/knowledge_fts 各索引全部节点。改为内部存储表, 触发器过滤恢复生效。
      DROP TRIGGER IF EXISTS nodes_ai;
      DROP TRIGGER IF EXISTS nodes_ad;
      DROP TRIGGER IF EXISTS nodes_au;
      DROP TABLE IF EXISTS code_fts;
      DROP TABLE IF EXISTS knowledge_fts;

      CREATE VIRTUAL TABLE code_fts USING fts5(
        id, name, qualified_name, docstring, signature, keywords,
        tokenize = 'unicode61 remove_diacritics 2'
      );
      CREATE VIRTUAL TABLE knowledge_fts USING fts5(
        id, name, definition, body, aliases, keywords,
        tokenize = 'trigram'
      );

      INSERT INTO code_fts(rowid, id, name, qualified_name, docstring, signature, keywords)
      SELECT rowid, id, name, qualified_name, docstring, signature, keywords
      FROM nodes WHERE source_type = 'codegraph';
      INSERT INTO knowledge_fts(rowid, id, name, definition, body, aliases, keywords)
      SELECT rowid, id, name, definition, body, aliases, keywords
      FROM nodes WHERE source_type != 'codegraph';

      CREATE TRIGGER nodes_ai AFTER INSERT ON nodes BEGIN
        INSERT INTO code_fts(rowid, id, name, qualified_name, docstring, signature, keywords)
        SELECT NEW.rowid, NEW.id, NEW.name, NEW.qualified_name, NEW.docstring, NEW.signature, NEW.keywords
        WHERE NEW.source_type = 'codegraph';
        INSERT INTO knowledge_fts(rowid, id, name, definition, body, aliases, keywords)
        SELECT NEW.rowid, NEW.id, NEW.name, NEW.definition, NEW.body, NEW.aliases, NEW.keywords
        WHERE NEW.source_type != 'codegraph';
      END;

      CREATE TRIGGER nodes_ad AFTER DELETE ON nodes BEGIN
        SELECT 1;
      END;

      CREATE TRIGGER nodes_au AFTER UPDATE ON nodes BEGIN
        SELECT 1;
      END;
    `,
  },
  {
    version: 6,
    description: 'Repair nodes_ad/nodes_au triggers — FTS5 delete command is invalid inside INSERT...SELECT triggers',
    sql: `
      -- v5 曾用 SELECT 'delete' 形式的触发器 (FTS5 delete 命令在触发器内报错),
      -- 已被 v5 迁移提交到已存在的库。此处重装为安全版本:
      -- DELETE/UPDATE 不做 FTS 直删, 一致性由同步末尾 ensureFtsConsistency 重建保证。
      DROP TRIGGER IF EXISTS nodes_ai;
      DROP TRIGGER IF EXISTS nodes_ad;
      DROP TRIGGER IF EXISTS nodes_au;

      CREATE TRIGGER nodes_ai AFTER INSERT ON nodes BEGIN
        INSERT INTO code_fts(rowid, id, name, qualified_name, docstring, signature, keywords)
        SELECT NEW.rowid, NEW.id, NEW.name, NEW.qualified_name, NEW.docstring, NEW.signature, NEW.keywords
        WHERE NEW.source_type = 'codegraph';
        INSERT INTO knowledge_fts(rowid, id, name, definition, body, aliases, keywords)
        SELECT NEW.rowid, NEW.id, NEW.name, NEW.definition, NEW.body, NEW.aliases, NEW.keywords
        WHERE NEW.source_type != 'codegraph';
      END;

      CREATE TRIGGER nodes_ad AFTER DELETE ON nodes BEGIN
        SELECT 1;
      END;

      CREATE TRIGGER nodes_au AFTER UPDATE ON nodes BEGIN
        SELECT 1;
      END;
    `,
  },
];

export function applyMigrations(conn: KgDatabaseConnection): void {
  const currentVersion = conn.getSchemaVersion();
  for (const migration of MIGRATIONS) {
    if (migration.version > currentVersion) {
      conn.transaction(() => {
        if (migration.sql) {
          conn.raw.exec(migration.sql);
        }
        conn.raw.prepare(
          'INSERT OR REPLACE INTO schema_versions (version, applied_at, description) VALUES (?, ?, ?)'
        ).run(migration.version, Date.now(), migration.description);
      });
    }
  }
}