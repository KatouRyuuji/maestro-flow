import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { readContainedFile } from './artifacts.js';
import { resolveCommandSource } from './contract.js';
import {
  artifactCompatibilityAssessmentSchema,
  artifactRepublishReceiptSchema,
  type ArtifactCompatibilityAssessment,
  type ArtifactRepublishReceipt,
} from './protocol-schemas.js';
import { artifactRegistrySchema, type ArtifactRegistry, type Artifact } from './schemas.js';
import { SessionStore } from './store.js';
import { sha256Digest, stableJsonUtf8 } from './transition-receipts.js';

export type CompatibilityRole = Artifact['role'];

export interface ArtifactCompatibilitySlot {
  kind: string;
  schema: string;
  role: CompatibilityRole;
  alias: string;
}

export interface AssessArtifactCompatibilityInput {
  source: ArtifactCompatibilityAssessment['source'];
  consumer: ArtifactCompatibilityAssessment['consumer'];
  source_status: Artifact['status'];
  producer_status: string;
  source_hash_valid: boolean;
  source_is_top_level_json: boolean;
  source_metadata_valid: boolean;
  producer_contract_captured: boolean;
}

export interface InspectArtifactCompatibilityOptions {
  sessionId: string;
  artifactId: string;
  consumerCommand: string;
  alias: string;
}

export interface PrepareArtifactRepublishOptions extends InspectArtifactCompatibilityOptions {
  assessmentHash: string;
  requestId: string;
  expectedArtifactRevision: number;
  expectedSessionRevision: number;
  participantId: string;
  actorId: string;
  reason: string;
  evidenceRefs: readonly string[];
  recordedAt?: string;
}

export interface PreparedArtifactRepublish {
  assessment: ArtifactCompatibilityAssessment;
  sourceArtifact: Artifact;
  artifact: Artifact;
  artifactId: string;
  artifactPath: string;
  content: string;
  compatibilityRunId: string;
  compatibilityStepId: string;
  recordedAt: string;
}

const REASON_ORDER = [
  'SOURCE_NOT_SEALED',
  'PRODUCER_NOT_SEALED',
  'SOURCE_HASH_MISMATCH',
  'SOURCE_NOT_TOP_LEVEL_JSON',
  'SOURCE_METADATA_INVALID',
  'SOURCE_KIND_MISMATCH',
  'SOURCE_SCHEMA_MISMATCH',
  'PRODUCER_KIND_MISMATCH',
  'PRODUCER_SCHEMA_MISMATCH',
  'CONSUMER_KIND_MISMATCH',
  'CONSUMER_SCHEMA_MISMATCH',
  'SOURCE_ROLE_REPRESENTATION_DRIFT',
  'SOURCE_ALIAS_REPRESENTATION_DRIFT',
  'SEALED_SOURCE_REPRESENTATION_CONFLICT',
  'PRODUCER_CONTRACT_UNAVAILABLE',
  'CONSUMER_ROLE_REPUBLISH_REQUIRED',
  'CONSUMER_ALIAS_REPUBLISH_REQUIRED',
  'COMPATIBLE',
] as const;

function orderedReasons(reasons: Set<string>): string[] {
  return [...reasons].sort((left, right) => {
    const leftIndex = REASON_ORDER.indexOf(left as typeof REASON_ORDER[number]);
    const rightIndex = REASON_ORDER.indexOf(right as typeof REASON_ORDER[number]);
    return (leftIndex < 0 ? REASON_ORDER.length : leftIndex)
      - (rightIndex < 0 ? REASON_ORDER.length : rightIndex)
      || left.localeCompare(right);
  });
}

function sameSchema(actual: string, expected: string): boolean {
  if (actual === expected) return true;
  const range = /^([^/]+)\/([0-9]+)\.x$/.exec(expected);
  const exact = /^([^/]+)\/([0-9]+)\.[0-9]+$/.exec(actual);
  return Boolean(range && exact && range[1] === exact[1] && range[2] === exact[2]);
}

