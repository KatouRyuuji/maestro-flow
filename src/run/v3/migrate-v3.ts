import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

import {
  artifactRegistrySchema,
  commandRunReadSchema,
  commandRunV1Schema,
  commandRunV11Schema,
  commandRunV12Schema,
  commandRunV13Schema,
  commandRunV14Schema,
  evidenceStoreSchema,
  executionStateSchema,
  gateRegistrySchema,
  runV30Schema,
  sessionStateV13Schema,
  sessionStateV20Schema,
  sessionStateV30Schema,
  type ArtifactRegistry,
  type CommandRunInput,
  type EvidenceStore,
  type ExecutionState,
  type GateRegistry,
  type RunV30,
  type SessionIdentityV20,
  type SessionState,
  type SessionStateV30,
} from '../schemas.js';
import {
  transitionReceiptV20Schema,
  type PersistedTransitionRecordV11,
  type TransitionReceiptV20,
} from '../protocol-schemas.js';
import {
  canonicalPayloadHash,
  createRequestReceipt,
  transitionReceiptRef,
} from './receipts.js';
import { SessionStore } from '../store.js';
import {
  sha256Digest,
  stableJsonUtf8,
  validatePersistedTransitionRecordV11,
} from '../transition-receipts.js';

type LegacyCommandRun =
  | z.infer<typeof commandRunV1Schema>
  | z.infer<typeof commandRunV11Schema>
  | z.infer<typeof commandRunV12Schema>
  | z.infer<typeof commandRunV13Schema>
  | z.infer<typeof commandRunV14Schema>;
type LegacySession = SessionState | SessionIdentityV20;
type SnapshotKind = 'session' | 'execution' | 'execution-transition' | 'run' | 'gates' | 'artifacts' | 'evidence' | 'retired-state';
type SnapshotParser = (value: unknown) => unknown;

const sha256Schema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const nonEmptyString = z.string().min(1);
const LEGACY_FALLBACK_TIME = '1970-01-01T00:00:00.000Z';
const FALLBACK_ACTOR = 'legacy-migration';

const sourceSnapshotSchema = z.object({
  kind: z.enum([
    'session', 'execution', 'execution-transition', 'run', 'gates', 'artifacts', 'evidence', 'retired-state',
  ]),
  source_id: nonEmptyString,
  sha256: sha256Schema,
  hash_basis: z.enum(['source-bytes', 'canonical-json-v1']),
}).strict();

const discardedPrivateStateSchema = z.object({
  sha256: sha256Schema,
  reason: nonEmptyString,
}).strict();

const retiredExecutionTransitionSchema = z.object({
  source_id: nonEmptyString,
  disposition: z.enum(['projected-v3-receipt', 'retained-read-only']),
  projected_transition_id: nonEmptyString.nullable(),
  projected_activity_revision: z.number().int().positive().nullable(),
  reason: nonEmptyString,
}).strict();

const legacySnapshotManifestSchema = z.object({
  schema_version: z.literal('legacy-v2-snapshot-manifest/1.0'),
  migration_id: nonEmptyString,
  files: z.array(z.object({
    path: nonEmptyString,
    source_sha256: sha256Schema,
    snapshot_sha256: sha256Schema,
  }).strict()),
}).strict();

type LegacySnapshotManifest = z.infer<typeof legacySnapshotManifestSchema>;

export const migrationReportV1Schema = z.object({
  schema_version: z.literal('session-v3-migration-report/1.0'),
  migration_id: nonEmptyString,
  session_id: nonEmptyString,
  source_session_schema: z.enum(['session/1.3', 'session/2.0']),
  source_execution_schema: z.literal('execution/1.0').nullable(),
  source_run_schemas: z.array(z.enum([
    'command-run/1.0', 'command-run/1.1', 'command-run/1.2', 'command-run/1.3', 'command-run/1.4',
  ])),
  target_session_schema: z.literal('session/3.0'),
  target_run_schema: z.literal('run/3.0'),
  recorded_at: nonEmptyString,
  source_status_signal: nonEmptyString,
  target_status: z.enum(['open', 'completed', 'archived', 'failed']),
  hash_scope: z.literal(
    'sha256 of supplied source bytes; otherwise sha256 of stable canonical JSON UTF-8 input',
  ),
  source_snapshots: z.array(sourceSnapshotSchema),
  retired_execution_transitions: z.array(retiredExecutionTransitionSchema),
  discarded_private_state: z.array(discardedPrivateStateSchema),
  references: z.object({
    validated: z.literal(true),
    run_count: z.number().int().nonnegative(),
    chain_step_count: z.number().int().nonnegative(),
    gate_count: z.number().int().nonnegative(),
    artifact_count: z.number().int().nonnegative(),
    evidence_count: z.number().int().nonnegative(),
  }).strict(),
  publication: z.object({
    api: z.literal('SessionStore.withV30Transaction'),
    atomic: z.literal(true),
    dual_write: z.literal(false),
    legacy_execution_storage: z.literal('retained-read-only'),
    legacy_snapshot_root: nonEmptyString,
    legacy_snapshot_manifest_hash: sha256Schema,
  }).strict(),
  target_hashes: z.object({
    session: sha256Schema,
    runs: z.record(z.string(), sha256Schema),
    transition_receipt: sha256Schema,
    legacy_transition_receipts: z.record(z.string(), sha256Schema),
    projection: sha256Schema,
  }).strict(),
}).strict();

export type V3MigrationReport = z.infer<typeof migrationReportV1Schema>;

export interface LegacyMigrationSourceBytes {
  session?: string | Buffer;
  execution?: string | Buffer;
  execution_transitions?: Readonly<Record<string, string | Buffer>>;
  runs?: Readonly<Record<string, string | Buffer>>;
  gates?: string | Buffer;
  artifacts?: string | Buffer;
  evidence?: string | Buffer;
}

export interface RetiredLegacyState {
  source_id: string;
  value: unknown;
  reason: string;
}

export interface LegacyV3MigrationInput {
  session: LegacySession;
  execution?: ExecutionState | null;
  execution_transitions?: readonly PersistedTransitionRecordV11[];
  runs: readonly CommandRunInput[];
  gates: GateRegistry;
  artifacts: ArtifactRegistry;
  evidence: EvidenceStore;
  source_bytes?: LegacyMigrationSourceBytes;
  retired_state?: readonly RetiredLegacyState[];
}

export interface V3MigrationOptions {
  actor_id?: string;
  recorded_at?: string;
  definition_of_done?: string;
  /** Migration audit identity (H3/⑨): a request receipt links the migration
   * transition to the caller's request for replay/idempotency parity with
   * regular v3 mutations. When omitted (e.g. programmatic callers) a
   * synthesized request id is used so the request-receipt chain is always
   * present. */
  request_id?: string;
  reason?: string;
  evidence_refs?: string[];
}

export interface V3MigrationProjection {
  session: SessionStateV30;
  runs: RunV30[];
  transition_receipt: TransitionReceiptV20;
  legacy_transition_receipts: TransitionReceiptV20[];
  report: V3MigrationReport;
}

export interface V3MigrationApplyResult extends V3MigrationProjection {
  status: 'applied' | 'already-applied';
  report_path: string;
}

export type V3MigrationErrorCode =
  | 'MIGRATION_INPUT_INVALID'
  | 'MIGRATION_RUNNING_RUN'
  | 'MIGRATION_REFERENCE_INTEGRITY'
  | 'MIGRATION_SOURCE_CHANGED'
  | 'MIGRATION_CONFLICT';

export class V3MigrationError extends Error {
  constructor(readonly code: V3MigrationErrorCode, message: string) {
    super(message);
    this.name = 'V3MigrationError';
  }
}

/** Ordered mapping table. The first matching signal is authoritative. */
export const V3_MIGRATION_STATUS_MAPPING = Object.freeze([
  { signal: 'session-archived', target: 'archived' },
  // The paused status was retired in the v3 simplification: legacy paused
  // executions/sessions migrate to open (no paused state exists anymore).
  { signal: 'execution-paused', target: 'open' },
  { signal: 'execution-sealed-done', target: 'completed' },
  { signal: 'execution-sealed-done_with_concerns', target: 'completed' },
  { signal: 'execution-sealed-failed', target: 'failed' },
  { signal: 'execution-active', target: 'open' },
  { signal: 'legacy-session-paused', target: 'open' },
  { signal: 'legacy-session-sealed', target: 'completed' },
  { signal: 'legacy-session-failed', target: 'failed' },
  { signal: 'no-execution-or-legacy-running', target: 'open' },
] as const);

interface DiscardAccumulator {
  entries: Array<z.infer<typeof discardedPrivateStateSchema>>;
  privateStrings: Set<string>;
}

interface StatusProjection {
  signal: string;
  status: SessionStateV30['status'];
  finalOutcome: 'done' | 'done_with_concerns' | 'failed' | null;
  sealSummary: string | null;
  terminalAt: string | null;
  archivedAt: string | null;
}

function fail(code: V3MigrationErrorCode, message: string): never {
  throw new V3MigrationError(code, message);
}

