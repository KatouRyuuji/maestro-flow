import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createRun } from '../run/runtime.js';
import {
  readRunKnowledgeDelta,
  stageRunKnowledgeCandidate,
} from '../run/knowledge.js';
import { readReportFrontmatter } from '../run/report.js';
import { SessionStore } from '../run/store.js';
import {
  isKnowledgeReconciliationFresh,
  persistActiveKnowledgeReconciliation,
  reconcileRunKnowledgeSync,
  resolveKnowledgeCandidate,
} from './reconcile.js';

const roots: string[] = [];

function root(): string {
  const path = mkdtempSync(join(tmpdir(), 'maestro-reconcile-'));
  roots.push(path);
  const commandDir = join(path, '.claude', 'commands');
  mkdirSync(commandDir, { recursive: true });
  writeFileSync(
    join(commandDir, 'reconcile-demo.md'),
    '<contract>\nconsumes: []\nproduces: []\ngates:\n  entry: []\n  exit: []\n</contract>\n',
    'utf8',
  );
  return path;
}

function writeSpec(
  projectRoot: string,
  entries: Array<{ sid: string; title: string; content: string }>,
): void {
  const dir = join(projectRoot, '.workflow', 'specs');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'coding-conventions.md'), `---
category: coding
---

${entries.map(entry => `<spec-entry category="coding" keywords="knowledge" date="2026-07-28" sid="${entry.sid}" title="${entry.title}">

### ${entry.title}

${entry.content}

</spec-entry>`).join('\n\n')}
`, 'utf8');
}

function setupCandidate(
  projectRoot: string,
  input: {
    title: string;
    content: string;
    action?: 'propose' | 'reaffirm' | 'supersede' | 'contest';
  },
): { sessionId: string; runId: string; candidateId: string } {
  const created = createRun({
    projectRoot,
    command: 'reconcile-demo',
    sessionId: 'reconcile-session',
    intent: 'reconcile candidate knowledge',
  });
  const staged = stageRunKnowledgeCandidate(
    projectRoot,
    created.run_id,
    {
      target: 'spec',
      title: input.title,
      content: input.content,
      action: input.action,
      category: 'coding',
    },
    created.session_id,
  );
  return {
    sessionId: created.session_id,
    runId: created.run_id,
    candidateId: staged.candidate_id,
  };
}

afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('knowledge reconciliation', () => {
  it('suppresses normalized exact duplicates without using exposure statistics', () => {
    const projectRoot = root();
    writeSpec(projectRoot, [{
      sid: 'S-cache',
      title: 'Cache rule',
      content: 'Cache search results for ten minutes.',
    }]);
    const candidate = setupCandidate(projectRoot, {
      title: 'Cache rule copy',
      content: '  Cache search results for ten minutes.  ',
    });
    const store = new SessionStore(projectRoot);
    const receipt = reconcileRunKnowledgeSync(
      projectRoot,
      candidate.sessionId,
      candidate.runId,
      readReportFrontmatter(store.runDir(candidate.sessionId, candidate.runId)),
    );

    expect(receipt.candidates).toEqual([
      expect.objectContaining({
        candidate_id: candidate.candidateId,
        disposition: 'exact_duplicate',
        promotion_eligibility: 'suppressed',
        canonical_id: 'S-cache',
      }),
    ]);
    expect(receipt.candidates[0].resolution?.status).toBe('automatic');
  });

  it('marks an evidence-backed opposing rule for conflict review', () => {
    const projectRoot = root();
    writeSpec(projectRoot, [{
      sid: 'S-cache',
      title: 'Search cache policy',
      content: 'The service must cache search results for ten minutes.',
    }]);
    const candidate = setupCandidate(projectRoot, {
      title: 'Search cache policy',
      content: 'The service must not cache search results for ten minutes.',
      action: 'contest',
    });
    const store = new SessionStore(projectRoot);
    const receipt = reconcileRunKnowledgeSync(
      projectRoot,
      candidate.sessionId,
      candidate.runId,
      readReportFrontmatter(store.runDir(candidate.sessionId, candidate.runId)),
    );

    expect(receipt.candidates[0]).toMatchObject({
      disposition: 'potential_conflict',
      promotion_eligibility: 'review_required',
      canonical_id: 'S-cache',
    });
    expect(receipt.candidates[0].matches[0].evidence).toContain('opposite normative stance');
  });

  it('persists human resolution and rejects a confirmed duplicate candidate', () => {
    const projectRoot = root();
    writeSpec(projectRoot, [{
      sid: 'S-store',
      title: 'Canonical transaction rule',
      content: 'Use one SessionStore transaction for coordinated writes.',
    }]);
    const candidate = setupCandidate(projectRoot, {
      title: 'Transaction rule',
      content: 'Use one SessionStore transaction for all coordinated writes.',
    });
    const store = new SessionStore(projectRoot);
    const receipt = reconcileRunKnowledgeSync(
      projectRoot,
      candidate.sessionId,
      candidate.runId,
      readReportFrontmatter(store.runDir(candidate.sessionId, candidate.runId)),
    );
    persistActiveKnowledgeReconciliation(projectRoot, receipt);
    const target = receipt.candidates[0].matches[0]?.knowledge_id;
    expect(target).toBe('S-store');

    const resolved = resolveKnowledgeCandidate(
      projectRoot,
      candidate.sessionId,
      candidate.candidateId,
      'duplicate',
      { targetId: target, reason: 'Same operational rule after review' },
    );
    expect(resolved).toMatchObject({
      promotion_eligibility: 'suppressed',
      canonical_id: 'S-store',
    });
    expect(readRunKnowledgeDelta(
      store,
      candidate.sessionId,
      candidate.runId,
    ).candidates[0].status).toBe('rejected');
  });

  it('invalidates a receipt when the candidate or corpus changes', () => {
    const projectRoot = root();
    writeSpec(projectRoot, [{
      sid: 'S-one',
      title: 'Existing rule',
      content: 'Keep existing behavior.',
    }]);
    const candidate = setupCandidate(projectRoot, {
      title: 'New rule',
      content: 'Use a deterministic receipt.',
    });
    const store = new SessionStore(projectRoot);
    const frontmatter = readReportFrontmatter(store.runDir(candidate.sessionId, candidate.runId));
    const receipt = reconcileRunKnowledgeSync(
      projectRoot,
      candidate.sessionId,
      candidate.runId,
      frontmatter,
    );
    persistActiveKnowledgeReconciliation(projectRoot, receipt);
    expect(isKnowledgeReconciliationFresh(
      projectRoot,
      candidate.sessionId,
      candidate.runId,
      receipt,
      frontmatter,
    )).toBe(true);

    writeSpec(projectRoot, [
      { sid: 'S-one', title: 'Existing rule', content: 'Keep existing behavior.' },
      { sid: 'S-two', title: 'New corpus rule', content: 'The corpus changed.' },
    ]);
    expect(isKnowledgeReconciliationFresh(
      projectRoot,
      candidate.sessionId,
      candidate.runId,
      receipt,
      frontmatter,
    )).toBe(false);
    expect(() => resolveKnowledgeCandidate(
      projectRoot,
      candidate.sessionId,
      candidate.candidateId,
      'unique',
      { reason: 'This stale receipt must not authorize resolution' },
    )).toThrow(/stale reconciliation/);
  });

  it('diversifies semantic matches across files and knowledge stores', () => {
    const projectRoot = root();
    const specsDir = join(projectRoot, '.workflow', 'specs');
    const knowhowDir = join(projectRoot, '.workflow', 'knowhow');
    mkdirSync(specsDir, { recursive: true });
    mkdirSync(knowhowDir, { recursive: true });
    for (let fileIndex = 0; fileIndex < 5; fileIndex++) {
      writeFileSync(join(specsDir, `family-${fileIndex}.md`), `---
category: coding
---

${[0, 1, 2].map(entryIndex => `<spec-entry category="coding" keywords="reconcile" date="2026-07-28" sid="S-${fileIndex}-${entryIndex}" title="Reconciliation variant ${fileIndex}-${entryIndex}">

### Reconciliation variant ${fileIndex}-${entryIndex}

Use deterministic knowledge reconciliation with semantic retrieval and bounded diversity variant ${fileIndex}-${entryIndex}.

</spec-entry>`).join('\n\n')}
`, 'utf8');
    }
    for (let index = 0; index < 5; index++) {
      writeFileSync(join(knowhowDir, `TIP-20260728-diversity-${index}.md`), `---
title: Semantic diversity recipe ${index}
type: tip
status: active
---

Use deterministic knowledge reconciliation with semantic retrieval and bounded diversity recipe ${index}.
`, 'utf8');
    }
    const candidate = setupCandidate(projectRoot, {
      title: 'Deterministic reconciliation',
      content: 'Use deterministic knowledge reconciliation with semantic retrieval and bounded diversity.',
    });
    const store = new SessionStore(projectRoot);
    const receipt = reconcileRunKnowledgeSync(
      projectRoot,
      candidate.sessionId,
      candidate.runId,
      readReportFrontmatter(store.runDir(candidate.sessionId, candidate.runId)),
    );
    const matches = receipt.candidates[0].matches;
    const perFamily = new Map<string, number>();
    const perTarget = new Map<string, number>();
    for (const match of matches) {
      const family = `${match.target}:${match.source_path}`;
      perFamily.set(family, (perFamily.get(family) ?? 0) + 1);
      perTarget.set(match.target, (perTarget.get(match.target) ?? 0) + 1);
    }

    expect(matches.length).toBeGreaterThan(4);
    expect(perFamily.size).toBeGreaterThan(3);
    expect(Math.max(...perFamily.values())).toBeLessThanOrEqual(2);
    expect(Math.max(...perTarget.values())).toBeLessThanOrEqual(8);
    expect(new Set(matches.map(match => match.target))).toEqual(new Set(['spec', 'knowhow']));
  });
});
