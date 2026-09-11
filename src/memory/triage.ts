/**
 * 枚举 kk-mem 自动抽取落全局（project=null）的写入候选，交给 agent 评审归属。
 *
 * 只读 kk-mem 本地流水 auto-writes.jsonl，不写 kk-mem 任何数据；归属纠正由
 * agent 调 kk-mem MCP 工具执行（先 memory_add 带 project，再 memory_delete 旧 id）。
 * 已处理 id 记录在 maestro 侧状态文件，重复运行不再列出，保证幂等。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir as osHomedir } from 'node:os';
import { join } from 'node:path';

export interface TriageCandidate {
  id: string;
  text: string;
  at: string;
  /** 流水所在宿主子目录；共享根归为 claude。 */
  host: string;
}

/** kk-mem 流水根：MEM0_CONFIG_DIR 覆盖，否则 ~/.config/mem0-claude。 */
export function kkmemCaptureBase(env: NodeJS.Dict<string | undefined> = process.env, home: string = osHomedir()): string {
  const override = (env.MEM0_CONFIG_DIR ?? '').trim();
  return override || join(home, '.config', 'mem0-claude');
}

/** 各宿主的流水目录：共享根（claude）+ codex/ + grok/。只返回存在的。 */
export function captureDirs(base: string): Array<{ host: string; dir: string }> {
  const all = [
    { host: 'claude', dir: base },
    { host: 'codex', dir: join(base, 'codex') },
    { host: 'grok', dir: join(base, 'grok') },
  ];
  return all.filter((x) => existsSync(join(x.dir, 'auto-writes.jsonl')));
}

const WRITE_EVENTS = new Set(['ADD', 'UPDATE']);

function parseLine(line: string): { at?: unknown; project?: unknown; text?: unknown; events?: unknown } | null {
  try {
    const v = JSON.parse(line);
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}

export interface CollectOptions {
  env?: NodeJS.Dict<string | undefined>;
  home?: string;
  /** 只保留该时间之后的条目（ISO 字符串比较前的毫秒下界）。 */
  sinceMs?: number;
}

/** 从所有宿主流水里收集「落全局的自动写入」候选（含已处理的，过滤在调用侧）。 */
export function collectGlobalAutoWrites(options: CollectOptions = {}): TriageCandidate[] {
  const base = kkmemCaptureBase(options.env ?? process.env, options.home ?? osHomedir());
  const out: TriageCandidate[] = [];
  const seen = new Set<string>();
  for (const { host, dir } of captureDirs(base)) {
    let lines: string[];
    try {
      lines = readFileSync(join(dir, 'auto-writes.jsonl'), 'utf8').split(/\r?\n/);
    } catch {
      continue;
    }
    for (const line of lines) {
      if (!line.trim()) continue;
      const entry = parseLine(line);
      if (!entry) continue;
      if (entry.project !== null && entry.project !== undefined) continue;
      const at = typeof entry.at === 'string' ? entry.at : '';
      const atMs = Date.parse(at);
      if (options.sinceMs !== undefined && Number.isFinite(atMs) && atMs < options.sinceMs) continue;
      const events = Array.isArray(entry.events) ? entry.events : [];
      const text = typeof entry.text === 'string' ? entry.text : '';
      for (const e of events) {
        if (!e || typeof e !== 'object') continue;
        const evt = (e as { event?: unknown }).event;
        const id = (e as { id?: unknown }).id;
        if (typeof id !== 'string' || !id || seen.has(id)) continue;
        if (typeof evt !== 'string' || !WRITE_EVENTS.has(evt.toUpperCase())) continue;
        seen.add(id);
        out.push({ id, text, at, host });
      }
    }
  }
  return out;
}

export function triageDonePath(home: string = osHomedir()): string {
  return join(home, '.maestro', 'memory', 'triage-done.json');
}

export function readTriageDone(home: string = osHomedir()): Set<string> {
  try {
    const data = JSON.parse(readFileSync(triageDonePath(home), 'utf8'));
    const ids = Array.isArray(data?.done) ? data.done : [];
    return new Set(ids.filter((x): x is string => typeof x === 'string'));
  } catch {
    return new Set();
  }
}

export function markTriageDone(ids: string[], home: string = osHomedir()): number {
  const done = readTriageDone(home);
  let added = 0;
  for (const id of ids) {
    if (!done.has(id)) {
      done.add(id);
      added += 1;
    }
  }
  const path = triageDonePath(home);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify({ done: [...done] }, null, 2), 'utf8');
  return added;
}

/** 解析 --since 时长（如 24h、7d），返回毫秒数；无法解析返回 undefined。 */
export function parseSince(value: string): number | undefined {
  const m = /^\s*(\d+)\s*([hd])\s*$/i.exec(value);
  if (!m) return undefined;
  const n = Number(m[1]);
  return m[2].toLowerCase() === 'h' ? n * 3600_000 : n * 86400_000;
}
