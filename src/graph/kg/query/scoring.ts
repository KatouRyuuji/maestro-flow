// src/graph/kg/query/scoring.ts — 搜索评分系统
// 参考: plan-maestrograph.md Gap 修补 6 + codegraph/src/search/query-utils.ts

import type { UnifiedNodeKind } from '../db/types.js';

// ---------------------------------------------------------------------------
// 1. 停用词过滤 (78 个英语词 + 代码噪声词)
// ---------------------------------------------------------------------------

const STOP_WORDS = new Set([
  // 英语停用词
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'had',
  'her', 'was', 'one', 'our', 'out', 'day', 'get', 'has', 'him', 'his',
  'how', 'its', 'may', 'new', 'now', 'old', 'see', 'way', 'who', 'boy',
  'did', 'let', 'put', 'say', 'she', 'too', 'use',
  // 代码噪声词
  'function', 'class', 'import', 'export', 'const', 'return', 'if', 'else',
  'for', 'while', 'do', 'switch', 'case', 'break', 'continue',
  'true', 'false', 'null', 'undefined', 'string', 'number', 'boolean',
  'void', 'any', 'never', 'unknown', 'type', 'interface',
]);

export function removeStopWords(tokens: string[]): string[] {
  return tokens.filter(t => !STOP_WORDS.has(t.toLowerCase()));
}

// ---------------------------------------------------------------------------
// 2. 词干变体生成 (简化版)
// ---------------------------------------------------------------------------

export function getStemVariants(term: string): string[] {
  const variants = new Set<string>();
  const lower = term.toLowerCase();
  variants.add(lower);

  // 去除常见后缀
  const suffixes: Array<[RegExp, string]> = [
    [/ies$/, 'y'], [/tion$/, ''], [/sion$/, ''], [/ment$/, ''],
    [/ness$/, ''], [/ing$/, ''], [/ed$/, ''], [/er$/, ''], [/es$/, ''], [/s$/, ''],
  ];
  for (const [pattern, replacement] of suffixes) {
    if (pattern.test(lower)) {
      variants.add(lower.replace(pattern, replacement));
    }
  }

  return [...variants];
}

// ---------------------------------------------------------------------------
// 3. 驼峰/蛇形分词
// ---------------------------------------------------------------------------

export function extractSearchTerms(query: string): string[] {
  const terms: string[] = [];

  for (const part of query.split(/[_.\s\-/]+/)) {
    if (!part) continue;

    // CamelCase / PascalCase 分词
    const camelParts = part.replace(/([a-z])([A-Z])/g, '$1_$2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2');
    for (const cp of camelParts.split('_')) {
      const lower = cp.toLowerCase();
      if (lower.length > 0) terms.push(lower);
    }

    // 保留原始复合标识符
    if (part.length > 2) terms.push(part.toLowerCase());
  }

  return [...new Set(terms)];
}

// ---------------------------------------------------------------------------
// 4. 代码查询扩展 (缩写 ↔ 全称同义词)
// ---------------------------------------------------------------------------

const CODE_SYNONYMS: ReadonlyMap<string, readonly string[]> = new Map([
  ['auth', ['authentication', 'authorization']],
  ['authentication', ['auth']],
  ['authorization', ['auth']],
  ['db', ['database']],
  ['database', ['db']],
  ['config', ['configuration', 'settings']],
  ['configuration', ['config']],
  ['settings', ['config', 'options']],
  ['btn', ['button']],
  ['button', ['btn']],
  ['msg', ['message']],
  ['message', ['msg']],
  ['req', ['request']],
  ['request', ['req']],
  ['res', ['response']],
  ['response', ['res']],
  ['err', ['error', 'exception']],
  ['error', ['err', 'exception']],
  ['exception', ['err', 'error']],
  ['fn', ['function']],
  ['cb', ['callback']],
  ['callback', ['cb']],
  ['ctx', ['context']],
  ['context', ['ctx']],
  ['env', ['environment']],
  ['environment', ['env']],
  ['param', ['parameter', 'arg', 'argument']],
  ['parameter', ['param']],
  ['arg', ['argument', 'param']],
  ['argument', ['arg', 'param']],
  ['init', ['initialize', 'initialization', 'setup']],
  ['initialize', ['init']],
  ['setup', ['init', 'configure']],
  ['util', ['utility', 'helper']],
  ['utility', ['util', 'helper']],
  ['helper', ['util', 'utility']],
  ['repo', ['repository']],
  ['repository', ['repo']],
  ['info', ['information']],
  ['information', ['info']],
  ['mgr', ['manager']],
  ['manager', ['mgr']],
  ['svc', ['service']],
  ['service', ['svc']],
  ['cmd', ['command']],
  ['command', ['cmd']],
  ['nav', ['navigation']],
  ['navigation', ['nav']],
  ['idx', ['index']],
  ['val', ['validate', 'validation']],
  ['validate', ['val', 'validation']],
  ['validation', ['val', 'validate']],
  ['sync', ['synchronize']],
  ['synchronize', ['sync']],
  ['async', ['asynchronous']],
  ['middleware', ['mw']],
  ['mw', ['middleware']],
]);