export function assessArtifactCompatibility(
  input: AssessArtifactCompatibilityInput,
): ArtifactCompatibilityAssessment {
  const reasons = new Set<string>();
  const { raw_slot: raw, registry_slot: registry, producer_slot: producer } = input.source;
  const consumer = input.consumer.slot;
  if (input.source_status !== 'sealed') reasons.add('SOURCE_NOT_SEALED');
  if (input.producer_status !== 'sealed') reasons.add('PRODUCER_NOT_SEALED');
  if (!input.source_hash_valid) reasons.add('SOURCE_HASH_MISMATCH');
  if (!input.source_is_top_level_json) reasons.add('SOURCE_NOT_TOP_LEVEL_JSON');
  if (!input.source_metadata_valid) reasons.add('SOURCE_METADATA_INVALID');
  if (raw.kind !== registry.kind) reasons.add('SOURCE_KIND_MISMATCH');
  if (raw.schema !== registry.schema) reasons.add('SOURCE_SCHEMA_MISMATCH');
  if (producer.kind !== registry.kind) reasons.add('PRODUCER_KIND_MISMATCH');
  if (producer.schema !== registry.schema) reasons.add('PRODUCER_SCHEMA_MISMATCH');
  if (consumer.kind !== registry.kind) reasons.add('CONSUMER_KIND_MISMATCH');
  if (!sameSchema(registry.schema, consumer.schema)) reasons.add('CONSUMER_SCHEMA_MISMATCH');

  const integrityFatal = [...reasons].some(reason => [
    'SOURCE_HASH_MISMATCH', 'SOURCE_NOT_TOP_LEVEL_JSON', 'SOURCE_METADATA_INVALID',
    'SOURCE_KIND_MISMATCH', 'SOURCE_SCHEMA_MISMATCH',
    'PRODUCER_KIND_MISMATCH', 'PRODUCER_SCHEMA_MISMATCH',
    'CONSUMER_KIND_MISMATCH', 'CONSUMER_SCHEMA_MISMATCH',
  ].includes(reason));
  const representationDrift = raw.role !== registry.role || producer.role !== registry.role
    || raw.alias !== registry.alias || producer.alias !== registry.alias;
  const sealedAuthority = input.source_status === 'sealed' && input.producer_status === 'sealed';
  let classification: ArtifactCompatibilityAssessment['classification'];
  if (integrityFatal) {
    classification = 'invalid';
  } else if (representationDrift) {
    if (raw.role !== registry.role || producer.role !== registry.role) {
      reasons.add('SOURCE_ROLE_REPRESENTATION_DRIFT');
    }
    if (raw.alias !== registry.alias || producer.alias !== registry.alias) {
      reasons.add('SOURCE_ALIAS_REPRESENTATION_DRIFT');
    }
    if (sealedAuthority) {
      reasons.add('SEALED_SOURCE_REPRESENTATION_CONFLICT');
      classification = 'invalid';
    } else if (input.producer_contract_captured) {
      classification = 'representation_repairable';
    } else {
      reasons.add('PRODUCER_CONTRACT_UNAVAILABLE');
      classification = 'invalid';
    }
  } else if (!sealedAuthority) {
    if (!input.producer_contract_captured) reasons.add('PRODUCER_CONTRACT_UNAVAILABLE');
    classification = 'invalid';
  } else if (registry.role !== consumer.role || registry.alias !== consumer.alias) {
    if (registry.role !== consumer.role) reasons.add('CONSUMER_ROLE_REPUBLISH_REQUIRED');
    if (registry.alias !== consumer.alias) reasons.add('CONSUMER_ALIAS_REPUBLISH_REQUIRED');
    classification = 'semantic_republish_required';
  } else {
    reasons.add('COMPATIBLE');
    classification = 'compatible';
  }

  const content = {
    schema_version: 'artifact-compatibility/1.0' as const,
    classification,
    reason_codes: orderedReasons(reasons),
    source: input.source,
    consumer: input.consumer,
  };
  return artifactCompatibilityAssessmentSchema.parse({
    ...content,
    assessment_hash: sha256Digest(stableJsonUtf8(content)),
  });
}

