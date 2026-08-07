/**
 * K12/K13/K16 — transcript evidence layer (knowledge-window-evidence-plan.md v3).
 *
 * Evidence anchors for window-session transcripts: stage-time content-addressed
 * snapshots of quoted fragments plus a `transcript:` URI that travels inside the
 * existing `evidence_refs: string[]` (zero schema change — run delta v1.0 stays
 * byte-for-byte untouched, E1/S1).
 *
 *   K12 — anchor URI string: `transcript:<hostKind>:<hostSessionId>:<entryId>:<sha256[:16]>`
 *         parsed only for display.
 *   K13 — stage-time fragment snapshot: sha256 over the raw quote bytes, then a
 *         content-addressed write to sessions/<sid>/transcript-evidence/<sha256>.json
 *         under the SessionStore transaction with the S8 sealed refusal
 *         (mirrors updateSessionKnowledgeSidecar's in-lock status check).
 *         Fragment limit 32 KiB / hard cap 64 KiB — over-limit throws, never
 *         silently truncates. Idempotent: an existing snapshot with the same
 *         sha256 is reused. The stored quote is the normalized UTF-8-LF-NFC form
 *         and its hash is recorded as normalized_sha256 (post-verification hash:
 *         re-hashing the stored normalized bytes must reproduce it).
 *   K16 — review rendering: renderTranscriptEvidence resolves a transcript URI to
 *         snapshot-present/absent + a desensitized preview (<= 120 chars) always
 *         marked [untrusted] (iron rule 10 — snapshots are display-only, never
 *         injected/indexed/corpus).
 *
 * The transcript-evidence/ directory is a snapshot store, not a corpus: nothing
 * under .workflow/specs|knowhow, and no search/index consumer reads it.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { z } from 'zod';

import { SessionStore } from './store.js';

/** Per-fragment quote limit (bytes, UTF-8). Quotes above this are rejected. */
export const TRANSCRIPT_EVIDENCE_MAX_BYTES = 32 * 1024;
/** Absolute hard cap (bytes, UTF-8). Quotes above this are rejected. */
export const TRANSCRIPT_EVIDENCE_HARD_CAP_BYTES = 64 * 1024;

/** URI host-field charset: no ':' and no Unicode control characters. */
const HOST_FIELD_RE = /^[^:\p{Cc}]{1,128}$/u;

const TRANSCRIPT_URI_PREFIX = 'transcript:';
const SHA256_PREFIX_RE = /^[a-f0-9]{16}$/;

/** K13 input descriptor contract (aligned with the Pi plugin side, immutable). */
export const transcriptQuoteInputSchema = z.object({
  host_kind: z.string().min(1),
  host_session_id: z.string().min(1),
  entry_id: z.string().min(1),
  quote: z.string().min(1),
}).strict();

/** Snapshot sidecar under sessions/<sid>/transcript-evidence/<sha256>.json. */
export const transcriptEvidenceSnapshotSchema = z.object({
  schema_version: z.literal('transcript-evidence/1.0'),
  /** Content address: sha256 over the raw quote bytes (K13). */
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  /** Post-verification hash over the stored normalized (UTF-8-LF-NFC) quote. */
  normalized_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  host_kind: z.string().min(1),
  /** Host window session id — a mapping key only, never a directory authority. */
  host_session_id: z.string().min(1),
  entry_id: z.string().min(1),
  captured_at: z.string().min(1),
  /** Normalized quote text (UTF-8-LF-NFC). */
  quote: z.string().min(1),
}).strict();

export type TranscriptEvidenceSnapshot = z.infer<typeof transcriptEvidenceSnapshotSchema>;

/**
 * Canonicalize a quote fragment: CRLF/CR line endings to LF, then Unicode NFC.
 * The stored snapshot carries this normalized form.
 */
export function normalizeQuote(quote: string): string {
  return quote.replace(/\r\n?/g, '\n').normalize('NFC');
}

/**
 * sha256 over the raw UTF-8 bytes of the quote — the content address that
 * determines the snapshot file name and the K12 URI tail ([:16]).
 */
export function quoteSha256(quote: string): string {
  return createHash('sha256').update(Buffer.from(quote, 'utf8')).digest('hex');
}

function assertQuoteWithinLimits(quote: string): void {
  const rawBytes = Buffer.byteLength(quote, 'utf8');
  if (rawBytes > TRANSCRIPT_EVIDENCE_HARD_CAP_BYTES) {
    throw new Error(
      `Transcript quote exceeds the ${TRANSCRIPT_EVIDENCE_HARD_CAP_BYTES}-byte hard cap (${rawBytes} bytes); no silent truncation`,
    );
  }
  if (rawBytes > TRANSCRIPT_EVIDENCE_MAX_BYTES) {
    throw new Error(
      `Transcript quote exceeds the ${TRANSCRIPT_EVIDENCE_MAX_BYTES}-byte fragment limit (${rawBytes} bytes); no silent truncation`,
    );
  }
  const normalizedBytes = Buffer.byteLength(normalizeQuote(quote), 'utf8');
  if (normalizedBytes > TRANSCRIPT_EVIDENCE_MAX_BYTES) {
    throw new Error(
      `Normalized transcript quote exceeds the ${TRANSCRIPT_EVIDENCE_MAX_BYTES}-byte fragment limit (${normalizedBytes} bytes); no silent truncation`,
    );
  }
}