function parseLegacySession(input: LegacySession): LegacySession {
  if (input.schema_version === 'session/1.3') return sessionStateV13Schema.parse(input);
  if (input.schema_version === 'session/2.0') return sessionStateV20Schema.parse(input);
  return fail(
    'MIGRATION_INPUT_INVALID',
    `unsupported Session migration source: ${(input as { schema_version?: unknown }).schema_version ?? '<missing>'}`,
  );
}

function parseLegacyRun(input: CommandRunInput): LegacyCommandRun {
  const parsed = commandRunReadSchema.parse(input);
  if (![
    'command-run/1.0', 'command-run/1.1', 'command-run/1.2', 'command-run/1.3', 'command-run/1.4',
  ].includes(parsed.schema_version)) {
    return fail('MIGRATION_INPUT_INVALID', `unsupported Run migration source: ${parsed.schema_version}`);
  }
  return parsed as LegacyCommandRun;
}

function parseExecutionTransition(input: PersistedTransitionRecordV11): PersistedTransitionRecordV11 {
  try {
    return validatePersistedTransitionRecordV11(input);
  } catch (error) {
    return fail(
      'MIGRATION_INPUT_INVALID',
      `invalid Execution transition migration source: ${(error as Error).message}`,
    );
  }
}

function canonicalHash(value: unknown): string {
  return sha256Digest(stableJsonUtf8(value));
}

function sourceBytes(value: string | Buffer): Buffer {
  return Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8');
}

function parseSuppliedBytes(
  raw: string | Buffer,
  parser: SnapshotParser,
  expected: unknown,
  label: string,
): Buffer {
  const source = sourceBytes(raw);
  let parsed: unknown;
  try {
    parsed = parser(JSON.parse(source.toString('utf8')));
  } catch (error) {
    return fail(
      'MIGRATION_INPUT_INVALID',
      `${label} source bytes are not the supplied valid JSON input: ${(error as Error).message}`,
    );
  }
  if (stableJsonUtf8(parsed) !== stableJsonUtf8(expected)) {
    return fail('MIGRATION_INPUT_INVALID', `${label} source bytes do not match the supplied canonical input`);
  }
  return source;
}

interface LegacySnapshotFile {
  path: string;
  raw: string;
  sourceSha256: string;
  snapshotSha256: string;
}

function sanitizeLegacySnapshot(value: unknown, privateStrings: ReadonlySet<string>, key = ''): unknown {
  if (typeof value === 'string') {
    return [...privateStrings].some(secret => secret.length > 0 && value.includes(secret))
      ? '[redacted during session/3.0 migration]'
      : value;
  }
  if (Array.isArray(value)) {
    if (key === 'args') {
      const sanitized: unknown[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const item = value[index];
        if (typeof item === 'string' && PRIVATE_ARG_FLAGS.has(item)) {
          index += 1;
          continue;
        }
        if (typeof item === 'string' && [...PRIVATE_ARG_FLAGS].some(flag => item.startsWith(`${flag}=`))) {
          continue;
        }
        sanitized.push(sanitizeLegacySnapshot(item, privateStrings));
      }
      return sanitized;
    }
    return value.map(item => sanitizeLegacySnapshot(item, privateStrings));
  }
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([childKey]) => !RETIRED_PRIVATE_KEYS.has(childKey)
      && childKey !== 'token'
      && !childKey.endsWith('_private_token'))
    .map(([childKey, child]) => [childKey, sanitizeLegacySnapshot(child, privateStrings, childKey)]));
}

