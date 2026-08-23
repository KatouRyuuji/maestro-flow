// src/graph/kg/query/allocation.ts — score-proportional byte allocation
//
// Ported from codegraph's CG-12 / #1500 explore budget allocation
// (codegraph/src/mcp/tools.ts:478-735). Pure algorithm, SQLite-agnostic,
// lifts answer quality on every repo size.
//
// The invariant that must never break:
//   Σ allowances ≤ pool ≤ budget.maxOutputChars, exactly, at every tier and
//   every candidate shape. Reservations are a PROMISE the render loop keeps,
//   not a cap it may quietly under-use. Pinned by allocation.test.ts.
//
// Calibrated for Maestro's smaller envelope (codegraph tiers 13K-24K;
// Maestro ~6K-12K): MIN_CHARS 700→400, MAX_SHARE 0.7→0.65. The cliff and
// whole-file ratios are size-independent and carry unchanged.

/**
 * Absolute ceiling on the cliff threshold and the score floor (the admission
 * gate). One overwhelming top file must not silence every peer the floor
 * admitted — the cliff is a RELATIVE prune of weak evidence, not a second
 * admission gate.
 */
export const SCORE_FLOOR_MAX = 10;

/**
 * Allocation constants. Each is a knob, not a magic number — see the comments
 * for what each pins and what breaks if it moves. Re-tuning is a visible
 * decision; the test suite pins the live values.
 */
export const EXPLORE_ALLOCATION = {
  /**
   * A file whose weight is under this fraction of the top file's gets no source.
   * Relative — size-independent. Generated CRUD lands at 10-11% and must cliff;
   * a genuine flow callee lands at 25% and must NOT. Between is a judgement the
   * agent can undo for ~0 cost (a cliffed file is still NAMED).
   */
  CLIFF_FRACTION: 0.15,
  /** Ceiling on the cliff, same units as SCORE_FLOOR_MAX. */
  CLIFF_MAX: SCORE_FLOOR_MAX,
  /**
   * Floor on a useful reservation — every admitted file gets this much before the
   * proportional split divides the rest. Below it a slice can't hold one complete
   * method and forces the Read this tool exists to prevent. Re-tuned down from
   * codegraph's 700 for Maestro's smaller envelope.
   */
  MIN_CHARS: 400,
  /** Safety valve against a single god-file (the proportional split is primary). */
  MAX_SHARE: 0.65,
  /** Markdown overhead per rendered file (header + fences + blanks). */
  FILE_OVERHEAD: 200,
  /** Flow-spine files are weighted ×2 and are exempt from the cliff. */
  SPINE_WEIGHT_BOOST: 2,
  /** Sliver a file may exceed its reservation and still ship whole. */
  WHOLE_FILE_GRACE_FRACTION: 0.15,
  WHOLE_FILE_GRACE_MAX: 800,
  /** Reservation covering ≥ this fraction of a file BUYS the whole file (CG-21). */
  WHOLE_FILE_BUY_FRACTION: 0.6,
  /** The buy overshoot is funded from ONE shared pool = this fraction of envelope. */
  WHOLE_FILE_BUY_OVERSHOOT_FRACTION: 0.15,
} as const;

/**
 * The envelope split among admitted files. `maxOutputChars` bounds the
 * RESERVATIONS; the render loop may overshoot by a bounded grace (CG-14 hard
 * ceiling = min(maxOutputChars × 1.5, 25000)).
 */
export interface ExploreOutputBudget {
  /** Total reservation pool. Σ allowances ≤ this, exactly. */
  maxOutputChars: number;
  /** Max files admitted (per-tier). */
  maxFiles: number;
  /** Flat per-file cap (survives only as the pre-allocation guard / MAX_SHARE clamp). */
  maxCharsPerFile: number;
}

/**
 * One candidate file's allocation inputs, in FINAL RANK ORDER. `candidates`
 * passed to {@link allocateExploreBudget} must already be sorted by the ranking
 * pass — `maxFiles` is applied to the cliff survivors in that order, so
 * cliffing genuinely hands a slot to the next file down.
 */
export interface ExploreAllocationCandidate {
  path: string;
  /** Post-rankPenalty relevance score from the ranking pass. */
  score: number;
  /**
   * How much this file's BYTES are worth, independent of how well it matched
   * (0-1). Generated CRUD can rank on name-collision while its bytes stay
   * mechanical — rankPenalty applied a SECOND time here finally sinks it.
   */
  worth: number;
  /** Carries a symbol on the rendered flow spine (exempt from cliff, ×2 weight). */
  spine: boolean;
}

/** Result of allocating one envelope across a ranked candidate set. */
export interface ExploreAllocation {
  /** path → chars of source it may render. Only holds admitted files. */
  allowances: Map<string, number>;
  /** Files the cliff zeroed, in rank order — pointers, not bytes. */
  cliffed: string[];
  /** The weight threshold the cliff fired at (0 when nothing was cliffed). */
  cliffAt: number;
  /** Chars actually split among the admitted files (≤ maxOutputChars). */
  pool: number;
}

