import { afterEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import {
  buildTranscriptUri,
  normalizeQuote,
  parseTranscriptUri,
  quoteSha256,
  renderTranscriptEvidence,
  storeTranscriptEvidence,
  TRANSCRIPT_EVIDENCE_HARD_CAP_BYTES,
  TRANSCRIPT_EVIDENCE_MAX_BYTES,
} from './transcript-evidence.js';
import {
  isTranscriptOnlyEvidenceRefs,
  sessionReconciliationPath,
} from './knowledge.js';
import {
  ensureSyntheticKnowledgeSession,
  stageSessionKnowledgeCandidate,
} from './session-knowledge.js';
import {
  promoteReconciledSessionKnowledge,
  persistSessionKnowledgeReconciliation,
  reconcileSessionKnowledgeSync,
} from '../knowledge/reconcile.js';
import { sealSession } from './runtime.js';
import { SessionStore } from './store.js';

function v2Workspace(root: string): void {
  mkdirSync(join(root, ".workflow"), { recursive: true });
  writeFileSync(join(root, ".workflow", "config.json"), JSON.stringify({
    session_schema: { schema_version: "session-schema-selection/1.0", writer: "session/1.3", features: { session_statusless: false } },
  }));
}

const roots: string[] = [];

function root(): string {
  const path = mkdtempSync(join(tmpdir(), 'maestro-transcript-evidence-'));

  v2Workspace(path);
  roots.push(path);
  mkdirSync(join(path, 'src'), { recursive: true });
  writeFileSync(join(path, 'src', 'foo.ts'), '// file evidence\n', 'utf8');
  writeFileSync(join(path, 'src', 'bar.ts'), '// file evidence\n', 'utf8');
  return path;
}

const HOST = { host_kind: 'hook', host_session_id: 'window-session-1', entry_id: 'entry-42' };

function evidenceDir(projectRoot: string, sessionId: string): string {
  return join(projectRoot, '.workflow', 'sessions', sessionId, 'transcript-evidence');
}

function immutableTranscriptRef(projectRoot: string, sessionId: string): string {
  const stored = storeTranscriptEvidence(projectRoot, sessionId, 'reviewed transcript quote', HOST);
  return buildTranscriptUri(
    HOST.host_kind,
    HOST.host_session_id,
    HOST.entry_id,
    stored.sha256,
  );
}

afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('quote canonicalization and hashing (K13)', () => {
  it('normalizes UTF-8-LF-NFC and hashes the raw bytes', () => {
    expect(normalizeQuote('line one\r\nline two\rline three')).toBe('line one\nline two\nline three');
    expect(normalizeQuote('café')).toBe('café');
    expect(normalizeQuote('e\u0301'.normalize('NFD'))).toBe('é');
    const digest = quoteSha256('hello');
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
    expect(quoteSha256('hello')).toBe(digest);
    expect(quoteSha256('hello\n')).not.toBe(digest);
  });

  it('accepts a 31 KiB quote and rejects a 33 KiB quote without truncation', () => {
    const projectRoot = root();
    const { sessionId } = ensureSyntheticKnowledgeSession(projectRoot, 'size-host');
    const ok = storeTranscriptEvidence(
      projectRoot,
      sessionId,
      'a'.repeat(31 * 1024),
      HOST,
    );
    expect(ok.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(() => storeTranscriptEvidence(
      projectRoot,
      sessionId,
      'b'.repeat(33 * 1024),
      HOST,
    )).toThrow(new RegExp(`exceeds the ${TRANSCRIPT_EVIDENCE_MAX_BYTES}-byte fragment limit`));
    // Hard cap: even between-limit quotes never reach the 64 KiB ceiling
    // silently — anything above it throws too.
    expect(() => storeTranscriptEvidence(
      projectRoot,
      sessionId,
      'c'.repeat(TRANSCRIPT_EVIDENCE_HARD_CAP_BYTES + 1),
      HOST,
    )).toThrow(/hard cap/);
  });
});

describe('content-addressed snapshot store (K13)', () => {
  it('writes quote-hash + locator-hash snapshots and is idempotent per locator', () => {
    const projectRoot = root();
    const { sessionId } = ensureSyntheticKnowledgeSession(projectRoot, 'snap-host');
    const first = storeTranscriptEvidence(projectRoot, sessionId, 'snapshot quote', HOST);
    expect(first.reused).toBe(false);
    expect(existsSync(first.path)).toBe(true);
    expect(basename(first.path)).toMatch(new RegExp(`^${first.sha256}-[a-f0-9]{16}\\.json$`));

    const second = storeTranscriptEvidence(projectRoot, sessionId, 'snapshot quote', HOST);
    expect(second.sha256).toBe(first.sha256);
    expect(second.path).toBe(first.path);
    expect(second.reused).toBe(true);
    expect(readdirSync(evidenceDir(projectRoot, sessionId))).toEqual([basename(first.path)]);
  });

  it('stores identical quotes from different entries as independent locator snapshots', () => {
    const projectRoot = root();
    const { sessionId } = ensureSyntheticKnowledgeSession(projectRoot, 'multi-locator-host');
    const first = storeTranscriptEvidence(projectRoot, sessionId, 'same quote', HOST);
    const secondHost = { ...HOST, host_session_id: 'window-session-2', entry_id: 'entry-99' };
    const second = storeTranscriptEvidence(projectRoot, sessionId, 'same quote', secondHost);
    expect(second.sha256).toBe(first.sha256);
    expect(second.path).not.toBe(first.path);
    expect(second.reused).toBe(false);
    expect(readdirSync(evidenceDir(projectRoot, sessionId))).toHaveLength(2);
    const firstUri = buildTranscriptUri(HOST.host_kind, HOST.host_session_id, HOST.entry_id, first.sha256);
    const secondUri = buildTranscriptUri(secondHost.host_kind, secondHost.host_session_id, secondHost.entry_id, second.sha256);
    expect(renderTranscriptEvidence(firstUri, projectRoot, sessionId).present).toBe(true);
    expect(renderTranscriptEvidence(secondUri, projectRoot, sessionId).present).toBe(true);
  });

  it('stores the normalized quote with a post-verification hash', () => {
    const projectRoot = root();
    const { sessionId } = ensureSyntheticKnowledgeSession(projectRoot, 'norm-host');
    const stored = storeTranscriptEvidence(
      projectRoot,
      sessionId,
      'first line\r\nsecond line',
      HOST,
    );
    const snapshot = JSON.parse(readFileSync(stored.path, 'utf8')) as { schema_version: string; sha256: string; normalized_sha256: string; quote: string };
    expect(snapshot.schema_version).toBe('transcript-evidence/1.0');
    expect(snapshot.sha256).toBe(stored.sha256);
    expect(snapshot.quote).toBe('first line\nsecond line');
    expect(quoteSha256(snapshot.quote)).toBe(snapshot.normalized_sha256);
  });

  it('refuses snapshot writes on a sealed Session (S8)', () => {
    const projectRoot = root();
    const { sessionId } = ensureSyntheticKnowledgeSession(projectRoot, 'seal-host');
    storeTranscriptEvidence(projectRoot, sessionId, 'pre-seal quote', HOST);
    sealSession(projectRoot, sessionId, 'sealed for snapshot guard');
    expect(() => storeTranscriptEvidence(projectRoot, sessionId, 'post-seal quote', HOST))
      .toThrow(/cannot write transcript evidence snapshots/);
  });

  it('fails closed on an unknown Session', () => {
    const projectRoot = root();
    expect(() => storeTranscriptEvidence(projectRoot, 'no-such-session', 'quote', HOST))
      .toThrow(/Session not found/);
  });
});

describe('K12 anchor URI', () => {
  it('builds and parses the transcript URI with the sha256[:16] tail', () => {
    const sha256 = quoteSha256('anchor quote');
    const uri = buildTranscriptUri('hook', 'window-session-1', 'entry-42', sha256);
    expect(uri).toMatch(/^transcript:hook:window-session-1:entry-42:[a-f0-9]{16}$/);
    const parsed = parseTranscriptUri(uri);
    expect(parsed).toEqual({
      hostKind: 'hook',
      hostSessionId: 'window-session-1',
      entryId: 'entry-42',
      sha256Prefix: sha256.slice(0, 16),
    });
    // Round trip: parse → rebuild.
    expect(buildTranscriptUri(
      parsed!.hostKind,
      parsed!.hostSessionId,
      parsed!.entryId,
      `${parsed!.sha256Prefix}${'0'.repeat(48)}`,
    )).toBe(uri);
  });

  it('keeps the URI tail consistent with the snapshot file name', () => {
    const projectRoot = root();
    const { sessionId } = ensureSyntheticKnowledgeSession(projectRoot, 'uri-host');
    const { sha256 } = storeTranscriptEvidence(projectRoot, sessionId, 'tail check quote', HOST);
    const uri = buildTranscriptUri(HOST.host_kind, HOST.host_session_id, HOST.entry_id, sha256);
    const tail = uri.split(':').pop()!;
    expect(tail).toBe(sha256.slice(0, 16));
    const file = readdirSync(evidenceDir(projectRoot, sessionId))[0];
    expect(file).toMatch(new RegExp(`^${sha256}-[a-f0-9]{16}\\.json$`));
    expect(file.startsWith(tail)).toBe(true);
  });

  it('rejects entry ids that contain colons (no round-trip) and reassembles valid ones', () => {
    // Colons are the URI segment delimiter; containing them breaks round-trip
    // (GPT final review fix) — the builder now refuses them.
    expect(() => buildTranscriptUri('hook', 'host-session', 'entry:a:b:c', 'a'.repeat(64)))
      .toThrow(/cannot round-trip/);
    const uri = buildTranscriptUri('hook', 'host-session', 'entry-1', 'a'.repeat(64));
    const parsed = parseTranscriptUri(uri);
    expect(parsed?.hostSessionId).toBe('host-session');
    expect(parsed?.entryId).toBe('entry-1');
    expect(parsed?.sha256Prefix).toBe('a'.repeat(16));
  });

  it('rejects malformed and non-transcript refs', () => {
    expect(parseTranscriptUri('file:src/a.ts:12')).toBeNull();
    expect(parseTranscriptUri('transcript:hook:only')).toBeNull();
    expect(parseTranscriptUri('transcript:hook:sid:entry:XYZ')).toBeNull();
  });
});

describe('K16 review rendering', () => {
  it('renders a present snapshot with state + entry_id and [untrusted] (no quote leak)', () => {
    const projectRoot = root();
    const { sessionId } = ensureSyntheticKnowledgeSession(projectRoot, 'render-host');
    const { sha256 } = storeTranscriptEvidence(
      projectRoot,
      sessionId,
      'Short quote for preview.',
      HOST,
    );
    const uri = buildTranscriptUri(HOST.host_kind, HOST.host_session_id, HOST.entry_id, sha256);
    const render = renderTranscriptEvidence(uri, projectRoot, sessionId);
    expect(render.present).toBe(true);
    expect(render.summary).toContain('snapshot present');
    expect(render.summary).toContain('[untrusted]');
    // Iron rule 10 boundary (GPT final review): review output is agent-visible,
    // so the quote text must never appear in the rendered summary.
    expect(render.summary).not.toContain('Short quote for preview.');
  });

  it('renders state-only output for long quotes and flags missing snapshots', () => {
    const projectRoot = root();
    const { sessionId } = ensureSyntheticKnowledgeSession(projectRoot, 'render-long-host');
    const { sha256 } = storeTranscriptEvidence(
      projectRoot,
      sessionId,
      'word '.repeat(200),
      HOST,
    );
    const uri = buildTranscriptUri(HOST.host_kind, HOST.host_session_id, HOST.entry_id, sha256);
    const present = renderTranscriptEvidence(uri, projectRoot, sessionId);
    expect(present.summary).toContain('snapshot present');
    expect(present.summary).not.toMatch(/“/); // no quote preview anywhere

    const ghost = buildTranscriptUri('hook', 'window-session-1', 'entry-999', 'a'.repeat(64));
    const missing = renderTranscriptEvidence(ghost, projectRoot, sessionId);
    expect(missing.present).toBe(false);
    expect(missing.summary).toContain('snapshot missing');
    expect(missing.summary).toContain('[untrusted]');

    const invalid = renderTranscriptEvidence('transcript:broken', projectRoot, sessionId);
    expect(invalid.present).toBe(false);
    expect(invalid.summary).toContain('invalid transcript ref');
  });

  it('rejects URI host fields that cannot round-trip (colons / control chars)', () => {
    const sha = 'a'.repeat(64);
    expect(() => buildTranscriptUri('pi', 'win:evil', 'entry', sha)).toThrow(/cannot round-trip/);
    expect(() => buildTranscriptUri('pi', 'ok', 'entry\x01bad', sha)).toThrow(/cannot round-trip/);
    expect(() => buildTranscriptUri('pi', 'ok', 'entry', 'nothex')).toThrow(/64-hex/);
    // Valid fields round-trip unchanged.
    const uri = buildTranscriptUri('pi', 'win-1', 'entry-1', sha);
    const parsed = parseTranscriptUri(uri);
    expect(parsed).toEqual({
      hostKind: 'pi',
      hostSessionId: 'win-1',
      entryId: 'entry-1',
      sha256Prefix: 'a'.repeat(16),
    });
  });
});

describe('K17 trust gate', () => {
  it('classifies transcript-only evidence sets (origin markers are not evidence)', () => {
    expect(isTranscriptOnlyEvidenceRefs(['transcript:hook:sid:entry:abc'])).toBe(true);
    expect(isTranscriptOnlyEvidenceRefs(['session:ksyn-abc', 'transcript:hook:sid:entry:abc'])).toBe(true);
    expect(isTranscriptOnlyEvidenceRefs(['run:r-1', 'transcript:hook:sid:entry:abc'])).toBe(true);
    expect(isTranscriptOnlyEvidenceRefs(['transcript:hook:sid:entry:abc', 'src/foo.ts:12'])).toBe(false);
    expect(isTranscriptOnlyEvidenceRefs(['src/foo.ts:12'])).toBe(false);
    expect(isTranscriptOnlyEvidenceRefs(['session:ksyn-abc'])).toBe(false);
    expect(isTranscriptOnlyEvidenceRefs([])).toBe(false);
  });

  it('defaults transcript-only candidates to review_required in the session receipt', () => {
    const projectRoot = root();
    const { sessionId } = ensureSyntheticKnowledgeSession(projectRoot, 'k17-host');
    const transcriptRef = immutableTranscriptRef(projectRoot, sessionId);
    const staged = stageSessionKnowledgeCandidate(projectRoot, sessionId, {
      target: 'knowhow',
      title: 'Quote-backed insight',
      content: 'Transcript-only rule: never auto-promote raw quotes.',
      evidenceRefs: [transcriptRef],
    });
    const mixed = stageSessionKnowledgeCandidate(projectRoot, sessionId, {
      target: 'knowhow',
      title: 'Mixed evidence insight',
      content: 'Mixed evidence rule: file anchors keep the normal gate.',
      evidenceRefs: [transcriptRef, 'src/foo.ts:12'],
    });
    const receipt = reconcileSessionKnowledgeSync(projectRoot, sessionId);
    expect(receipt.candidates.find(item => item.candidate_id === staged.candidate_id)
      ?.promotion_eligibility).toBe('review_required');
    expect(receipt.candidates.find(item => item.candidate_id === mixed.candidate_id)
      ?.promotion_eligibility).toBe('eligible');
  });

  it('excludes transcript-only candidates from --all auto-promotion', () => {
    const projectRoot = root();
    const { sessionId } = ensureSyntheticKnowledgeSession(projectRoot, 'k17-all-host');
    const transcriptRef = immutableTranscriptRef(projectRoot, sessionId);
    const staged = stageSessionKnowledgeCandidate(projectRoot, sessionId, {
      target: 'knowhow',
      title: 'Quote-only insight',
      content: 'Quote-only rule content for the --all gate.',
      evidenceRefs: [transcriptRef],
    });
    const mixed = stageSessionKnowledgeCandidate(projectRoot, sessionId, {
      target: 'knowhow',
      title: 'File-anchored insight',
      content: 'File-anchored rule content for the --all gate.',
      evidenceRefs: [transcriptRef, 'src/bar.ts:3'],
    });
    sealSession(projectRoot, sessionId, 'sealed for k17 --all gate');
    const result = promoteReconciledSessionKnowledge(projectRoot, sessionId, { all: true });
    expect(result.skipped_review_required).toContain(staged.candidate_id);
    expect(result.promoted.map(item => item.candidate_id)).toContain(mixed.candidate_id);
    // Explicit promotion of the review_required transcript-only candidate keeps
    // the existing V11 gate semantics: it must be resolved first.
    // Refresh the remaining candidate's receipt after the mixed candidate was
    // promoted and removed from the pending snapshot.
    persistSessionKnowledgeReconciliation(
      projectRoot,
      reconcileSessionKnowledgeSync(projectRoot, sessionId),
    );
    expect(() => promoteReconciledSessionKnowledge(projectRoot, sessionId, {
      candidateIds: [staged.candidate_id],
    })).toThrow(/resolve it .* first/);
  });

  it('defends explicit promotion against an eligible-but-unresolved transcript-only receipt', () => {
    const projectRoot = root();
    const { sessionId } = ensureSyntheticKnowledgeSession(projectRoot, 'k17-defensive-host');
    const transcriptRef = immutableTranscriptRef(projectRoot, sessionId);
    const staged = stageSessionKnowledgeCandidate(projectRoot, sessionId, {
      target: 'knowhow',
      title: 'Quote-only insight (defensive)',
      content: 'Defensive gate: an eligible receipt must not auto-promote quotes.',
      evidenceRefs: [transcriptRef],
    });
    sealSession(projectRoot, sessionId, 'sealed for defensive gate');
    // Forge the receipt entry to eligible without any human resolution — the
    // candidate snapshot hash does not cover evidence_refs (E5), so the forged
    // receipt still looks fresh; the K17 gate must block anyway.
    const store = new SessionStore(projectRoot);
    const receiptPath = sessionReconciliationPath(store, sessionId);
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8')) as {
      candidates: Array<{ candidate_id: string; promotion_eligibility: string; resolution: unknown }>;
    };
    const entry = receipt.candidates.find(item => item.candidate_id === staged.candidate_id)!;
    entry.promotion_eligibility = 'eligible';
    entry.resolution = null;
    writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
    expect(() => promoteReconciledSessionKnowledge(projectRoot, sessionId, {
      candidateIds: [staged.candidate_id],
    })).toThrow(/backed only by transcript evidence/);
  });

  // K15 — iron rule 10 boundary (negative assertions): snapshots live in
  // sessions/<sid>/transcript-evidence/ and must never be picked up as
  // knowledge corpus by the injection regex or the search scope.
  describe('iron rule 10 boundary (K15)', () => {
    // Mirrors the injection-path knowledge-file matcher (src/commands/hooks.ts).
    const knowledgeFileMatcher = /\.workflow\/(specs|knowhow|issues|domain|scratch)\//;

    it('snapshot paths never match the knowledge-file injection matcher', () => {
      const snapshotPath = `.workflow/sessions/20260807-demo/transcript-evidence/${'a'.repeat(64)}.json`;
      expect(knowledgeFileMatcher.test(snapshotPath)).toBe(false);
      const deltaPath = '.workflow/sessions/20260807-demo/knowledge-delta.json';
      expect(knowledgeFileMatcher.test(deltaPath)).toBe(false);
    });

    it('snapshot directory is outside every search/corpus scope root', () => {
      // Mirrors the search scope list (src/graph/kg/engine.ts) — snapshots must
      // not be reachable under any corpus root.
      const scopes = ['specs', 'knowhow', 'issues', 'domain', 'codebase'];
      for (const scope of scopes) {
        expect(`sessions/20260807-demo/transcript-evidence/${scope}`.includes(`${scope}/`)).toBe(false);
      }
      // The evidence dir itself is nested under sessions/, not under a corpus root.
      expect('sessions/20260807-demo/transcript-evidence/'.match(/\/(specs|knowhow|issues|domain|codebase)\//)).toBeNull();
    });
  });

  // GPT final review — trust-boundary documentation test: the K17 gate defends
  // against accidental automation, not against a local actor who can rewrite
  // the receipt file (that actor can rewrite the corpus directly). The forged
  // confirmed-resolution bypass is therefore a documented accepted risk, and
  // this test pins the current behavior so a future hardening (e.g. binding
  // resolution to a receipt version / actor record) is a deliberate change.
  describe('K17 trust boundary (documented behavior)', () => {
    it('a locally forged confirmed resolution can bypass the gate (accepted, §10.4)', () => {
      const projectRoot = root();
      const { sessionId } = ensureSyntheticKnowledgeSession(projectRoot, 'k17-boundary-host');
      const transcriptRef = immutableTranscriptRef(projectRoot, sessionId);
      const staged = stageSessionKnowledgeCandidate(projectRoot, sessionId, {
        target: 'knowhow',
        title: 'Quote-only insight (boundary)',
        content: 'Boundary: local receipt forgery bypasses the gate by design.',
        evidenceRefs: [transcriptRef],
      });
      sealSession(projectRoot, sessionId, 'sealed for boundary test');
      const store = new SessionStore(projectRoot);
      const receiptPath = sessionReconciliationPath(store, sessionId);
      const receipt = JSON.parse(readFileSync(receiptPath, 'utf8')) as {
        candidates: Array<{ candidate_id: string; promotion_eligibility: string; resolution: unknown }>;
      };
      const entry = receipt.candidates.find(item => item.candidate_id === staged.candidate_id)!;
      entry.promotion_eligibility = 'eligible';
      entry.resolution = {
        status: 'confirmed',
        reason: 'forged human review',
        resolved_at: new Date().toISOString(),
      };
      writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
      // Documented accepted behavior: local write access = trust boundary.
      expect(() => promoteReconciledSessionKnowledge(projectRoot, sessionId, {
        candidateIds: [staged.candidate_id],
      })).not.toThrow();
    });

    it('a structurally incomplete confirmed resolution does NOT bypass the gate', () => {
      const projectRoot = root();
      const { sessionId } = ensureSyntheticKnowledgeSession(projectRoot, 'k17-boundary-host-2');
      const transcriptRef = immutableTranscriptRef(projectRoot, sessionId);
      const staged = stageSessionKnowledgeCandidate(projectRoot, sessionId, {
        target: 'knowhow',
        title: 'Quote-only insight (boundary 2)',
        content: 'Boundary 2: partial resolution must not count as human review.',
        evidenceRefs: [transcriptRef],
      });
      sealSession(projectRoot, sessionId, 'sealed for boundary test 2');
      const store = new SessionStore(projectRoot);
      const receiptPath = sessionReconciliationPath(store, sessionId);
      const receipt = JSON.parse(readFileSync(receiptPath, 'utf8')) as {
        candidates: Array<{ candidate_id: string; promotion_eligibility: string; resolution: unknown }>;
      };
      const entry = receipt.candidates.find(item => item.candidate_id === staged.candidate_id)!;
      entry.promotion_eligibility = 'eligible';
      entry.resolution = { status: 'confirmed' } as unknown; // missing reason/resolved_at
      writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
      // A structurally incomplete resolution cannot bypass: the receipt schema
      // rejects it at load (zod), so promotion throws before the K17 gate even
      // runs. Either way the promotion is refused.
      expect(() => promoteReconciledSessionKnowledge(projectRoot, sessionId, {
        candidateIds: [staged.candidate_id],
      })).toThrow();
    });
  });
});