function legacySnapshotFiles(input: {
  session: LegacySession;
  execution: ExecutionState | null;
  executionTransitions: readonly PersistedTransitionRecordV11[];
  runs: readonly LegacyCommandRun[];
  gates: GateRegistry;
  artifacts: ArtifactRegistry;
  evidence: EvidenceStore;
  supplied: LegacyMigrationSourceBytes;
}): LegacySnapshotFile[] {
  const accumulator: DiscardAccumulator = { entries: [], privateStrings: new Set() };
  for (const value of [
    input.session,
    input.execution,
    ...input.executionTransitions,
    ...input.runs,
    input.gates,
    input.artifacts,
    input.evidence,
  ]) {
    rememberPrivateStrings(value, accumulator);
  }
  const file = (path: string, value: unknown, supplied: string | Buffer | undefined) => {
    const raw = `${JSON.stringify(sanitizeLegacySnapshot(value, accumulator.privateStrings), null, 2)}\n`;
    return {
      path,
      raw,
      sourceSha256: supplied === undefined ? canonicalHash(value) : sha256Digest(sourceBytes(supplied)),
      snapshotSha256: sha256Digest(raw),
    };
  };
  const files = [
    file('session.json', input.session, input.supplied.session),
    ...(input.execution ? [file(
      `executions/${input.execution.execution_id}/execution.json`, input.execution, input.supplied.execution,
    )] : []),
    ...(input.execution ? input.executionTransitions.map(transition => file(
      `executions/${input.execution!.execution_id}/transitions/${transition.request_id}.json`,
      transition,
      input.supplied.execution_transitions?.[transition.request_id],
    )) : []),
    ...input.runs.map(run => file(
      `runs/${run.run_id}/run.json`, run, input.supplied.runs?.[run.run_id],
    )),
    file('gates.json', input.gates, input.supplied.gates),
    file('artifacts.json', input.artifacts, input.supplied.artifacts),
    file('evidence.json', input.evidence, input.supplied.evidence),
  ];
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function legacySnapshotManifest(
  migrationId: string,
  files: readonly LegacySnapshotFile[],
): LegacySnapshotManifest {
  return legacySnapshotManifestSchema.parse({
    schema_version: 'legacy-v2-snapshot-manifest/1.0',
    migration_id: migrationId,
    files: files.map(file => ({
      path: file.path,
      source_sha256: file.sourceSha256,
      snapshot_sha256: file.snapshotSha256,
    })),
  });
}

function legacySnapshotRoot(migrationId: string): string {
  return `legacy-v2-snapshot/${migrationId}`;
}

function sourceSnapshot(
  kind: SnapshotKind,
  sourceId: string,
  value: unknown,
  supplied: string | Buffer | undefined,
  parser: SnapshotParser,
): z.infer<typeof sourceSnapshotSchema> {
  if (supplied !== undefined) {
    const source = parseSuppliedBytes(supplied, parser, value, `${kind}:${sourceId}`);
    return { kind, source_id: sourceId, sha256: sha256Digest(source), hash_basis: 'source-bytes' };
  }
  return {
    kind,
    source_id: sourceId,
    sha256: canonicalHash(value),
    hash_basis: 'canonical-json-v1',
  };
}

function rememberPrivateStrings(
  value: unknown,
  accumulator: DiscardAccumulator,
  path: readonly string[] = [],
): void {
  if (typeof value === 'string') {
    const key = path.at(-1) ?? '';
    const isSecret = key === 'token'
      || key === 'lease_id'
      || key === 'handoff_token'
      || key === 'operation_token'
      || key === 'private_token'
      || key.endsWith('_private_token')
      || (key === 'id' && path.includes('lease'));
    if (isSecret && value.length > 0) accumulator.privateStrings.add(value);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((child, index) => rememberPrivateStrings(child, accumulator, [...path, String(index)]));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    rememberPrivateStrings(child, accumulator, [...path, key]);
  }
}

function addDiscard(accumulator: DiscardAccumulator, value: unknown, reason: string): void {
  if (value === null || value === undefined) return;
  const entry = { sha256: canonicalHash(value), reason };
  if (!accumulator.entries.some(candidate => candidate.sha256 === entry.sha256 && candidate.reason === entry.reason)) {
    accumulator.entries.push(entry);
  }
  rememberPrivateStrings(value, accumulator);
}

const RETIRED_PRIVATE_KEYS = new Set([
  'lease', 'lease_claim', 'lease_id', 'heartbeat', 'heartbeat_at', 'handoff_to', 'handoff_token',
  'operation_token', 'private_token', 'pending_retry', 'retry_fence',
]);

function collectEmbeddedPrivateState(value: unknown, accumulator: DiscardAccumulator, context: string): void {
  const visit = (item: unknown): void => {
    if (Array.isArray(item)) {
      item.forEach(visit);
      return;
    }
    if (!item || typeof item !== 'object') return;
    for (const [key, child] of Object.entries(item as Record<string, unknown>)) {
      if (key.endsWith('_hash')) continue;
      const isGenericToken = key === 'token' || key.endsWith('_private_token');
      if (RETIRED_PRIVATE_KEYS.has(key) || isGenericToken) {
        rememberPrivateStrings(child, accumulator, [key]);
        addDiscard(
          accumulator,
          child,
          key === 'lease'
            ? `${context} retired lease/heartbeat/handoff state is invalid after the session/3.0 authority switch`
            : `${context} retired ${key} state is invalid after the session/3.0 authority switch`,
        );
        if (key === 'lease') visit(child);
        continue;
      }
      visit(child);
    }
  };
  visit(value);
}

const PRIVATE_ARG_FLAGS = new Set([
  '--lease-id', '--handoff-token', '--operation-token', '--private-token', '--token',
]);

function sanitizeArgs(
  input: readonly string[],
  accumulator: DiscardAccumulator,
  context: string,
): string[] {
  const result: string[] = [];
  for (let index = 0; index < input.length; index++) {
    const value = input[index];
    const equalsFlag = [...PRIVATE_ARG_FLAGS].find(flag => value.startsWith(`${flag}=`));
    if (equalsFlag) {
      accumulator.privateStrings.add(value.slice(equalsFlag.length + 1));
      addDiscard(accumulator, value, `${context} private command argument is retired during migration`);
      continue;
    }
    if (PRIVATE_ARG_FLAGS.has(value)) {
      const privateValue = input[index + 1];
      if (privateValue !== undefined) accumulator.privateStrings.add(privateValue);
      addDiscard(
        accumulator,
        privateValue === undefined ? value : [value, privateValue],
        `${context} private command argument is retired during migration`,
      );
      if (privateValue !== undefined) index++;
      continue;
    }
    if ([...accumulator.privateStrings].some(secret => value.includes(secret))) {
      addDiscard(accumulator, value, `${context} argument containing retired private state is discarded`);
      continue;
    }
    result.push(value);
  }
  return result;
}

function sanitizeOptionalText(
  value: string | null,
  accumulator: DiscardAccumulator,
  context: string,
): string | null {
  if (value === null) return null;
  const containsPrivateValue = [...accumulator.privateStrings].some(secret => value.includes(secret));
  const containsPrivateFlag = [...PRIVATE_ARG_FLAGS].some(flag => value.includes(flag));
  if (!containsPrivateValue && !containsPrivateFlag) return value;
  addDiscard(accumulator, value, `${context} contained retired private state and was redacted`);
  return '[redacted during session/3.0 migration]';
}

function assertNoPrivateValueLeak(value: unknown, accumulator: DiscardAccumulator): void {
  const serialized = stableJsonUtf8(value);
  const leaked = [...accumulator.privateStrings].find(secret => serialized.includes(secret));
  if (leaked) {
    fail('MIGRATION_INPUT_INVALID', 'retired private state would leak into the session/3.0 projection');
  }
}

function projectStatus(session: LegacySession, execution: ExecutionState | null): StatusProjection {
  const archivedAt = session.schema_version === 'session/2.0'
    ? session.archived_at
    : session.status === 'archived' ? session.lifecycle.sealed_at : null;
  if (archivedAt !== null || (session.schema_version === 'session/1.3' && session.status === 'archived')) {
    return {
      signal: 'session-archived',
      status: 'archived',
      finalOutcome: execution?.final_outcome ?? null,
      sealSummary: execution?.seal_summary
        ?? (session.schema_version === 'session/1.3' ? session.lifecycle.seal_summary : null),
      terminalAt: execution?.sealed_at ?? null,
      archivedAt: archivedAt ?? LEGACY_FALLBACK_TIME,
    };
  }
  if (execution?.status === 'paused') {
    return {
      signal: 'execution-paused', status: 'open', finalOutcome: null, sealSummary: null,
      terminalAt: null, archivedAt: null,
    };
  }
  if (execution?.status === 'sealed') {
    return {
      signal: `execution-sealed-${execution.final_outcome}`,
      status: execution.final_outcome === 'failed' ? 'failed' : 'completed',
      finalOutcome: execution.final_outcome,
      sealSummary: execution.seal_summary,
      terminalAt: execution.sealed_at,
      archivedAt: null,
    };
  }
  if (execution?.status === 'active') {
    return {
      signal: 'execution-active', status: 'open', finalOutcome: null, sealSummary: null,
      terminalAt: null, archivedAt: null,
    };
  }
  if (session.schema_version === 'session/1.3') {
    if (session.status === 'paused') {
      return {
        signal: 'legacy-session-paused', status: 'open', finalOutcome: null, sealSummary: null,
        terminalAt: null, archivedAt: null,
      };
    }
    if (session.status === 'sealed') {
      return {
        signal: 'legacy-session-sealed', status: 'completed', finalOutcome: 'done',
        sealSummary: session.lifecycle.seal_summary,
        terminalAt: session.lifecycle.sealed_at,
        archivedAt: null,
      };
    }
    if (session.status === 'failed') {
      return {
        signal: 'legacy-session-failed', status: 'failed', finalOutcome: 'failed',
        sealSummary: session.lifecycle.seal_summary,
        terminalAt: session.lifecycle.sealed_at,
        archivedAt: null,
      };
    }
  }
  return {
    signal: 'no-execution-or-legacy-running', status: 'open', finalOutcome: null, sealSummary: null,
    terminalAt: null, archivedAt: null,
  };
}

function validateExecutionBinding(session: LegacySession, execution: ExecutionState | null): void {
  if (!execution) {
    if (session.schema_version === 'session/2.0') {
      const executionId = session.current_execution_id ?? session.latest_execution_id;
      if (executionId !== null) {
        fail(
          'MIGRATION_REFERENCE_INTEGRITY',
          `Session ${session.session_id} points to Execution ${executionId}, but no Execution snapshot was supplied`,
        );
      }
    }
    return;
  }
  if (execution.session_id !== session.session_id) {
    fail('MIGRATION_REFERENCE_INTEGRITY', `Execution ${execution.execution_id} belongs to another Session`);
  }
  if (session.schema_version !== 'session/2.0') return;
  const expectedId = session.current_execution_id ?? session.latest_execution_id;
  if (expectedId !== null && execution.execution_id !== expectedId) {
    fail(
      'MIGRATION_REFERENCE_INTEGRITY',
      `supplied Execution ${execution.execution_id} does not match Session pointer ${expectedId}`,
    );
  }
}

function mapRunStatus(status: LegacyCommandRun['status']): RunV30['status'] {
  switch (status) {
    case 'created': return 'pending';
    case 'running': return 'running';
    case 'blocked': return 'blocked';
    case 'completed': return 'completed';
    case 'failed': return 'failed';
    case 'sealed': return 'sealed';
  }
}

function mapStepStatus(
  status: SessionState['orchestration']['chain'][number]['status'],
): SessionStateV30['chain'][number]['status'] {
  return status === 'sealed' ? 'completed' : status;
}

function mapDecisionStatus(
  status: SessionState['orchestration']['decision_points'][number]['status'],
): SessionStateV30['decisions'][number]['status'] {
  if (status === 'pending') return 'open';
  if (status === 'passed') return 'resolved';
  return 'escalated';
}

function mapVerdict(verdict: LegacyCommandRun['output']['verdict']): RunV30['verdict'] {
  if (verdict === null) return null;
  if (verdict === 'ready') return 'done';
  if (verdict === 'ready_with_concerns') return 'done_with_concerns';
  if (verdict === 'blocked') return 'blocked';
  return 'needs_retry';
}

function legacyChain(
  session: LegacySession,
  execution: ExecutionState | null,
): SessionState['orchestration']['chain'] {
  if (execution) return execution.chain;
  return session.schema_version === 'session/1.3' ? session.orchestration.chain : [];
}

function legacyDecisions(
  session: LegacySession,
  execution: ExecutionState | null,
): SessionState['orchestration']['decision_points'] {
  if (execution) return execution.decision_points;
  return session.schema_version === 'session/1.3' ? session.orchestration.decision_points : [];
}

function explicitRunStep(run: LegacyCommandRun): string | null {
  return 'chain_step_id' in run ? run.chain_step_id : null;
}

function retrySource(run: LegacyCommandRun): string | null {
  if (!('creation_decision' in run) || run.creation_decision?.mode !== 'retry') return null;
  if ('creation_provenance' in run && run.creation_provenance.source_run_id) {
    return run.creation_provenance.source_run_id;
  }
  return run.parent_run_id;
}

function assertUnique(values: readonly string[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) fail('MIGRATION_REFERENCE_INTEGRITY', `duplicate ${label}: ${value}`);
    seen.add(value);
  }
}

function referenceExists(ref: string, artifacts: ArtifactRegistry): boolean {
  return ref in artifacts.artifacts
    || (ref in artifacts.aliases && artifacts.aliases[ref] in artifacts.artifacts);
}