function safeArtifactPath(store: SessionStore, sessionId: string, artifact: Artifact): string {
  const sessionDir = resolve(store.sessionDir(sessionId));
  if (isAbsolute(artifact.relative_path) || artifact.relative_path.split(/[\\/]+/).includes('..')) {
    throw new Error(`invalid Artifact path: ${artifact.relative_path}`);
  }
  const path = resolve(sessionDir, artifact.relative_path);
  if (path !== sessionDir && !path.startsWith(`${sessionDir}${sep}`)) {
    throw new Error(`Artifact path escapes Session: ${artifact.relative_path}`);
  }
  return path;
}

function sourceAlias(registry: ArtifactRegistry, artifactId: string, rawAlias: unknown): string {
  if (typeof rawAlias === 'string' && rawAlias.trim()) return rawAlias;
  return Object.entries(registry.aliases)
    .filter(([, id]) => id === artifactId)
    .map(([alias]) => alias)
    .sort()[0] ?? '(missing)';
}

function producerSlotFromSnapshot(
  normalized: unknown,
  artifact: Artifact,
  runDir: string,
): ArtifactCompatibilitySlot | null {
  if (!normalized || typeof normalized !== 'object' || Array.isArray(normalized)) return null;
  const produces = (normalized as { produces?: unknown }).produces;
  if (!Array.isArray(produces)) return null;
  const outputPath = relative(runDir, join(runDir, '..', '..', artifact.relative_path)).replaceAll('\\', '/');
  const candidates = produces.filter(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
    const raw = item as Record<string, unknown>;
    return raw.kind === artifact.kind
      && (raw.schema === undefined || raw.schema === artifact.schema_version)
      && (raw.path === undefined || raw.path === outputPath);
  }) as Array<Record<string, unknown>>;
  if (candidates.length !== 1) return null;
  const item = candidates[0];
  return {
    kind: String(item.kind),
    schema: typeof item.schema === 'string' ? item.schema : artifact.schema_version,
    role: (typeof item.role === 'string' ? item.role : item.primary === true ? 'primary' : 'attachment') as CompatibilityRole,
    alias: typeof item.alias === 'string' ? item.alias : '(missing)',
  };
}

function historicalAuthorityHash(input: {
  artifactId: string;
  producerRunHash: string;
  rawSlot: ArtifactCompatibilitySlot;
  registrySlot: ArtifactCompatibilitySlot;
}): string {
  return sha256Digest(stableJsonUtf8({
    authority: 'sealed-raw-registry/1.0',
    artifact_id: input.artifactId,
    producer_run_hash: input.producerRunHash,
    raw_slot: input.rawSlot,
    registry_slot: input.registrySlot,
  }));
}

function exactConsumer(projectRoot: string, command: string, alias: string) {
  const source = resolveCommandSource(projectRoot, command);
  const matches = source.contract.consumes
    .map((slot, index) => ({ slot, index }))
    .filter(item => item.slot.alias === alias);
  if (matches.length !== 1) {
    throw new Error(`consumer command ${command} must declare exactly one consumes slot for alias ${alias}`);
  }
  const match = matches[0];
  if (!match.slot.schema && !match.slot.schema_range) {
    throw new Error(`consumer command ${command} alias ${alias} must declare an exact schema or schema_range`);
  }
  if (!match.slot.role) {
    throw new Error(`consumer command ${command} alias ${alias} must declare a role`);
  }
  return {
    command,
    command_contract_hash: source.contractSnapshot.snapshot_hash,
    slot_index: match.index,
    slot: {
      kind: match.slot.kind,
      schema: match.slot.schema ?? match.slot.schema_range!,
      role: match.slot.role,
      alias,
    },
  };
}

