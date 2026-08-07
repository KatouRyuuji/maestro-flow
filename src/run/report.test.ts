import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readReportFrontmatter } from './report.js';

function writeReport(frontmatter: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'maestro-report-'));
  mkdirSync(join(dir, 'runs', 'run-1'), { recursive: true });
  writeFileSync(join(dir, 'runs', 'run-1', 'report.md'), `---\n${frontmatter}\n---\n`);
  return dir;
}

describe('readReportFrontmatter', () => {
  it('accepts shorthand { accepted: "<text>" } decision items', () => {
    const dir = writeReport('verdict: done\ndecisions:\n  - accepted: "Use X"\n  - text: "Use Y"\n    status: rejected\n  - plain string');
    try {
      const fm = readReportFrontmatter(join(dir, 'runs', 'run-1'));
      expect(fm.decisions).toEqual([
        { id: 'D-001', text: 'Use X', status: 'accepted' },
        { id: 'D-002', text: 'Use Y', status: 'rejected' },
        { id: 'D-003', text: 'plain string', status: 'proposed' },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('accepts shorthand { locked: "<text>" } constraint items', () => {
    const dir = writeReport('verdict: done\nconstraints:\n  - locked: "Always Y"\n  - deferred: "Maybe later"');
    try {
      const fm = readReportFrontmatter(join(dir, 'runs', 'run-1'));
      expect(fm.constraints).toEqual([
        { id: 'C-001', text: 'Always Y', status: 'locked' },
        { id: 'C-002', text: 'Maybe later', status: 'deferred' },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects unknown keys with an actionable message naming allowed shapes', () => {
    const dir = writeReport('verdict: done\ndecisions:\n  - foo: "not a shape"');
    try {
      expect(() => readReportFrontmatter(join(dir, 'runs', 'run-1'))).toThrow(/Allowed shapes/);
      expect(() => readReportFrontmatter(join(dir, 'runs', 'run-1'))).toThrow(/status: proposed\|accepted\|rejected/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps the strict { text, status } form working', () => {
    const dir = writeReport('verdict: done\ndecisions:\n  - text: "Use Z"\n    status: accepted');
    try {
      const fm = readReportFrontmatter(join(dir, 'runs', 'run-1'));
      expect(fm.decisions).toEqual([{ id: 'D-001', text: 'Use Z', status: 'accepted' }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
