// src/graph/kg/query/context-builder.ts — 上下文组装 (for hook inject)
// 参考: plan-maestrograph.md 统一 Hook Injector 设计 + codegraph #1500 explore allocation
//
// The budget path was ported from codegraph's CG-12/21/26/30/31/36/38 render
// loop: sections are ranked, each is RESERVED a score-proportional share of the
// envelope up front (allocateExploreBudget), and the render loop spends those
// reservations — never a flat cap. Carry-forward hands unspent slack down rank
// order; a displacement guard (fundedHeadroom) holds back what is still owed to
// sections below; a whole-section buy rule sends a section in full when its
// reservation already covers most of it. Invariant: every admitted section
// receives ≥ its reservation before any section draws carry-forward slack.

import type { KgQueryBuilder } from '../db/queries.js';
import type { UnifiedNode, SourceType } from '../db/types.js';
import { searchUnified, parseQuery } from './search.js';
import { bfs } from './traversal.js';
import {
  allocateExploreBudget,
  getExploreOutputBudget,
  wholeFileGraceBound,
  EXPLORE_ALLOCATION,
  type ExploreAllocationCandidate,
  type ExploreOutputBudget,
} from './allocation.js';

// ---------------------------------------------------------------------------
// Context Section — 注入到 agent 的知识片段
// ---------------------------------------------------------------------------

export interface ContextSection {
  label: string;
  lines: string[];
  sourceType: SourceType;
  relevance: number;
}

export interface ContextBudget {
  maxTotalChars: number;
  maxSections: number;
  maxCharsPerSection: number;
}

const DEFAULT_BUDGET: ContextBudget = {
  maxTotalChars: 8000,
  maxSections: 10,
  maxCharsPerSection: 2000,
};

// ---------------------------------------------------------------------------
// 上下文构建入口
// ---------------------------------------------------------------------------

export interface BuiltContext {
  sections: ContextSection[];
  totalChars: number;
  summary: {
    codeSymbols: number;
    domainTerms: number;
    specRules: number;
    knowhowDocs: number;
  };
}

/**
 * 从查询结果构建 agent 上下文
 *
 * 1. FTS5 搜索 → 直接命中
 * 2. 图遍历 → 1-hop 关联
 * 3. 按 source_type 分组组装 sections
 * 4. Context budget 管控
 */
export function buildContext(
  queries: KgQueryBuilder,
  prompt: string,
  options?: {
    budget?: Partial<ContextBudget>;
    expandDepth?: number;
    agentType?: string;
  },
): BuiltContext {
  const budget = { ...DEFAULT_BUDGET, ...options?.budget };
  const expandDepth = options?.expandDepth ?? 1;

  // Step 1: FTS5 搜索
  const { directMatches, summary } = searchUnified(queries, prompt, {
    limit: 15,
    includeCode: true,
    includeKnowledge: true,
  });

  // Step 2: 图遍历 — 从命中节点扩展 1 hop
  const relatedNodes = new Map<string, UnifiedNode>();
  const seedIds = directMatches.map(m => m.node.id);

  if (expandDepth > 0 && seedIds.length > 0) {
    for (const seedId of seedIds.slice(0, 5)) { // 限制种子数避免爆炸
      const traversal = bfs(queries, seedId, {
        maxDepth: expandDepth,
        maxNodes: 10,
      });
      for (const [id, node] of traversal.nodes) {
        if (!seedIds.includes(id)) {
          relatedNodes.set(id, node);
        }
      }
    }
  }

  // Step 3: 按 source_type 分组
  const sections: ContextSection[] = [];
  const allNodes = new Map<string, UnifiedNode>();
  for (const m of directMatches) allNodes.set(m.node.id, m.node);
  for (const [id, node] of relatedNodes) allNodes.set(id, node);

  // Domain terms
  const domainNodes = [...allNodes.values()].filter(n => n.sourceType === 'domain');
  if (domainNodes.length > 0) {
    sections.push({
      label: `domain[${domainNodes.map(n => n.name).join(',')}]`,
      lines: formatDomainNodes(domainNodes),
      sourceType: 'domain',
      relevance: domainNodes.length * 3,
    });
  }

  // Spec entries
  const specNodes = [...allNodes.values()].filter(n => n.sourceType === 'spec');
  if (specNodes.length > 0) {
    sections.push({
      label: `spec[${specNodes.map(n => n.category).join(',')}]`,
      lines: formatSpecNodes(specNodes),
      sourceType: 'spec',
      relevance: specNodes.length * 2,
    });
  }

  // Knowhow docs
  const knowhowNodes = [...allNodes.values()].filter(n => n.sourceType === 'knowhow');
  if (knowhowNodes.length > 0) {
    sections.push({
      label: `knowhow[${knowhowNodes.map(n => n.name).join(',')}]`,
      lines: formatKnowhowNodes(knowhowNodes),
      sourceType: 'knowhow',
      relevance: knowhowNodes.length * 2,
    });
  }

  // Code symbols
  const codeNodes = [...allNodes.values()].filter(n => n.sourceType === 'codegraph');
  if (codeNodes.length > 0) {
    sections.push({
      label: `code[${codeNodes.map(n => n.name).join(',')}]`,
      lines: formatCodeNodes(codeNodes),
      sourceType: 'codegraph',
      relevance: codeNodes.length,
    });
  }

  // Codebase docs
  const codebaseNodes = [...allNodes.values()].filter(n => n.sourceType === 'codebase');
  if (codebaseNodes.length > 0) {
    sections.push({
      label: `codebase[${codebaseNodes.map(n => n.name).join(',')}]`,
      lines: formatCodebaseNodes(codebaseNodes),
      sourceType: 'codebase',
      relevance: codebaseNodes.length,
    });
  }

  // Issues
  const issueNodes = [...allNodes.values()].filter(n => n.sourceType === 'issue');
  if (issueNodes.length > 0) {
    sections.push({
      label: `issues[${issueNodes.map(n => n.name).join(',')}]`,
      lines: formatIssueNodes(issueNodes),
      sourceType: 'issue',
      relevance: issueNodes.length,
    });
  }

  // Step 4: Allocation-driven budget (CG-12/21/26/30/31/36/38) —
  //  the render loop lives in {@link renderSectionsWithBudget} below, extracted
  //  so it is unit-testable without a DB. It keeps three invariants:
  //   - carry-forward: a section that cannot spend its reservation hands the
  //     difference DOWN rank order.
  //   - displacement guard: fundedHeadroom holds back what is still OWED to
  //     sections below.
  //   - whole-section buy: a section whose reservation covers >=60% of itself
  //     is sent in FULL from one shared 15% overshoot pool.
  const { sections: selected, totalChars } = renderSectionsWithBudget(
    sections,
    {
      maxOutputChars: options?.budget?.maxTotalChars ?? getExploreOutputBudget(allNodes.size).maxOutputChars,
      maxFiles: options?.budget?.maxSections ?? budget.maxSections,
      maxCharsPerFile: options?.budget?.maxCharsPerSection ?? budget.maxCharsPerSection,
    },
  );

  return {
    sections: selected,
    totalChars,
    summary,
  };
}