/**
 * 代码查询扩展 — 基于 extractSearchTerms 分词 + 缩写同义词 + 词干变体
 * 返回包含原始 term、同义词和词干变体的扩展查询字符串
 */
export function expandCodeQuery(query: string): string {
  const terms = extractSearchTerms(query);
  const expanded = new Set(terms);

  for (const term of terms) {
    const lower = term.toLowerCase();
    const synonyms = CODE_SYNONYMS.get(lower);
    if (synonyms) {
      for (const syn of synonyms) expanded.add(syn);
    }
    const stems = getStemVariants(lower);
    for (const stem of stems) {
      if (stem.length >= 3) expanded.add(stem);
    }
  }

  return [...expanded].join(' ');
}

// ---------------------------------------------------------------------------
// 5. 多信号评分
// ---------------------------------------------------------------------------

export function kindBonus(kind: UnifiedNodeKind): number {
  switch (kind) {
    case 'function': case 'method': return 10;
    case 'interface': case 'trait': case 'protocol': case 'route': return 9;
    case 'class': case 'component': return 8;
    case 'type_alias': case 'struct': return 6;
    case 'enum': case 'constant': return 5;
    case 'variable': case 'field': case 'property': return 4;
    // 知识节点 — 在独立 FTS5 中不与代码竞争
    case 'domain_term': return 12;
    case 'spec_entry': return 8;
    case 'knowhow_entry': return 6;
    case 'decision': case 'requirement': return 7;
    case 'issue': return 5;
    default: return 0;
  }
}

export function scorePathRelevance(filePath: string, query: string): number {
  const normalized = filePath.replace(/\\/g, '/').toLowerCase();
  const queryLower = query.toLowerCase();
  const queryTokens = extractSearchTerms(query);

  let score = 0;

  // 文件名匹配: +10
  const fileName = normalized.split('/').pop() ?? '';
  if (fileName.includes(queryLower)) score += 10;

  // 目录匹配: +5
  const parts = normalized.split('/');
  for (const part of parts) {
    if (queryTokens.some(t => part.includes(t))) score += 5;
  }

  // 路径匹配: +3
  if (normalized.includes(queryLower)) score += 3;

  // 测试文件: -15 (降权)
  if (isTestPath(normalized)) score -= 15;

  return score;
}

function isTestPath(path: string): boolean {
  return (
    /\.test\.[jt]sx?$/.test(path) ||
    /\.spec\.[jt]sx?$/.test(path) ||
    /\b__tests__\//.test(path) ||
    /\btests?\//.test(path)
  );
}

export function nameMatchBonus(name: string, query: string): number {
  const nameLower = name.toLowerCase();
  const queryLower = query.toLowerCase();
  const queryTokens = extractSearchTerms(query);
  const nameTokens = extractSearchTerms(name);

  // 精确匹配: +80
  if (nameLower === queryLower) return 80;

  // 全令牌精确覆盖: +80
  if (queryTokens.length > 1 && queryTokens.every(qt => nameTokens.includes(qt))) return 80;

  // 单令牌精确: +60
  if (nameTokens.some(nt => queryTokens.includes(nt))) return 60;

  // 前缀匹配: +10~40 (按长度比例)
  if (nameLower.startsWith(queryLower)) {
    return Math.floor(10 + 30 * (queryLower.length / nameLower.length));
  }

  // 全分词包含: +15
  if (queryTokens.every(qt => nameTokens.some(nt => nt.includes(qt)))) return 15;

  // 子串匹配: +10
  if (nameLower.includes(queryLower)) return 10;

  return 0;
}

// ---------------------------------------------------------------------------
// 6. 综合评分
// ---------------------------------------------------------------------------

export interface ScoredResult {
  id: string;
  score: number;
}

export interface CandidateScoreMetadata {
  /** FTS retrieval signal 已转换为正向相关度。 */
  _bm25Score?: number;
  /** LIKE fallback 已计算完成的最终综合分。 */
  _computedScore?: number;
}

export type ScoreCandidateNode = {
  id: string;
  kind: UnifiedNodeKind;
  name: string;
  filePath: string;
} & CandidateScoreMetadata;

