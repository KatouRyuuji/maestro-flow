import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createIntentIdentity, canonicalWorkspaceId } from './intent-identity.js';
import {
  runRecallV11Schema,
  sourceFenceReadSchema,
  sourceFenceSchema,
  sourceFenceV11Schema,
  type ExecutionSealReceipt,
  type RunRecall,
  type RecallConfirmationRecord,
} from './protocol-schemas.js';
import { SessionStore } from './store.js';
import { sha256Digest, stableJsonUtf8 } from './transition-receipts.js';
import { createTopicIdentity, normalizeTopic, sameTopicIdentity } from './topic-identity.js';
import { assessSessionReuse } from './runtime.js';
import type { SessionState } from './schemas.js';

export interface RecallRequest {
  command: string;
  intent: string;
  topic?: string;
  limit?: number;
  asOf?: string;
  interactive?: boolean;
}

function fileHash(path: string): string { return sha256Digest(readFileSync(path)); }
type SourceFence = NonNullable<RecallConfirmationRecord['source_fence']>;

function receiptForRun(
  store: SessionStore,
  sessionId: string,
  runId: string,
): ExecutionSealReceipt | null {
  let executionId = 'execution-legacy-g1';
  try {
    executionId = store.readExecutionRun(sessionId, runId).execution_id;
  } catch {
    // Migrated session/1.x sources use the deterministic generation-1 Execution.
  }
  const receipt = store.readExecutionSealReceipt(sessionId, executionId);
  return receipt?.runs.some(snapshot => snapshot.run_id === runId) ? receipt : null;
}

export function buildSourceFence(projectRoot: string, sessionId: string, runId: string, workspaceLinkName: string | null = null): SourceFence {
  const store = new SessionStore(projectRoot);
  const session = store.readSessionRecord(sessionId);
  const bundle = store.readBundle(sessionId);
  const run = store.readRun(sessionId, runId);
  const receipt = receiptForRun(store, sessionId, runId);
  if (run.status !== 'sealed') throw new Error('source Run must be sealed');
  // session/3.0 has no legacy identity_revision and no source fence; the
  // recall/source-fence flow is legacy-only (readBundle already rejects v3).
  if (session.schema_version === 'session/3.0') {
    throw new Error('session/3.0 authority is not a legacy source-fence source');
  }
  // The known/unknown read union is not TS-discriminable; the guards above
  // already rejected v3, so the remaining members all carry the legacy
  // identity_revision/activity_revision fields.
  const legacySession = session as SessionState;
  if (session.schema_version === 'session/2.0' && !receipt) {
    throw new Error('session/2.0 source requires an immutable sealed Execution receipt');
  }
  if (!receipt && !['sealed', 'archived'].includes(bundle.session.status)) {
    throw new Error('legacy source must be a sealed or archived Session with a sealed Run');
  }
  const selected = (receipt?.schema_version === 'execution-seal-receipt/1.1'
    ? receipt.artifacts.snapshots
        .filter(item => item.producer_run_id === runId)
        .map(item => ({
          kind: item.kind,
          relative_path: item.relative_path,
          content_hash: item.content_hash,
        }))
    : Object.values(bundle.artifacts.artifacts)
        .filter(item => item.producer_run_id === runId && item.status === 'sealed')
        .map(item => ({
          kind: item.kind,
          relative_path: item.relative_path,
          content_hash: `sha256:${item.content_hash}`,
        })))
    .sort((a, b) => a.relative_path.localeCompare(b.relative_path));
  const runHash = fileHash(join(store.runDir(sessionId, runId), 'run.json'));
  if (receipt) {
    const execution = store.readExecution(sessionId, receipt.execution_id);
    const snapshot = receipt.runs.find(item => item.run_id === runId);
    if (execution.status !== 'sealed'
      || execution.generation !== receipt.generation
      || execution.revision !== receipt.execution_revision
      || execution.sealed_at !== receipt.sealed_at
      || !snapshot
      || snapshot.content_hash !== runHash) {
      throw new Error('source Run does not match its immutable sealed Execution receipt');
    }
    for (const expected of selected) {
      if (receipt.schema_version === 'execution-seal-receipt/1.1') {
        const matching = receipt.artifacts.snapshots.filter(artifact => (
          artifact.producer_run_id === runId
          && artifact.kind === expected.kind
          && artifact.relative_path === expected.relative_path
          && artifact.content_hash === expected.content_hash
        ));
        if (matching.length !== 1) {
          throw new Error(`source artifact is not sealed by the Execution receipt: ${expected.relative_path}`);
        }
        continue;
      }
      const matchingArtifact = Object.entries(bundle.artifacts.artifacts).find(([, artifact]) => (
        artifact.producer_run_id === runId
        && artifact.kind === expected.kind
        && artifact.relative_path === expected.relative_path
        && `sha256:${artifact.content_hash}` === expected.content_hash
      ));
      if (!matchingArtifact || receipt.artifacts.content_hashes[matchingArtifact[0]] !== expected.content_hash) {
        throw new Error(`source artifact is not sealed by the Execution receipt: ${expected.relative_path}`);
      }
    }
  }
  const base = {
    workspace_id: canonicalWorkspaceId(projectRoot), workspace_link_name: workspaceLinkName,
    session_id: sessionId, session_schema_version: session.schema_version,
    session_identity_revision: legacySession.identity_revision,
    session_activity_revision: legacySession.activity_revision,
    session_hash: fileHash(join(store.sessionDir(sessionId), 'session.json')),
    run_id: runId,
    run_schema_version: receipt?.runs.find(snapshot => snapshot.run_id === runId)?.schema_version ?? run.schema_version,
    run_hash: runHash,
    artifact_registry_revision: bundle.artifacts.revision, selected_artifacts: selected,
  };
  const parsed = (receipt
    ? sourceFenceV11Schema.parse({
        ...base,
        schema_version: 'source-fence/1.1',
        execution_seal_receipt: {
          execution_id: receipt.execution_id,
          generation: receipt.generation,
          sealed_at: receipt.sealed_at,
          relative_path: `executions/${receipt.execution_id}/seal-receipt.json`,
          overall_hash: receipt.overall_hash,
        },
      })
    : sourceFenceSchema.parse(base)) as SourceFence;
  sourceFenceReadSchema.parse(parsed);
  return parsed;
}

