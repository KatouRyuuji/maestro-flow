// ---------------------------------------------------------------------------
// Lease guard — engine-agnostic concurrency check over
// `session.orchestration.lease`. When a session carries a non-null lease with a
// non-empty owner, `run next` / `run complete` must present the matching
// execution-owner / owner-epoch / lease-id triple or be refused.
//
// Semantics come from the retired ralph engine's lease rejection path (formerly
// src/ralph/cmd-next.ts / cmd-complete.ts, removed in the Session/Run
// unification): a mismatch is a plain "lease conflict: ..." message that the
// caller surfaces on stderr with exit code 1. A null lease (or one with a null
// owner) imposes zero verification — non-leased sessions are unaffected.
// ---------------------------------------------------------------------------

import { createHash, randomBytes } from 'node:crypto';
import type { ExecutionLease, OrchestrationLease } from './schemas.js';

export interface LeaseClaim {
  executionOwner?: string;
  ownerEpoch?: number;
  leaseId?: string;
}

export const DEFAULT_EXECUTION_LEASE_STALE_MS = 30_000;

export interface ExecutionLeaseClaim {
  ownerId: string;
  ownerKind: ExecutionLease['owner_kind'];
  epoch: number;
  leaseId: string;
}

export interface ExecutionLeaseStatus {
  state: 'unleased' | 'active' | 'stale' | 'handoff';
  stale: boolean;
  heartbeat_age_ms: number | null;
  lease: Omit<ExecutionLease, 'lease_id'> | null;
  lease_id_hash: string | null;
}

function required(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

export function hashExecutionLeaseId(leaseId: string): string {
  return `sha256:${createHash('sha256').update(required(leaseId, 'lease id')).digest('hex')}`;
}

export function mintExecutionLeaseId(): string {
  return randomBytes(32).toString('base64url');
}

export function executionLeaseClaim(lease: ExecutionLease): ExecutionLeaseClaim {
  return {
    ownerId: lease.owner_id,
    ownerKind: lease.owner_kind,
    epoch: lease.epoch,
    leaseId: lease.lease_id,
  };
}

/** Require the complete execution lease tuple and reject an old owner after takeover. */
export function assertExecutionLease(
  lease: ExecutionLease | null,
  claim: ExecutionLeaseClaim,
  options: { allowHandoff?: boolean } = {},
): ExecutionLease {
  if (!lease) throw new Error('execution lease fence conflict: Execution is unleased');
  if (!claim || !claim.ownerId || !claim.ownerKind || !claim.leaseId || !Number.isInteger(claim.epoch)) {
    throw new Error('execution lease fence requires owner_id, owner_kind, epoch, and lease_id');
  }
  if (lease.owner_id !== claim.ownerId
    || lease.owner_kind !== claim.ownerKind
    || lease.epoch !== claim.epoch
    || lease.lease_id !== claim.leaseId) {
    throw new Error('execution lease fence conflict: stale owner, epoch, kind, or token');
  }
  if (lease.handoff_to && !options.allowHandoff) {
    throw new Error(`execution lease handoff in progress to ${lease.handoff_to}`);
  }
  return lease;
}

export function isExecutionLeaseStale(
  lease: ExecutionLease,
  now = new Date(),
  staleAfterMs = DEFAULT_EXECUTION_LEASE_STALE_MS,
): boolean {
  if (!Number.isFinite(staleAfterMs) || staleAfterMs < 1) throw new Error('staleAfterMs must be positive');
  const heartbeat = Date.parse(lease.heartbeat_at);
  if (!Number.isFinite(heartbeat)) return true;
  return now.getTime() - heartbeat >= staleAfterMs;
}

export function describeExecutionLease(
  lease: ExecutionLease | null,
  now = new Date(),
  staleAfterMs = DEFAULT_EXECUTION_LEASE_STALE_MS,
): ExecutionLeaseStatus {
  if (!lease) {
    return { state: 'unleased', stale: false, heartbeat_age_ms: null, lease: null, lease_id_hash: null };
  }
  const heartbeat = Date.parse(lease.heartbeat_at);
  const age = Number.isFinite(heartbeat) ? Math.max(0, now.getTime() - heartbeat) : Number.MAX_SAFE_INTEGER;
  const stale = isExecutionLeaseStale(lease, now, staleAfterMs);
  const { lease_id: _privateToken, ...publicLease } = lease;
  return {
    state: stale ? 'stale' : lease.handoff_to ? 'handoff' : 'active',
    stale,
    heartbeat_age_ms: age,
    lease: publicLease,
    lease_id_hash: hashExecutionLeaseId(lease.lease_id),
  };
}

/**
 * Verify a claim against a session lease. Returns a conflict message (for the
 * caller to print on stderr before exiting 1) or null when the claim passes.
 *
 * A lease is inert unless it exists and names an owner: `null` lease or
 * `owner === null` short-circuits to null (no verification, no effect). When
 * active, each set field of the lease must match the claim:
 *   - `owner` ≠ executionOwner  → conflict (mirrors the retired ralph engine's execution_owner check)
 *   - `id`    ≠ leaseId         → conflict (mirrors the retired ralph engine's lease_id check)
 *   - `epoch` ≠ ownerEpoch      → conflict (epoch fencing; an active lease
 *                                 requires the complete owner/epoch/id claim)
 */
export function checkLease(
  lease: OrchestrationLease | null | undefined,
  claim: LeaseClaim,
): string | null {
  if (!lease || !lease.owner) return null;

  if (lease.owner !== claim.executionOwner) {
    return `lease conflict: session owned by "${lease.owner}", got "${claim.executionOwner ?? '<none>'}"`;
  }
  if (!lease.id) {
    return 'lease conflict: active session lease has no lease_id';
  }
  if (lease.id !== claim.leaseId) {
    return `lease conflict: session lease_id is "${lease.id}", got "${claim.leaseId ?? '<none>'}"`;
  }
  if (lease.epoch !== claim.ownerEpoch) {
    return `lease conflict: session epoch is ${lease.epoch}, got ${claim.ownerEpoch ?? '<none>'}`;
  }
  return null;
}

/**
 * The lease value after a claim, or null when nothing should be written.
 * Originally modelled on the retired ralph cmd-next claim path (removed;
 * `m.execution_owner = ...` after the step goes
 * live): a claim is written only when the caller supplies an executionOwner and
 * either the session has no active lease owner (fresh claim) or the existing
 * owner matches (renewal). A conflicting claim never reaches here — checkLease
 * rejects it upstream. An active owner always requires a complete epoch/id
 * fencing tuple; omitted fields are rejected instead of inherited or defaulted.
 *
 * Returns null (no write) when no executionOwner is supplied, so `run next`
 * without `--execution-owner` leaves a leaseless session leaseless.
 */
export function claimLease(
  lease: OrchestrationLease | null | undefined,
  claim: LeaseClaim,
): OrchestrationLease | null {
  if (!claim.executionOwner) return null;
  if (claim.ownerEpoch === undefined) {
    throw new Error('lease claim requires --owner-epoch when --execution-owner is set');
  }
  if (!claim.leaseId) {
    throw new Error('lease claim requires --lease-id when --execution-owner is set');
  }
  // A conflict would have been rejected by checkLease; persist the complete
  // fencing tuple supplied by this claim without inheriting omitted fields.
  return {
    owner: claim.executionOwner,
    epoch: claim.ownerEpoch,
    id: claim.leaseId,
  };
}