export interface TranscriptEvidenceStoreResult {
  sha256: string;
  path: string;
  reused: boolean;
}

export interface TranscriptQuoteHost {
  host_kind: string;
  host_session_id: string;
  entry_id: string;
}

function transcriptLocatorHash(host: TranscriptQuoteHost): string {
  return createHash('sha256')
    .update(`${host.host_kind}\u0000${host.host_session_id}\u0000${host.entry_id}`, 'utf8')
    .digest('hex')
    .slice(0, 16);
}

function transcriptSnapshotStem(sha256: string, host: TranscriptQuoteHost): string {
  return `${sha256}-${transcriptLocatorHash(host)}`;
}

/**
 * K13 — content-addressed snapshot write under the SessionStore transaction.
 * Quote hash identifies the content; a locator hash suffix separates identical
 * quotes observed in different windows/entries so independent evidence roots
 * do not collide. The same quote+locator pair remains idempotent.
 */
export function storeTranscriptEvidence(
  projectRoot: string,
  sessionId: string,
  quote: string,
  host: TranscriptQuoteHost,
): TranscriptEvidenceStoreResult {
  if (!quote) throw new Error('Transcript quote is required');
  assertQuoteWithinLimits(quote);
  const sha256 = quoteSha256(quote);
  const normalized = normalizeQuote(quote);
  const normalizedSha256 = quoteSha256(normalized);
  const store = new SessionStore(projectRoot);
  if (!store.sessionExists(sessionId)) throw new Error(`Session not found: ${sessionId}`);
  const dir = join(store.sessionDir(sessionId), 'transcript-evidence');
  const path = join(dir, `${transcriptSnapshotStem(sha256, host)}.json`);
  return store.updateKnowledgeLifecycle(sessionId, (_lifecycle, tx) => {
    // Re-check under the lock (readBundle is re-entrancy safe via isHeld).
    const status = store.readBundle(sessionId).session.status;
    if (status !== 'running' && status !== 'paused') {
      throw new Error(
        `Session ${sessionId} is ${status} and cannot write transcript evidence snapshots`,
      );
    }
    if (existsSync(path)) {
      // Idempotent reuse; verify the full content binding, not just the file
      // name: re-hashing the stored normalized quote must reproduce the
      // recorded normalized_sha256, and the requested quote must be the same
      // fragment (same raw hash) with compatible host metadata.
      const existing = store.readJsonFileReadOnly(path, transcriptEvidenceSnapshotSchema);
      if (existing.sha256 !== sha256) {
        throw new Error(`Transcript evidence snapshot hash mismatch at ${path}`);
      }
      if (quoteSha256(existing.quote) !== existing.normalized_sha256) {
        throw new Error(`Transcript evidence snapshot integrity check failed at ${path}`);
      }
      if (quoteSha256(normalizeQuote(quote)) !== existing.normalized_sha256) {
        throw new Error('Transcript evidence snapshot content mismatch on reuse');
      }
      if (existing.host_kind !== host.host_kind
        || existing.host_session_id !== host.host_session_id
        || existing.entry_id !== host.entry_id) {
        throw new Error('Transcript evidence snapshot host metadata mismatch on reuse');
      }
      return { sha256, path, reused: true };
    }
    tx.writeJson(path, {
      schema_version: 'transcript-evidence/1.0',
      sha256,
      normalized_sha256: normalizedSha256,
      host_kind: host.host_kind,
      host_session_id: host.host_session_id,
      entry_id: host.entry_id,
      captured_at: new Date().toISOString(),
      quote: normalized,
    }, transcriptEvidenceSnapshotSchema);
    return { sha256, path, reused: false };
  });
}

/**
 * K12 — transcript anchor URI string, appendable into evidence_refs as-is.
 * Tail is the first 16 hex chars of the snapshot sha256. hostKind/
 * hostSessionId/entryId must be ':'-free and control-char-free so the URI
 * round-trips through parseTranscriptUri unchanged (K16 concern fix).
 */
export function buildTranscriptUri(
  hostKind: string,
  hostSessionId: string,
  entryId: string,
  sha256: string,
): string {
  for (const [name, value] of [
    ['hostKind', hostKind],
    ['hostSessionId', hostSessionId],
    ['entryId', entryId],
  ] as const) {
    if (!HOST_FIELD_RE.test(value)) {
      throw new Error(
        `Transcript URI ${name} contains ':' or control characters and cannot round-trip (value length ${value.length})`,
      );
    }
  }
  if (!/^[a-f0-9]{64}$/.test(sha256)) {
    throw new Error('Transcript URI sha256 must be a 64-hex digest');
  }
  return `${TRANSCRIPT_URI_PREFIX}${hostKind}:${hostSessionId}:${entryId}:${sha256.slice(0, 16)}`;
}

export interface ParsedTranscriptUri {
  hostKind: string;
  hostSessionId: string;
  entryId: string;
  sha256Prefix: string;
}