function validateReferences(
  session: SessionStateV30,
  runs: readonly RunV30[],
  gates: GateRegistry,
  artifacts: ArtifactRegistry,
  evidence: EvidenceStore,
): void {
  const runIds = new Set(runs.map(run => run.run_id));
  const stepIds = new Set(session.chain.map(step => step.step_id));
  const gateIds = new Set(Object.keys(gates.gates));
  const artifactIds = new Set(Object.keys(artifacts.artifacts));
  const evidenceIds = new Set(Object.keys(evidence.records));
  const requireRef = (present: boolean, label: string): void => {
    if (!present) fail('MIGRATION_REFERENCE_INTEGRITY', `dangling migration reference: ${label}`);
  };
  requireRef(session.artifacts_ref === 'artifacts.json', `Session artifacts registry ${session.artifacts_ref}`);
  requireRef(session.evidence_ref === 'evidence.json', `Session evidence registry ${session.evidence_ref}`);

  for (const step of session.chain) {
    for (const runId of step.run_ids) requireRef(runIds.has(runId), `chain ${step.step_id} -> Run ${runId}`);
    for (const decisionId of step.decision_refs) {
      requireRef(
        session.decisions.some(decision => decision.decision_id === decisionId),
        `chain ${step.step_id} -> decision ${decisionId}`,
      );
    }
  }
  for (const decision of session.decisions) {
    if (decision.after_step_id) {
      requireRef(stepIds.has(decision.after_step_id), `decision ${decision.decision_id} -> step ${decision.after_step_id}`);
    }
    for (const evidenceRef of decision.evidence_refs) {
      requireRef(evidenceIds.has(evidenceRef), `decision ${decision.decision_id} -> evidence ${evidenceRef}`);
    }
  }
  for (const activeRunId of session.active_run_ids) {
    requireRef(runIds.has(activeRunId), `Session active Run ${activeRunId}`);
  }

  for (const run of runs) {
    requireRef(stepIds.has(run.step_id), `Run ${run.run_id} -> step ${run.step_id}`);
    if (run.parent_run_id) {
      requireRef(runIds.has(run.parent_run_id), `Run ${run.run_id} -> parent ${run.parent_run_id}`);
    }
    if (run.retry_of_run_id) {
      requireRef(runIds.has(run.retry_of_run_id), `Run ${run.run_id} -> retry source ${run.retry_of_run_id}`);
    }
    for (const ref of [...run.input_refs, ...run.output_refs]) {
      requireRef(referenceExists(ref, artifacts), `Run ${run.run_id} -> artifact ${ref}`);
    }
    if (run.primary_artifact_id) {
      requireRef(
        referenceExists(run.primary_artifact_id, artifacts),
        `Run ${run.run_id} -> primary artifact ${run.primary_artifact_id}`,
      );
    }
  }

  for (const [gateId, gate] of Object.entries(gates.gates)) {
    // The registry key is the gate ID; `gate.key` is a display name that v2
    // data legitimately writes differently (e.g. registry key GATE-001-01
    // with key "produce-artifact"). Requiring equality rejects real legacy
    // gates, so only the registry presence is asserted here.
    void gate.key;
    if (gate.run_id) requireRef(runIds.has(gate.run_id), `gate ${gateId} -> Run ${gate.run_id}`);
    for (const evidenceRef of gate.evidence_refs) {
      requireRef(evidenceIds.has(evidenceRef), `gate ${gateId} -> evidence ${evidenceRef}`);
    }
    if (gate.check.type === 'schema') {
      requireRef(
        referenceExists(gate.check.artifact_ref, artifacts),
        `gate ${gateId} -> schema artifact ${gate.check.artifact_ref}`,
      );
    }
  }
  for (const gateId of gates.summary.active_gate_ids) {
    requireRef(gateIds.has(gateId), `gate summary -> gate ${gateId}`);
  }
  if (gates.summary.blocking_run_id) {
    requireRef(runIds.has(gates.summary.blocking_run_id), `gate summary -> Run ${gates.summary.blocking_run_id}`);
  }

  for (const [artifactId, artifact] of Object.entries(artifacts.artifacts)) {
    requireRef(runIds.has(artifact.producer_run_id), `artifact ${artifactId} -> producer Run ${artifact.producer_run_id}`);
    for (const sourceId of artifact.derived_from) {
      requireRef(artifactIds.has(sourceId), `artifact ${artifactId} -> source artifact ${sourceId}`);
    }
    if (artifact.replaces) {
      requireRef(artifactIds.has(artifact.replaces), `artifact ${artifactId} -> replaced artifact ${artifact.replaces}`);
    }
  }
  for (const [alias, artifactId] of Object.entries(artifacts.aliases)) {
    requireRef(artifactIds.has(artifactId), `artifact alias ${alias} -> ${artifactId}`);
  }

  for (const [evidenceId, record] of Object.entries(evidence.records)) {
    requireRef(runIds.has(record.run_id), `evidence ${evidenceId} -> Run ${record.run_id}`);
    for (const artifactRef of record.artifact_refs) {
      requireRef(referenceExists(artifactRef, artifacts), `evidence ${evidenceId} -> artifact ${artifactRef}`);
    }
    for (const gateRef of record.gate_refs) {
      requireRef(gateIds.has(gateRef), `evidence ${evidenceId} -> gate ${gateRef}`);
    }
  }
}

function latestTimestamp(values: Array<string | null | undefined>, fallback: string): string {
  const present = values.filter((value): value is string => typeof value === 'string' && value.length > 0).sort();
  return present.at(-1) ?? fallback;
}

function earliestTimestamp(values: Array<string | null | undefined>, fallback: string): string {
  const present = values.filter((value): value is string => typeof value === 'string' && value.length > 0).sort();
  return present[0] ?? fallback;
}

