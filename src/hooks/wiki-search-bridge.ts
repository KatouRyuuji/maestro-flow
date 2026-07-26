/**
 * Wiki Search Bridge — hot-path helper for keyword spec injection.
 *
 * Provides a best-effort wiki search that never throws: tries the resident
 * search daemon first (no heavy imports), falls back to a lazily-loaded
 * WikiIndexer BM25 search. Results are filtered to spec + knowhow entries,
 * score-thresholded, and capped.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { WikiIndexer } from '#maestro-dashboard/wiki/wiki-indexer.js';
import { isDeprecatedKnowledgeEntry } from '../utils/knowledge-lifecycle.js';

export interface WikiSearchHit {
  id: string;
  type: string;
  title: string;
  summary: string;
  score: number;
}

export type WikiSearchSource = 'daemon' | 'indexer' | 'none';

const ALLOWED_TYPES = new Set(['spec', 'knowhow']);
const INTERNAL_LIMIT = 10;
const DEFAULT_LIMIT = 3;
const DEFAULT_MIN_SCORE = 1.0;
/**
 * Daemon budget — also the total budget of this call whenever a daemon is live.
 * Measured daemon latency is 220-305ms idle and 470-1870ms under load, so this
 * leaves ~2x headroom over the idle case while keeping the worst case bounded
 * well inside an interactive hook. Missing it yields no context, which is the
 * correct trade on a prompt hot path: a wider budget would just move seconds of
 * stall from the fallback into the wait.
 */
const DEFAULT_HOOK_DAEMON_TIMEOUT_MS = 700;
/**
 * Pathological-hang guard for the cold in-process indexer, which parses ~11MB of
 * index JSON and legitimately needs ~2s. It only runs when no daemon is live, so
 * it is the sole content source on that path and is not held to the hook budget.
 */
const DEFAULT_INDEXER_TIMEOUT_MS = 3000;
/** Hybrid mode: keep hits scoring at least this fraction of the top hit. */
const HYBRID_RELATIVE_FACTOR = 0.4;
/** Scale heuristic: hybrid scores are ≤ ~1.2 while BM25 raw scores run far higher. */
const HYBRID_SCALE_CUTOFF = 1.5;

// --- Cached WikiIndexer (lazy, only loaded when daemon is unavailable) ---

let _indexer: WikiIndexer | null = null;
let _indexerRoot: string | null = null;

async function getIndexer(workflowRoot: string): Promise<WikiIndexer> {
  if (_indexer && _indexerRoot === workflowRoot) return _indexer;
  const { WikiIndexer: Cls } = await import('#maestro-dashboard/wiki/wiki-indexer.js');
  _indexer = new Cls({ workflowRoot });
  _indexerRoot = workflowRoot;
  return _indexer;
}

interface RawHit {
  entry: {
    id: string;
    type: string;
    title?: string;
    summary?: string;
    status?: string;
    ext?: { status?: string };
  };
  score: number;
}

/**
 * Resolve the score threshold for a daemon response.
 *
 * Daemon hybrid scores are normalized (≤ ~1.2×decay) while BM25-only raw
 * scores commonly exceed 5 — a fixed absolute threshold silently empties
 * results whenever embedding is active. Hybrid mode uses a relative cut
 * against the top score; BM25 keeps the absolute default. When the response
 * does not report `embeddingUsed`, infer the mode from the score scale.
 */
function adaptiveMinScore(raw: RawHit[], embeddingUsed?: boolean): number {
  const top = raw.reduce((m, r) => Math.max(m, r.score), 0);
  if (top <= 0) return DEFAULT_MIN_SCORE;
  const hybrid = embeddingUsed ?? top < HYBRID_SCALE_CUTOFF;
  return hybrid ? HYBRID_RELATIVE_FACTOR * top : DEFAULT_MIN_SCORE;
}

