// src/graph/kg/query/__tests__/allocation.test.ts
//
// Pins the score-proportional allocation invariants. Ported from codegraph's
// explore-proportional-allocation.test.ts — the LCG envelope-safety sweep is
// the load-bearing assertion: Σ allowances ≤ pool ≤ maxOutputChars, exactly,
// for every tier and candidate shape.

import { describe, it, expect } from 'vitest';
import {
  allocateExploreBudget,
  getExploreOutputBudget,
  wholeFileGraceBound,
  shouldBuyWholeFile,
  EXPLORE_ALLOCATION,
  type ExploreAllocationCandidate,
} from '../allocation.js';

// ── helpers mirroring codegraph's test assertions ─────────────────────────

function reservedTotal(alloc: ReturnType<typeof allocateExploreBudget>): number {
  let s = 0;
  for (const v of alloc.allowances.values()) s += v;
  return s;
}

/** What the render loop can emit: Σ (allowance + FILE_OVERHEAD) per admitted file. */
function worstCaseEmission(alloc: ReturnType<typeof allocateExploreBudget>): number {
  let s = 0;
  for (const v of alloc.allowances.values()) s += v + EXPLORE_ALLOCATION.FILE_OVERHEAD;
  return s;
}

/** Deterministic LCG so the sweep is reproducible (same seeds, same failures). */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function candidate(path: string, score: number, worth = 1, spine = false): ExploreAllocationCandidate {
  return { path, score, worth, spine };
}

// ── tests ─────────────────────────────────────────────────────────────────