/** Pure, deterministic projection. It performs no filesystem writes or clock reads. */
export function projectLegacySessionToV30(
  rawInput: LegacyV3MigrationInput,
  options: V3MigrationOptions = {},
): V3MigrationProjection {
  const session = parseLegacySession(rawInput.session);
  const execution = rawInput.execution == null ? null : executionStateSchema.parse(rawInput.execution);
  const executionTransitions = (rawInput.execution_transitions ?? []).map(parseExecutionTransition);
  const legacyRuns = rawInput.runs.map(parseLegacyRun);
  const gates = gateRegistrySchema.parse(rawInput.gates);
  const artifacts = artifactRegistrySchema.parse(rawInput.artifacts);
  const evidence = evidenceStoreSchema.parse(rawInput.evidence);
  const retiredState = rawInput.retired_state ?? [];
  validateExecutionBinding(session, execution);
  if (executionTransitions.length > 0 && !execution) {
    fail('MIGRATION_REFERENCE_INTEGRITY', 'Execution transitions were supplied without an Execution snapshot');
  }
  assertUnique(executionTransitions.map(transition => transition.request_id), 'Execution transition request ID');
  assertUnique(executionTransitions.map(transition => transition.outcome.transition_id), 'Execution transition ID');
  for (const transition of executionTransitions) {
    const subject = transition.payload.subject;
    if (subject.session_id !== session.session_id
      || subject.execution_id !== execution!.execution_id
      || subject.generation !== execution!.generation) {
      fail(
        'MIGRATION_REFERENCE_INTEGRITY',
        `Execution transition ${transition.request_id} does not bind selected Execution ${execution!.execution_id}`,
      );
    }
  }

  assertUnique(legacyRuns.map(run => run.run_id), 'Run ID');
  for (const run of legacyRuns) {
    if (run.session_id !== session.session_id) {
      fail('MIGRATION_REFERENCE_INTEGRITY', `Run ${run.run_id} belongs to another Session`);
    }
    if (run.schema_version === 'command-run/1.4') {
      if (!execution) {
        fail(
          'MIGRATION_REFERENCE_INTEGRITY',
          `Run ${run.run_id} is bound to Execution ${run.execution_id}, but no Execution snapshot was supplied`,
        );
      }
      // Historical-generation Runs (bound to a sealed Execution that is not
      // the selected one) migrate read-only: their bytes are still verified
      // against the source snapshot, but their Execution binding is not
      // asserted against the selected Execution. Only Runs bound to the
      // selected Execution must match its identity/generation exactly.
      if (run.execution_id === execution!.execution_id) {
        if (run.generation !== execution!.generation) {
          fail(
            'MIGRATION_REFERENCE_INTEGRITY',
            `Run ${run.run_id} Execution binding does not match ${execution!.execution_id} generation ${execution!.generation}`,
          );
        }
      } else if (run.generation >= execution!.generation) {
        fail(
          'MIGRATION_REFERENCE_INTEGRITY',
          `Run ${run.run_id} references Execution ${run.execution_id} generation ${run.generation} newer than the selected ${execution!.execution_id} generation ${execution!.generation}`,
        );
      }
    }
    if (run.handoff && run.handoff.producer_run_id !== run.run_id) {
      fail(
        'MIGRATION_REFERENCE_INTEGRITY',
        `Run ${run.run_id} handoff belongs to Run ${run.handoff.producer_run_id}`,
      );
    }
    // A running Run migrates as running: the v3 projection keeps the Run and
    // its chain step in the running state so the migrated Session can be
    // completed through the v3 surface (run complete --advance). Rejecting it
    // here created a deadlock under the v3 default writer: `session migrate`
    // demanded the Run be completed first, while the v3 command surface
    // refused to touch the legacy Run (SESSION_INACCESSIBLE).
  }

  const sourceChain = legacyChain(session, execution);
  const sourceDecisions = legacyDecisions(session, execution);
  assertUnique(sourceChain.map(step => step.step_id), 'chain step ID');
  assertUnique(sourceDecisions.map(decision => decision.point_id), 'decision ID');

  const runById = new Map(legacyRuns.map(run => [run.run_id, run]));
  for (const step of sourceChain) {
    if (step.run_id !== null && !runById.has(step.run_id)) {
      fail('MIGRATION_REFERENCE_INTEGRITY', `chain step ${step.step_id} references missing Run ${step.run_id}`);
    }
    // An orphaned running step (no Run snapshot) is projected to pending
    // instead of being rejected — rejecting it deadlocked under the v3 default
    // writer where no command can repair the legacy step.
  }
  const sourceStepIds = new Set(sourceChain.map(step => step.step_id));
  const stepForRun = new Map<string, string>();
  for (const run of legacyRuns) {
    const explicit = explicitRunStep(run);
    if (explicit !== null) {
      if (!sourceStepIds.has(explicit) && sourceChain.length > 0) {
        fail('MIGRATION_REFERENCE_INTEGRITY', `Run ${run.run_id} references missing chain step ${explicit}`);
      }
      stepForRun.set(run.run_id, explicit);
      continue;
    }
    const owner = sourceChain.find(step => step.run_id === run.run_id);
    stepForRun.set(run.run_id, owner?.step_id ?? `legacy-run-${run.run_id}`);
  }

  const discard: DiscardAccumulator = { entries: [], privateStrings: new Set() };
  collectEmbeddedPrivateState(session, discard, 'legacy Session');
  if (execution) collectEmbeddedPrivateState(execution, discard, 'legacy Execution');
  executionTransitions.forEach(transition => collectEmbeddedPrivateState(
    transition,
    discard,
    `legacy Execution transition ${transition.request_id}`,
  ));
  legacyRuns.forEach(run => collectEmbeddedPrivateState(run, discard, `legacy Run ${run.run_id}`));
  for (const item of retiredState) {
    if (!item.source_id || !item.reason) {
      fail('MIGRATION_INPUT_INVALID', 'retired_state entries require source_id and reason');
    }
    addDiscard(discard, item.value, item.reason);
  }

  const retryOf = new Map(legacyRuns.map(run => [run.run_id, retrySource(run)]));
  const attempts = new Map<string, number>();
  const attemptFor = (runId: string, visiting = new Set<string>()): number => {
    const known = attempts.get(runId);
    if (known !== undefined) return known;
    if (visiting.has(runId)) fail('MIGRATION_REFERENCE_INTEGRITY', `retry lineage cycle at Run ${runId}`);
    const sourceId = retryOf.get(runId) ?? null;
    if (sourceId === null) {
      attempts.set(runId, 1);
      return 1;
    }
    if (!runById.has(sourceId)) {
      fail('MIGRATION_REFERENCE_INTEGRITY', `Run ${runId} retries missing Run ${sourceId}`);
    }
    visiting.add(runId);
    const attempt = attemptFor(sourceId, visiting) + 1;
    visiting.delete(runId);
    attempts.set(runId, attempt);
    return attempt;
  };

  const actorId = options.actor_id?.trim() || FALLBACK_ACTOR;
  const projectedRuns = legacyRuns.map((run): RunV30 => {
    if (run.parent_run_id !== null && !runById.has(run.parent_run_id)) {
      fail('MIGRATION_REFERENCE_INTEGRITY', `Run ${run.run_id} references missing parent Run ${run.parent_run_id}`);
    }
    const stepId = stepForRun.get(run.run_id)!;
    const sourceStep = sourceChain.find(step => step.step_id === stepId);
    const outputRefs = [...new Set([
      ...run.output.produces,
      ...(run.handoff?.artifact_refs ?? []),
    ])];
    const legacyGeneration = run.schema_version === 'command-run/1.4'
      ? run.generation
      : execution?.generation ?? null;
    const goal = ('goal_binding' in run ? run.goal_binding?.step_goal_ref : null)
      ?? sourceStep?.goal_ref
      ?? null;
    return runV30Schema.parse({
      schema_version: 'run/3.0',
      run_id: run.run_id,
      session_id: session.session_id,
      step_id: stepId,
      parent_run_id: run.parent_run_id,
      retry_of_run_id: retryOf.get(run.run_id) ?? null,
      attempt: attemptFor(run.run_id),
      command: run.command.name,
      args: sanitizeArgs(run.input.args, discard, `legacy Run ${run.run_id}`),
      goal,
      status: mapRunStatus(run.status),
      revision: 0,
      actor_id: actorId,
      input_refs: [...run.input.consumes],
      output_refs: outputRefs,
      primary_artifact_id: run.output.primary_artifact_id,
      verdict: mapVerdict(run.output.verdict),
      summary: sanitizeOptionalText(
        run.handoff?.summary ?? null,
        discard,
        `legacy Run ${run.run_id} summary`,
      ),
      legacy_execution_generation: legacyGeneration,
      created_at: run.started_at,
      started_at: run.status === 'created' ? null : run.started_at,
      ended_at: run.completed_at,
      sealed_at: run.sealed_at,
    });
  });

  const runsByStep = new Map<string, LegacyCommandRun[]>();
  for (const run of legacyRuns) {
    const stepId = stepForRun.get(run.run_id)!;
    const current = runsByStep.get(stepId) ?? [];
    current.push(run);
    runsByStep.set(stepId, current);
  }
  const decisionRefsForStep = (stepId: string, explicit: string | null): string[] => [...new Set([
    ...(explicit ? [explicit] : []),
    ...sourceDecisions.filter(decision => decision.after_step_id === stepId).map(decision => decision.point_id),
  ])];
  const projectedChain: SessionStateV30['chain'] = sourceChain.map(step => {
    const matchingRuns = (runsByStep.get(step.step_id) ?? [])
      .sort((left, right) => left.sequence - right.sequence || left.run_id.localeCompare(right.run_id));
    const fallbackArgs = matchingRuns[0]?.input.args ?? [];
    const sanitizedStepArgs = step.args === undefined
      ? sanitizeArgs(fallbackArgs, discard, `chain step ${step.step_id}`)
      : sanitizeOptionalText(step.args, discard, `chain step ${step.step_id} args`);
    // A running/failed step WITHOUT a Run snapshot is an orphaned legacy
    // marker (non-atomic crash residue). It must not block the migration:
    // project it to pending so the v3 surface can re-dispatch it (run next).
    const stepStatus = (step.status === 'running' || step.status === 'failed')
      && step.run_id === null
      && matchingRuns.length === 0
      ? 'pending' as const
      : mapStepStatus(step.status);
    return {
      step_id: step.step_id,
      command: step.command,
      args: step.args === undefined
        ? sanitizedStepArgs as string[]
        : sanitizedStepArgs === step.args ? [step.args] : [],
      status: stepStatus,
      run_ids: matchingRuns.map(run => run.run_id),
      goal_ref: step.goal_ref ?? null,
      decision_ref: null,
      decision_refs: decisionRefsForStep(step.step_id, step.decision_ref),
    };
  });
  for (const [stepId, matchingRuns] of [...runsByStep.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    if (sourceStepIds.has(stepId)) continue;
    const sortedRuns = matchingRuns.sort(
      (left, right) => left.sequence - right.sequence || left.run_id.localeCompare(right.run_id),
    );
    const first = projectedRuns.find(run => run.run_id === sortedRuns[0].run_id)!;
    const stepStatus: SessionStateV30['chain'][number]['status'] = first.status === 'failed'
      ? 'failed'
      : first.status === 'pending'
        ? 'pending'
        : first.status === 'blocked' || first.status === 'running'
          ? 'running'
          : 'completed';
    projectedChain.push({
      step_id: stepId,
      command: first.command,
      args: [...first.args],
      status: stepStatus,
      run_ids: sortedRuns.map(run => run.run_id),
      goal_ref: first.goal,
      decision_ref: null,
      decision_refs: [],
    });
  }

  const projectedDecisions: SessionStateV30['decisions'] = sourceDecisions.map(decision => ({
    decision_id: decision.point_id,
    after_step_id: decision.after_step_id,
    status: mapDecisionStatus(decision.status),
    evidence_refs: decision.evidence_ref ? [decision.evidence_ref] : [],
  }));

  const status = projectStatus(session, execution);
  status.sealSummary = sanitizeOptionalText(status.sealSummary, discard, 'legacy seal summary');
  const recordedAt = options.recorded_at?.trim()
    || status.archivedAt
    || status.terminalAt
    || execution?.started_at
    || legacyRuns[0]?.started_at
    || LEGACY_FALLBACK_TIME;
  const sourceIdentityRevision = session.identity_revision;
  const sourceActivityRevision = session.activity_revision;
  const createdAt = earliestTimestamp([
    execution?.started_at,
    ...legacyRuns.map(run => run.started_at),
    recordedAt,
  ], recordedAt);
  const updatedAt = latestTimestamp([
    status.archivedAt,
    status.terminalAt,
    execution?.sealed_at,
    ...legacyRuns.flatMap(run => [run.completed_at, run.sealed_at]),
    recordedAt,
  ], recordedAt);
  const activeRunIds = projectedRuns
    .filter(run => run.status === 'running' || run.status === 'blocked')
    .map(run => run.run_id)
    .sort();
  const sourceActiveRunId = execution?.active_run_id
    ?? (session.schema_version === 'session/1.3' ? session.active_run_id : null);
  const latestCompletedRunId = session.latest_completed_run_id;
  if (latestCompletedRunId !== null && !projectedRuns.some(run => run.run_id === latestCompletedRunId)) {
    fail('MIGRATION_REFERENCE_INTEGRITY', `latest completed Run pointer references missing Run ${latestCompletedRunId}`);
  }
  if (sourceActiveRunId !== null && !projectedRuns.some(run => run.run_id === sourceActiveRunId)) {
    fail('MIGRATION_REFERENCE_INTEGRITY', `active Run pointer references missing Run ${sourceActiveRunId}`);
  }

  const projectedSession = sessionStateV30Schema.parse({
    schema_version: 'session/3.0',
    session_id: session.session_id,
    objective: session.intent,
    definition_of_done: session.schema_version === 'session/1.3'
      ? session.boundary_contract.definition_of_done
      : options.definition_of_done ?? '',
    status: status.status,
    orchestration_revision: execution?.revision
      ?? (session.schema_version === 'session/1.3' ? session.activity_revision : 0),
    activity_revision: sourceActivityRevision + 1,
    chain: projectedChain,
    decisions: projectedDecisions,
    active_run_ids: activeRunIds,
    artifacts_ref: execution?.artifacts_ref
      ?? (session.schema_version === 'session/1.3' ? session.refs.artifacts : 'artifacts.json'),
    evidence_ref: execution?.evidence_ref
      ?? (session.schema_version === 'session/1.3' ? session.refs.evidence : 'evidence.json'),
    created_at: createdAt,
    updated_at: updatedAt,
    completed_at: status.status === 'completed' || status.status === 'failed'
      ? status.terminalAt ?? recordedAt
      : null,
    archived_at: status.status === 'archived' ? status.archivedAt ?? recordedAt : null,
  });

  validateReferences(projectedSession, projectedRuns, gates, artifacts, evidence);

  const supplied = rawInput.source_bytes ?? {};
  const suppliedExecutionTransitionBytes = supplied.execution_transitions ?? {};
  const executionTransitionByRequest = new Map(
    executionTransitions.map(transition => [transition.request_id, transition]),
  );
  const unknownExecutionTransitionBytes = Object.keys(suppliedExecutionTransitionBytes)
    .filter(requestId => !executionTransitionByRequest.has(requestId));
  if (unknownExecutionTransitionBytes.length > 0) {
    fail(
      'MIGRATION_INPUT_INVALID',
      `source_bytes contains unknown Execution transitions: ${unknownExecutionTransitionBytes.sort().join(', ')}`,
    );
  }
  const suppliedRunBytes = supplied.runs ?? {};
  const unknownRunBytes = Object.keys(suppliedRunBytes).filter(runId => !runById.has(runId));
  if (unknownRunBytes.length > 0) {
    fail('MIGRATION_INPUT_INVALID', `source_bytes contains unknown Runs: ${unknownRunBytes.sort().join(', ')}`);
  }
  const snapshots = [
    sourceSnapshot(
      'session',
      session.session_id,
      session,
      supplied.session,
      value => parseLegacySession(value as LegacySession),
    ),
    ...(execution ? [sourceSnapshot(
      'execution',
      execution.execution_id,
      execution,
      supplied.execution,
      value => executionStateSchema.parse(value),
    )] : []),
    ...executionTransitions
      .slice()
      .sort((left, right) => left.request_id.localeCompare(right.request_id))
      .map(transition => sourceSnapshot(
        'execution-transition',
        transition.request_id,
        transition,
        suppliedExecutionTransitionBytes[transition.request_id],
        value => parseExecutionTransition(value as PersistedTransitionRecordV11),
      )),
    ...legacyRuns
      .slice()
      .sort((left, right) => left.run_id.localeCompare(right.run_id))
      .map(run => sourceSnapshot(
        'run',
        run.run_id,
        run,
        suppliedRunBytes[run.run_id],
        value => parseLegacyRun(value as CommandRunInput),
      )),
    sourceSnapshot(
      'gates', 'gates.json', gates, supplied.gates, value => gateRegistrySchema.parse(value),
    ),
    sourceSnapshot(
      'artifacts', 'artifacts.json', artifacts, supplied.artifacts, value => artifactRegistrySchema.parse(value),
    ),
    sourceSnapshot(
      'evidence', 'evidence.json', evidence, supplied.evidence, value => evidenceStoreSchema.parse(value),
    ),
    ...retiredState
      .slice()
      .sort((left, right) => left.source_id.localeCompare(right.source_id))
      .map(item => sourceSnapshot('retired-state', item.source_id, item.value, undefined, value => value)),
  ];
  const sourceSetHash = canonicalHash(snapshots);
  const migrationId = `migration-${sourceSetHash.slice('sha256:'.length, 'sha256:'.length + 24)}`;
  const snapshotFiles = legacySnapshotFiles({
    session,
    execution,
    executionTransitions,
    runs: legacyRuns,
    gates,
    artifacts,
    evidence,
    supplied,
  });
  const snapshotManifest = legacySnapshotManifest(migrationId, snapshotFiles);
  const transitionSnapshotByRequest = new Map(snapshots
    .filter(snapshot => snapshot.kind === 'execution-transition')
    .map(snapshot => [snapshot.source_id, snapshot]));
  const projectedLegacyTransitions = new Map<string, TransitionReceiptV20>();
  for (const transition of executionTransitions) {
    const before = transition.payload.preconditions.execution_revision;
    const after = transition.outcome.postconditions.execution_revision;
    const revisionBefore = before ?? (transition.payload.operation === 'execution-start' && after === 1 ? 0 : null);
    const activityRevision = transition.outcome.postconditions.session_activity_revision;
    if (transition.status !== 'applied'
      || revisionBefore === null
      || after === null
      || after !== revisionBefore + 1
      || activityRevision <= 0) {
      continue;
    }
    const sourceSnapshotHash = transitionSnapshotByRequest.get(transition.request_id)!.sha256;
    const sourceActor = transition.payload.payload.actor;
    const actorCandidate = typeof sourceActor === 'string' ? sourceActor.trim() : '';
    const actor = actorCandidate.length > 0
      && ![...discard.privateStrings].some(secret => actorCandidate.includes(secret))
      ? actorCandidate
      : FALLBACK_ACTOR;
    projectedLegacyTransitions.set(transition.request_id, transitionReceiptV20Schema.parse({
      schema_version: 'transition-receipt/2.0',
      transition_id: transition.outcome.transition_id,
      request_id: transition.request_id,
      session_id: session.session_id,
      activity_revision: activityRevision,
      target_type: 'orchestration',
      target_id: session.session_id,
      revision_before: revisionBefore,
      revision_after: after,
      actor_id: actor,
      participant_id: actor,
      reason: `Migrated legacy Execution ${transition.payload.operation} transition`,
      evidence_refs: [`migration-source:${sourceSnapshotHash}`],
      recorded_at: transition.outcome.applied_at,
      result: {
        operation: 'migrate-legacy-execution-transition',
        legacy_operation: transition.payload.operation,
        legacy_execution_id: execution!.execution_id,
        legacy_execution_generation: execution!.generation,
        legacy_request_hash: transition.payload.normalized_request_hash,
        legacy_result_hash: transition.outcome.result_hash,
        source_snapshot_hash: sourceSnapshotHash,
      },
    }));
  }
  const legacyTransitionReceipts = [...projectedLegacyTransitions.values()].sort(
    (left, right) => left.activity_revision - right.activity_revision
      || left.transition_id.localeCompare(right.transition_id),
  );
  const retiredExecutionTransitions = executionTransitions
    .slice()
    .sort((left, right) => left.request_id.localeCompare(right.request_id))
    .map(transition => {
      const projected = projectedLegacyTransitions.get(transition.request_id) ?? null;
      return {
        source_id: transition.request_id,
        disposition: projected ? 'projected-v3-receipt' as const : 'retained-read-only' as const,
        projected_transition_id: projected?.transition_id ?? null,
        projected_activity_revision: projected?.activity_revision ?? null,
        reason: projected
          ? 'legacy Execution transition projected without private lease or handoff credentials'
          : 'legacy Execution transition is source-covered but cannot safely represent an applied v3 revision transition',
      };
    });
  const receipt = transitionReceiptV20Schema.parse({
    schema_version: 'transition-receipt/2.0',
    transition_id: migrationId,
    request_id: migrationId,
    session_id: session.session_id,
    activity_revision: projectedSession.activity_revision,
    target_type: 'session-identity',
    target_id: session.session_id,
    revision_before: sourceIdentityRevision,
    revision_after: sourceIdentityRevision + 1,
    actor_id: actorId,
    participant_id: actorId,
    reason: 'Legacy Session/Execution authority projected to session/3.0',
    evidence_refs: snapshots.map(snapshot => `migration-source:${snapshot.sha256}`),
    recorded_at: recordedAt,
    result: {
      operation: 'migrate-to-v3',
      migration_id: migrationId,
      source_session_schema: session.schema_version,
      source_execution_schema: execution?.schema_version ?? null,
      source_status_signal: status.signal,
      target_status: status.status,
      final_outcome: status.finalOutcome,
      seal_summary: status.sealSummary,
    },
  });
  const targetSessionHash = canonicalHash(projectedSession);
  const targetRunHashes = Object.fromEntries(
    projectedRuns
      .slice()
      .sort((left, right) => left.run_id.localeCompare(right.run_id))
      .map(run => [run.run_id, canonicalHash(run)]),
  );
  const receiptHash = canonicalHash(receipt);
  const legacyTransitionReceiptHashes = Object.fromEntries(
    legacyTransitionReceipts.map(legacyReceipt => [
      legacyReceipt.transition_id,
      canonicalHash(legacyReceipt),
    ]),
  );
  const projectionHash = canonicalHash({
    session: targetSessionHash,
    runs: targetRunHashes,
    transition_receipt: receiptHash,
    legacy_transition_receipts: legacyTransitionReceiptHashes,
  });
  discard.entries.sort(
    (left, right) => left.sha256.localeCompare(right.sha256) || left.reason.localeCompare(right.reason),
  );
  const report = migrationReportV1Schema.parse({
    schema_version: 'session-v3-migration-report/1.0',
    migration_id: migrationId,
    session_id: session.session_id,
    source_session_schema: session.schema_version,
    source_execution_schema: execution?.schema_version ?? null,
    source_run_schemas: legacyRuns.map(run => run.schema_version).sort(),
    target_session_schema: 'session/3.0',
    target_run_schema: 'run/3.0',
    recorded_at: recordedAt,
    source_status_signal: status.signal,
    target_status: status.status,
    hash_scope: 'sha256 of supplied source bytes; otherwise sha256 of stable canonical JSON UTF-8 input',
    source_snapshots: snapshots,
    retired_execution_transitions: retiredExecutionTransitions,
    discarded_private_state: discard.entries,
    references: {
      validated: true,
      run_count: projectedRuns.length,
      chain_step_count: projectedSession.chain.length,
      gate_count: Object.keys(gates.gates).length,
      artifact_count: Object.keys(artifacts.artifacts).length,
      evidence_count: Object.keys(evidence.records).length,
    },
    publication: {
      api: 'SessionStore.withV30Transaction',
      atomic: true,
      dual_write: false,
      legacy_execution_storage: 'retained-read-only',
      legacy_snapshot_root: legacySnapshotRoot(migrationId),
      legacy_snapshot_manifest_hash: canonicalHash(snapshotManifest),
    },
    target_hashes: {
      session: targetSessionHash,
      runs: targetRunHashes,
      transition_receipt: receiptHash,
      legacy_transition_receipts: legacyTransitionReceiptHashes,
      projection: projectionHash,
    },
  });

  assertNoPrivateValueLeak({
    session: projectedSession,
    runs: projectedRuns,
    receipts: [...legacyTransitionReceipts, receipt],
    report,
  }, discard);
  return {
    session: projectedSession,
    runs: projectedRuns,
    transition_receipt: receipt,
    legacy_transition_receipts: legacyTransitionReceipts,
    report,
  };
}

export function v3MigrationReportPath(store: SessionStore, sessionId: string): string {
  return join(store.sessionDir(sessionId), 'v3-migration-report.json');
}

function snapshotRootPath(store: SessionStore, sessionId: string, report: V3MigrationReport): string {
  return join(store.sessionDir(sessionId), report.publication.legacy_snapshot_root);
}

function verifyLegacySnapshot(store: SessionStore, report: V3MigrationReport): void {
  const root = snapshotRootPath(store, report.session_id, report);
  const manifestPath = join(root, 'manifest.json');
  if (!existsSync(manifestPath)) fail('MIGRATION_CONFLICT', 'legacy migration snapshot manifest is missing');
  const manifest = store.readJsonFileReadOnly(manifestPath, legacySnapshotManifestSchema);
  if (manifest.migration_id !== report.migration_id
    || canonicalHash(manifest) !== report.publication.legacy_snapshot_manifest_hash) {
    fail('MIGRATION_CONFLICT', 'legacy migration snapshot manifest changed');
  }
  for (const file of manifest.files) {
    const path = join(root, file.path);
    if (!existsSync(path) || sha256Digest(readFileSync(path)) !== file.snapshot_sha256) {
      fail('MIGRATION_CONFLICT', `legacy migration snapshot changed: ${file.path}`);
    }
  }
}

function findSnapshot(
  report: V3MigrationReport,
  kind: SnapshotKind,
  sourceId: string,
): z.infer<typeof sourceSnapshotSchema> {
  const snapshot = report.source_snapshots.find(item => item.kind === kind && item.source_id === sourceId);
  if (!snapshot) {
    fail('MIGRATION_SOURCE_CHANGED', `migration report is missing source snapshot ${kind}:${sourceId}`);
  }
  return snapshot;
}

function verifySourceFile(
  path: string,
  snapshot: z.infer<typeof sourceSnapshotSchema>,
  expected: unknown,
  parser: SnapshotParser,
): void {
  if (!existsSync(path)) fail('MIGRATION_SOURCE_CHANGED', `migration source disappeared: ${path}`);
  const raw = readFileSync(path);
  let parsed: unknown;
  try {
    parsed = parser(JSON.parse(raw.toString('utf8')));
  } catch (error) {
    fail(
      'MIGRATION_SOURCE_CHANGED',
      `migration source is no longer valid at ${path}: ${(error as Error).message}`,
    );
  }
  if (stableJsonUtf8(parsed) !== stableJsonUtf8(expected)) {
    fail('MIGRATION_SOURCE_CHANGED', `migration source changed before publication: ${path}`);
  }
  const actualHash = snapshot.hash_basis === 'source-bytes' ? sha256Digest(raw) : canonicalHash(parsed);
  if (actualHash !== snapshot.sha256) {
    fail('MIGRATION_SOURCE_CHANGED', `migration source hash changed before publication: ${path}`);
  }
}

function storedRunIds(store: SessionStore, sessionId: string): string[] {
  const root = join(store.sessionDir(sessionId), 'runs');
  if (!existsSync(root)) return [];
  const ids: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isSymbolicLink() || !entry.isDirectory() || lstatSync(path).isSymbolicLink()) {
      fail('MIGRATION_SOURCE_CHANGED', `invalid Run storage entry during migration: ${path}`);
    }
    if (existsSync(join(path, 'run.json'))) ids.push(entry.name);
  }
  return ids.sort();
}