// ---------------------------------------------------------------------------
// CG-10 / #1500 — relevance scoring overhaul (multiplicative demotions)
//
// Ported from codegraph's explore relevance scoring (tools.ts:300-440). Four
// levers; the first three are MULTIPLICATIVE so they compose without ordering
// surprises, the fourth decides admission from the result:
//
//   1. KIND      — what a match on this NodeKind actually tells you (below).
//   2. ISOLATION — a weak-kind symbol nothing calls/references is a pure name
//                  collision; graph participation is the corroboration.
//   3. PENALTY   — generated / test / ambient-declaration files are weaker
//                  answers at EVERY signal, not just the equal-score tiebreak.
//   4. FLOOR     — admission scales with the best file's score (applied in the
//                  ranking pass / context-builder, not here).
//
// All CG-10 behaviour is OPT-IN: computeScore keeps its exact legacy behaviour
// unless a RelevanceContext is passed. The explore context-builder passes one;
// the existing search/scored paths and their tests are unchanged.
// ---------------------------------------------------------------------------

/**
 * How strongly a match on a symbol of this kind corroborates that its FILE is
 * what the query is about.
 *   1.0   a callable or a type — the unit an architecture question is about
 *   ~0.5  a member of a type, or the file node (a path match, not a symbol)
 *   ~0.3  a variable / constant — as often a name collision as a definition
 *   0.15  a parameter — essentially never the subject of a question
 * Unlisted kinds fall back to DEFAULT so a new NodeKind is neither free nor fatal.
 */
export const RELEVANCE_KIND_WEIGHT: Readonly<Record<string, number>> = {
  // Callables and types: the answer lives in one of these.
  function: 1, method: 1, class: 1, struct: 1, union: 1, interface: 1, trait: 1,
  protocol: 1, component: 1, route: 1, enum: 1, type_alias: 1, constructor: 1,
  // Containers: real structure, but coarser than a callable match.
  namespace: 0.8, module: 0.8,
  // Members of a type: real, weaker on their own.
  property: 0.5, field: 0.5, enum_member: 0.35,
  // The file node itself — the path matched, no symbol did.
  file: 0.5,
  // Incidental until the graph corroborates them (see ISOLATED_WEAK_KIND_WEIGHT).
  constant: 0.35, variable: 0.3, parameter: 0.15,
};
const DEFAULT_RELEVANCE_KIND_WEIGHT = 0.5;

/** Kinds whose evidentiary value depends on whether anything USES them. */
export const WEAK_RELEVANCE_KINDS: ReadonlySet<string> = new Set([
  'constant', 'variable', 'parameter', 'field', 'property', 'enum_member',
]);

/** Weight for a weak-kind symbol with no incoming/outgoing usage edge at all. */
export const ISOLATED_WEAK_KIND_WEIGHT = 0.08;

/**
 * Edges that mean "this symbol is used". `contains` is lexical nesting, not
 * usage — counting it would make every file-scope constant look corroborated,
 * which is exactly the case this guards against.
 */
export const RELEVANCE_USAGE_EDGES: ReadonlySet<string> = new Set([
  'calls', 'references', 'extends', 'implements', 'overrides',
  'instantiates', 'returns', 'type_of', 'decorates',
]);

/**
 * Cap on what PERIPHERAL nodes (in the subgraph, but neither a query match nor
 * adjacent to one) can contribute to a file's score. Uncapped, each such node
 * added a flat +1, so a file grew more "relevant" simply by being bigger — size
 * is not evidence; cap its contribution. Applied at the file-group level in the
 * ranking pass (context-builder), exposed here for that pass to import.
 */
export const PERIPHERAL_SCORE_CAP = 5;

/** Rank penalties, applied to BOTH the relevance score and the graph mass. */
export const GENERATED_RANK_PENALTY = 0.3;
export const LOW_VALUE_RANK_PENALTY = 0.5;
/** Ambient declaration files — hand-written `.d.ts` of global shims (CG-28). */
export const AMBIENT_DECLARATION_RANK_PENALTY = 0.5;

/**
 * Opt-in relevance context for {@link computeScore}. When absent, computeScore
 * keeps its exact legacy (additive) behaviour. When present, the multiplicative
 * CG-10 demotions apply: kind weight scales the symbol-match signal, isolation
 * zeroes an unused weak-kind match, and rankPenalty demotes generated/test/
 * ambient-declaration files on the PRIMARY sort key.
 */
export interface RelevanceContext {
  /**
   * Return true if `nodeId` has no incoming/outgoing usage edge (see
   * {@link RELEVANCE_USAGE_EDGES}). Used by the isolation lever. If absent, no
   * isolation probing — weak kinds keep their base weight (fail-open).
   */
  isUsageIsolated?: (nodeId: string) => boolean;
  /**
   * Per-file classification flags for the rank penalty. If absent, no rank
   * penalty applies (fail-open).
   */
  classifyFile?: (filePath: string) => {
    isGenerated?: boolean;
    isLowValue?: boolean;            // test/spec/icon/i18n
    isDampedDeclaration?: boolean;   // ambient .d.ts declaring only types (CG-28)
  };
}