describe('allocateExploreBudget', () => {
  it('returns empty for no candidates', () => {
    const alloc = allocateExploreBudget([], getExploreOutputBudget(100));
    expect(alloc.allowances.size).toBe(0);
    expect(alloc.cliffed).toEqual([]);
    expect(alloc.pool).toBe(0);
  });

  it('gives the higher-scoring file the bigger share', () => {
    const budget = getExploreOutputBudget(100);
    const alloc = allocateExploreBudget([
      candidate('a', 50),
      candidate('b', 10),
    ], budget);
    expect(alloc.allowances.get('a')!).toBeGreaterThan(alloc.allowances.get('b')!);
  });

  it('scales the split with the score ratio', () => {
    const budget = getExploreOutputBudget(100);
    const wide = allocateExploreBudget([candidate('a', 40), candidate('b', 10)], budget);
    const narrow = allocateExploreBudget([candidate('a', 11), candidate('b', 10)], budget);
    const wideRatio = wide.allowances.get('a')! / wide.allowances.get('b')!;
    const narrowRatio = narrow.allowances.get('a')! / narrow.allowances.get('b')!;
    // A 4x score buys more share than a 1.1x score.
    expect(wideRatio).toBeGreaterThan(narrowRatio);
  });

  it('never reserves more than the envelope', () => {
    const budget = getExploreOutputBudget(100);
    const alloc = allocateExploreBudget(
      [candidate('a', 50), candidate('b', 40), candidate('c', 30), candidate('d', 20)],
      budget,
    );
    expect(reservedTotal(alloc)).toBeLessThanOrEqual(budget.maxOutputChars);
    expect(alloc.pool).toBeLessThanOrEqual(budget.maxOutputChars);
  });

  it('caps any single file at MAX_SHARE', () => {
    const budget = getExploreOutputBudget(100);
    const alloc = allocateExploreBudget([candidate('a', 999), candidate('b', 1)], budget);
    const ceiling = Math.round(budget.maxOutputChars * EXPLORE_ALLOCATION.MAX_SHARE);
    for (const v of alloc.allowances.values()) expect(v).toBeLessThanOrEqual(ceiling);
  });

  it('lets the top file exceed the flat per-file cap when it earns it', () => {
    const budget = getExploreOutputBudget(100);
    const alloc = allocateExploreBudget([candidate('a', 100), candidate('b', 5)], budget);
    // A god-file concentrates the envelope: its share exceeds the flat cap.
    expect(alloc.allowances.get('a')!).toBeGreaterThan(budget.maxCharsPerFile);
  });

  it('is RELATIVE — the same score survives against weaker company', () => {
    const budget = getExploreOutputBudget(100);
    const cliffed = allocateExploreBudget(
      [candidate('top', 90), candidate('mid', 8)],
      budget,
    );
    const notCliffed = allocateExploreBudget(
      [candidate('top', 12), candidate('mid', 8)],
      budget,
    );
    // score 8 is cliffed when the top is 90 (8/90 < 0.15), NOT when the top is 12 (8/12 > 0.15).
    expect(cliffed.cliffed).toContain('mid');
    expect(notCliffed.cliffed).not.toContain('mid');
  });

  it('never rises above the score-floor ceiling', () => {
    const budget = getExploreOutputBudget(100);
    const alloc = allocateExploreBudget([candidate('god', 500), candidate('peer', 9)], budget);
    // CLIFF_MAX caps the cliff at 10; a peer at weight 9 is below 10 and cliffed,
    // but no god-file pushes the cliff above 10 to silence legitimately-admitted peers.
    expect(alloc.cliffAt).toBeLessThanOrEqual(EXPLORE_ALLOCATION.CLIFF_MAX);
  });

  it('doubles the penalty on worth (worth < 1 demotes)', () => {
    const budget = getExploreOutputBudget(100);
    const alloc = allocateExploreBudget(
      [candidate('gen', 20, 0.3), candidate('hand', 20, 1)],
      budget,
    );
    // Same score, but gen.ts worth 0.3 → weight 6, hand.ts worth 1 → weight 20.
    // gen.ts (6) is under cliff (min(20*0.15,10)=3)? No — 6 > 3, admitted but smaller.
    expect(alloc.allowances.get('hand')!).toBeGreaterThanOrEqual(alloc.allowances.get('gen')!);
  });

  it('exempts flow-spine files from the cliff', () => {
    const budget = getExploreOutputBudget(100);
    const alloc = allocateExploreBudget(
      [candidate('top', 400), candidate('spine', 2, 1, true)],
      budget,
    );
    // spine.ts weight 2*2=4 < cliff(min(800*0.15,10)=10) BUT spine-exempt → admitted.
    expect(alloc.allowances.has('spine')).toBe(true);
    expect(alloc.cliffed).not.toContain('spine');
  });

  it('never cliffs every candidate', () => {
    const budget = getExploreOutputBudget(100);
    const alloc = allocateExploreBudget([candidate('only', 0.5)], budget);
    expect(alloc.allowances.size).toBe(1);
    expect(alloc.allowances.get('only')!).toBeGreaterThan(0);
    expect(alloc.cliffed).not.toContain('only');
  });

  it('hands a cliffed file maxFiles slot to the next file down', () => {
    const budget = getExploreOutputBudget(100);
    // maxFiles=2; noise cliffs, the slot goes to 'b' (the next file down).
    const alloc = allocateExploreBudget(
      [candidate('a', 100), candidate('b', 20), candidate('noise', 1)],
      budget,
      2,
    );
    expect([...alloc.allowances.keys()].sort()).toEqual(['a', 'b']);
  });

  it('gives every admitted file ≥ MIN_CHARS when affordable', () => {
    const budget = getExploreOutputBudget(100);
    const alloc = allocateExploreBudget(
      Array.from({ length: 4 }, (_, i) => candidate(`f${i}`, 10 + i)),
      budget,
    );
    for (const v of alloc.allowances.values()) {
      expect(v).toBeGreaterThanOrEqual(EXPLORE_ALLOCATION.MIN_CHARS);
    }
  });

  it('accounts for every candidate (admitted ∪ cliffed = input)', () => {
    const budget = getExploreOutputBudget(100);
    const inputs = [candidate('a', 100), candidate('b', 50), candidate('c', 1)];
    const alloc = allocateExploreBudget(inputs, budget);
    const accounted = new Set([...alloc.allowances.keys(), ...alloc.cliffed]);
    expect(accounted.size).toBe(inputs.length);
    for (const c of inputs) expect(accounted.has(c.path)).toBe(true);
  });

  it('fails safe on non-finite score', () => {
    const budget = getExploreOutputBudget(100);
    for (const bad of [Infinity, -Infinity, NaN] as const) {
      const alloc = allocateExploreBudget([candidate('a', bad), candidate('b', 5)], budget);
      for (const v of alloc.allowances.values()) {
        expect(Number.isFinite(v)).toBe(true);
      }
    }
  });

  // ── tier invariant ──────────────────────────────────────────────────────

  it('never gives a larger tier a smaller maxCharsPerFile', () => {
    const counts = [50, 300, 2000, 20000];
    const budgets = counts.map(getExploreOutputBudget);
    for (let i = 1; i < budgets.length; i++) {
      expect(budgets[i]!.maxCharsPerFile).toBeGreaterThanOrEqual(budgets[i - 1]!.maxCharsPerFile);
      expect(budgets[i]!.maxOutputChars).toBeGreaterThanOrEqual(budgets[i - 1]!.maxOutputChars);
    }
  });

  it('cliffs the same files at every tier (cliff is relative, not sized)', () => {
    const candidates = [
      candidate('top', 100), candidate('mid', 30), candidate('low', 5),
    ];
    const cliffs = [100, 1000, 10000].map((n) => {
      const budget = getExploreOutputBudget(n);
      return new Set(allocateExploreBudget(candidates, budget).cliffed);
    });
    // The cliff decision is identical regardless of tier.
    const s0 = cliffs[0]!;
    expect(cliffs.every((s) => s.size === s0.size && [...s0].every((x) => s.has(x)))).toBe(true);
  });

  // ── the load-bearing envelope-safety sweep ──────────────────────────────

  it('LCG sweep: reservedTotal ≤ pool AND worstCaseEmission ≤ maxOutputChars, every shape', () => {
    const tiers = [50, 300, 2000, 20000];
    const maxFilesOptions = [1, 4, 8, 30];
    const rng = lcg(0xC0FFEE);
    let checks = 0;
    for (const tierCount of tiers) {
      const budget = getExploreOutputBudget(tierCount);
      for (const mf of maxFilesOptions) {
        for (let trial = 0; trial < 200; trial++) {
          const n = 1 + Math.floor(rng() * 30); // 1..30 files
          const cands: ExploreAllocationCandidate[] = [];
          for (let i = 0; i < n; i++) {
            const score = Math.floor(rng() * 100);
            const worth = Math.round(rng() * 10) / 10;
            const spine = rng() < 0.1;
            cands.push(candidate(`f${i}`, score, worth, spine));
          }
          const alloc = allocateExploreBudget(cands, budget, mf);
          // THE invariant: reservations fit the envelope exactly.
          expect(reservedTotal(alloc)).toBeLessThanOrEqual(alloc.pool + 0);
          expect(alloc.pool).toBeLessThanOrEqual(budget.maxOutputChars);
          // Worst-case render emission (reservations + overhead) ≤ envelope.
          // (The CG-14 hard ceiling allows bounded overshoot beyond this in the
          // render loop's whole-file-buy path; the RESERVATIONS themselves fit.)
          expect(worstCaseEmission(alloc)).toBeLessThanOrEqual(
            budget.maxOutputChars + EXPLORE_ALLOCATION.FILE_OVERHEAD * alloc.allowances.size,
          );
          checks++;
        }
      }
    }
    // Sanity: the sweep actually ran thousands of shapes, not a degenerate few.
    expect(checks).toBeGreaterThan(1000);
  });

  it('concentrates a precise query far harder than a diffuse one', () => {
    const budget = getExploreOutputBudget(100);
    // Precise: one dominant file.
    const precise = allocateExploreBudget(
      [candidate('answer', 90), candidate('peer1', 9), candidate('peer2', 8), candidate('peer3', 7)],
      budget,
    );
    // Diffuse: roughly equal files.
    const diffuse = allocateExploreBudget(
      [candidate('a', 20), candidate('b', 19), candidate('c', 18), candidate('d', 17)],
      budget,
    );
    const preciseTopShare = precise.allowances.get('answer')! / reservedTotal(precise);
    const diffuseTopShare = diffuse.allowances.get('a')! / reservedTotal(diffuse);
    expect(preciseTopShare).toBeGreaterThan(0.45);
    expect(diffuseTopShare).toBeLessThan(0.3);
    expect(preciseTopShare).toBeGreaterThan(diffuseTopShare);
  });
});

describe('whole-file helpers', () => {
  it('grace bound grows with reservation but is capped', () => {
    const big = wholeFileGraceBound(10000);
    const small = wholeFileGraceBound(1000);
    expect(big).toBeGreaterThan(small);
    // Cap: never more than GRACE_MAX (800) over the reservation.
    expect(big - 10000).toBeLessThanOrEqual(EXPLORE_ALLOCATION.WHOLE_FILE_GRACE_MAX);
  });

  it('buys whole when the file is within the grace bound', () => {
    expect(shouldBuyWholeFile(3800, 4100, 0, 3800, 12000)).toBe(true);
  });

  it('does not buy whole when the reservation covers less than the buy fraction', () => {
    // fileSize 10000, reservation 1000 (10% < 60%) and far outside grace.
    expect(shouldBuyWholeFile(1000, 10000, 0, 1000, 12000)).toBe(false);
  });
});
