// ---------------------------------------------------------------------------
// Search usage recorder — 将 Maestro Search 的使用统计合并进 .workflow/learning/
//
// 高频知识面板（sidebar get_top_knowledge / scan_top_learning）读取 learning 目录
// 下全部 *.jsonl 的使用统计行。此前只有外部工具（如 claude-code）写 patterns.jsonl，
// Maestro 自身的搜索用量只进 KG credibility 表，与面板完全脱节 —— 本模块打通闭环：
// 每次搜索曝光（有结果）合并/追加一行 {"command":"maestro-search", ...}。
// Best-effort：任何 IO 错误静默降级，绝不阻塞或影响搜索主流程。
// ---------------------------------------------------------------------------

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface SearchUsageRow {
  command: string;
  frequency: number;
  successRate: number;
  avgDuration: number;
  lastUsed: string;
  contexts: string[];
}

export const SEARCH_USAGE_COMMAND = 'maestro-search';
export const SEARCH_USAGE_FILE = 'maestro-search.jsonl';

const MAX_CONTEXTS = 5;

/**
 * 记录一次 Maestro Search 使用（有结果曝光时调用）。
 *
 * - 已有 maestro-search 行：frequency+1，successRate/avgDuration 滚动平均，lastUsed 刷新
 * - 无行：追加新行（frequency=1）
 * - 同目录其它文件（patterns.jsonl 等）原样保留
 */
export function recordSearchUsage(
  projectRoot: string,
  options: { success?: boolean; durationMs?: number; contexts?: string[] } = {},
): void {
  try {
    const learningDir = join(projectRoot, '.workflow', 'learning');
    const file = join(learningDir, SEARCH_USAGE_FILE);
    const now = new Date().toISOString();
    const success = options.success !== false;
    const durationMs = options.durationMs ?? 0;
    const contexts = (options.contexts ?? [])
      .filter(Boolean)
      .map(context => String(context).slice(0, 40))
      .slice(0, MAX_CONTEXTS);

    let rows: SearchUsageRow[] = [];
    if (existsSync(file)) {
      const raw = readFileSync(file, 'utf8');
      rows = raw
        .split('\n')
        .filter(line => line.trim().length > 0)
        .map(line => {
          try {
            return JSON.parse(line) as SearchUsageRow;
          } catch {
            return null;
          }
        })
        .filter((row): row is SearchUsageRow => row !== null);
    }

    const existing = rows.find(row => row.command === SEARCH_USAGE_COMMAND);
    if (existing) {
      const uses = existing.frequency + 1;
      existing.frequency = uses;
      existing.successRate =
        ((existing.successRate * (uses - 1)) + (success ? 1 : 0)) / uses;
      if (durationMs > 0) {
        existing.avgDuration =
          existing.avgDuration > 0
            ? ((existing.avgDuration * (uses - 1)) + durationMs) / uses
            : durationMs;
      }
      existing.lastUsed = now;
      if (contexts.length > 0) {
        existing.contexts = [...new Set([...contexts, ...(existing.contexts ?? [])])].slice(0, MAX_CONTEXTS);
      }
    } else {
      rows.push({
        command: SEARCH_USAGE_COMMAND,
        frequency: 1,
        successRate: success ? 1 : 0,
        avgDuration: durationMs,
        lastUsed: now,
        contexts,
      });
    }

    writeFileSync(file, rows.map(row => JSON.stringify(row)).join('\n') + '\n', 'utf8');
  } catch {
    // 记录失败不影响搜索
  }
}
