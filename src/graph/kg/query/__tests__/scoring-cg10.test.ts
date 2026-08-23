// src/graph/kg/query/__tests__/scoring-cg10.test.ts
//
// Pins the CG-10 relevance scoring overhaul — the four multiplicative demotions
// ported from codegraph's tools.ts:300-440. All behaviour is opt-in via the
// RelevanceContext, so computeScore's legacy behaviour is covered by scoring.test.ts.

import { describe, it, expect } from 'vitest';
import {
  computeScore,
  relevanceWeight,
  rankPenalty,
  RELEVANCE_KIND_WEIGHT,
  WEAK_RELEVANCE_KINDS,
  ISOLATED_WEAK_KIND_WEIGHT,
  RELEVANCE_USAGE_EDGES,
  PERIPHERAL_SCORE_CAP,
  GENERATED_RANK_PENALTY,
  LOW_VALUE_RANK_PENALTY,
  AMBIENT_DECLARATION_RANK_PENALTY,
  type ScoreCandidateNode,
  type RelevanceContext,
} from '../scoring.js';

const node = (overrides: Partial<ScoreCandidateNode> = {}): ScoreCandidateNode => ({
  id: 'n1', kind: 'function', name: 'explore', filePath: '/src/explore.ts', ...overrides,
});

describe('relevanceWeight (CG-10 lever 1+2)', () => {
  it('gives callables and types weight 1.0', () => {
    for (const kind of ['function', 'method', 'class', 'interface', 'trait', 'protocol']) {
      expect(relevanceWeight(kind as never)).toBe(1);
    }
  });

  it('gives parameters weight 0.15 — essentially never the subject of a question', () => {
    expect(relevanceWeight('parameter')).toBe(0.15);
  });

  it('uses the default weight for an unlisted kind', () => {
    expect(relevanceWeight('unknown_xyz' as never)).toBe(0.5);
  });

  it('does not probe isolation for a callable — returns full weight', () => {
    // function is not in WEAK_RELEVANCE_KINDS, so probeIsolation is ignored.
    const w = relevanceWeight('function', {
      probeIsolation: true,
      nodeId: 'n',
      isUsageIsolated: () => true,
    });
    expect(w).toBe(1);
  });

  it('isolates a weak kind that nothing uses → ISOLATED_WEAK_KIND_WEIGHT', () => {
    // constant is weak; probeIsolation applies.
    const w = relevanceWeight('constant', {
      probeIsolation: true,
      nodeId: 'n',
      isUsageIsolated: () => true,
    });
    expect(w).toBe(ISOLATED_WEAK_KIND_WEIGHT);
  });

  it('keeps full weight for a weak kind that IS used', () => {
    const w = relevanceWeight('variable', {
      probeIsolation: true,
      nodeId: 'n',
      isUsageIsolated: () => false,
    });
    expect(w).toBe(RELEVANCE_KIND_WEIGHT['variable']);
  });

  it('is fail-open without an isUsageIsolated probe — keeps full weight', () => {
    // probeIsolation requested but no isUsageIsolated fn → cannot decide → keep weight.
    const w = relevanceWeight('constant', { probeIsolation: true, nodeId: 'n' });
    expect(w).toBe(RELEVANCE_KIND_WEIGHT['constant']);
  });
});

describe('rankPenalty (CG-10 lever 3)', () => {
  it('returns 1.0 for a plain source file', () => {
    expect(rankPenalty('/src/explore.ts', () => ({}))).toBe(1);
  });

  it('applies GENERATED for generated source', () => {
    expect(rankPenalty('/gen/crud.ts', () => ({ isGenerated: true }))).toBe(GENERATED_RANK_PENALTY);
  });

  it('applies LOW_VALUE and compounds with generated (two reasons)', () => {
    const p = rankPenalty('/gen/crud.gen.test.ts', () => ({ isGenerated: true, isLowValue: true }));
    expect(p).toBeCloseTo(GENERATED_RANK_PENALTY * LOW_VALUE_RANK_PENALTY, 6);
  });

  it('takes min(generated, ambient) — does NOT double-charge for the same property', () => {
    const both = rankPenalty('/x.d.ts', () => ({ isGenerated: true, isDampedDeclaration: true }));
    // min(0.3, 0.5) = 0.3, NOT 0.3 * 0.5.
    expect(both).toBe(Math.min(GENERATED_RANK_PENALTY, AMBIENT_DECLARATION_RANK_PENALTY));
  });

  it('applies ambient (CG-28) for a hand-written .d.ts of types nothing imports', () => {
    expect(rankPenalty('/globals.d.ts', () => ({ isDampedDeclaration: true }))).toBe(AMBIENT_DECLARATION_RANK_PENALTY);
  });
});