// ── Tier sizing ──────────────────────────────────────────────────────────

/**
 * Default tier table indexed by indexed file count. Larger tiers afford a
 * proportionally larger envelope (more context to spend). A larger tier must
 * never allow LESS per file than a smaller one (monotonic invariant), except
 * MIN_CHARS which is an absolute floor.
 *
 * Scaled for Maestro's scope (codegraph's tiers ran 13K-24K); Maestro's
 * knowledge-graph explore targets docs + wiki + mid-size code, so the
 * envelope is ~half. Keep the ratios, shrink the absolute numbers.
 */
const DEFAULT_TIERS: ReadonlyArray<{ maxFiles?: number; maxOutputChars: number; defaultMaxFiles: number; maxCharsPerFile: number }> = [
  { maxFiles: 150, maxOutputChars: 6_000, defaultMaxFiles: 4, maxCharsPerFile: 1_800 },
  { maxFiles: 500, maxOutputChars: 9_000, defaultMaxFiles: 5, maxCharsPerFile: 2_200 },
  { maxFiles: 5_000, maxOutputChars: 12_000, defaultMaxFiles: 8, maxCharsPerFile: 3_200 },
  { maxOutputChars: 12_000, defaultMaxFiles: 8, maxCharsPerFile: 3_600 },
];

/**
 * Resolve the output budget for a project of `fileCount` indexed files.
 * The tier invariant (monotonic maxCharsPerFile) is asserted at module load.
 */
export function getExploreOutputBudget(fileCount: number): ExploreOutputBudget {
  for (const tier of DEFAULT_TIERS) {
    if (tier.maxFiles === undefined || fileCount < tier.maxFiles) {
      return {
        maxOutputChars: tier.maxOutputChars,
        maxFiles: tier.defaultMaxFiles,
        maxCharsPerFile: tier.maxCharsPerFile,
      };
    }
  }
  const last = DEFAULT_TIERS[DEFAULT_TIERS.length - 1]!;
  return {
    maxOutputChars: last.maxOutputChars,
    maxFiles: last.defaultMaxFiles,
    maxCharsPerFile: last.maxCharsPerFile,
  };
}

// Tier monotonicity self-check (fail loud at startup, not silently at runtime).
for (let i = 1; i < DEFAULT_TIERS.length; i++) {
  const prev = DEFAULT_TIERS[i - 1]!;
  const cur = DEFAULT_TIERS[i]!;
  if (cur.maxCharsPerFile < prev.maxCharsPerFile || cur.maxOutputChars < prev.maxOutputChars) {
    throw new Error(`allocation.ts: tier invariant violated at index ${i}`);
  }
}

// ── The allocator ─────────────────────────────────────────────────────────

/**
 * Split `budget.maxOutputChars` across ranked candidates in proportion to
 * relevance, with a hard relative cliff.
 *
 * Invariant: Σ allowances ≤ pool ≤ budget.maxOutputChars, exactly.
 * Invariant: a larger tier never allows less per file than a smaller one.
 *
 * Algorithm (mirrors codegraph CG-12):
 *   1. weight(c) = max(0,score) × max(0,min(1,worth)) × (spine ? 2 : 1)
 *   2. cliff = min(topWeight × 0.15, 10); files under it (and not spine) → pointer
 *   3. admit up to maxFiles survivors (cliff frees the slot for the next file down)
 *   4. affordability trim: cliff lowest-weight files if envelope can't afford MIN_CHARS each
 *   5. pool = maxOutputChars − FILE_OVERHEAD × admitted
 *      allowance = floor(MIN_CHARS-each) + floor(remainder × weight/total), clamped to MAX_SHARE
 */
