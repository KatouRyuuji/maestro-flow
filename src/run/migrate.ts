// ---------------------------------------------------------------------------
// `maestro session migrate` — fold a legacy ralph-meta.json into session.json
// and stamp the session at schema_version session/1.3.
//
// The migration is explicit and idempotent. ralph-meta.json is the pre-1.1
// side channel for ralph orchestration state; this merges its editorial fields
// (position / decomposition / lease / executor + per-step chain enrichment)
// into the canonical session.json orchestration block. The source file is left
// in place — verification_ledger and the excluded fields keep living there until
// a later milestone retires it.
//
// ralph-meta.json is read here through a deliberately loose local shape rather
// than a shared RalphMeta type: that type lived in the now-removed src/ralph/
// tree, so run defines its own read-only view of the legacy file.
// ---------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SessionStore, createSessionArchiveReceipt } from './store.js';
import { createExecutionState, createSessionIdentityV20 } from './defaults.js';
import {
  sessionStateV13Schema,
  type ExecutionState,
  type SessionState,
} from './schemas.js';
import type {
  GoalChangelogEntry,
  OrchestrationDecomposition,
  OrchestrationExecutor,
  OrchestrationLease,
  OrchestrationPosition,
  TaskDecompositionItem,
} from './schemas.js';

export type MigrateStatus = 'migrated' | 'already-migrated' | 'version-only' | 'migrated-to-2.0';

export interface MigrateResult {
  session_id: string;
  status: MigrateStatus;
  had_ralph_meta: boolean;
  mapped_steps: number;
  target_version?: 'session/1.3' | 'session/2.0';
  legacy_execution_id?: string;
}

// ── Loose ralph-meta shape (read-only local view of the legacy file) ─────────

interface RalphStepDetailLoose {
  args?: string;
  stage?: string;
  goal_ref?: string | null;
  retry_count?: number;
  max_retries?: number;
  // completion_* / concerns are intentionally not read (handoff is the source).
}

interface RalphMetaLoose {
  lifecycle_position?: string;
  phase?: number | null;
  phase_is_new?: boolean;
  milestone?: string;
  planning_mode?: string | null;
  passed_gates?: string[];
  scope_verdict?: string | null;
  execution_criteria?: string[];
  task_decomposition?: TaskDecompositionItem[];
  goal_changelog?: GoalChangelogEntry[];
  execution_owner?: string | null;
  owner_epoch?: number;
  lease_id?: string | null;
  cli_tool?: string;
  platform?: string;
  step_details?: Record<string, RalphStepDetailLoose>;
  // verification_ledger / context / protocol_version stay in ralph-meta.json.
}

// Default retry ceiling mirrors the ralph decision node default (max_retries: 2).
const DEFAULT_RETRY_MAX = 2;

function readRalphMeta(sessionDir: string): RalphMetaLoose | null {
  const path = join(sessionDir, 'ralph-meta.json');
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as RalphMetaLoose;
  } catch (error) {
    throw new Error(`invalid legacy ralph-meta.json at ${path}: ${(error as Error).message}`);
  }
}

function readStoredSessionVersion(sessionDir: string): string {
  const path = join(sessionDir, 'session.json');
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as { schema_version?: unknown };
    return typeof raw.schema_version === 'string' ? raw.schema_version : '';
  } catch (error) {
    throw new Error(`invalid session.json at ${path}: ${(error as Error).message}`);
  }
}

function buildPosition(meta: RalphMetaLoose): OrchestrationPosition {
  return {
    lifecycle: meta.lifecycle_position ?? '',
    phase: meta.phase ?? null,
    phase_is_new: meta.phase_is_new ?? false,
    milestone: meta.milestone ?? '',
    planning_mode: meta.planning_mode ?? null,
    passed_gates: meta.passed_gates ?? [],
    scope_verdict: meta.scope_verdict ?? null,
  };
}

function buildDecomposition(meta: RalphMetaLoose): OrchestrationDecomposition | null {
  const hasContent = (meta.execution_criteria?.length ?? 0) > 0
    || (meta.task_decomposition?.length ?? 0) > 0
    || (meta.goal_changelog?.length ?? 0) > 0;
  if (!hasContent) return null;
  return {
    execution_criteria: meta.execution_criteria ?? [],
    goals: meta.task_decomposition ?? [],
    changelog: meta.goal_changelog ?? [],
  };
}