function assertSameValue(actual: unknown, expected: unknown, label: string): void {
  if (stableJsonUtf8(actual) !== stableJsonUtf8(expected)) {
    fail('MIGRATION_CONFLICT', `${label} differs from the requested v3 migration projection`);
  }
}

function verifyLegacySources(
  store: SessionStore,
  input: LegacyV3MigrationInput,
  projection: V3MigrationProjection,
): void {
  const session = parseLegacySession(input.session);
  const execution = input.execution == null ? null : executionStateSchema.parse(input.execution);
  const executionTransitions = (input.execution_transitions ?? []).map(parseExecutionTransition);
  const runs = input.runs.map(parseLegacyRun);
  const gates = gateRegistrySchema.parse(input.gates);
  const artifacts = artifactRegistrySchema.parse(input.artifacts);
  const evidence = evidenceStoreSchema.parse(input.evidence);
  const report = projection.report;
  verifySourceFile(
    join(store.sessionDir(session.session_id), 'session.json'),
    findSnapshot(report, 'session', session.session_id),
    session,
    value => parseLegacySession(value as LegacySession),
  );
  if (execution) {
    verifySourceFile(
      store.executionPath(session.session_id, execution.execution_id),
      findSnapshot(report, 'execution', execution.execution_id),
      execution,
      value => executionStateSchema.parse(value),
    );
    const storedTransitions = store.listExecutionTransitions(session.session_id, execution.execution_id);
    assertSameValue(
      storedTransitions.map(transition => transition.request_id).sort(),
      executionTransitions.map(transition => transition.request_id).sort(),
      'complete Execution transition source set',
    );
    for (const transition of executionTransitions) {
      verifySourceFile(
        store.executionTransitionPath(session.session_id, execution.execution_id, transition.request_id),
        findSnapshot(report, 'execution-transition', transition.request_id),
        transition,
        value => parseExecutionTransition(value as PersistedTransitionRecordV11),
      );
    }
  }
  const expectedRunIds = runs.map(run => run.run_id).sort();
  if (stableJsonUtf8(storedRunIds(store, session.session_id)) !== stableJsonUtf8(expectedRunIds)) {
    fail('MIGRATION_SOURCE_CHANGED', 'stored Run set differs from the complete migration input');
  }
  for (const run of runs) {
    verifySourceFile(
      join(store.runDir(session.session_id, run.run_id), 'run.json'),
      findSnapshot(report, 'run', run.run_id),
      run,
      value => parseLegacyRun(value as CommandRunInput),
    );
  }
  verifySourceFile(
    join(store.sessionDir(session.session_id), 'gates.json'),
    findSnapshot(report, 'gates', 'gates.json'),
    gates,
    value => gateRegistrySchema.parse(value),
  );
  verifySourceFile(
    join(store.sessionDir(session.session_id), 'artifacts.json'),
    findSnapshot(report, 'artifacts', 'artifacts.json'),
    artifacts,
    value => artifactRegistrySchema.parse(value),
  );
  verifySourceFile(
    join(store.sessionDir(session.session_id), 'evidence.json'),
    findSnapshot(report, 'evidence', 'evidence.json'),
    evidence,
    value => evidenceStoreSchema.parse(value),
  );
}

