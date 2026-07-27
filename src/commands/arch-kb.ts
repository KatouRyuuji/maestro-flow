/**
 * Arch-KB Command — 隔离架构知识库查询 (基于 awesome-architecture)
 *
 * 独立于 maestro search，仅通过 `maestro arch-kb <cmd>` 触发。
 * 索引预构建于 resources/arch-kb/index.json，运行时只读。
 *
 * Subcommands: match, checklist, patterns, framework, list, show, search
 */

import type { Command } from 'commander';
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
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

function resolveIndexDir(): string {
  // 1. ~/.maestro/arch-kb (install 后的标准位置)
  if (existsSync(join(paths.archKb, 'index.json'))) return paths.archKb;
  // 2. 包内 resources/ (发布模式 fallback)
  const pkgResources = resolve(fileURLToPath(import.meta.url), '../../../resources/arch-kb');
  if (existsSync(join(pkgResources, 'index.json'))) return pkgResources;
  // 3. 项目根 resources/ (开发模式)
  const projectResources = resolve(process.cwd(), 'resources/arch-kb');
  if (existsSync(join(projectResources, 'index.json'))) return projectResources;
  // 4. dist 相对路径
  const distResources = resolve(fileURLToPath(import.meta.url), '../../../../resources/arch-kb');
  if (existsSync(join(distResources, 'index.json'))) return distResources;
  return pkgResources; // fallback
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
  // 尝试从 _analysis/awesome-architecture/ 读取原始内容
  const candidates = [
    resolve(process.cwd(), '_analysis/awesome-architecture', relativePath),
    resolve(resolveIndexDir(), relativePath),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
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
  const titleTokens = tokenize(entry.title);
  const kwSet = new Set(entry.keywords.map(k => k.toLowerCase()));
  const sectionText = entry.sections.join(' ').toLowerCase();

  for (const qt of queryTokens) {
    // 关键词精确匹配 (权重最高)
    if (kwSet.has(qt)) score += 10;
    // 关键词部分匹配
    else if (entry.keywords.some(k => k.toLowerCase().includes(qt) || qt.includes(k.toLowerCase()))) score += 6;
    // 标题匹配
    if (titleTokens.some(t => t.includes(qt) || qt.includes(t))) score += 5;
    // slug 匹配
    if (entry.slug.includes(qt)) score += 4;
    // summary 匹配
    if (entry.summary.toLowerCase().includes(qt)) score += 2;
    // sections 匹配
    if (sectionText.includes(qt)) score += 1;
  }

  // type boost: template > case > tutorial (for match queries)
  if (entry.type === 'template') score += 1;

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

// ─── Checklist Data (from tutorial/24) ────────────────────────────────

const CHECKLIST_DIMENSIONS: Record<string, { title: string; items: string[] }> = {
  consistency: {
    title: '数据一致性 (ch11)',
    items: [
      '幂等: 写操作重复执行会怎样? 有幂等键吗?',
      '跨服务一致性: 用 Saga / Outbox 了吗? 中途失败怎么补偿?',
      '事务边界: 哪些必须强一致(钱/库存), 哪些可最终一致?',
      '并发: 两个请求同时改一条数据会怎样? 有没有超卖/丢更新?',
    ],
  },
  resilience: {
    title: '韧性 (ch12)',
    items: [
      '超时: 每个外部调用都设超时了吗?',
      '重试: 指数退避还是无脑重试? 重试的操作幂等吗?',
      '熔断/降级: 依赖挂了能熔断+降级返回兜底吗?',
      '资源上限: 有没有无界队列/无上限并发/无超时循环?',
    ],
  },
  scale: {
    title: '规模 (ch13)',
    items: [
      '热点: 有没有热key/热分区? 爆款会不会打爆单点?',
      'N+1与扇出: 循环里查库? 一次请求扇出N次下游调用?',
      '分页/上限: 列表接口有分页吗? 会不会一把捞几百万行?',
      '尾延迟: P99而非P50; 有没有慢路径拖累整体?',
    ],
  },
  security: {
    title: '安全 (ch16)',
    items: [
      '输入校验: 外部输入都校验了吗? SQL/命令注入?',
      '鉴权与越权: 每个接口都校验权限吗? 能改ID看别人数据吗?',
      '多租户隔离: 查询强制按租户过滤了吗?',
      '提示注入: AI系统外部内容能诱导模型违规吗?',
    ],
  },
  observability: {
    title: '可观测 (ch12/32)',
    items: [
      'trace: 多步操作有全链路追踪吗?',
      'metrics: 关键指标(延迟/错误率/饱和度)有监控吗?',
      'alert: 异常能自动告警吗? SLO有定义吗?',
      '日志: 结构化日志? 能按请求ID关联吗?',
    ],
  },
  ai_specific: {
    title: 'AI特有 (ch17/24)',
    items: [
      '非确定性: 同一输入两次结果不同, 有兜底吗?',
      '成本: 多步调用有预算上限吗? token花费可追踪吗?',
      '幻觉: 模型输出有校验/引用溯源吗?',
      '上下文: 长任务有压缩/检查点/恢复机制吗?',
      '工具副作用: 高危操作有人工审批关卡吗?',
    ],
  },
};

// ─── Command Registration ─────────────────────────────────────────────

export function registerArchKbCommand(program: Command): void {
  const archKb = program
    .command('arch-kb')
    .alias('akb')
    .description('Architecture knowledge base query (isolated, keyword-triggered)');

  // ── match: 系统类型 → 模板匹配 ─────────────────────────────────────
  archKb
    .command('match <description>')
    .description('Match system description to architecture templates')
    .option('--limit <n>', 'Max results', '5')
    .option('--json', 'JSON output')
    .action((description: string, opts) => {
      const index = loadIndex();
      const results = searchEntries(index.entries, description, {
        type: 'template',
        limit: parseInt(opts.limit, 10),
      });
      outputResults(results, {
        json: opts.json,
        verbose: true,
        header: `🗺️  Architecture template match for: "${description}"\n`,
      });
    });

  // ── checklist: 审查清单 ─────────────────────────────────────────────
  archKb
    .command('checklist [concerns]')
    .description('Get architecture review checklist (concerns: consistency,resilience,scale,security,observability,ai)')
    .option('--all', 'All dimensions')
    .option('--json', 'JSON output')
    .action((concerns: string | undefined, opts) => {
      const ALIASES: Record<string, string> = { ai: 'ai_specific', obs: 'observability', sec: 'security', perf: 'scale' };
      let dims: string[];
      if (opts.all || !concerns) {
        dims = Object.keys(CHECKLIST_DIMENSIONS);
      } else {
        dims = concerns.split(',').map(c => {
          const t = c.trim().toLowerCase();
          return ALIASES[t] ?? t;
        });
      }

      if (opts.json) {
        const out: Record<string, unknown> = {};
        for (const d of dims) {
          const dim = CHECKLIST_DIMENSIONS[d];
          if (dim) out[d] = dim;
        }
        console.log(JSON.stringify(out, null, 2));
        return;
      }

      console.log('📋 Architecture Review Checklist (from awesome-architecture ch24)\n');
      for (const d of dims) {
        const dim = CHECKLIST_DIMENSIONS[d];
        if (!dim) {
          console.log(`  ⚠ Unknown dimension: ${d} (valid: ${Object.keys(CHECKLIST_DIMENSIONS).join(', ')})`);
          continue;
        }
        console.log(`  ── ${dim.title} ──`);
        for (const item of dim.items) {
          console.log(`  [ ] ${item}`);
        }
        console.log();
      }
    });

  // ── patterns: 架构模式查询 ──────────────────────────────────────────
  archKb
    .command('patterns <problem>')
    .description('Find architecture patterns for a given problem/concern')
    .option('--limit <n>', 'Max results', '5')
    .option('--json', 'JSON output')
    .action((problem: string, opts) => {
      const index = loadIndex();
      // 搜索 tutorial 中的模式相关内容 + 模板中的决策章节
      const results = searchEntries(index.entries, problem, {
        limit: parseInt(opts.limit, 10),
      });
      outputResults(results, {
        json: opts.json,
        verbose: true,
        header: `🔍 Architecture patterns for: "${problem}"\n`,
      });
    });

  // ── framework: 思考框架 ─────────────────────────────────────────────
  archKb
    .command('framework [step]')
    .description('Get architecture thinking framework (steps: requirements,constraints,quality,candidates,tradeoffs,decision)')
    .option('--json', 'JSON output')
    .action((step: string | undefined, opts) => {
      const FRAMEWORK_STEPS = [
        { id: 'requirements', label: '① 需求', desc: '功能性需求(做什么) + 非功能性需求(做多好)。先分清这两种。' },
        { id: 'constraints', label: '② 约束', desc: '不可逾越的边界: 技术/业务/组织/合规/成本/团队规模。' },
        { id: 'quality', label: '③ 质量属性', desc: '性能/可用性/一致性/可扩展/安全/可维护 — 量化目标。' },
        { id: 'candidates', label: '④ 候选方案', desc: '至少2-3种搭法。每种对应不同的模式组合。' },
        { id: 'tradeoffs', label: '⑤ 取舍', desc: '每个方案拿什么换什么? 用约束和质量属性做判据。' },
        { id: 'decision', label: '⑥ 决策', desc: '选一个,写下为什么(ADR)。业务变了就重走。' },
      ];

      if (opts.json) {
        const out = step
          ? FRAMEWORK_STEPS.filter(s => s.id === step)
          : FRAMEWORK_STEPS;
        console.log(JSON.stringify(out, null, 2));
        return;
      }

      console.log('🧭 Architecture Thinking Framework (from awesome-architecture ch02)\n');
      console.log('   需求 → 约束 → 质量属性 → 候选方案 → 取舍 → 决策\n');

      const steps = step ? FRAMEWORK_STEPS.filter(s => s.id === step) : FRAMEWORK_STEPS;
      if (steps.length === 0) {
        console.log(`  ⚠ Unknown step: ${step} (valid: ${FRAMEWORK_STEPS.map(s => s.id).join(', ')})`);
        return;
      }
      for (const s of steps) {
        console.log(`  ${s.label}: ${s.desc}`);
      }

      if (!step) {
        console.log('\n  ↻ 这不是一次性流程 — 业务/规模变化时回到起点重走。');
        console.log('  📖 详情: maestro arch-kb show arch-tut-02');
      }
    });

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
        console.log('\n  ⚠ Source file not found. Index metadata shown above.');
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
    .description('Free-text search across all arch-kb entries')
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

  // ── tech-select: 技术选型决策树 ─────────────────────────────────────
  archKb
    .command('tech-select <category>')
    .description('Technology selection guidance (category: language,database,cache,api,cloud,observability,ai-infra)')
    .option('--json', 'JSON output')
    .action((category: string, opts) => {
      const index = loadIndex();
      // 映射到对应教程章节
      const CATEGORY_MAP: Record<string, string> = {
        language: 'arch-tut-27',
        database: 'arch-tut-28',
        storage: 'arch-tut-28',
        cache: 'arch-tut-29',
        mq: 'arch-tut-29',
        api: 'arch-tut-30',
        communication: 'arch-tut-30',
        cloud: 'arch-tut-31',
        deploy: 'arch-tut-31',
        observability: 'arch-tut-32',
        monitoring: 'arch-tut-32',
        'ai-infra': 'arch-tut-33',
        gpu: 'arch-tut-33',
        'decision-tree': 'arch-tut-34',
      };

      const targetId = CATEGORY_MAP[category.toLowerCase()];
      if (!targetId) {
        console.error(`Unknown category: ${category}`);
        console.error(`Valid: ${Object.keys(CATEGORY_MAP).join(', ')}`);
        process.exitCode = 1;
        return;
      }

      const entry = index.entries.find(e => e.id === targetId);
      if (!entry) {
        console.error(`Entry ${targetId} not found in index`);
        process.exitCode = 1;
        return;
      }

      if (opts.json) {
        console.log(JSON.stringify(entry, null, 2));
        return;
      }

      const contentPath = resolveContentPath(entry.path);
      if (contentPath) {
        console.log(readFileSync(contentPath, 'utf-8'));
      } else {
        console.log(formatEntry(entry, true));
      }
    });
}