function toHits(raw: RawHit[], limit: number, minScore: number): WikiSearchHit[] {
  return raw
    .filter((r) =>
      ALLOWED_TYPES.has(r.entry.type)
      && !isDeprecatedKnowledgeEntry(r.entry)
      && r.score >= minScore
    )
    .slice(0, limit)
    .map((r) => ({
      id: r.entry.id,
      type: r.entry.type,
      title: r.entry.title || 'Untitled',
      summary: (r.entry.summary || '').slice(0, 200),
      score: r.score,
    }));
}

function hasPersistedSearchIndex(workflowRoot: string): boolean {
  return existsSync(join(workflowRoot, 'search-cache.json'))
    || existsSync(join(workflowRoot, 'wiki-index.json'));
}

/**
 * Search the wiki knowledge base. Best-effort — never throws.
 * Returns filtered spec + knowhow hits and the source that produced them.
 */
export async function searchWiki(
  workflowRoot: string,
  query: string,
  opts?: { limit?: number; minScore?: number; daemonTimeoutMs?: number; skipEmbedding?: boolean },
): Promise<{ hits: WikiSearchHit[]; source: WikiSearchSource }> {
  const limit = opts?.limit ?? DEFAULT_LIMIT;
  const daemonTimeoutMs = opts?.daemonTimeoutMs ?? DEFAULT_HOOK_DAEMON_TIMEOUT_MS;
  const skipEmbedding = opts?.skipEmbedding ?? true;

  try {
    // Fast path: try search daemon (no heavy imports)
    let daemonLive = false;
    try {
      const { tryDaemonSearch, readDaemonInfo, isDaemonAlive } =
        await import('../search/daemon-client.js');
      const info = readDaemonInfo(workflowRoot);
      daemonLive = !!info && isDaemonAlive(info);
      const daemonResult = await tryDaemonSearch(
        workflowRoot,
        query,
        INTERNAL_LIMIT,
        skipEmbedding,
        { timeoutMs: daemonTimeoutMs },
      );
      if (daemonResult?.ok && daemonResult.results) {
        const raw = daemonResult.results as RawHit[];
        const minScore = opts?.minScore ?? adaptiveMinScore(raw, daemonResult.embeddingUsed);
        return { hits: toHits(raw, limit, minScore), source: 'daemon' };
      }
    } catch {
      // Daemon unavailable — fall through to direct search
    }

    // A live daemon owns the same index the local indexer would rebuild. When it
    // is up but did not answer in time, spending seconds to duplicate its work
    // in-process is the worst outcome for an interactive hook — degrade to empty
    // instead. The fallback exists for the daemon-absent case only.
    if (daemonLive) {
      return { hits: [], source: 'none' };
    }

    if (!hasPersistedSearchIndex(workflowRoot)) {
      return { hits: [], source: 'none' };
    }

    // Fallback: direct WikiIndexer BM25 search (skipEmbedding → raw BM25 scale).
    // Bounded — a cold process parses ~11MB of index JSON, so this must never be
    // allowed to run unmetered on the prompt hot path.
    const indexer = await getIndexer(workflowRoot);
    const results = await withTimeout(
      indexer.searchWithMeta(query, INTERNAL_LIMIT, { skipEmbedding: true }).then(r => r.results),
      DEFAULT_INDEXER_TIMEOUT_MS,
    );
    if (!results) return { hits: [], source: 'none' };
    const minScore = opts?.minScore ?? DEFAULT_MIN_SCORE;
    return { hits: toHits(results as RawHit[], limit, minScore), source: 'indexer' };
  } catch {
    return { hits: [], source: 'none' };
  }
}

/** Resolve to null if the promise does not settle within `ms`. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    if (typeof timer.unref === 'function') timer.unref();
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      () => { clearTimeout(timer); resolve(null); },
    );
  });
}

/**
 * Fire-and-forget background init of the WikiIndexer so future searches
 * skip the cold-start cost. Never throws.
 */
export function prewarmWikiIndexer(workflowRoot: string): void {
  getIndexer(workflowRoot).catch(() => {});
}
