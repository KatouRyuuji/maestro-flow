/**
 * Shared types and utilities for the search daemon (client + server).
 * Single source of truth — both daemon.ts and daemon-client.ts import from here.
 */

import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import type { WikiEntry, WikiSearchFilters } from '#maestro-dashboard/wiki/wiki-types.js';

const DAEMON_FILE = 'search-daemon.json';

export interface DaemonInfo {
  pid: number;
  port: number;
  startedAt: string;
}

export interface DaemonSearchRequest {
  action: 'search' | 'invalidate';
  query?: string;
  limit?: number;
  skipEmbedding?: boolean;
  filters?: WikiSearchFilters;
}

export interface DaemonSearchResponse {
  ok: boolean;
  results?: Array<{ entry: WikiEntry; score: number }>;
  embeddingUsed?: boolean;
  embeddingDocs?: number;
  /** True only when the daemon applied request filters before ranking truncation. */
  filtersApplied?: boolean;
  error?: string;
}

export function getDaemonPath(workflowRoot: string): string {
  return join(workflowRoot, DAEMON_FILE);
}

export function readDaemonInfo(workflowRoot: string): DaemonInfo | null {
  const p = getDaemonPath(workflowRoot);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf-8'));
  } catch { return null; }
}

export function isDaemonAlive(info: DaemonInfo): boolean {
  try { process.kill(info.pid, 0); return true; } catch { return false; }
}