/**
 * Render ranked sections under an allocation-driven budget (exported for
 * unit testing). Sections are RESERVED a score-proportional share of the
 * envelope up front ({@link allocateExploreBudget}); the loop spends those
 * reservations — never a flat cap. Pure function: no DB, no I/O.
 *
 * Invariant: every admitted section receives >= its reservation before any
 * section draws carry-forward slack; cliffed sections are NAMED (a pointer,
 * never a bare omission); the whole response stays under the hard ceiling.
 */
export function renderSectionsWithBudget(
  sections: ContextSection[],
  tierBudget: ExploreOutputBudget,
): { sections: ContextSection[]; totalChars: number } {
  const prioritized = sections.sort((a, b) => b.relevance - a.relevance);

  const candidates: ExploreAllocationCandidate[] = prioritized.map((s) => ({
    path: s.label,
    score: Math.max(0, s.relevance),
    worth: 1,
    // Code + spec carry the answer to a flow question -> flow-spine (exempt
    // from the cliff, weighted x2). Knowledge/domain/issues are context.
    spine: s.sourceType === 'codegraph' || s.sourceType === 'spec',
  }));
  const allocation = allocateExploreBudget(candidates, tierBudget);
  const reservedTotal = [...allocation.allowances.values()].reduce((s, v) => s + v, 0);
  const sourceCeiling =
    reservedTotal + Math.round(tierBudget.maxOutputChars * EXPLORE_ALLOCATION.WHOLE_FILE_BUY_OVERSHOOT_FRACTION);
  const hardCeiling = Math.min(tierBudget.maxOutputChars * 1.5, 25000);

  const selected: ContextSection[] = [];
  let reservedSoFar = 0;
  let sourceSpent = 0;
  const fullSizeOf = (section: ContextSection): number => section.lines.join('\n').length + LABEL_OVERHEAD;

  for (const section of prioritized) {
    const reserved = allocation.allowances.get(section.label) ?? 0;
    if (reserved <= 0) {
      // Cliffed: not delivered as source, but NAMED so one follow-up fetches it.
      selected.push({ ...section, lines: cliffedPointer(section), relevance: 0 });
      continue;
    }

    reservedSoFar += reserved;
    const owedBelow = Math.max(0, reservedTotal - reservedSoFar);
    const fileSize = fullSizeOf(section);

    // Carry-forward: reservation PLUS slack unspent by sections above, clamped
    // to the MAX_SHARE ceiling so borrowed slack never dominates the envelope.
    const allowance = Math.min(
      reserved + Math.max(0, reservedSoFar - sourceSpent - reserved),
      Math.max(reserved, Math.round(tierBudget.maxOutputChars * EXPLORE_ALLOCATION.MAX_SHARE)),
    );

    // Whole-section buy (CG-21). MERIT reads `reserved`; FUNDING reads the
    // shared overshoot pool with owedBelow.
    const graceBound = wholeFileGraceBound(reserved);
    const buysWhole =
      fileSize <= graceBound ||
      (reserved >= fileSize * EXPLORE_ALLOCATION.WHOLE_FILE_BUY_FRACTION &&
        sourceSpent + fileSize + owedBelow <= sourceCeiling &&
        sourceSpent + fileSize <= hardCeiling);

    if (buysWhole) {
      sourceSpent += fileSize;
      selected.push(section);
      continue;
    }

    // Cluster render bounded by fundedHeadroom (displacement guard in render
    // space). Hold back what is owed below (CG-26).
    const headroom = Math.max(0, hardCeiling - sourceSpent - LABEL_OVERHEAD);
    const fundedHeadroom = Math.floor(Math.min(reserved, headroom, Math.max(0, headroom - owedBelow)));
    const charsBudget = Math.max(0, Math.min(allowance, fundedHeadroom));
    if (charsBudget <= 0) continue;

    const trimmed = trimToChars(section, charsBudget);
    sourceSpent += trimmed.join('\n').length + LABEL_OVERHEAD;
    selected.push({ ...section, lines: trimmed });
  }

  const totalChars = selected.reduce(
    (s, sec) => s + sec.lines.join('\n').length + (sec.relevance === 0 ? 0 : LABEL_OVERHEAD),
    0,
  );

  return { sections: selected, totalChars };
}