function verifyAppliedProjection(store: SessionStore, projection: V3MigrationProjection): void {
  const sessionId = projection.session.session_id;
  const reportPath = v3MigrationReportPath(store, sessionId);
  if (!existsSync(reportPath)) {
    fail('MIGRATION_CONFLICT', 'session/3.0 exists without its migration report');
  }
  const storedReport = migrationReportV1Schema.parse(JSON.parse(readFileSync(reportPath, 'utf8')));
  assertSameValue(storedReport, projection.report, 'migration report');
  verifyLegacySnapshot(store, storedReport);
  assertSameValue(store.readSessionV30(sessionId), projection.session, 'Session');
  const expectedRunIds = projection.runs.map(run => run.run_id).sort();
  assertSameValue(storedRunIds(store, sessionId), expectedRunIds, 'Run set');
  for (const run of projection.runs) {
    assertSameValue(store.readRunV30(sessionId, run.run_id), run, `Run ${run.run_id}`);
  }
  for (const legacyReceipt of projection.legacy_transition_receipts) {
    const stored = store.readTransitionReceiptV20(
      sessionId,
      legacyReceipt.activity_revision,
      legacyReceipt.transition_id,
    );
    assertSameValue(stored, legacyReceipt, `legacy transition receipt ${legacyReceipt.transition_id}`);
  }
  const receipt = store.readTransitionReceiptV20(
    sessionId,
    projection.transition_receipt.activity_revision,
    projection.transition_receipt.transition_id,
  );
  assertSameValue(receipt, projection.transition_receipt, 'migration transition receipt');
}