function buildLease(meta: RalphMetaLoose): OrchestrationLease | null {
  if (meta.execution_owner == null && meta.owner_epoch == null && meta.lease_id == null) {
    return null;
  }
  return {
    owner: meta.execution_owner ?? null,
    epoch: meta.owner_epoch ?? 0,
    id: meta.lease_id ?? null,
  };
}

function buildExecutor(meta: RalphMetaLoose): OrchestrationExecutor | null {
  if (meta.platform == null && meta.cli_tool == null) return null;
  return {
    platform: meta.platform ?? '',
    cli_tool: meta.cli_tool ?? '',
  };
}

function applyRalphMeta(
  session: SessionState,
  meta: RalphMetaLoose | null,
): { mappedSteps: number; changed: boolean } {
  if (!meta) return { mappedSteps: 0, changed: false };
  const orchestration = session.orchestration;
  let changed = false;
  if (orchestration.position === null) {
    orchestration.position = buildPosition(meta);
    changed = true;
  }
  const decomposition = buildDecomposition(meta);
  if (orchestration.decomposition === null && decomposition !== null) {
    orchestration.decomposition = decomposition;
    changed = true;
  }
  const lease = buildLease(meta);
  if (orchestration.lease === null && lease !== null) {
    orchestration.lease = lease;
    changed = true;
  }
  const executor = buildExecutor(meta);
  if (orchestration.executor === null && executor !== null) {
    orchestration.executor = executor;
    changed = true;
  }

  let mappedSteps = 0;
  const stepDetails = meta.step_details ?? {};
  for (const step of orchestration.chain) {
    const detail = stepDetails[step.step_id];
    if (!detail) continue;
    let mapped = false;
    if (step.args === undefined && detail.args !== undefined) { step.args = detail.args; mapped = true; }
    if (step.stage === undefined && detail.stage !== undefined) { step.stage = detail.stage; mapped = true; }
    if (step.goal_ref === undefined && detail.goal_ref !== undefined) { step.goal_ref = detail.goal_ref; mapped = true; }
    if (step.retry === undefined) {
      step.retry = { count: detail.retry_count ?? 0, max: detail.max_retries ?? DEFAULT_RETRY_MAX };
      mapped = true;
    }
    if (mapped) {
      mappedSteps++;
      changed = true;
    }
  }
  return { mappedSteps, changed };
}

const LEGACY_MIGRATION_TIME = '1970-01-01T00:00:00.000Z';
const LEGACY_EXECUTION_ID = 'execution-legacy-g1';