// ── Render-path helpers ───────────────────────────────────────────────────

/** Markdown overhead per rendered section (header `## label\n` + trailing blank). */
const LABEL_OVERHEAD = EXPLORE_ALLOCATION.FILE_OVERHEAD;

/**
 * Trim a section's lines to a char budget on whole-line boundaries — never
 * slice a line mid-way (CG-30: cuts on whole lines). Drops trailing lines first
 * (the grouping above appends nodes in discovery order; the head carries seeds).
 */
function trimToChars(section: ContextSection, charsBudget: number): string[] {
  const out: string[] = [];
  let acc = 0;
  for (const line of section.lines) {
    const cost = line.length + 1; // +newline
    if (acc > 0 && acc + cost > charsBudget) break;
    out.push(line);
    acc += cost;
  }
  return out;
}

/**
 * A cliffed section becomes a one-line pointer so the agent can fetch it in a
 * follow-up — "a pointer, never a bare omission".
 */
function cliffedPointer(section: ContextSection): string[] {
  return [`[not included — ${section.sourceType} section "${section.label}" ranked below the relevance cliff; ask again to fetch it]`];
}

// ---------------------------------------------------------------------------
// 格式化函数 — 将节点转为可读文本
// ---------------------------------------------------------------------------

function formatDomainNodes(nodes: UnifiedNode[]): string[] {
  return nodes.map(n => {
    const aliases = n.aliases.length > 0 ? ` (别名: ${n.aliases.join(', ')})` : '';
    return `[domain] ${n.name}${aliases}: ${n.definition}`;
  });
}

function formatSpecNodes(nodes: UnifiedNode[]): string[] {
  return nodes.map(n => {
    const roles = n.roles.length > 0 ? ` [${n.roles.join(',')}]` : '';
    return `[spec:${n.category}] ${n.name}${roles}: ${n.definition.substring(0, 200)}`;
  });
}

function formatKnowhowNodes(nodes: UnifiedNode[]): string[] {
  return nodes.map(n => {
    const tags = n.keywords.length > 0 ? ` #${n.keywords.slice(0, 3).join(' #')}` : '';
    return `[knowhow:${n.metadata.type ?? ''}] ${n.name}${tags}: ${n.definition.substring(0, 200)}`;
  });
}

function formatCodeNodes(nodes: UnifiedNode[]): string[] {
  return nodes.map(n => {
    const sig = n.signature ? ` ${n.signature}` : '';
    const file = n.filePath ? ` (${n.filePath}:${n.startLine})` : '';
    return `[${n.kind}] ${n.name}${sig}${file}`;
  });
}

function formatCodebaseNodes(nodes: UnifiedNode[]): string[] {
  return nodes.map(n => `[codebase] ${n.name}: ${n.definition.substring(0, 200)}`);
}

function formatIssueNodes(nodes: UnifiedNode[]): string[] {
  return nodes.map(n => {
    const sev = n.category ? ` [${n.category}]` : '';
    return `[issue] ${n.name}${sev}: ${n.definition.substring(0, 200)}`;
  });
}

// ---------------------------------------------------------------------------
// Agent-type 特化 — PreToolUse 时加载 role-based spec
// ---------------------------------------------------------------------------

const AGENT_CATEGORY_MAP: Record<string, string[]> = {
  'implement': ['coding', 'arch'],
  'review': ['review', 'coding'],
  'debug': ['debug', 'learning'],
  'plan': ['arch', 'coding'],
  'test': ['test', 'coding'],
  'analyze': ['arch', 'learning'],
};

export function getAgentCategories(agentType: string): string[] {
  return AGENT_CATEGORY_MAP[agentType] ?? [];
}