export function inspectArtifactCompatibility(
  projectRoot: string,
  options: InspectArtifactCompatibilityOptions,
  authorityStore?: SessionStore,
): ArtifactCompatibilityAssessment {
  const store = authorityStore ?? new SessionStore(projectRoot);
  const inspect = (): ArtifactCompatibilityAssessment => {
    const session = store.readSessionRecordReadOnly(options.sessionId);
    if (![
      'session/1.0', 'session/1.1', 'session/1.2', 'session/1.3', 'session/2.0', 'session/3.0',
    ].includes(session.schema_version)) {
      throw new Error(`unsupported Session schema for Artifact compatibility: ${session.schema_version}`);
    }
    const supportedSession = session as typeof session & {
      schema_version: ArtifactCompatibilityAssessment['source']['session_schema_version'];
      activity_revision: number;
    };
    const registry = store.readJsonFileReadOnly(
      join(store.sessionDir(options.sessionId), 'artifacts.json'), artifactRegistrySchema,
    );
    const artifact = registry.artifacts[options.artifactId];
    if (!artifact) throw new Error(`Artifact not found: ${options.artifactId}`);
    const path = safeArtifactPath(store, options.sessionId, artifact);
    if (!existsSync(path) || lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile()) {
      throw new Error(`Artifact is not a regular file: ${artifact.relative_path}`);
    }
    const verified = readContainedFile(path);
    let parsed: Record<string, unknown> | null = null;
    try {
      const value = JSON.parse(verified.data.toString('utf8')) as unknown;
      if (value && typeof value === 'object' && !Array.isArray(value)) parsed = value as Record<string, unknown>;
    } catch {
      // The assessment classifies non-JSON source bytes as invalid.
    }
    const rawMeta = parsed && parsed._meta && typeof parsed._meta === 'object' && !Array.isArray(parsed._meta)
      ? parsed._meta as Record<string, unknown>
      : {};
    const alias = sourceAlias(registry, options.artifactId, rawMeta.alias);
    const registrySlot: ArtifactCompatibilitySlot = {
      kind: artifact.kind,
      schema: artifact.schema_version,
      role: artifact.role,
      alias: Object.entries(registry.aliases).find(([, id]) => id === options.artifactId)?.[0] ?? alias,
    };
    const rawRole = typeof rawMeta.role === 'string' && [
      'primary', 'attachment', 'evidence', 'report', 'checkpoint',
    ].includes(rawMeta.role) ? rawMeta.role as CompatibilityRole : artifact.role;
    const rawSlot: ArtifactCompatibilitySlot = {
      kind: typeof rawMeta.kind === 'string' ? rawMeta.kind : '(missing)',
      schema: typeof rawMeta.schema === 'string' ? rawMeta.schema : '(missing)',
      role: rawRole,
      alias,
    };
    const runPath = join(store.runDir(options.sessionId, artifact.producer_run_id), 'run.json');
    if (!existsSync(runPath)) throw new Error(`producer Run not found: ${artifact.producer_run_id}`);
    const producerRunHash = sha256Digest(readFileSync(runPath));
    let producerStatus: string;
    let producerSlot: ArtifactCompatibilitySlot;
    let producerContractHash: string;
    let producerContractSource: ArtifactCompatibilityAssessment['source']['producer_contract_source'];
    if (supportedSession.schema_version === 'session/3.0') {
      const run = store.readRunV30(options.sessionId, artifact.producer_run_id);
      producerStatus = run.status;
      producerSlot = registrySlot;
      producerContractHash = historicalAuthorityHash({
        artifactId: options.artifactId, producerRunHash, rawSlot, registrySlot,
      });
      producerContractSource = run.status === 'sealed' && artifact.status === 'sealed'
        ? 'sealed_raw_registry'
        : 'unavailable';
    } else {
      const run = store.readRun(options.sessionId, artifact.producer_run_id);
      producerStatus = run.status;
      const slot = producerSlotFromSnapshot(run.contract_snapshot?.normalized, artifact, store.runDir(options.sessionId, run.run_id));
      if (slot && run.contract_snapshot) {
        producerSlot = slot;
        producerContractHash = run.contract_snapshot.snapshot_hash;
        producerContractSource = 'captured_snapshot';
      } else {
        producerSlot = registrySlot;
        producerContractHash = historicalAuthorityHash({
          artifactId: options.artifactId, producerRunHash, rawSlot, registrySlot,
        });
        producerContractSource = run.status === 'sealed' && artifact.status === 'sealed'
          ? 'sealed_raw_registry'
          : 'unavailable';
      }
    }
    const sessionRevision = supportedSession.schema_version === 'session/3.0'
      ? (supportedSession as typeof supportedSession & { orchestration_revision: number }).orchestration_revision
      : supportedSession.activity_revision;
    return assessArtifactCompatibility({
      source: {
        session_id: options.sessionId,
        session_schema_version: supportedSession.schema_version,
        session_revision: sessionRevision,
        artifact_id: options.artifactId,
        artifact_registry_revision: registry.revision,
        artifact_path: artifact.relative_path,
        artifact_hash: `sha256:${artifact.content_hash}`,
        artifact_size: artifact.size,
        producer_run_id: artifact.producer_run_id,
        producer_run_hash: producerRunHash,
        producer_contract_hash: producerContractHash,
        producer_contract_source: producerContractSource,
        raw_slot: rawSlot,
        registry_slot: registrySlot,
        producer_slot: producerSlot,
      },
      consumer: exactConsumer(projectRoot, options.consumerCommand, options.alias),
      source_status: artifact.status,
      producer_status: producerStatus,
      source_hash_valid: verified.hash === artifact.content_hash && verified.data.byteLength === artifact.size,
      source_is_top_level_json: parsed !== null && Object.keys(rawMeta).length > 0,
      source_metadata_valid: typeof rawMeta.kind === 'string' && rawMeta.kind.length > 0
        && typeof rawMeta.schema === 'string' && rawMeta.schema.length > 0
        && typeof rawMeta.role === 'string' && [
          'primary', 'attachment', 'evidence', 'report', 'checkpoint',
        ].includes(rawMeta.role)
        && typeof rawMeta.alias === 'string' && rawMeta.alias.length > 0,
      producer_contract_captured: producerContractSource === 'captured_snapshot',
    });
  };
  return authorityStore ? inspect() : store.withLock(inspect);
}

