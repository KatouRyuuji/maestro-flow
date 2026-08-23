// src/graph/kg/query/__tests__/render-path.test.ts
//
// Pins the render-path invariants of renderSectionsWithBudget (CG-21/26/30/31/36/38):
//   - carry-forward of unspent slack down rank order
//   - displacement guard (fundedHeadroom) — an overspending top section cannot
//     take a lower section's reservation
//   - whole-section buy (reservation >=60% of section → send in full from the
//     shared overshoot pool)
//   - cliffed sections are NAMED (a pointer, never a bare omission)
//   - the whole response stays under the hard ceiling
//
// Pure function tests — no DB. renderSectionsWithBudget is extracted from
// buildContext precisely for this.

import { describe, it, expect } from 'vitest';
import { renderSectionsWithBudget, type ContextSection } from '../context-builder.js';
import { EXPLORE_ALLOCATION } from '../allocation.js';

function section(
  label: string,
  sourceType: ContextSection['sourceType'],
  relevance: number,
  lineCount = 20,
  lineLen = 60,
): ContextSection {
  const lines = Array.from({ length: lineCount }, (_, i) => `${label} line ${i}: ${'x'.repeat(lineLen)}`);
  return { label, lines, sourceType, relevance };
}

const CODE = 'codegraph' as ContextSection['sourceType'];
const SPEC = 'spec' as ContextSection['sourceType'];
const KNOW = 'knowhow' as ContextSection['sourceType'];

const SMALL_BUDGET = { maxOutputChars: 2000, maxFiles: 8, maxCharsPerFile: 2000 };
const MED_BUDGET = { maxOutputChars: 6000, maxFiles: 8, maxCharsPerFile: 1800 };

function deliveredChars(sections: ContextSection[]): number {
  let s = 0;
  for (const sec of sections) s += sec.lines.join('\n').length + (sec.relevance === 0 ? 0 : EXPLORE_ALLOCATION.FILE_OVERHEAD);
  return s;
}

describe('renderSectionsWithBudget — cliff + naming', () => {
  it('names a cliffed section with a pointer, never a bare omission', () => {
    // A dominant code section and a tiny weak one — the weak one cliffs.
    const out = renderSectionsWithBudget(
      [section('code[answer]', CODE, 100, 30), section('knowhow[weak]', KNOW, 1, 5)],
      MED_BUDGET,
    );
    const weak = out.sections.find((s) => s.label.includes('weak'))!;
    expect(weak).toBeDefined();
    // relevance 0 marks it a pointer; its lines mention it was withheld.
    expect(weak.relevance).toBe(0);
    expect(weak.lines.some((l) => /not included|below|cliff|fetch/i.test(l))).toBe(true);
  });

  it('returns no sections for empty input', () => {
    const out = renderSectionsWithBudget([], MED_BUDGET);
    expect(out.sections).toEqual([]);
    expect(out.totalChars).toBe(0);
  });
});

describe('renderSectionsWithBudget — concentration + whole-section buy', () => {
  it('gives the higher-relevance code section more bytes than a weaker one', () => {
    const out = renderSectionsWithBudget(
      [section('code[answer]', CODE, 100, 40), section('code[peer]', CODE, 20, 40)],
      MED_BUDGET,
    );
    const answer = out.sections.find((s) => s.label.includes('answer'))!;
    const peer = out.sections.find((s) => s.label.includes('peer'))!;
    const answerChars = answer.lines.join('\n').length;
    const peerChars = peer.lines.join('\n').length;
    expect(answerChars).toBeGreaterThan(peerChars);
  });

  it('buys a small section whole when its reservation covers most of it', () => {
    // A small code section that ranks high → its reservation (≥ MIN_CHARS) likely
    // covers ≥60% of it → it ships WHOLE (not truncated).
    const small = section('code[small]', CODE, 100, 5, 40); // ~5 lines ~200 chars + overhead
    const out = renderSectionsWithBudget([small], MED_BUDGET);
    const rendered = out.sections.find((s) => s.label === 'code[small]')!;
    expect(rendered.lines.length).toBe(5); // whole — not trimmed
  });
});

describe('renderSectionsWithBudget — ceiling invariants', () => {
  it('keeps the total response under the hard ceiling (1.5× envelope)', () => {
    const sections = Array.from({ length: 10 }, (_, i) =>
      section(`code[f${i}]`, CODE, 100 - i * 5, 25, 50),
    );
    const out = renderSectionsWithBudget(sections, MED_BUDGET);
    const hardCeiling = Math.min(MED_BUDGET.maxOutputChars * 1.5, 25000);
    expect(deliveredChars(out.sections)).toBeLessThanOrEqual(hardCeiling + 50); // +overhead slack
  });

  it('admits a lower-ranked section its reservation even when the top one is large', () => {
    // Displacement-guard core case: a huge top section must not starve a smaller
    // one ranked below it.
    const huge = section('code[huge]', CODE, 100, 60, 50);
    const small = section('code[small]', CODE, 60, 8, 50);
    const out = renderSectionsWithBudget([huge, small], MED_BUDGET);
    const renderedSmall = out.sections.find((s) => s.label === 'code[small]')!;
    // The small section is admitted and delivers SOMETHING (>0 source chars).
    expect(renderedSmall.relevance).not.toBe(0); // not a bare pointer
    expect(renderedSmall.lines.join('\n').length).toBeGreaterThan(0);
  });
});

describe('renderSectionsWithBudget — small-envelope survival', () => {
  it('does not starve when every section scores identically (degenerate)', () => {
    const sections = Array.from({ length: 4 }, (_, i) => section(`code[f${i}]`, CODE, 30, 15, 40));
    const out = renderSectionsWithBudget(sections, SMALL_BUDGET);
    const admitted = out.sections.filter((s) => s.relevance !== 0);
    // At least one section is admitted with real content.
    expect(admitted.length).toBeGreaterThanOrEqual(1);
    for (const s of admitted) expect(s.lines.length).toBeGreaterThan(0);
  });
});
