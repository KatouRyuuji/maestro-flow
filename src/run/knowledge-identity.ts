/**
 * Knowledge write-authority identity plane (K3/K4 of
 * docs/knowledge-session-decoupling-mvp.md).
 *
 * Write authorization tiers (S3):
 *   A — explicit --run/--session/--channel, fenced lease (epoch claim with
 *       30s staleness), host-injected channels (Pi env / hook registration);
 *   C — narrowed scan (exactly ONE running Session AND zero live channels),
 *       always warned;
 *   anything else — fail-closed with a listing of live channels and running
 *   Sessions. Guessing is forbidden; reads are never blocked by identity
 *   failure (S7) because only write paths call into this module.
 *
 * Channels live per-workspace at `.workflow/tmp/channels/<identity>.channel.json`;
 * hook hosts register via the coordinator-tracker write point, manual callers
 * via --channel / MAESTRO_CHANNEL. Lineage fingerprints are intentionally NOT
 * implemented in MVP (deferred, see MVP doc §8).
 */
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { ensureSyntheticKnowledgeSession } from './session-knowledge.js';
import type { SessionStore } from './store.js';

export const CHANNEL_SCHEMA_VERSION = 'knowledge-channel/1.0' as const;
/** Generous idle cap: hook events refresh; expiry only fails writes closed. */
export const CHANNEL_TTL_MS = 24 * 60 * 60 * 1000;
/** Mirrors the plugin WorkflowLeaseStore staleAfterMs. */
export const LEASE_STALE_MS = 30_000;
export const MAESTRO_CHANNEL_ENV = 'MAESTRO_CHANNEL';
export const PI_HOST_SESSION_ENV = 'PI_HOST_SESSION_ID';

export type ChannelHostKind = 'pi' | 'hook' | 'manual';

export interface KnowledgeChannelRecord {
  schema_version: typeof CHANNEL_SCHEMA_VERSION;
  identity: string;
  host_kind: ChannelHostKind;
  /** Bound governance context, if resolved. */
  context: { kind: 'session' | 'run'; session_id: string; run_id?: string } | null;
  /** Reserved (MVP always null). */
  workspace_id: string | null;
  /** Reserved for a future CAS upgrade; MVP writes 1. */
  revision: number;
  created_at: string;
  expires_at: string;
  last_seen_at: string;
}

// ---------------------------------------------------------------------------
// Channel files
// ---------------------------------------------------------------------------

function tmpRoot(projectRoot: string): string {
  return join(projectRoot, '.workflow', 'tmp');
}

export function channelsDir(projectRoot: string): string {
  return join(tmpRoot(projectRoot), 'channels');
}

/**
 * Normalize a caller-supplied identity into a safe file segment. Non-empty
 * guaranteed; unsafe characters collapsed; bounded length.
 */
export function sanitizeChannelIdentity(raw: string): string {
  const trimmed = raw.trim().slice(0, 128);
  if (!trimmed) throw new Error('Channel identity must be non-empty');
  const safe = trimmed
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, '_')
    .replace(/[. ]+$/, '')
    .slice(0, 128);
  if (!safe || safe === '.' || safe === '..') {
    throw new Error(`Invalid channel identity: "${raw}"`);
  }
  return safe;
}

export function channelFilePath(projectRoot: string, identity: string): string {
  return join(channelsDir(projectRoot), `${sanitizeChannelIdentity(identity)}.channel.json`);
}

function isFreshChannel(record: KnowledgeChannelRecord, nowMs: number): boolean {
  const expires = Date.parse(record.expires_at);
  return Number.isFinite(expires) && expires > nowMs;
}

export function readChannel(
  projectRoot: string,
  identity: string,
): KnowledgeChannelRecord | null {
  try {
    const parsed = JSON.parse(readFileSync(channelFilePath(projectRoot, identity), 'utf8'));
    if (parsed?.schema_version !== CHANNEL_SCHEMA_VERSION) return null;
    if (typeof parsed.identity !== 'string' || typeof parsed.host_kind !== 'string') return null;
    return parsed as KnowledgeChannelRecord;
  } catch {
    return null;
  }
}

/** Live = parseable, schema-matching, unexpired, and carrying a bound context. */
export function listLiveChannels(
  projectRoot: string,
  nowMs: number = Date.now(),
): KnowledgeChannelRecord[] {
  const dir = channelsDir(projectRoot);
  if (!existsSync(dir)) return [];
  const live: KnowledgeChannelRecord[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.channel.json')) continue;
    try {
      const parsed = JSON.parse(readFileSync(join(dir, name), 'utf8'));
      if (parsed?.schema_version !== CHANNEL_SCHEMA_VERSION) continue;
      if (!isFreshChannel(parsed, nowMs)) continue;
      if (!parsed.context || typeof parsed.context.session_id !== 'string') continue;
      live.push(parsed as KnowledgeChannelRecord);
    } catch {
      // Corrupt/partial channel files never break resolution.
    }
  }
  return live;
}