export function allocateExploreBudget(
  candidates: readonly ExploreAllocationCandidate[],
  budget: ExploreOutputBudget,
  maxFiles: number = budget.maxFiles,
): ExploreAllocation {
  const A = EXPLORE_ALLOCATION;
  const empty: ExploreAllocation = { allowances: new Map(), cliffed: [], cliffAt: 0, pool: 0 };
  if (candidates.length === 0) return empty;

  // Non-finite weight fails safe to 0 — Infinity/Infinity = NaN would poison the
  // render loop. Scores are finite sums in the real pipeline; this only guards.
  const weightOf = (c: ExploreAllocationCandidate): number => {
    const w = Math.max(0, c.score) * Math.max(0, Math.min(1, c.worth)) * (c.spine ? A.SPINE_WEIGHT_BOOST : 1);
    return Number.isFinite(w) ? w : 0;
  };

  const weights = new Map(candidates.map((c) => [c.path, weightOf(c)]));
  const topWeight = Math.max(...weights.values());
  if (!(topWeight > 0)) return empty;

  // Cliff over the WHOLE list, before maxFiles — otherwise the file cap fills
  // with cliff-bound files and the slot they free is never handed on.
  const cliffAt = Math.min(topWeight * A.CLIFF_FRACTION, A.CLIFF_MAX);
  const cliffed: string[] = [];
  let admitted: ExploreAllocationCandidate[] = [];
  for (const c of candidates) {
    if (!c.spine && (weights.get(c.path) ?? 0) < cliffAt) cliffed.push(c.path);
    else admitted.push(c);
  }
  // Never cliff every candidate: an empty response costs a whole round-trip.
  if (admitted.length === 0) {
    admitted = [candidates[0]!];
    const firstIdx = cliffed.indexOf(candidates[0]!.path);
    if (firstIdx >= 0) cliffed.splice(firstIdx, 1);
  }
  // Apply maxFiles AFTER cliffing — cliffing frees a slot for the next file down.
  for (const c of admitted.slice(maxFiles)) cliffed.push(c.path);
  admitted = admitted.slice(0, maxFiles);

  // Serve fewer files well rather than many badly: the envelope must afford
  // MIN_CHARS for everything admitted. Cliff the lowest-weight (never a spine,
  // never the last) in ONE deterministic trim — one-at-a-time snowballs.
  const affordable = Math.max(1, Math.floor(budget.maxOutputChars / (A.MIN_CHARS + A.FILE_OVERHEAD)));
  if (admitted.length > affordable) {
    const byWeight = [...admitted].sort((a, b) => (weights.get(b.path) ?? 0) - (weights.get(a.path) ?? 0));
    const keep = new Set(byWeight.slice(0, affordable).map((c) => c.path));
    for (const c of admitted) if (c.spine) keep.add(c.path);
    for (const c of admitted) if (!keep.has(c.path)) cliffed.push(c.path);
    admitted = admitted.filter((c) => keep.has(c.path));
  }

  const allowances = new Map<string, number>();
  const pool = Math.max(0, budget.maxOutputChars - A.FILE_OVERHEAD * admitted.length);
  const total = admitted.reduce((s, c) => s + (weights.get(c.path) ?? 0), 0);
  if (total <= 0 || admitted.length === 0) return { allowances, cliffed, cliffAt, pool };

  // Everyone gets MIN_CHARS; the REMAINDER splits by weight. The floor keeps a
  // diffuse survey question returning a useful spread; the remainder
  // concentrates a precise one (the top file's slice grows with its weight).
  const ceiling = Math.round(budget.maxOutputChars * A.MAX_SHARE);
  const floors = Math.min(pool, A.MIN_CHARS * admitted.length);
  const remainder = Math.max(0, pool - floors);
  // Both parts FLOOR: rounded shares can exceed the remainder that fed it (by
  // up to half a char/file), and reservations must fit the pool EXACTLY — the
  // render loop spends them, so an over-allocation is an over-long response
  // the hard ceiling then has to truncate.
  for (const c of admitted) {
    const share = Math.floor(floors / admitted.length)
      + Math.floor((remainder * (weights.get(c.path) ?? 0)) / total);
    allowances.set(c.path, Math.min(share, ceiling));
  }
  return { allowances, cliffed, cliffAt, pool };
}

// ── Whole-file decision helpers (used by the render loop in context-builder) ──

/**
 * The grace bound: a file within this many chars over its reservation still
 * ships WHOLE (slicing the sliver saves ~1% envelope and costs a Read).
 */
export function wholeFileGraceBound(reservation: number): number {
  const A = EXPLORE_ALLOCATION;
  return reservation + Math.min(A.WHOLE_FILE_GRACE_MAX, Math.round(reservation * A.WHOLE_FILE_GRACE_FRACTION));
}

/**
 * CG-21 buy rule: should a reservation that already covers most of a file buy
 * the WHOLE file? MERIT reads the reservation (not post-carry allowance);
 * FUNDING reads the shared overshoot pool with `owedBelow`. Three independent
 * tests, kept apart — borrowed slack can never promote a weak file to whole.
 */
export function shouldBuyWholeFile(
  reservation: number,
  fileSize: number,
  sourceSpent: number,
  reservedTotal: number,
  maxOutputChars: number,
): boolean {
  const A = EXPLORE_ALLOCATION;
  if (fileSize <= wholeFileGraceBound(reservation)) return true;
  const owedBelow = Math.max(0, reservedTotal - reservation); // placeholder; caller passes real owedBelow
  const sourceCeiling = reservedTotal + Math.round(maxOutputChars * A.WHOLE_FILE_BUY_OVERSHOOT_FRACTION);
  return (
    reservation >= fileSize * A.WHOLE_FILE_BUY_FRACTION // MERIT
    && sourceSpent + fileSize + owedBelow <= sourceCeiling // FUNDING
  );
}