function normalizedRequired(value: string, label: string): string {
  const result = value.trim();
  if (!result) throw new Error(`${label} is required`);
  return result;
}

function stableId(prefix: string, input: unknown): string {
  return `${prefix}-${createHash('sha256').update(stableJsonUtf8(input)).digest('hex').slice(0, 20)}`;
}

export function prepareArtifactRepublish(
  projectRoot: string,
  options: PrepareArtifactRepublishOptions,
  authorityStore?: SessionStore,
): PreparedArtifactRepublish {
  const store = authorityStore ?? new SessionStore(projectRoot);
  const assessment = inspectArtifactCompatibility(projectRoot, options, store);
  if (assessment.assessment_hash !== options.assessmentHash) {
    throw new Error('artifact compatibility assessment changed');
  }
  if (assessment.classification !== 'semantic_republish_required') {
    throw new Error(`Artifact assessment is ${assessment.classification}; semantic republish is not allowed`);
  }
  if (assessment.source.artifact_registry_revision !== options.expectedArtifactRevision) {
    throw new Error(`artifact registry revision conflict: expected ${options.expectedArtifactRevision}, current ${assessment.source.artifact_registry_revision}`);
  }
  if (assessment.source.session_revision !== options.expectedSessionRevision) {
    throw new Error(`session revision conflict: expected ${options.expectedSessionRevision}, current ${assessment.source.session_revision}`);
  }
  normalizedRequired(options.requestId, 'request ID');
  normalizedRequired(options.participantId, 'participant ID');
  normalizedRequired(options.actorId, 'actor ID');
  normalizedRequired(options.reason, 'reason');
  const evidenceRefs = [...new Set(options.evidenceRefs.map(item => item.trim()).filter(Boolean))].sort();
  if (evidenceRefs.length === 0) throw new Error('at least one evidence reference is required');

  const registry = store.readJsonFileReadOnly(
    join(store.sessionDir(options.sessionId), 'artifacts.json'), artifactRegistrySchema,
  );
  const sourceArtifact = registry.artifacts[options.artifactId];
  if (!sourceArtifact) throw new Error(`Artifact not found: ${options.artifactId}`);
  const sourcePath = safeArtifactPath(store, options.sessionId, sourceArtifact);
  const raw = JSON.parse(readContainedFile(sourcePath).data.toString('utf8')) as Record<string, unknown>;
  const meta = raw._meta as Record<string, unknown>;
  const transformed = {
    ...raw,
    _meta: {
      ...meta,
      role: assessment.consumer.slot.role,
      alias: assessment.consumer.slot.alias,
    },
  };
  const content = `${JSON.stringify(transformed, null, 2)}\n`;
  const compatibilityRunId = stableId('RUN-COMPAT', {
    request_id: options.requestId, assessment_hash: assessment.assessment_hash,
  });
  const compatibilityStepId = stableId('STEP-COMPAT', {
    request_id: options.requestId, consumer: assessment.consumer,
  });
  const artifactId = stableId('ART-COMPAT', {
    request_id: options.requestId, source_artifact_id: options.artifactId, consumer: assessment.consumer,
  });
  const artifactPath = `runs/${compatibilityRunId}/outputs/${basename(sourceArtifact.relative_path)}`;
  const bytes = Buffer.from(content, 'utf8');
  const contentHash = createHash('sha256').update(bytes).digest('hex');
  return {
    assessment,
    sourceArtifact: structuredClone(sourceArtifact),
    artifact: {
      ...structuredClone(sourceArtifact),
      role: assessment.consumer.slot.role,
      producer_run_id: compatibilityRunId,
      relative_path: artifactPath,
      content_hash: contentHash,
      size: bytes.byteLength,
      status: 'sealed',
      derived_from: [options.artifactId],
      replaces: null,
    },
    artifactId,
    artifactPath,
    content,
    compatibilityRunId,
    compatibilityStepId,
    recordedAt: options.recordedAt ?? new Date().toISOString(),
  };
}