/** Atomic-ish write: temp file + rename (same convention as lease claims). */
export function writeChannel(
  projectRoot: string,
  record: KnowledgeChannelRecord,
): void {
  const dir = channelsDir(projectRoot);
  mkdirSync(dir, { recursive: true });
  const finalPath = channelFilePath(projectRoot, record.identity);
  const pendingPath = `${finalPath}.${createHash('sha256')
    .update(`${record.identity}\u0000${record.last_seen_at}`)
    .digest('hex')
    .slice(0, 8)}.pending`;
  writeFileSync(pendingPath, `${JSON.stringify(record)}\n`, 'utf8');
  renameSync(pendingPath, finalPath);
}

/**
 * Create or refresh a channel. Existing bound context is preserved unless a
 * new one is supplied; TTL/lastSeen always advance.
 */
export function touchChannel(
  projectRoot: string,
  opts: {
    identity: string;
    hostKind: ChannelHostKind;
    context?: KnowledgeChannelRecord['context'];
    nowMs?: number;
  },
): KnowledgeChannelRecord {
  const nowMs = opts.nowMs ?? Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const identity = sanitizeChannelIdentity(opts.identity);
  const existing = readChannel(projectRoot, identity);
  const record: KnowledgeChannelRecord = {
    schema_version: CHANNEL_SCHEMA_VERSION,
    identity,
    host_kind: opts.hostKind,
    context: opts.context ?? existing?.context ?? null,
    workspace_id: null,
    revision: 1,
    created_at: existing?.created_at ?? nowIso,
    expires_at: new Date(nowMs + CHANNEL_TTL_MS).toISOString(),
    last_seen_at: nowIso,
  };
  writeChannel(projectRoot, record);
  return record;
}

// ---------------------------------------------------------------------------
// Lease reads (plugin WorkflowLeaseStore claim files)
// ---------------------------------------------------------------------------

export interface LeaseClaim {
  sessionId: string;
  hostSessionId: string;
  epoch: number;
  heartbeatAt: string;
  token: string;
}

function leaseRoot(projectRoot: string): string {
  return join(tmpRoot(projectRoot), 'hook');
}

/**
 * Read the highest-epoch claim per `.workflow/tmp/hook/<sessionId>.lease/`
 * directory. Corrupt directories are skipped; staleness is judged by the
 * caller against the claim file mtime.
 */
export function readLeaseClaims(
  projectRoot: string,
): Array<LeaseClaim & { claimPath: string; mtimeMs: number }> {
  const root = leaseRoot(projectRoot);
  if (!existsSync(root)) return [];
  const claims: Array<LeaseClaim & { claimPath: string; mtimeMs: number }> = [];
  for (const dirName of readdirSync(root)) {
    if (!dirName.endsWith('.lease')) continue;
    const dir = join(root, dirName);
    let entries: string[];
    try {
      entries = readdirSync(dir).filter(name => name.endsWith('.claim.json'));
    } catch {
      continue;
    }
    if (entries.length === 0) continue;
    const epochs = entries
      .map((name) => {
        const epoch = Number.parseInt(name.split('.')[0], 10);
        return { name, epoch: Number.isFinite(epoch) ? epoch : -1 };
      })
      .sort((a, b) => b.epoch - a.epoch);
    for (const { name } of epochs) {
      const claimPath = join(dir, name);
      try {
        const parsed = JSON.parse(readFileSync(claimPath, 'utf8')) as LeaseClaim;
        if (typeof parsed.sessionId !== 'string' || typeof parsed.hostSessionId !== 'string') continue;
        claims.push({ ...parsed, claimPath, mtimeMs: statSync(claimPath).mtimeMs });
        break; // highest epoch wins per lease directory
      } catch {
        // Fall through to older epochs when the newest claim is unreadable.
      }
    }
  }
  return claims;
}