/** Parse a K12 anchor URI; null for non-transcript refs or malformed values. */
export function parseTranscriptUri(ref: string): ParsedTranscriptUri | null {
  if (!ref.startsWith(TRANSCRIPT_URI_PREFIX)) return null;
  const parts = ref.slice(TRANSCRIPT_URI_PREFIX.length).split(':');
  if (parts.length !== 4) return null;
  const [hostKind, hostSessionId, entryId, sha256Prefix] = parts;
  if (!HOST_FIELD_RE.test(hostKind)
    || !HOST_FIELD_RE.test(hostSessionId)
    || !HOST_FIELD_RE.test(entryId)
    || !SHA256_PREFIX_RE.test(sha256Prefix)) return null;
  return { hostKind, hostSessionId, entryId, sha256Prefix };
}

export interface TranscriptEvidenceRender {
  present: boolean;
  summary: string;
}

/**
 * K16 — desensitized review rendering for a transcript anchor URI.
 * sessionId scopes the lookup to one governance Session's snapshot directory;
 * when omitted every Session under .workflow/sessions is scanned (best effort —
 * the URI alone cannot pin the governance Session; host ids are mapping keys
 * only, iron rule 7). Rendering always carries the [untrusted] marker.
 *
 * Iron-rule-10 boundary (GPT final review fix): the summary NEVER contains the
 * quote text — review output is agent-visible, so quote content would leak
 * into an LLM tool context. Only the snapshot state (present/absent/integrity
 * failed) is rendered; full quote display is deferred to an explicit
 * human-only evidence-show surface (Phase 2B / evidence capsule).
 */
export function renderTranscriptEvidence(
  ref: string,
  projectRoot: string,
  sessionId?: string,
): TranscriptEvidenceRender {
  const parsed = parseTranscriptUri(ref);
  if (!parsed) {
    return { present: false, summary: `${ref} (invalid transcript ref) [untrusted]` };
  }
  let located: { path: string; snapshot: TranscriptEvidenceSnapshot } | null = null;
  try {
    located = locateTranscriptSnapshot(projectRoot, parsed, sessionId);
  } catch {
    located = null;
  }
  if (!located) {
    return { present: false, summary: `${ref} (snapshot missing) [untrusted]` };
  }
  // Post-verification hash: the file name and URI tail bind the content
  // address, and re-hashing the stored normalized quote must reproduce the
  // recorded normalized_sha256 (K13).
  const snapshotHost: TranscriptQuoteHost = {
    host_kind: located.snapshot.host_kind,
    host_session_id: located.snapshot.host_session_id,
    entry_id: located.snapshot.entry_id,
  };
  if (basename(located.path, '.json') !== transcriptSnapshotStem(located.snapshot.sha256, snapshotHost)
    || !located.snapshot.sha256.startsWith(parsed.sha256Prefix)
    || quoteSha256(located.snapshot.quote) !== located.snapshot.normalized_sha256
    || located.snapshot.host_kind !== parsed.hostKind
    || located.snapshot.host_session_id !== parsed.hostSessionId
    || located.snapshot.entry_id !== parsed.entryId) {
    return { present: false, summary: `${ref} (snapshot integrity check failed) [untrusted]` };
  }
  return {
    present: true,
    summary: `${ref} (snapshot present · ${located.snapshot.entry_id}) [untrusted]`,
  };
}

/**
 * Desensitized preview is intentionally NOT rendered in agent-visible review
 * output (iron rule 10, GPT final review fix): full quote display moves to an
 * explicit human-only evidence-show surface in Phase 2B.
 */

function locateTranscriptSnapshot(
  projectRoot: string,
  parsed: ParsedTranscriptUri,
  sessionId?: string,
): { path: string; snapshot: TranscriptEvidenceSnapshot } | null {
  const sessionsRoot = join(projectRoot, '.workflow', 'sessions');
  if (!existsSync(sessionsRoot)) return null;
  const candidateDirs = sessionId
    ? [join(sessionsRoot, sessionId)]
    : readdirSync(sessionsRoot)
        .filter(name => !name.startsWith('.'))
        .map(name => join(sessionsRoot, name));
  for (const dir of candidateDirs) {
    if (!existsSync(dir) || !existsSync(join(dir, 'session.json'))) continue;
    const evidenceDir = join(dir, 'transcript-evidence');
    if (!existsSync(evidenceDir)) continue;
    const files = readdirSync(evidenceDir)
      .filter(name => name.endsWith('.json') && name.startsWith(parsed.sha256Prefix))
      .sort();
    for (const file of files) {
      const path = join(evidenceDir, file);
      const snapshot = transcriptEvidenceSnapshotSchema.parse(
        JSON.parse(readFileSync(path, 'utf8')),
      );
      if (snapshot.sha256.startsWith(parsed.sha256Prefix)
        && snapshot.host_kind === parsed.hostKind
        && snapshot.host_session_id === parsed.hostSessionId
        && snapshot.entry_id === parsed.entryId) {
        return { path, snapshot };
      }
    }
  }
  return null;
}