describe('computeScore (opt-in CG-10 path)', () => {
  it('legacy path is byte-identical with no relevanceContext', () => {
    // Same node/query → legacy and no-context path give the same number.
    const legacy = computeScore(node(), 'explore');
    const ctxless = computeScore(node(), 'explore', undefined);
    const withOptsUndefined = computeScore(node(), 'explore', undefined, { relevanceContext: undefined });
    expect(ctxless).toBe(legacy);
    expect(withOptsUndefined).toBe(legacy);
  });

  it('kills an isolated weak-kind name collision vs a real definition', () => {
    // Two files, both match the query 'explore'.
    // real: function explore, used → full kind weight.
    // incidental: const explore (weak), unused → ISOLATED weight.
    const realUsedCtx: RelevanceContext = { isUsageIsolated: () => false };
    const constUnusedCtx: RelevanceContext = { isUsageIsolated: () => true };

    const realNode = node({ kind: 'function', name: 'explore' });
    const constNode = node({ id: 'n2', kind: 'constant', name: 'explore' });

    const real = computeScore(realNode, 'explore', undefined, { relevanceContext: realUsedCtx });
    const incidental = computeScore(constNode, 'explore', undefined, { relevanceContext: constUnusedCtx });

    // A const collision must be well below the function definition — the whole #1500 fix.
    expect(real).toBeGreaterThan(0);
    expect(incidental).toBeLessThan(real);
    // The isolated weight (0.08) drives the name-match demotion; the additive
    // bm25/path base softens the RATIO but the collision is still strongly below.
    // (codegraph applies this at the file-group level where the base is smaller;
    // per-node the composite is ~0.2-0.25 — still a decisive demotion.)
    expect(incidental / real).toBeLessThan(0.4);
  });

  it('applyFile demotes a generated file multiplicatively on the primary sort key', () => {
    const classify = (fp: string) => ({ isGenerated: fp.includes('/gen/') });
    const ctx: RelevanceContext = { classifyFile: classify };

    const handScore = computeScore(node({ filePath: '/src/explore.ts' }), 'explore', undefined, {
      relevanceContext: ctx,
    });
    const genScore = computeScore(node({ filePath: '/gen/explore.ts' }), 'explore', undefined, {
      relevanceContext: ctx,
    });

    // Same node identity, but generated is demoted by GENERATED_RANK_PENALTY.
    expect(genScore).toBeCloseTo(handScore * GENERATED_RANK_PENALTY, 6);
  });
});

describe('CG-10 invariants', () => {
  it('RELEVANCE_USAGE_EDGES never includes "contains" (lexical nesting is not usage)', () => {
    expect(RELEVANCE_USAGE_EDGES.has('contains')).toBe(false);
    expect(RELEVANCE_USAGE_EDGES.has('calls')).toBe(true);
    expect(RELEVANCE_USAGE_EDGES.has('references')).toBe(true);
  });

  it('WEAK_RELEVANCE_KINDS is exactly the weak set', () => {
    expect(WEAK_RELEVANCE_KINDS.has('constant')).toBe(true);
    expect(WEAK_RELEVANCE_KINDS.has('variable')).toBe(true);
    expect(WEAK_RELEVANCE_KINDS.has('parameter')).toBe(true);
    expect(WEAK_RELEVANCE_KINDS.has('property')).toBe(true);
    expect(WEAK_RELEVANCE_KINDS.has('field')).toBe(true);
    expect(WEAK_RELEVANCE_KINDS.has('enum_member')).toBe(true);
    // A callable is NOT weak.
    expect(WEAK_RELEVANCE_KINDS.has('function')).toBe(false);
  });

  it('PERIPHERAL_SCORE_CAP is a small constant (size is not evidence)', () => {
    expect(PERIPHERAL_SCORE_CAP).toBeLessThanOrEqual(10);
    expect(PERIPHERAL_SCORE_CAP).toBeGreaterThan(0);
  });
});