function migrateSessionToV20(
  store: SessionStore,
  sessionId: string,
  storedVersion: string,
  meta: RalphMetaLoose | null,
): MigrateResult {
  if (storedVersion === 'session/2.0') {
    const current = store.readSessionRecord(sessionId);
    const latestExecutionId = current.schema_version === 'session/2.0'
      ? (current.latest_execution_id as string | null)
      : null;
    return {
      session_id: sessionId,
      status: 'already-migrated',
      had_ralph_meta: meta !== null,
      mapped_steps: 0,
      target_version: 'session/2.0',
      ...(latestExecutionId ? { legacy_execution_id: latestExecutionId } : {}),
    };
  }
  if (!storedVersion.startsWith('session/1.')) {
    throw new Error(`session ${sessionId} cannot migrate unsupported version ${storedVersion || '<missing>'}`);
  }

  const sessionPath = join(store.sessionDir(sessionId), 'session.json');
  const legacySource = readFileSync(sessionPath);
  const compatibility = structuredClone(store.readBundle(sessionId).session);
  const sourceIdentityRevision = compatibility.identity_revision;
  const sourceActivityRevision = compatibility.activity_revision;
  const metaResult = applyRalphMeta(compatibility, meta);
  if (metaResult.changed) compatibility.activity_revision++;
  compatibility.schema_version = 'session/1.3';
  sessionStateV13Schema.parse(compatibility);

  const archived = compatibility.status === 'archived';
  const terminal = compatibility.status === 'sealed' || archived;
  const paused = compatibility.status === 'paused' || compatibility.status === 'failed';
  const archivedAt = archived
    ? compatibility.lifecycle.sealed_at ?? LEGACY_MIGRATION_TIME
    : null;
  const archivedBy = archived ? 'legacy-migration' : null;
  const activityRevision = compatibility.activity_revision + (archived ? 1 : 0);

  const existingExecutions = store.listExecutions(sessionId);
  const openExecutions = existingExecutions.filter(execution => execution.status !== 'sealed');
  if (openExecutions.length > 1) {
    throw new Error(
      `session ${sessionId} has multiple nonsealed Executions: `
      + openExecutions.map(execution => execution.execution_id).sort().join(', '),
    );
  }
  if (terminal && openExecutions.length > 0) {
    throw new Error(
      `sealed legacy session ${sessionId} has nonsealed Execution ${openExecutions[0].execution_id}`,
    );
  }

  let legacyExecution: ExecutionState | undefined;
  if (existingExecutions.length === 0) {
    legacyExecution = createExecutionState(compatibility, {
      executionId: LEGACY_EXECUTION_ID,
      generation: 1,
      startedAt: compatibility.lifecycle.sealed_at ?? LEGACY_MIGRATION_TIME,
    }) as ExecutionState;
    legacyExecution.status = terminal ? 'sealed' : paused ? 'paused' : 'active';
    legacyExecution.active_run_id = legacyExecution.status === 'active' ? compatibility.active_run_id : null;
    legacyExecution.lease = null;
    if (terminal) {
      legacyExecution.sealed_at = compatibility.lifecycle.sealed_at ?? LEGACY_MIGRATION_TIME;
      legacyExecution.seal_summary = compatibility.lifecycle.seal_summary ?? 'Migrated sealed legacy Session';
      legacyExecution.final_outcome = 'done';
    }
  }

  const reconciledExecutions = legacyExecution ? [legacyExecution] : existingExecutions;
  const latestExecution = reconciledExecutions.reduce((latest, execution) => (
    execution.generation > latest.generation ? execution : latest
  ));
  const currentExecutionId = reconciledExecutions.find(execution => execution.status !== 'sealed')?.execution_id ?? null;
  const identity = createSessionIdentityV20(compatibility.session_id, compatibility.intent, {
    topicIdentity: compatibility.topic_identity,
    identityRevision: compatibility.identity_revision,
    activityRevision,
    currentExecutionId,
    latestExecutionId: latestExecution.execution_id,
    latestCompletedRunId: compatibility.latest_completed_run_id,
    archivedAt,
    archivedBy,
  });

  const archiveReceipt = archived ? createSessionArchiveReceipt({
    receipt_id: `archive-${String(activityRevision).padStart(12, '0')}`,
    operation: 'archive',
    session_id: sessionId,
    actor: archivedBy!,
    reason: 'Historical session/1.x archived status migration',
    evidence_refs: [`legacy-session:sha256:${createHash('sha256').update(legacySource).digest('hex')}`],
    recorded_at: archivedAt!,
    before: {
      identity_revision: compatibility.identity_revision,
      activity_revision: compatibility.activity_revision,
      archived_at: null,
      archived_by: null,
    },
    after: {
      identity_revision: identity.identity_revision,
      activity_revision: identity.activity_revision,
      archived_at: identity.archived_at,
      archived_by: identity.archived_by,
    },
    previous_receipt_hash: null,
  }) : undefined;

  store.migrateLegacySessionToV20({
    identity,
    compatibility,
    legacyExecution,
    archiveReceipt,
    sourceIdentityRevision,
    sourceActivityRevision,
  });
  return {
    session_id: sessionId,
    status: 'migrated-to-2.0',
    had_ralph_meta: meta !== null,
    mapped_steps: metaResult.mappedSteps,
    target_version: 'session/2.0',
    legacy_execution_id: latestExecution.execution_id,
  };
}

/**
 * Merge ralph-meta.json into session.json and stamp the latest Session schema. Idempotent:
 * a session already carrying position or decomposition is treated as migrated
 * and returned untouched. A session with a running chain step is rejected — the
 * caller must complete it first so migration never races an in-flight step.
 */