function topicMatches(
  session: ReturnType<SessionStore['readBundle']>['session'],
  topicIdentity: ReturnType<typeof createTopicIdentity>,
): boolean {
  return session.topic_identity
    ? sameTopicIdentity(session.topic_identity, topicIdentity)
    : normalizeTopic(session.intent) === topicIdentity.normalized;
}

type DerivedRecallLifecycle = 'idle' | 'runnable' | 'executing' | 'blocked';

function exactRecallCandidates(
  store: SessionStore,
  topicIdentity: ReturnType<typeof createTopicIdentity>,
) {
  return store.listSessionsReadOnly().candidates.flatMap(({ sessionId, session }) => {
    if (!topicMatches(session, topicIdentity)) return [];
    const record = store.readSessionRecord(sessionId);
    if (record.schema_version !== 'session/2.0') {
      if (session.status !== 'running') return [];
      return [{
        candidate_id: `live:${sessionId}`,
        session_id: sessionId,
        status: 'running' as const,
        active_run_id: session.active_run_id,
        identity_revision: session.identity_revision,
        activity_revision: session.activity_revision,
        eligible_actions: [],
        exclusions: session.active_run_id ? ['ACTIVE_RUN_PRESENT'] : [],
        next_if_active: null,
      }];
    }
    if (record.archived_at) return [];

    const currentExecutionId = typeof record.current_execution_id === 'string'
      ? record.current_execution_id
      : null;
    const current = currentExecutionId
      ? store.readExecution(sessionId, currentExecutionId)
      : null;
    let lifecycle: DerivedRecallLifecycle = 'idle';
    if (current?.status === 'paused') {
      lifecycle = 'blocked';
    } else if (current?.status === 'active') {
      if (!current.active_run_id) {
        lifecycle = 'runnable';
      } else {
        const run = store.readExecutionRun(sessionId, current.active_run_id);
        lifecycle = run.status === 'blocked' || run.status === 'failed' ? 'blocked' : 'executing';
      }
    } else if (current) {
      lifecycle = 'blocked';
    }
    const activeRunId = current?.active_run_id ?? null;
    return [{
      candidate_id: `live:${sessionId}`,
      session_id: sessionId,
      status: lifecycle === 'blocked' ? 'paused' as const : 'running' as const,
      active_run_id: activeRunId,
      identity_revision: record.identity_revision,
      activity_revision: record.activity_revision,
      eligible_actions: [],
      exclusions: [
        `DERIVED_${lifecycle.toUpperCase()}`,
        ...(activeRunId ? ['ACTIVE_RUN_PRESENT'] : []),
      ],
      next_if_active: null,
    }];
  });
}

export async function recallRuns(projectRoot: string, request: RecallRequest): Promise<RunRecall> {
  const asOf = request.asOf ?? new Date().toISOString();
  const store = new SessionStore(projectRoot);
  const topicIdentity = createTopicIdentity(
    projectRoot,
    request.topic?.trim() || request.intent,
    { source: request.topic ? 'explicit' : 'legacy-intent' },
  );
  const intentIdentity = createIntentIdentity(projectRoot, request.command, request.intent);
  const exact = exactRecallCandidates(store, topicIdentity);
  const reuseAssessments = exact.length === 1
    ? assessSessionReuse(projectRoot, exact[0].session_id, request.command).assessments
    : [];
  const result = {
    schema_version: 'run-recall/1.1' as const,
    request: { request_id: randomUUID(), request_hash: sha256Digest(stableJsonUtf8({ command: request.command, intent: request.intent, topic: topicIdentity.normalized, as_of: asOf })), command: request.command, intent: request.intent, workspace: canonicalWorkspaceId(projectRoot), as_of: asOf, interactive: request.interactive ?? false },
    intent_identity: intentIdentity,
    topic_identity: topicIdentity,
    exact_candidates: exact,
    historical_candidates: [],
    reuse_assessments: reuseAssessments,
    recommendation: { action: null, candidate_id: exact.length === 1 ? exact[0].candidate_id : null, automatic: false as const, reason_codes: [exact.length > 1 ? 'AMBIGUOUS_TOPIC_MATCH' : exact.length === 1 ? 'READ_ONLY_TOPIC_MATCH' : 'NO_RUNNING_TOPIC_MATCH'] },
    confirmation: { required: false, issuance_command: '', allowed_actions: [] },
    next: { suggest_only: true as const, command: null, reason: 'Recall is a read-only topic and reuse assessment; normal run prepare/create performs routing.' },
  };
  return runRecallV11Schema.parse(result);
}