/** Fresh lease claim for a host session, if any (mtime within LEASE_STALE_MS). */
export function findLeaseForHost(
  projectRoot: string,
  hostSessionId: string,
  nowMs: number = Date.now(),
): { sessionId: string; heartbeatAt: string; epoch: number } | null {
  const normalized = hostSessionId.trim();
  if (!normalized) return null;
  for (const claim of readLeaseClaims(projectRoot)) {
    if (claim.hostSessionId !== normalized) continue;
    if (nowMs - claim.mtimeMs > LEASE_STALE_MS) continue;
    return { sessionId: claim.sessionId, heartbeatAt: claim.heartbeatAt, epoch: claim.epoch };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Write-authority resolution
// ---------------------------------------------------------------------------

export type WriteAuthorityVia = 'explicit' | 'lease' | 'channel' | 'synthetic' | 'narrowed-scan';

export type WriteAuthority =
  | { kind: 'run'; sessionId: string; runId: string; via: WriteAuthorityVia; identity?: string; warning?: string }
  | {
      kind: 'session';
      sessionId: string;
      via: WriteAuthorityVia;
      synthetic: boolean;
      identity?: string;
      warning?: string;
    };

export interface ResolveWriteAuthorityInput {
  projectRoot: string;
  store: SessionStore;
  explicitRun?: string;
  explicitSession?: string;
  explicitChannel?: string;
  /** Injectable for tests; defaults to process.env. */
  env?: Record<string, string | undefined>;
  nowMs?: number;
}

function formatChannelListing(channels: KnowledgeChannelRecord[]): string {
  return channels
    .map(ch => `  - ${ch.identity} (${ch.host_kind}) → ${ch.context?.session_id ?? 'unbound'} · last seen ${ch.last_seen_at}`)
    .join('\n');
}

/**
 * Resolve where a knowledge write belongs. Tier order per MVP K3:
 * explicit → env channel → Pi host lease → single live channel → narrowed
 * scan → synthetic (nothing running) → fail-closed.
 */
export function resolveWriteAuthority(input: ResolveWriteAuthorityInput): WriteAuthority {
  const env = input.env ?? process.env;
  const nowMs = input.nowMs ?? Date.now();
  const { projectRoot, store } = input;

  // Tier A: explicit parameters.
  if (input.explicitRun) {
    const located = store.findRun(input.explicitRun, input.explicitSession);
    return { kind: 'run', sessionId: located.sessionId, runId: input.explicitRun, via: 'explicit' };
  }
  if (input.explicitSession) {
    if (!store.sessionExists(input.explicitSession)) {
      throw new Error(`Session not found: ${input.explicitSession}`);
    }
    return { kind: 'session', sessionId: input.explicitSession, via: 'explicit', synthetic: false };
  }

  // Tier A: manual/env channel identity.
  const channelIdentityRaw = input.explicitChannel ?? env[MAESTRO_CHANNEL_ENV];
  if (channelIdentityRaw?.trim()) {
    const identity = sanitizeChannelIdentity(channelIdentityRaw);
    const live = readChannel(projectRoot, identity);
    if (live && isFreshChannel(live, nowMs) && live.context) {
      const bound = bindChannelContextToAuthority(store, live);
      if (bound) return { ...bound, via: 'channel', identity };
    }
    // Unbound manual channel: create/refresh the synthetic Session it governs.
    const { sessionId, created } = ensureSyntheticKnowledgeSession(projectRoot, identity);
    touchChannel(projectRoot, {
      identity,
      hostKind: 'manual',
      context: { kind: 'session', session_id: sessionId },
      nowMs,
    });
    return {
      kind: 'session',
      sessionId,
      via: 'channel',
      synthetic: created || sessionId.startsWith('ksyn-'),
      identity,
    };
  }

  // Tier A: Pi host session env → lease reverse lookup.
  const hostSessionId = env[PI_HOST_SESSION_ENV]?.trim();
  if (hostSessionId) {
    const lease = findLeaseForHost(projectRoot, hostSessionId, nowMs);
    if (lease && store.sessionExists(lease.sessionId)) {
      const session = store.readBundle(lease.sessionId).session;
      if (session.status === 'running' && session.active_run_id) {
        return { kind: 'run', sessionId: lease.sessionId, runId: session.active_run_id, via: 'lease' };
      }
      return { kind: 'session', sessionId: lease.sessionId, via: 'lease', synthetic: false };
    }
  }

  // Tier A: exactly one live hook-registered channel with a bound context.
  // Manual channels never participate in identity-less inference: they belong
  // to callers who bind explicitly via --channel (K4 semantics).
  const liveChannels = listLiveChannels(projectRoot, nowMs);
  const hookChannels = liveChannels.filter(ch => ch.host_kind !== 'manual');
  const boundSessions = [...new Set(hookChannels.map(ch => ch.context!.session_id))];
  if (boundSessions.length === 1 && store.sessionExists(boundSessions[0])) {
    const session = store.readBundle(boundSessions[0]).session;
    const runChannel = hookChannels.find(ch => ch.context!.kind === 'run' && ch.context!.run_id);
    if (session.status === 'running' && runChannel
      && session.active_run_id === runChannel.context!.run_id) {
      return {
        kind: 'run',
        sessionId: boundSessions[0],
        runId: runChannel.context!.run_id!,
        via: 'channel',
        identity: runChannel.identity,
      };
    }
    if (session.status === 'running' || session.status === 'paused') {
      return {
        kind: 'session',
        sessionId: boundSessions[0],
        via: 'channel',
        synthetic: boundSessions[0].startsWith('ksyn-'),
        identity: hookChannels[0].identity,
      };
    }
  }
  if (boundSessions.length > 1) {
    throw new Error(
      'Multiple live knowledge channels claim different Sessions; write authority is ambiguous. '
      + 'Pass --run/--session/--channel explicitly.\nLive channels:\n'
      + formatChannelListing(liveChannels),
    );
  }

  const running = store.listRunningSessions();

  // Tier C: narrowed scan — exactly one running Session, zero live hook
  // channels. Binds the active Run when present, otherwise the Session itself
  // (session-source attribution); always warned.
  if (hookChannels.length === 0) {
    if (running.length === 1 && running[0].activeRunId) {
      return {
        kind: 'run',
        sessionId: running[0].sessionId,
        runId: running[0].activeRunId,
        via: 'narrowed-scan',
        warning:
          `No caller identity found; attributed to the unique running Session `
          + `${running[0].sessionId}. Pass --run/--session/--channel to bind explicitly.`,
      };
    }
    if (running.length === 1 && !running[0].activeRunId) {
      return {
        kind: 'session',
        sessionId: running[0].sessionId,
        via: 'narrowed-scan',
        synthetic: running[0].sessionId.startsWith('ksyn-'),
        warning:
          `No caller identity found; attributed to the unique running Session `
          + `${running[0].sessionId} (no active Run). Pass --session/--channel to bind explicitly.`,
      };
    }
    if (running.length === 0) {
      // Nothing running: open a synthetic Session (daily-partitioned identity).
      const host = hostSessionId || 'adhoc';
      const { sessionId } = ensureSyntheticKnowledgeSession(projectRoot, host);
      return {
        kind: 'session',
        sessionId,
        via: 'synthetic',
        synthetic: true,
        identity: host,
        warning: host === 'adhoc'
          ? 'No caller identity found; created a shared synthetic knowledge Session. '
            + 'Concurrent terminals should pass --channel <name> to stay separated.'
          : undefined,
      };
    }
  }

  // Fail-closed: ambiguous and no authorization tier matched.
  throw new Error(
    'Knowledge write authority is ambiguous: '
    + `${running.length} running Session(s) and ${liveChannels.length} live channel(s). `
    + 'Pass --run/--session/--channel explicitly.\n'
    + `Running sessions:\n${running.map(r => `  - ${r.sessionId}${r.activeRunId ? ` (run ${r.activeRunId})` : ''}`).join('\n')}\n`
    + (liveChannels.length > 0 ? `Live channels:\n${formatChannelListing(liveChannels)}` : ''),
  );
}

/**
 * Read-only Session attribution target for best-effort load attribution:
 * host env lease or exactly one live bound channel. Never creates Sessions.
 */
export function findSessionAttributionTarget(
  projectRoot: string,
  store: SessionStore,
  env: Record<string, string | undefined> = process.env,
  nowMs: number = Date.now(),
): string | null {
  const hostSessionId = env[PI_HOST_SESSION_ENV]?.trim();
  if (hostSessionId) {
    const lease = findLeaseForHost(projectRoot, hostSessionId, nowMs);
    if (lease && store.sessionExists(lease.sessionId)) return lease.sessionId;
  }
  // Hook channels only: manual channels belong to explicit --channel callers
  // and must not capture attribution from unidentified loads.
  const live = listLiveChannels(projectRoot, nowMs).filter(ch => ch.host_kind !== 'manual');
  const bound = [...new Set(live.map(ch => ch.context!.session_id))];
  if (bound.length === 1 && store.sessionExists(bound[0])) return bound[0];
  return null;
}

/** Map a channel's bound context back to an authority, if still valid. */
function bindChannelContextToAuthority(
  store: SessionStore,
  channel: KnowledgeChannelRecord,
): WriteAuthority | null {
  const context = channel.context;
  if (!context || !store.sessionExists(context.session_id)) return null;
  const session = store.readBundle(context.session_id).session;
  if (context.kind === 'run' && context.run_id
    && session.status === 'running' && session.active_run_id === context.run_id) {
    return { kind: 'run', sessionId: context.session_id, runId: context.run_id, via: 'channel' };
  }
  if (session.status === 'running' || session.status === 'paused') {
    return {
      kind: 'session',
      sessionId: context.session_id,
      via: 'channel',
      synthetic: context.session_id.startsWith('ksyn-'),
    };
  }
  return null;
}