export function migrateSession(projectRoot: string, sessionId: string): MigrateResult {
  const root = resolve(projectRoot);
  const store = new SessionStore(root);
  if (!store.sessionExists(sessionId)) {
    throw new Error(`session not found: ${sessionId}`);
  }

  const sessionDir = store.sessionDir(sessionId);
  const storedVersion = readStoredSessionVersion(sessionDir);
  const meta = readRalphMeta(sessionDir);
  if (store.sessionSchemaSelection().writer === 'session/2.0') {
    return migrateSessionToV20(store, sessionId, storedVersion, meta);
  }

  const bundle = store.readBundle(sessionId);
  const session = bundle.session;
  const orch = session.orchestration;

  const runningStep = orch.chain.find(step => step.status === 'running');
  if (runningStep) {
    throw new Error(
      `session ${sessionId} has a running chain step (${runningStep.step_id}); complete it before migrating`,
    );
  }

  // No ralph-meta: nothing to fold. The store write-back stamps session/1.3.
  if (!meta) {
    if (storedVersion === 'session/1.3') {
      return { session_id: sessionId, status: 'already-migrated', had_ralph_meta: false, mapped_steps: 0 };
    }
    store.update(sessionId, (draft) => {
      draft.session.activity_revision++;
      return null;
    });
    return { session_id: sessionId, status: 'version-only', had_ralph_meta: false, mapped_steps: 0 };
  }

  const stepDetails = meta.step_details ?? {};
  const applied = store.update(sessionId, (draft) => {
    const o = draft.session.orchestration;
    let changed = storedVersion !== 'session/1.3';
    let mappedSteps = 0;
    if (o.position === null) { o.position = buildPosition(meta); changed = true; }
    const decomposition = buildDecomposition(meta);
    if (o.decomposition === null && decomposition !== null) { o.decomposition = decomposition; changed = true; }
    const lease = buildLease(meta);
    if (o.lease === null && lease !== null) { o.lease = lease; changed = true; }
    const executor = buildExecutor(meta);
    if (o.executor === null && executor !== null) { o.executor = executor; changed = true; }

    // Fold per-step enrichment onto chain steps, matched by step_id.
    for (const step of o.chain) {
      const detail = stepDetails[step.step_id];
      if (!detail) continue;
      let mapped = false;
      if (step.args === undefined && detail.args !== undefined) { step.args = detail.args; mapped = true; }
      if (step.stage === undefined && detail.stage !== undefined) { step.stage = detail.stage; mapped = true; }
      if (step.goal_ref === undefined && detail.goal_ref !== undefined) { step.goal_ref = detail.goal_ref; mapped = true; }
      if (step.retry === undefined) {
        step.retry = { count: detail.retry_count ?? 0, max: detail.max_retries ?? DEFAULT_RETRY_MAX };
        mapped = true;
      }
      if (mapped) { mappedSteps++; changed = true; }
    }

    if (changed) draft.session.activity_revision++;
    return { changed, mappedSteps };
  });

  return {
    session_id: sessionId,
    status: applied.changed ? 'migrated' : 'already-migrated',
    had_ralph_meta: true,
    mapped_steps: applied.mappedSteps,
  };
}

/**
 * Migrate every session under `.workflow/sessions/`. Each session is migrated
 * independently; a failure on one is captured and reported without aborting the
 * batch.
 */
export function migrateAllSessions(
  projectRoot: string,
): Array<{ session_id: string; result?: MigrateResult; error?: string }> {
  const root = resolve(projectRoot);
  const store = new SessionStore(root);
  const out: Array<{ session_id: string; result?: MigrateResult; error?: string }> = [];
  if (!existsSync(store.sessionsRoot)) return out;

  for (const name of readdirSync(store.sessionsRoot)) {
    const dir = join(store.sessionsRoot, name);
    try {
      if (!statSync(dir).isDirectory()) continue;
      if (!existsSync(join(dir, 'session.json'))) continue;
    } catch {
      continue;
    }
    try {
      out.push({ session_id: name, result: migrateSession(root, name) });
    } catch (error) {
      out.push({ session_id: name, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return out;
}