export function artifactRepublishReceiptHash(receipt: ArtifactRepublishReceipt): string {
  const { receipt_hash: _receiptHash, ...content } = receipt;
  return sha256Digest(stableJsonUtf8(content));
}

export function createArtifactRepublishReceipt(
  input: Omit<ArtifactRepublishReceipt, 'schema_version' | 'receipt_hash'>,
): ArtifactRepublishReceipt {
  const receipt = {
    schema_version: 'artifact-republish/1.0' as const,
    ...input,
    receipt_hash: `sha256:${'0'.repeat(64)}`,
  };
  receipt.receipt_hash = artifactRepublishReceiptHash(receipt);
  return artifactRepublishReceiptSchema.parse(receipt);
}

export function artifactRepublishReceiptPath(
  store: SessionStore,
  sessionId: string,
  receiptId: string,
): string {
  return join(store.receiptsDir(sessionId), 'artifact-republish', `${receiptId}.json`);
}

export function findArtifactRepublishReceipts(
  store: SessionStore,
  sessionId: string,
): ArtifactRepublishReceipt[] {
  const root = join(store.receiptsDir(sessionId), 'artifact-republish');
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter(name => name.endsWith('.json'))
    .sort()
    .map(name => artifactRepublishReceiptSchema.parse(JSON.parse(readFileSync(join(root, name), 'utf8'))))
    .filter(receipt => artifactRepublishReceiptHash(receipt) === receipt.receipt_hash);
}

export function exactArtifactRepublishReceipt(
  store: SessionStore,
  sessionId: string,
  artifactId: string,
  consumer: ArtifactCompatibilityAssessment['consumer'],
): ArtifactRepublishReceipt | null {
  const matches = findArtifactRepublishReceipts(store, sessionId).filter(receipt => {
    if (receipt.artifact_id !== artifactId
      || stableJsonUtf8(receipt.consumer) !== stableJsonUtf8(consumer)) return false;
    const registry = store.readJsonFileReadOnly(
      join(store.sessionDir(sessionId), 'artifacts.json'), artifactRegistrySchema,
    );
    const artifact = registry.artifacts[artifactId];
    if (!artifact
      || artifact.status !== 'sealed'
      || `sha256:${artifact.content_hash}` !== receipt.artifact_hash
      || artifact.producer_run_id !== receipt.compatibility_run_id
      || stableJsonUtf8(artifact.derived_from) !== stableJsonUtf8([receipt.source_artifact_id])
      || registry.aliases[consumer.slot.alias] !== artifactId) return false;
    const path = safeArtifactPath(store, sessionId, artifact);
    if (!existsSync(path)) return false;
    const observed = readContainedFile(path);
    return `sha256:${observed.hash}` === receipt.artifact_hash && observed.data.byteLength === artifact.size;
  });
  return matches.length === 1 ? matches[0] : null;
}