/**
 * Controlled legacy replacement entry point. Normal writeSessionV30/writeRunV30
 * guards remain intact; only this validated W5 path uses the W1 transaction's
 * migration-capable batch to replace legacy authority atomically.
 */
export function readAppliedV3Migration(
  store: SessionStore,
  sessionId: string,
): V3MigrationApplyResult {
  const reportPath = v3MigrationReportPath(store, sessionId);
  if (!existsSync(reportPath)) fail('MIGRATION_CONFLICT', 'session/3.0 authority has no migration report');
  const report = store.readJsonFileReadOnly(reportPath, migrationReportV1Schema);
  if (report.session_id !== sessionId) fail('MIGRATION_CONFLICT', 'migration report Session identity mismatch');
  verifyLegacySnapshot(store, report);
  const session = store.readSessionV30(sessionId);
  const runs = Object.keys(report.target_hashes.runs).sort().map(runId => store.readRunV30(sessionId, runId));
  const receiptNames = readdirSync(store.transitionReceiptsDir(sessionId))
    .filter(name => name.endsWith(`-${report.migration_id}.json`));
  if (receiptNames.length !== 1) fail('MIGRATION_CONFLICT', 'migration transition receipt is missing or ambiguous');
  const activityRevision = Number(receiptNames[0].slice(0, 12));
  const transitionReceipt = store.readTransitionReceiptV20(sessionId, activityRevision, report.migration_id);
  if (!transitionReceipt) fail('MIGRATION_CONFLICT', 'migration transition receipt is missing');
  const projectedTransitionAudits = report.retired_execution_transitions
    .filter(item => item.disposition === 'projected-v3-receipt');
  const legacyTransitionReceipts = projectedTransitionAudits
    .map(item => store.readTransitionReceiptV20(
      sessionId,
      item.projected_activity_revision!,
      item.projected_transition_id!,
    ))
    .map((receipt, index) => {
      if (!receipt) {
        fail(
          'MIGRATION_CONFLICT',
          `projected legacy transition receipt is missing: ${projectedTransitionAudits[index].source_id}`,
        );
      }
      return receipt;
    });
  const actualLegacyReceiptHashes = Object.fromEntries(legacyTransitionReceipts.map(receipt => [
    receipt.transition_id,
    canonicalHash(receipt),
  ]));
  if (canonicalHash(session) !== report.target_hashes.session
    || canonicalHash(transitionReceipt) !== report.target_hashes.transition_receipt
    || stableJsonUtf8(actualLegacyReceiptHashes) !== stableJsonUtf8(report.target_hashes.legacy_transition_receipts)) {
    fail('MIGRATION_CONFLICT', 'applied migration authority hash changed');
  }
  for (const run of runs) {
    if (canonicalHash(run) !== report.target_hashes.runs[run.run_id]) {
      fail('MIGRATION_CONFLICT', `applied migration Run hash changed: ${run.run_id}`);
    }
  }
  return {
    status: 'already-applied',
    session,
    runs,
    transition_receipt: transitionReceipt,
    legacy_transition_receipts: legacyTransitionReceipts,
    report,
    report_path: reportPath,
  };
}

export function applyV3Migration(
  store: SessionStore,
  input: LegacyV3MigrationInput,
  options: V3MigrationOptions = {},
): V3MigrationApplyResult {
  const projection = projectLegacySessionToV30(input, options);
  const sessionId = projection.session.session_id;
  // Audit identity (H3/⑨): caller reason/evidence override the synthesized
  // migration reason; a request receipt always links the migration transition.
  const transitionReceipt = options.reason
    ? { ...projection.transition_receipt, reason: options.reason }
    : projection.transition_receipt;
  const transitionReceiptWithEvidence = options.evidence_refs?.length
    ? {
        ...transitionReceipt,
        evidence_refs: [...transitionReceipt.evidence_refs, ...options.evidence_refs],
      }
    : transitionReceipt;
  const migrationRequestId = options.request_id ?? `migrate-${randomUUID()}`;
  const migrationRequestReceipt = createRequestReceipt({
    requestId: migrationRequestId,
    participantId: options.actor_id ?? 'migration',
    payloadHash: canonicalPayloadHash({ operation: 'session-migrate', session_id: sessionId }),
    transitionReceiptRef: transitionReceiptRef(
      transitionReceiptWithEvidence.activity_revision,
      transitionReceiptWithEvidence.transition_id,
    ),
  });
  const reportPath = v3MigrationReportPath(store, sessionId);
  const snapshotFiles = legacySnapshotFiles({
    session: parseLegacySession(input.session),
    execution: input.execution == null ? null : executionStateSchema.parse(input.execution),
    executionTransitions: (input.execution_transitions ?? []).map(parseExecutionTransition),
    runs: input.runs.map(parseLegacyRun),
    gates: gateRegistrySchema.parse(input.gates),
    artifacts: artifactRegistrySchema.parse(input.artifacts),
    evidence: evidenceStoreSchema.parse(input.evidence),
    supplied: input.source_bytes ?? {},
  });
  const snapshotManifest = legacySnapshotManifest(projection.report.migration_id, snapshotFiles);
  const snapshotRoot = snapshotRootPath(store, sessionId, projection.report);
  const status = store.withV30Transaction(sessionId, tx => {
    const current = JSON.parse(readFileSync(join(store.sessionDir(sessionId), 'session.json'), 'utf8')) as {
      schema_version?: unknown;
    };
    if (current.schema_version === 'session/3.0') {
      verifyAppliedProjection(store, projection);
      return 'already-applied' as const;
    }
    if (current.schema_version !== 'session/1.3' && current.schema_version !== 'session/2.0') {
      fail('MIGRATION_CONFLICT', `cannot replace Session source schema ${String(current.schema_version)}`);
    }
    if (existsSync(reportPath)) {
      fail('MIGRATION_CONFLICT', 'legacy Session already has a v3 migration report');
    }
    const receiptPaths = [
      ...projection.legacy_transition_receipts,
      transitionReceiptWithEvidence,
    ].map(candidate => store.transitionReceiptV20Path(
      sessionId,
      candidate.activity_revision,
      candidate.transition_id,
    ));
    if (receiptPaths.some(path => existsSync(path))) {
      fail('MIGRATION_CONFLICT', 'migration transition receipt path already exists');
    }

    verifyLegacySources(store, input, projection);
    for (const file of snapshotFiles) {
      tx.writeRaw(join(snapshotRoot, file.path), file.raw, 0o600);
    }
    tx.writeJson(join(snapshotRoot, 'manifest.json'), snapshotManifest, legacySnapshotManifestSchema, 0o600);
    tx.writeSession(projection.session);
    for (const run of projection.runs) tx.writeRun(run);
    for (const legacyReceipt of projection.legacy_transition_receipts) {
      tx.writeTransitionReceipt(legacyReceipt);
    }
    tx.writeTransitionReceipt(transitionReceiptWithEvidence);
    tx.writeRequestReceipt(migrationRequestReceipt);
    tx.writeJson(reportPath, projection.report, migrationReportV1Schema, 0o600);
    return 'applied' as const;
  });
  return { ...projection, status, report_path: reportPath };
}
