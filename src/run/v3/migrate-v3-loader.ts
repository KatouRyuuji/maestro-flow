import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  sessionStateV13Schema,
  sessionStateV20Schema,
  type CommandRunInput,
  type ExecutionState,
  type SessionIdentityV20,
  type SessionState,
} from '../schemas.js';
import type { PersistedTransitionRecordV11 } from '../protocol-schemas.js';
import { SessionStore } from '../store.js';
import type { LegacyV3MigrationInput } from './migrate-v3.js';

function readBytes(path: string): Buffer {
  if (!existsSync(path)) throw new Error(`missing migration source: ${path}`);
  return readFileSync(path);
}

function selectExecution(
  session: SessionState | SessionIdentityV20,
  executions: readonly ExecutionState[],
): ExecutionState | null {
  if (executions.length === 0) return null;
  const explicitId = session.schema_version === 'session/2.0'
    ? session.current_execution_id ?? session.latest_execution_id
    : null;
  // An open (nonsealed) Execution is the live authority: when exactly one
  // exists it wins over a stale current/latest pointer that may reference a
  // sealed Execution (a sealed pointer would project a terminal Session while
  // the real work continues in the open one).
  const nonsealed = executions.filter(item => item.status !== 'sealed');
  if (nonsealed.length === 1) return nonsealed[0];
  if (explicitId) {
    const selected = executions.find(item => item.execution_id === explicitId);
    if (!selected) throw new Error(`Session references missing Execution ${explicitId}`);
    return selected;
  }
  return [...executions].sort((left, right) => right.generation - left.generation
    || left.execution_id.localeCompare(right.execution_id))[0];
}

export function loadLegacyV3MigrationInput(
  store: SessionStore,
  sessionId: string,
): LegacyV3MigrationInput {
  const record = store.readSessionRecord(sessionId);
  if (record.schema_version !== 'session/1.3' && record.schema_version !== 'session/2.0') {
    throw new Error(`Session ${sessionId} cannot migrate from ${record.schema_version}`);
  }
  const legacySession = record.schema_version === 'session/2.0'
    ? sessionStateV20Schema.parse(record)
    : sessionStateV13Schema.parse(record);
  const bundle = store.readBundle(sessionId);
  const executions = store.listExecutions(sessionId);
  const execution = selectExecution(legacySession, executions);
  const executionTransitions: PersistedTransitionRecordV11[] = execution
    ? store.listExecutionTransitions(sessionId, execution.execution_id)
    : [];
  const executionTransitionBytes: Record<string, Buffer> = {};
  if (execution) {
    for (const transition of executionTransitions) {
      executionTransitionBytes[transition.request_id] = readBytes(store.executionTransitionPath(
        sessionId,
        execution.execution_id,
        transition.request_id,
      ));
    }
  }
  const runsRoot = join(store.sessionDir(sessionId), 'runs');
  const runIds = existsSync(runsRoot) ? readdirSync(runsRoot).sort() : [];
  const runs: CommandRunInput[] = [];
  const runBytes: Record<string, Buffer> = {};
  for (const runId of runIds) {
    const path = join(store.runDir(sessionId, runId), 'run.json');
    if (!existsSync(path)) continue;
    const run = store.readRunRecord(sessionId, runId);
    if (run.schema_version === 'run/3.0') throw new Error(`Run ${runId} is already run/3.0`);
    runs.push(run as CommandRunInput);
    runBytes[runId] = readBytes(path);
  }
  const dir = store.sessionDir(sessionId);
  const sessionPath = join(dir, 'session.json');
  const gatesPath = join(dir, 'gates.json');
  const artifactsPath = join(dir, 'artifacts.json');
  const evidencePath = join(dir, 'evidence.json');
  return {
    session: legacySession,
    execution,
    execution_transitions: executionTransitions,
    runs,
    gates: bundle.gates,
    artifacts: bundle.artifacts,
    evidence: bundle.evidence,
    source_bytes: {
      session: readBytes(sessionPath),
      ...(execution ? {
        execution: readBytes(store.executionPath(sessionId, execution.execution_id)),
        execution_transitions: executionTransitionBytes,
      } : {}),
      runs: runBytes,
      gates: readBytes(gatesPath),
      artifacts: readBytes(artifactsPath),
      evidence: readBytes(evidencePath),
    },
  };
}