/**
 * Multiplicative kind weight. When `probeIsolation` is true and the kind is
 * weak, an isolated symbol (nothing uses it) drops to
 * {@link ISOLATED_WEAK_KIND_WEIGHT}. Mirrors codegraph's `relevanceWeight`.
 */
export function relevanceWeight(
  kind: UnifiedNodeKind,
  opts?: { probeIsolation?: boolean; nodeId?: string; isUsageIsolated?: (nodeId: string) => boolean },
): number {
  const weight = RELEVANCE_KIND_WEIGHT[kind] ?? DEFAULT_RELEVANCE_KIND_WEIGHT;
  if (!opts?.probeIsolation || !WEAK_RELEVANCE_KINDS.has(kind)) return weight;
  const isolated = opts.nodeId !== undefined && opts.isUsageIsolated?.(opts.nodeId);
  return isolated ? ISOLATED_WEAK_KIND_WEIGHT : weight;
}

/**
 * File-level rank penalty (CG-10 lever 3). Applied multiplicatively to BOTH the
 * score and graph mass in the ranking pass. Generated and ambient-declaration
 * are taken as `min` (stronger) — penalising twice for the same property is how
 * a file gets cliffed out of answers where it is genuinely relevant. The
 * low-value multiplier compounds (a generated test file is two reasons).
 */
export function rankPenalty(
  filePath: string,
  classify: NonNullable<RelevanceContext['classifyFile']>,
): number {
  const flags = classify(filePath);
  return (
    Math.min(
      flags.isGenerated ? GENERATED_RANK_PENALTY : 1,
      flags.isDampedDeclaration ? AMBIENT_DECLARATION_RANK_PENALTY : 1,
    ) * (flags.isLowValue ? LOW_VALUE_RANK_PENALTY : 1)
  );
}

export function computeScore(
  node: ScoreCandidateNode,
  query: string,
  credibilityFactor?: number,
  opts?: { relevanceContext?: RelevanceContext },
): number {
  const ctx = opts?.relevanceContext;
  // Legacy path: no relevance context → exact original behaviour (additive).
  if (!ctx) {
    let score = 0;
    const bm25 = node._bm25Score;
    if (typeof bm25 === 'number' && bm25 > 0) score += Math.min(bm25 * 2, 30);
    score += kindBonus(node.kind);
    score += scorePathRelevance(node.filePath, query);
    score += nameMatchBonus(node.name, query);
    if (typeof credibilityFactor === 'number') score *= credibilityFactor;
    return score;
  }

  // CG-10 path: multiplicative kind weight on the symbol-match signal, plus a
  // file-level rank penalty on the total. The bm25/path signals are kept
  // additive (they describe retrieval/location, not kind-evidence); the KIND
  // weight scales the symbol-match (nameMatch) signal, and isolation can zero
  // an unused weak-kind match — the combination that sinks an incidental
  // `const explore` collision without touching a real `function explore`.
  let score = 0;
  const bm25 = node._bm25Score;
  if (typeof bm25 === 'number' && bm25 > 0) score += Math.min(bm25 * 2, 30);
  score += scorePathRelevance(node.filePath, query);

  const kindW = relevanceWeight(node.kind, {
    probeIsolation: true,
    nodeId: node.id,
    isUsageIsolated: ctx.isUsageIsolated,
  });
  score += nameMatchBonus(node.name, query) * kindW;
  // A matched callable/type still contributes a base kind signal even when the
  // name match was weak; an isolated weak kind contributes nothing beyond it.
  if (kindW >= 1) score += kindBonus(node.kind);

  if (ctx.classifyFile) score *= rankPenalty(node.filePath, ctx.classifyFile);
  if (typeof credibilityFactor === 'number') score *= credibilityFactor;
  return score;
}

function compareStableText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

export function compareNodeTie(
  left: Pick<ScoreCandidateNode, 'kind' | 'name' | 'id'>,
  right: Pick<ScoreCandidateNode, 'kind' | 'name' | 'id'>,
): number {
  return compareStableText(left.kind, right.kind)
    || compareStableText(left.name, right.name)
    || compareStableText(left.id, right.id);
}

export function compareScoredNodes(
  left: { node: Pick<ScoreCandidateNode, 'kind' | 'name' | 'id'>; score: number },
  right: { node: Pick<ScoreCandidateNode, 'kind' | 'name' | 'id'>; score: number },
): number {
  return right.score - left.score || compareNodeTie(left.node, right.node);
}
