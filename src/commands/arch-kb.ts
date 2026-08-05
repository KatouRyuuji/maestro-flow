/**
 * Arch-KB Command — 隔离架构知识库查询 (基于 awesome-architecture)
 *
 * 独立于 maestro search，仅通过 `maestro arch-kb <cmd>` 触发。
 * 索引预构建于 resources/arch-kb/index.json，运行时只读。
 *
 * 精简子命令集: list, show, search
 * - search: 自由搜索（BM25-lite），--type template 等价于原 match
 * - show:   命中后查看完整正文（--section 只看章节）
 * - list:   浏览条目
 */

import type { Command } from 'commander';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { paths } from '../config/paths.js';

// ─── Types ────────────────────────────────────────────────────────────

interface ArchKbEntry {
  id: string;
  type: 'template' | 'tutorial' | 'case';
  title: string;
  slug: string;
  summary: string;
  keywords: string[];
  path: string;
  sections: string[];
}

interface ArchKbIndex {
  version: number;
  builtAt: string;
  source: string;
  license: string;
  stats: { templates: number; tutorials: number; cases: number; total: number };
  entries: ArchKbEntry[];
}

// ─── Index Loading ────────────────────────────────────────────────────

let _cachedIndex: ArchKbIndex | null = null;

function bundledResourceDirs(): string[] {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  return [
    resolve(moduleDir, '../../../resources/arch-kb'), // compiled: dist/src/commands
    resolve(moduleDir, '../../resources/arch-kb'),  // source: src/commands
  ];
}

function resolveIndexDir(): string {
  const candidates = [
    paths.archKb,
    ...bundledResourceDirs(),
    resolve(process.cwd(), 'resources/arch-kb'),
  ];
  return candidates.find((dir) => existsSync(join(dir, 'index.json'))) ?? bundledResourceDirs()[0];
}

function loadIndex(): ArchKbIndex {
  if (_cachedIndex) return _cachedIndex;
  const dir = resolveIndexDir();
  const indexPath = join(dir, 'index.json');
  if (!existsSync(indexPath)) {
    console.error('Error: arch-kb index not found. Run: node scripts/build-arch-kb-index.mjs');
    process.exit(1);
  }
  _cachedIndex = JSON.parse(readFileSync(indexPath, 'utf-8')) as ArchKbIndex;
  return _cachedIndex;
}

function resolveContentPath(relativePath: string): string | null {
  const candidates = [
    resolve(resolveIndexDir(), relativePath),
    ...bundledResourceDirs().map((dir) => resolve(dir, relativePath)),
    resolve(process.cwd(), 'resources/arch-kb', relativePath),
    resolve(process.cwd(), '_analysis/awesome-architecture', relativePath),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

// ─── Search Engine (BM25-lite) ────────────────────────────────────────

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\w\u4e00-\u9fff-]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 0);
}

function scoreEntry(entry: ArchKbEntry, queryTokens: string[]): number {
  let score = 0;
  let matched = false;
  const titleTokens = tokenize(entry.title);
  const kwSet = new Set(entry.keywords.map(k => k.toLowerCase()));
  const sectionText = entry.sections.join(' ').toLowerCase();

  for (const qt of queryTokens) {
    // 关键词精确匹配 (权重最高)
    if (kwSet.has(qt)) { score += 10; matched = true; }
    // 关键词部分匹配
    else if (entry.keywords.some(k => k.toLowerCase().includes(qt) || qt.includes(k.toLowerCase()))) { score += 6; matched = true; }
    // 标题匹配
    if (titleTokens.some(t => t.includes(qt) || qt.includes(t))) { score += 5; matched = true; }
    // slug 匹配
    if (entry.slug.includes(qt)) { score += 4; matched = true; }
    // summary 匹配
    if (entry.summary.toLowerCase().includes(qt)) { score += 2; matched = true; }
    // sections 匹配
    if (sectionText.includes(qt)) { score += 1; matched = true; }
  }

  // type boost: template > case > tutorial (for match queries)
  // 仅在确有命中时生效，避免无匹配查询整类混入结果
  if (matched && entry.type === 'template') score += 1;

  return score;
}

function searchEntries(entries: ArchKbEntry[], query: string, opts?: { type?: string; limit?: number }): ArchKbEntry[] {
  const tokens = tokenize(query);
  if (tokens.length === 0) return [];

  let filtered = entries;
  if (opts?.type) {
    filtered = entries.filter(e => e.type === opts.type);
  }

  const scored = filtered
    .map(e => ({ entry: e, score: scoreEntry(e, tokens) }))
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score);

  return scored.slice(0, opts?.limit ?? 10).map(x => x.entry);
}

// ─── Output Formatting ────────────────────────────────────────────────

function formatEntry(entry: ArchKbEntry, verbose = false): string {
  const typeIcon = { template: '🗺️', tutorial: '📚', case: '🧪' }[entry.type];
  const lines = [`${typeIcon} [${entry.id}] ${entry.title}`];
  if (verbose) {
    if (entry.summary) lines.push(`   ${entry.summary.slice(0, 120)}`);
    if (entry.keywords.length) lines.push(`   keywords: ${entry.keywords.join(', ')}`);
    if (entry.sections.length) lines.push(`   sections: ${entry.sections.slice(0, 8).join(' | ')}`);
    lines.push(`   path: ${entry.path}`);
  }
  return lines.join('\n');
}

function outputResults(entries: ArchKbEntry[], opts: { json?: boolean; verbose?: boolean; header?: string }): void {
  if (opts.json) {
    console.log(JSON.stringify(entries, null, 2));
    return;
  }
  if (opts.header) console.log(opts.header);
  if (entries.length === 0) {
    console.log('  (no matches)');
    return;
  }
  for (const e of entries) {
    console.log(formatEntry(e, opts.verbose));
  }
  console.log(`\n  ${entries.length} result(s). Use "maestro arch-kb show <id>" to view content.`);
}

// ─── Command Registration ─────────────────────────────────────────────

export function registerArchKbCommand(program: Command): void {
  const archKb = program
    .command('arch-kb')
    .alias('akb')
    .description('Architecture knowledge base query (isolated, keyword-triggered)');

  // ── list: 列出所有条目 ──────────────────────────────────────────────
  archKb
    .command('list [type]')
    .description('List entries (type: template|tutorial|case|all)')
    .option('--json', 'JSON output')
    .action((type: string | undefined, opts) => {
      const index = loadIndex();
      const filterType = type && type !== 'all' ? type : undefined;
      const entries = filterType
        ? index.entries.filter(e => e.type === filterType)
        : index.entries;

      if (opts.json) {
        console.log(JSON.stringify(entries.map(e => ({ id: e.id, type: e.type, title: e.title })), null, 2));
        return;
      }

      console.log(`📦 arch-kb index: ${index.stats.templates} templates, ${index.stats.tutorials} tutorials, ${index.stats.cases} cases\n`);

      const grouped: Record<string, ArchKbEntry[]> = {};
      for (const e of entries) {
        (grouped[e.type] ??= []).push(e);
      }
      for (const [t, es] of Object.entries(grouped)) {
        const icon = { template: '🗺️', tutorial: '📚', case: '🧪' }[t] || '📄';
        console.log(`  ${icon} ${t.toUpperCase()} (${es.length})`);
        for (const e of es) {
          console.log(`     ${e.id.padEnd(35)} ${e.title}`);
        }
        console.log();
      }
    });

  // ── show: 查看条目内容 ──────────────────────────────────────────────
  archKb
    .command('show <id>')
    .description('Show entry content (reads from source markdown)')
    .option('--section <name>', 'Show specific section only')
    .option('--json', 'JSON output (metadata only)')
    .action((id: string, opts) => {
      const index = loadIndex();
      const entry = index.entries.find(e => e.id === id || e.slug === id);
      if (!entry) {
        console.error(`Error: entry not found: ${id}`);
        console.error(`Hint: run "maestro arch-kb list" to see available entries`);
        process.exitCode = 1;
        return;
      }

      if (opts.json) {
        console.log(JSON.stringify(entry, null, 2));
        return;
      }

      // 尝试读取原始 markdown
      const contentPath = resolveContentPath(entry.path);
      if (!contentPath) {
        console.log(formatEntry(entry, true));
        console.error('\n  ⚠ Source file not found. Index metadata shown above.');
        process.exitCode = 1;
        return;
      }

      let content = readFileSync(contentPath, 'utf-8');

      if (opts.section) {
        // 提取指定章节
        const sectionRe = new RegExp(`^##\\s+.*${opts.section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*$`, 'im');
        const match = content.match(sectionRe);
        if (match && match.index !== undefined) {
          const start = match.index;
          const nextSection = content.indexOf('\n## ', start + match[0].length);
          content = nextSection === -1
            ? content.slice(start)
            : content.slice(start, nextSection);
        } else {
          console.log(`  ⚠ Section "${opts.section}" not found. Available sections:`);
          for (const s of entry.sections) console.log(`     - ${s}`);
          return;
        }
      }

      console.log(content);
    });

  // ── search: 自由搜索 ────────────────────────────────────────────────
  archKb
    .command('search <query>')
    .description('Free-text search across all arch-kb entries (--type template = template matching)')
    .option('--type <type>', 'Filter: template|tutorial|case')
    .option('--limit <n>', 'Max results', '8')
    .option('--json', 'JSON output')
    .action((query: string, opts) => {
      const index = loadIndex();
      const results = searchEntries(index.entries, query, {
        type: opts.type,
        limit: parseInt(opts.limit, 10),
      });
      outputResults(results, {
        json: opts.json,
        verbose: true,
        header: `🔎 arch-kb search: "${query}"\n`,
      });
    });
}
