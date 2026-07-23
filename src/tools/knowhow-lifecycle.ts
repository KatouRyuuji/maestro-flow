import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import {
  getKnowhowDir,
  knowhowFileToWikiId,
  parseFrontmatter,
} from '../utils/frontmatter.js';
import { updateFileAtomic } from '../utils/atomic-write.js';

const LIFECYCLE_LOCK = '.lifecycle.lock';
const LIFECYCLE_INTENT = '.lifecycle.intent.json';
const LOCK_TIMEOUT_MS = 10_000;
const LOCK_RETRY_MS = 50;

type ContentHash = string | null;

export interface KnowhowLifecycleResult {
  success: boolean;
  schema_version?: 'knowhow-supersede-result/1.0';
  operation?: 'supersede';
  oldId?: string;
  newId?: string;
  replayed?: boolean;
  error?: string;
  code?: string;
}

export interface KnowhowEvolutionLink {
  id: string;
  filename: string;
  path: string;
  title: string;
  deprecated: boolean;
  current: boolean;
  broken: boolean;
  supersedes: string[];
  supersededBy: string | null;
}

export interface LifecycleFaultOptions {
  afterTarget?: (path: string, completedTargets: number) => void;
  beforeLockDelete?: (
    phase: 'reclaim' | 'release',
    lockPath: string,
  ) => void;
}

interface KnowhowNode {
  id: string;
  filename: string;
  filePath: string;
  relativePath: string;
  raw: string;
  data: Record<string, unknown>;
}

interface LifecycleIntentTarget {
  id: string;
  path: string;
  beforeHash: ContentHash;
  afterHash: ContentHash;
  beforeBase64: string | null;
  afterBase64: string | null;
}

export interface LifecycleIntent {
  schema_version: 'knowhow-lifecycle-intent/1.0';
  operation: 'supersede';
  oldId: string;
  newId: string;
  targets: LifecycleIntentTarget[];
}

export interface KnowhowSnapshotTarget {
  path: string;
  beforeHash: ContentHash;
  beforeBase64: string | null;
  afterHash: ContentHash;
  expectedAbsent: boolean;
}

export interface KnowhowLifecycleSnapshot {
  schema_version: 'knowhow-lifecycle-snapshot/1.0';
  createdAt: string;
  sealedAt: string | null;
  oldId: string;
  newId: string;
  targets: KnowhowSnapshotTarget[];
}

export interface CreateKnowhowSnapshotOptions {
  oldId: string;
  newId: string;
  newPath: string;
  includeRelative?: string[];
  out: string;
}

export interface RestoreTargetState {
  path: string;
  beforeHash: ContentHash;
  afterHash: ContentHash;
  restoreHash: ContentHash;
  completed: boolean;
}

export interface KnowhowRestoreIntent {
  schema_version: 'knowhow-restore-intent/1.0';
  requestId: string;
  operation: 'restore';
  status: 'pending' | 'completed' | 'conflict';
  subject: string;
  claimedRun: string;
  requestHash: string;
  targets: RestoreTargetState[];
  conflict?: {
    path: string;
    expectedHash: ContentHash;
    actualHash: ContentHash;
  };
}

export interface KnowhowRestoreReceipt {
  schema_version: 'knowhow-restore-receipt/1.0';
  requestId: string;
  operation: 'restore';
  status: 'completed' | 'conflict';
  subject: string;
  claimedRun: string;
  requestHash: string;
  resultHash: string;
  targets: RestoreTargetState[];
  conflict?: {
    path: string;
    expectedHash: ContentHash;
    actualHash: ContentHash;
  };
}

export interface RestoreKnowhowOptions extends LifecycleFaultOptions {
  claimedRun?: string;
}

export interface RestoreKnowhowResult {
  success: boolean;
  replayed: boolean;
  intent: KnowhowRestoreIntent;
  receipt?: KnowhowRestoreReceipt;
  error?: string;
  code?: string;
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

type LifecyclePathExpectation =
  | 'existing-file'
  | 'existing-directory'
  | 'write-target'
  | 'delete-target';

function comparablePath(path: string): string {
  const normalized = path.replaceAll('\\', '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function isContainedPath(canonicalRoot: string, candidate: string): boolean {
  const root = comparablePath(canonicalRoot);
  const target = comparablePath(candidate);
  return target === root || target.startsWith(`${root}/`);
}

function unsafeLifecyclePath(input: string, reason: string): Error {
  return new Error(`Unsafe knowhow lifecycle path: ${input} (${reason})`);
}

export function resolveLifecyclePath(
  projectRoot: string,
  input: string,
  expected: LifecyclePathExpectation,
): string {
  const canonicalRoot = realpathSync.native(projectRoot);
  const normalizedInput = input.replaceAll('\\', sep);
  const lexicalTarget = isAbsolute(normalizedInput)
    ? resolve(normalizedInput)
    : resolve(canonicalRoot, normalizedInput);
  if (!isContainedPath(canonicalRoot, lexicalTarget)) {
    throw unsafeLifecyclePath(input, 'outside canonical project root');
  }

  const relativeTarget = relative(canonicalRoot, lexicalTarget);
  const components = relativeTarget
    .split(/[\\/]+/)
    .filter(component => component.length > 0 && component !== '.');
  let canonicalParent = canonicalRoot;
  let finalStat = lstatSync(canonicalRoot);

  for (let index = 0; index < components.length; index += 1) {
    const component = components[index];
    const candidate = join(canonicalParent, component);
    try {
      const stat = lstatSync(candidate);
      if (stat.isSymbolicLink()) {
        throw unsafeLifecyclePath(input, `symbolic link or junction component: ${component}`);
      }
      if (!stat.isFile() && !stat.isDirectory()) {
        throw unsafeLifecyclePath(input, `unsupported filesystem component: ${component}`);
      }
      const canonical = realpathSync.native(candidate);
      const expectedCanonical = join(canonicalParent, component);
      if (comparablePath(canonical) !== comparablePath(expectedCanonical)
        || !isContainedPath(canonicalRoot, canonical)) {
        throw unsafeLifecyclePath(input, `reparse point or containment mismatch: ${component}`);
      }
      canonicalParent = canonical;
      finalStat = stat;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (expected === 'existing-file' || expected === 'existing-directory') {
        throw unsafeLifecyclePath(input, 'required path does not exist');
      }
      const unresolved = resolve(canonicalParent, ...components.slice(index));
      if (!isContainedPath(canonicalRoot, unresolved)) {
        throw unsafeLifecyclePath(input, 'nearest existing parent escapes canonical project root');
      }
      return unresolved;
    }
  }

  if (expected === 'existing-file' && !finalStat.isFile()) {
    throw unsafeLifecyclePath(input, 'expected a regular file');
  }
  if (expected === 'existing-directory' && !finalStat.isDirectory()) {
    throw unsafeLifecyclePath(input, 'expected a directory');
  }
  return canonicalParent;
}

function ensureLifecycleDirectory(projectRoot: string, input: string): string {
  const path = resolveLifecyclePath(projectRoot, input, 'write-target');
  mkdirSync(path, { recursive: true });
  return resolveLifecyclePath(projectRoot, path, 'existing-directory');
}

function removeLifecycleFile(projectRoot: string, input: string): void {
  const path = resolveLifecyclePath(projectRoot, input, 'delete-target');
  if (existsSync(path)) {
    resolveLifecyclePath(projectRoot, path, 'existing-file');
    rmSync(path, { force: true });
  }
  const after = resolveLifecyclePath(projectRoot, path, 'delete-target');
  if (existsSync(after)) throw unsafeLifecyclePath(input, 'delete did not remove target');
}

interface LifecycleLockRecord {
  schema_version: 'knowhow-lifecycle-lock/1.0';
  token: string;
  pid: number;
  acquiredAt: number;
}

interface LifecycleLockIdentity {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  birthtimeMs: number;
}

interface LifecycleLockSnapshot {
  bytes: Buffer;
  owner: LifecycleLockRecord;
  identity: LifecycleLockIdentity;
}

function lifecycleLockIdentity(
  stats: ReturnType<typeof fstatSync>,
): LifecycleLockIdentity {
  return {
    dev: Number(stats.dev),
    ino: Number(stats.ino),
    size: Number(stats.size),
    mtimeMs: Number(stats.mtimeMs),
    birthtimeMs: Number(stats.birthtimeMs),
  };
}

function sameLifecycleLockIdentity(
  left: LifecycleLockIdentity,
  right: LifecycleLockIdentity,
): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.birthtimeMs === right.birthtimeMs;
}

function parseLifecycleLockRecord(bytes: Buffer): LifecycleLockRecord | null {
  try {
    const value = JSON.parse(bytes.toString('utf8')) as Partial<LifecycleLockRecord>;
    const keys = Object.keys(value).sort();
    if (keys.join(',') !== 'acquiredAt,pid,schema_version,token'
      || value.schema_version !== 'knowhow-lifecycle-lock/1.0'
      || typeof value.token !== 'string'
      || value.token.length === 0
      || !Number.isInteger(value.pid)
      || (value.pid ?? 0) <= 0
      || !Number.isInteger(value.acquiredAt)
      || (value.acquiredAt ?? -1) < 0) {
      return null;
    }
    return value as LifecycleLockRecord;
  } catch {
    return null;
  }
}

function sameLifecycleLockSnapshot(
  left: LifecycleLockSnapshot,
  right: LifecycleLockSnapshot,
): boolean {
  return left.bytes.equals(right.bytes)
    && left.owner.pid === right.owner.pid
    && left.owner.token === right.owner.token
    && left.owner.acquiredAt === right.owner.acquiredAt
    && sameLifecycleLockIdentity(left.identity, right.identity);
}

function readStableLifecycleLockSnapshot(
  projectRoot: string,
  lockPathInput: string,
): LifecycleLockSnapshot | null {
  let fd: number | null = null;
  try {
    const candidate = resolveLifecyclePath(projectRoot, lockPathInput, 'delete-target');
    if (!existsSync(candidate)) return null;
    const lockPath = resolveLifecyclePath(projectRoot, candidate, 'existing-file');
    fd = openSync(lockPath, 'r');
    const before = lifecycleLockIdentity(fstatSync(fd));
    const bytes = readFileSync(fd);
    const after = lifecycleLockIdentity(fstatSync(fd));
    if (!sameLifecycleLockIdentity(before, after)) return null;
    resolveLifecyclePath(projectRoot, lockPath, 'existing-file');
    const pathIdentity = lifecycleLockIdentity(statSync(lockPath));
    if (!sameLifecycleLockIdentity(after, pathIdentity)) return null;
    const owner = parseLifecycleLockRecord(bytes);
    return owner ? { bytes, owner, identity: after } : null;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'EACCES' || code === 'EPERM' || code === 'EBUSY') {
      return null;
    }
    if (!existsSync(lockPathInput)) return null;
    throw error;
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* fd already closed */ }
    }
  }
}

function lifecycleOwnerLiveness(pid: number): 'alive' | 'dead' | 'unknown' {
  try {
    process.kill(pid, 0);
    return 'alive';
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'dead' : 'unknown';
  }
}

function withLifecycleLock<T>(
  projectRoot: string,
  action: () => T,
  options?: LifecycleFaultOptions,
): T {
  const knowhowDir = ensureLifecycleDirectory(projectRoot, getKnowhowDir(projectRoot));
  const lockPath = resolveLifecyclePath(
    projectRoot,
    join(knowhowDir, LIFECYCLE_LOCK),
    'write-target',
  );
  const startedAt = Date.now();
  const owner: LifecycleLockRecord = {
    schema_version: 'knowhow-lifecycle-lock/1.0',
    token: randomUUID(),
    pid: process.pid,
    acquiredAt: Date.now(),
  };
  const ownerBytes = Buffer.from(JSON.stringify(owner), 'utf8');
  let acquired = false;
  while (!acquired) {
    try {
      resolveLifecyclePath(projectRoot, lockPath, 'write-target');
      const fd = openSync(lockPath, 'wx');
      try {
        writeFileSync(fd, ownerBytes);
      } finally {
        closeSync(fd);
      }
      resolveLifecyclePath(projectRoot, lockPath, 'existing-file');
      acquired = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const snapshot = readStableLifecycleLockSnapshot(projectRoot, lockPath);
      if (snapshot) {
        const liveness = lifecycleOwnerLiveness(snapshot.owner.pid);
        if (liveness === 'dead') {
          options?.beforeLockDelete?.('reclaim', lockPath);
          const verified = readStableLifecycleLockSnapshot(projectRoot, lockPath);
          if (verified && sameLifecycleLockSnapshot(snapshot, verified)) {
            try {
              unlinkSync(lockPath);
              continue;
            } catch (unlinkError) {
              if ((unlinkError as NodeJS.ErrnoException).code === 'ENOENT') continue;
            }
          }
        }
      }
      if (Date.now() - startedAt >= LOCK_TIMEOUT_MS) {
        throw new Error(`Timed out acquiring knowhow lifecycle lock: ${lockPath}`);
      }
      sleepSync(LOCK_RETRY_MS);
    }
  }
  try {
    return action();
  } finally {
    try {
      const snapshot = readStableLifecycleLockSnapshot(projectRoot, lockPath);
      if (snapshot?.owner.pid === owner.pid && snapshot.owner.token === owner.token) {
        options?.beforeLockDelete?.('release', lockPath);
        const verified = readStableLifecycleLockSnapshot(projectRoot, lockPath);
        if (verified && sameLifecycleLockSnapshot(snapshot, verified)) {
          unlinkSync(lockPath);
        }
      }
    } catch { /* stale-lock recovery handles crashes */ }
  }
}

function sha256(value: string | Buffer): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function stableJson(value: unknown): string {
  const normalize = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(normalize);
    if (item && typeof item === 'object') {
      return Object.fromEntries(
        Object.entries(item as Record<string, unknown>)
          .filter(([, child]) => child !== undefined)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, child]) => [key, normalize(child)]),
      );
    }
    return item;
  };
  return JSON.stringify(normalize(value));
}

function hashFile(projectRoot: string, input: string): ContentHash {
  const path = resolveLifecyclePath(projectRoot, input, 'delete-target');
  if (!existsSync(path)) return null;
  const before = resolveLifecyclePath(projectRoot, path, 'existing-file');
  const content = readFileSync(before);
  const after = resolveLifecyclePath(projectRoot, path, 'existing-file');
  if (comparablePath(before) !== comparablePath(after)) {
    throw unsafeLifecyclePath(input, 'path identity changed while reading');
  }
  return sha256(content);
}

function updateLifecycleFileAtomic(
  projectRoot: string,
  pathInput: string,
  update: (current: string | null) => string | null,
): string | null {
  const path = resolveLifecyclePath(projectRoot, pathInput, 'write-target');
  const sidecars = [`${path}.lock`, `${path}.tmp`];
  for (const sidecar of sidecars) {
    resolveLifecyclePath(projectRoot, sidecar, 'write-target');
  }
  const result = updateFileAtomic(path, update);
  for (const sidecar of sidecars) {
    resolveLifecyclePath(projectRoot, sidecar, 'delete-target');
  }
  if (existsSync(path)) resolveLifecyclePath(projectRoot, path, 'existing-file');
  return result;
}

function relativePath(projectRoot: string, path: string): string {
  return relative(realpathSync.native(projectRoot), resolve(path)).replaceAll('\\', '/');
}

function writeJsonAtomic(projectRoot: string, pathInput: string, value: unknown): void {
  const path = resolveLifecyclePath(projectRoot, pathInput, 'write-target');
  const document = `${JSON.stringify(value, null, 2)}\n`;
  updateLifecycleFileAtomic(projectRoot, path, () => document);
  resolveLifecyclePath(projectRoot, path, 'existing-file');
}

function readJson<T>(projectRoot: string, pathInput: string): T {
  const path = resolveLifecyclePath(projectRoot, pathInput, 'existing-file');
  const document = readFileSync(path, 'utf8');
  resolveLifecyclePath(projectRoot, path, 'existing-file');
  return JSON.parse(document) as T;
}

function listMarkdownFiles(projectRoot: string, dirInput: string): string[] {
  const candidate = resolveLifecyclePath(projectRoot, dirInput, 'delete-target');
  if (!existsSync(candidate)) return [];
  const dir = resolveLifecyclePath(projectRoot, candidate, 'existing-directory');
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      resolveLifecyclePath(projectRoot, path, 'existing-directory');
      out.push(...listMarkdownFiles(projectRoot, path));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      out.push(resolveLifecyclePath(projectRoot, path, 'existing-file'));
    } else if (entry.isSymbolicLink()) {
      throw unsafeLifecyclePath(path, 'symbolic link or junction in knowhow scan');
    }
  }
  resolveLifecyclePath(projectRoot, dir, 'existing-directory');
  return out.sort();
}

function stringList(value: unknown): string[] {
  const values = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  return [...new Set(values.map(String).map(item => item.trim()).filter(Boolean))];
}

function scanKnowhow(projectRoot: string): Map<string, KnowhowNode> {
  const byId = new Map<string, KnowhowNode>();
  for (const filePath of listMarkdownFiles(projectRoot, getKnowhowDir(projectRoot))) {
    const filename = basename(filePath);
    const id = knowhowFileToWikiId(filename);
    if (byId.has(id)) throw new Error(`Duplicate knowhow id: ${id}`);
    const safeFilePath = resolveLifecyclePath(projectRoot, filePath, 'existing-file');
    const raw = readFileSync(safeFilePath, 'utf8');
    resolveLifecyclePath(projectRoot, safeFilePath, 'existing-file');
    const { data } = parseFrontmatter(raw);
    byId.set(id, {
      id,
      filename,
      filePath: safeFilePath,
      relativePath: relativePath(projectRoot, safeFilePath),
      raw,
      data,
    });
  }
  return byId;
}

function yamlValue(value: string): string {
  return JSON.stringify(value);
}

function setFrontmatterValues(
  raw: string,
  values: Record<string, string | string[]>,
): string {
  const normalized = raw.replace(/\r\n?/g, '\n');
  const lines = normalized.split('\n');
  if (lines[0]?.trim() !== '---') throw new Error('Knowhow entry is missing YAML frontmatter');
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  if (end < 0) throw new Error('Knowhow entry has unterminated YAML frontmatter');

  for (const [key, value] of Object.entries(values)) {
    const next = Array.isArray(value)
      ? `${key}: ${JSON.stringify(value)}`
      : `${key}: ${yamlValue(value)}`;
    const index = lines.findIndex((line, lineIndex) => (
      lineIndex > 0
      && lineIndex < end
      && line.match(/^([^:#]+):/)?.[1].trim() === key
    ));
    if (index >= 0) lines[index] = next;
    else {
      lines.splice(end, 0, next);
    }
  }
  return lines.join('\n');
}

function successorMap(nodes: Map<string, KnowhowNode>): Map<string, string> {
  const out = new Map<string, string>();
  for (const node of nodes.values()) {
    const direct = typeof node.data.supersededBy === 'string' ? node.data.supersededBy : undefined;
    if (direct) out.set(node.id, direct);
    for (const predecessor of stringList(node.data.supersedes)) {
      const existing = out.get(predecessor);
      if (existing && existing !== node.id) {
        throw new Error(`${predecessor} has conflicting successors: ${existing}, ${node.id}`);
      }
      out.set(predecessor, node.id);
    }
  }
  return out;
}

function wouldCreateCycle(successors: Map<string, string>, oldId: string, newId: string): boolean {
  const seen = new Set<string>();
  let current: string | undefined = newId;
  while (current && !seen.has(current)) {
    if (current === oldId) return true;
    seen.add(current);
    current = successors.get(current);
  }
  return false;
}

function lifecycleIntentPath(projectRoot: string): string {
  return join(getKnowhowDir(projectRoot), LIFECYCLE_INTENT);
}

export function assertLifecycleIntent(
  projectRoot: string,
  value: LifecycleIntent,
): void {
  if (value.schema_version !== 'knowhow-lifecycle-intent/1.0'
    || value.operation !== 'supersede'
    || typeof value.oldId !== 'string'
    || typeof value.newId !== 'string'
    || value.oldId === value.newId
    || !Array.isArray(value.targets)
    || value.targets.length !== 2) {
    throw new Error('Invalid knowhow lifecycle intent');
  }

  const nodes = scanKnowhow(projectRoot);
  const oldNode = nodes.get(value.oldId);
  const newNode = nodes.get(value.newId);
  if (!oldNode || !newNode) {
    throw new Error('Lifecycle intent ids do not resolve to canonical knowhow files');
  }
  const expectedNodes = new Map([
    [value.oldId, oldNode],
    [value.newId, newNode],
  ]);
  const seenIds = new Set<string>();
  const seenPaths = new Set<string>();

  for (const target of value.targets) {
    if (!target.path || !target.id || !('beforeHash' in target) || !('afterHash' in target)) {
      throw new Error('Invalid knowhow lifecycle intent target');
    }
    if (target.beforeBase64 === null || target.afterBase64 === null) {
      throw new Error(`Lifecycle supersede target must preserve a knowhow file: ${target.path}`);
    }
    const before = Buffer.from(target.beforeBase64, 'base64');
    const after = Buffer.from(target.afterBase64, 'base64');
    if (sha256(before) !== target.beforeHash) {
      throw new Error(`Lifecycle intent before hash is invalid: ${target.path}`);
    }
    if (sha256(after) !== target.afterHash) {
      throw new Error(`Lifecycle intent after hash is invalid: ${target.path}`);
    }

    const expectedNode = expectedNodes.get(target.id);
    if (!expectedNode || seenIds.has(target.id)) {
      throw new Error(`Lifecycle intent target id is not bound to the supersede pair: ${target.id}`);
    }
    const canonicalTarget = resolveLifecyclePath(projectRoot, target.path, 'existing-file');
    const canonicalExpected = resolveLifecyclePath(
      projectRoot,
      expectedNode.filePath,
      'existing-file',
    );
    const comparableTarget = comparablePath(canonicalTarget);
    if (comparableTarget !== comparablePath(canonicalExpected)
      || seenPaths.has(comparableTarget)) {
      throw new Error(`Lifecycle intent target path is not canonical for ${target.id}: ${target.path}`);
    }

    const beforeRaw = before.toString('utf8');
    const expectedAfter = target.id === value.oldId
      ? setFrontmatterValues(beforeRaw, {
        status: 'deprecated',
        supersededBy: value.newId,
      })
      : setFrontmatterValues(beforeRaw, {
        supersedes: [...new Set([
          ...stringList(parseFrontmatter(beforeRaw).data.supersedes),
          value.oldId,
        ])].sort(),
      });
    if (!after.equals(Buffer.from(expectedAfter, 'utf8'))) {
      throw new Error(`Lifecycle intent after bytes exceed the allowed supersede transform: ${target.path}`);
    }
    seenIds.add(target.id);
    seenPaths.add(comparableTarget);
  }
  if (seenIds.size !== expectedNodes.size) {
    throw new Error('Lifecycle intent targets do not exactly match oldId/newId');
  }
}

function writeTarget(
  projectRoot: string,
  target: LifecycleIntentTarget,
  expectedHash: ContentHash,
  contentBase64: string | null,
): void {
  const path = resolveLifecyclePath(projectRoot, target.path, 'write-target');
  if (hashFile(projectRoot, path) !== expectedHash) {
    throw new Error(`Concurrent modification detected: ${target.path}`);
  }
  if (contentBase64 === null) {
    removeLifecycleFile(projectRoot, path);
    return;
  }
  const content = Buffer.from(contentBase64, 'base64').toString('utf8');
  resolveLifecyclePath(projectRoot, path, 'write-target');
  updateLifecycleFileAtomic(projectRoot, path, current => {
    const currentHash = current === null ? null : sha256(Buffer.from(current, 'utf8'));
    if (currentHash !== expectedHash) throw new Error(`Concurrent modification detected: ${target.path}`);
    return content;
  });
  resolveLifecyclePath(projectRoot, path, 'existing-file');
}

function recoverLifecycleUnlocked(projectRoot: string, options?: LifecycleFaultOptions): boolean {
  const intentPath = resolveLifecyclePath(
    projectRoot,
    lifecycleIntentPath(projectRoot),
    'delete-target',
  );
  if (!existsSync(intentPath)) return false;
  const intent = readJson<LifecycleIntent>(projectRoot, intentPath);
  assertLifecycleIntent(projectRoot, intent);
  let completed = 0;
  for (const target of [...intent.targets].sort((left, right) => left.id.localeCompare(right.id))) {
    const path = resolveLifecyclePath(projectRoot, target.path, 'existing-file');
    const currentHash = hashFile(projectRoot, path);
    if (currentHash === target.afterHash) {
      completed++;
      continue;
    }
    if (currentHash !== target.beforeHash) {
      throw new Error(
        `KNOWHOW_LIFECYCLE_CONFLICT: ${target.path} expected ${target.beforeHash} or ${target.afterHash}, got ${currentHash}`,
      );
    }
    writeTarget(projectRoot, target, target.beforeHash, target.afterBase64);
    completed++;
    options?.afterTarget?.(target.path, completed);
  }
  removeLifecycleFile(projectRoot, intentPath);
  return true;
}

function assertHistoryRecoveryNotRequired(projectRoot: string): void {
  const intentPath = resolveLifecyclePath(
    projectRoot,
    lifecycleIntentPath(projectRoot),
    'delete-target',
  );
  if (existsSync(intentPath)) {
    resolveLifecyclePath(projectRoot, intentPath, 'existing-file');
    throw new Error(
      `KNOWHOW_LIFECYCLE_RECOVERY_REQUIRED: run "maestro knowhow recover" before reading history`,
    );
  }
}

export function recoverKnowhowLifecycleIntent(
  projectRoot: string,
  options?: LifecycleFaultOptions,
): KnowhowLifecycleResult {
  try {
    const replayed = withLifecycleLock(
      projectRoot,
      () => recoverLifecycleUnlocked(projectRoot, options),
      options,
    );
    return { success: true, replayed };
  } catch (error) {
    return {
      success: false,
      code: 'KNOWHOW_LIFECYCLE_CONFLICT',
      error: (error as Error).message,
    };
  }
}

export function supersedeKnowhowEntry(
  projectRoot: string,
  oldId: string,
  newId: string,
  options?: LifecycleFaultOptions,
): KnowhowLifecycleResult {
  try {
    return withLifecycleLock(projectRoot, () => {
      recoverLifecycleUnlocked(projectRoot);
      if (oldId === newId) throw new Error(`Cannot supersede a knowhow id with itself: ${oldId}`);

      const nodes = scanKnowhow(projectRoot);
      const oldNode = nodes.get(oldId);
      const newNode = nodes.get(newId);
      if (!oldNode) throw new Error(`Knowhow id not found: ${oldId}`);
      if (!newNode) throw new Error(`Knowhow id not found: ${newId}`);

      const successors = successorMap(nodes);
      const existingSuccessor = successors.get(oldId);
      if (existingSuccessor && existingSuccessor !== newId) {
        throw new Error(`${oldId} is already superseded by ${existingSuccessor}`);
      }
      if (wouldCreateCycle(successors, oldId, newId)) {
        throw new Error(`Superseding ${oldId} by ${newId} would create a cycle`);
      }

      const newPredecessors = stringList(newNode.data.supersedes);
      const completePair = existingSuccessor === newId
        && newPredecessors.includes(oldId)
        && oldNode.data.status === 'deprecated'
        && oldNode.data.supersededBy === newId;
      if (completePair) {
        return {
          success: true,
          schema_version: 'knowhow-supersede-result/1.0',
          operation: 'supersede',
          oldId,
          newId,
          replayed: true,
        };
      }

      const oldAfter = setFrontmatterValues(oldNode.raw, {
        status: 'deprecated',
        supersededBy: newId,
      });
      const newAfter = setFrontmatterValues(newNode.raw, {
        supersedes: [...new Set([...newPredecessors, oldId])].sort(),
      });
      const targetDocuments = [
        { node: oldNode, after: oldAfter },
        { node: newNode, after: newAfter },
      ].sort((left, right) => left.node.id.localeCompare(right.node.id));
      const intent: LifecycleIntent = {
        schema_version: 'knowhow-lifecycle-intent/1.0',
        operation: 'supersede',
        oldId,
        newId,
        targets: targetDocuments.map(({ node, after }) => ({
          id: node.id,
          path: node.relativePath,
          beforeHash: sha256(Buffer.from(node.raw, 'utf8')),
          afterHash: sha256(Buffer.from(after, 'utf8')),
          beforeBase64: Buffer.from(node.raw, 'utf8').toString('base64'),
          afterBase64: Buffer.from(after, 'utf8').toString('base64'),
        })),
      };
      writeJsonAtomic(projectRoot, lifecycleIntentPath(projectRoot), intent);
      let completed = 0;
      for (const target of intent.targets) {
        writeTarget(projectRoot, target, target.beforeHash, target.afterBase64);
        completed++;
        options?.afterTarget?.(target.path, completed);
      }
      removeLifecycleFile(projectRoot, lifecycleIntentPath(projectRoot));
      return {
        success: true,
        schema_version: 'knowhow-supersede-result/1.0',
        operation: 'supersede',
        oldId,
        newId,
        replayed: false,
      };
    }, options);
  } catch (error) {
    return {
      success: false,
      code: 'KNOWHOW_LIFECYCLE_CONFLICT',
      error: (error as Error).message,
    };
  }
}

export function getKnowhowEvolutionChain(
  projectRoot: string,
  id: string,
): KnowhowEvolutionLink[] {
  assertHistoryRecoveryNotRequired(projectRoot);
  const nodes = scanKnowhow(projectRoot);
  assertHistoryRecoveryNotRequired(projectRoot);
  if (!nodes.has(id)) return [];
  const successors = successorMap(nodes);
  const predecessors = new Map<string, string[]>();
  for (const [oldId, newId] of successors) {
    const values = predecessors.get(newId) ?? [];
    values.push(oldId);
    predecessors.set(newId, values.sort());
  }

  let root = id;
  const backwardGuard = new Set<string>();
  while (!backwardGuard.has(root)) {
    backwardGuard.add(root);
    const previous = predecessors.get(root)?.find(candidate => nodes.has(candidate));
    if (!previous) break;
    root = previous;
  }

  const chain: KnowhowEvolutionLink[] = [];
  const forwardGuard = new Set<string>();
  let current: string | undefined = root;
  while (current && nodes.has(current) && !forwardGuard.has(current)) {
    forwardGuard.add(current);
    const node = nodes.get(current)!;
    const successor: string | null = successors.get(current) ?? null;
    const deprecated = node.data.status === 'deprecated';
    chain.push({
      id: current,
      filename: node.filename,
      path: node.relativePath.replace(/^\.workflow\//, ''),
      title: typeof node.data.title === 'string' ? node.data.title : 'Untitled',
      deprecated,
      current: false,
      broken: successor !== null && !nodes.has(successor),
      supersedes: stringList(node.data.supersedes),
      supersededBy: successor,
    });
    current = successor ?? undefined;
  }
  if (chain.length > 0) {
    const tail = chain[chain.length - 1];
    if (!tail.deprecated && !tail.broken) tail.current = true;
    else if (tail.deprecated && !tail.supersededBy) tail.broken = true;
  }
  return chain;
}

function resolveSnapshotPath(
  projectRoot: string,
  path: string,
  expected: LifecyclePathExpectation,
): string {
  return resolveLifecyclePath(projectRoot, path, expected);
}

function resolveSnapshotTargetInput(projectRoot: string, path: string): string {
  const normalized = path.replaceAll('\\', '/');
  return normalized.startsWith('knowhow/')
    ? resolveLifecyclePath(projectRoot, join('.workflow', normalized), 'delete-target')
    : resolveLifecyclePath(projectRoot, path, 'delete-target');
}

function captureSnapshotTarget(projectRoot: string, path: string): KnowhowSnapshotTarget {
  const absolute = resolveLifecyclePath(projectRoot, path, 'delete-target');
  const present = existsSync(absolute);
  const content = present
    ? readFileSync(resolveLifecyclePath(projectRoot, absolute, 'existing-file'))
    : null;
  if (present) resolveLifecyclePath(projectRoot, absolute, 'existing-file');
  return {
    path: relativePath(projectRoot, absolute),
    beforeHash: content ? sha256(content) : null,
    beforeBase64: content?.toString('base64') ?? null,
    afterHash: null,
    expectedAbsent: !present,
  };
}

function assertSnapshot(snapshot: KnowhowLifecycleSnapshot): void {
  if (snapshot.schema_version !== 'knowhow-lifecycle-snapshot/1.0'
    || !Array.isArray(snapshot.targets)) {
    throw new Error('Invalid knowhow lifecycle snapshot');
  }
  for (const target of snapshot.targets) {
    if (target.beforeBase64 !== null
      && sha256(Buffer.from(target.beforeBase64, 'base64')) !== target.beforeHash) {
      throw new Error(`Snapshot before hash is invalid: ${target.path}`);
    }
    if ((target.beforeBase64 === null) !== target.expectedAbsent) {
      throw new Error(`Snapshot absence marker is invalid: ${target.path}`);
    }
  }
}

export function createKnowhowLifecycleSnapshot(
  projectRoot: string,
  options: CreateKnowhowSnapshotOptions,
): KnowhowLifecycleSnapshot {
  return withLifecycleLock(projectRoot, () => {
    recoverLifecycleUnlocked(projectRoot);
    const nodes = scanKnowhow(projectRoot);
    const oldNode = nodes.get(options.oldId);
    if (!oldNode) throw new Error(`Knowhow id not found: ${options.oldId}`);

    const paths = [
      oldNode.relativePath,
      options.newPath,
      ...(options.includeRelative ?? []),
    ];
    const uniquePaths = [...new Set(paths.map(path => relativePath(
      projectRoot,
      resolveSnapshotTargetInput(projectRoot, path),
    )))].sort();
    const snapshot: KnowhowLifecycleSnapshot = {
      schema_version: 'knowhow-lifecycle-snapshot/1.0',
      createdAt: new Date().toISOString(),
      sealedAt: null,
      oldId: options.oldId,
      newId: options.newId,
      targets: uniquePaths.map(path => captureSnapshotTarget(projectRoot, path)),
    };
    const out = resolveSnapshotPath(projectRoot, options.out, 'write-target');
    ensureLifecycleDirectory(projectRoot, dirname(out));
    resolveLifecyclePath(projectRoot, out, 'write-target');
    if (existsSync(out)) throw new Error(`Snapshot already exists: ${relativePath(projectRoot, out)}`);
    writeJsonAtomic(projectRoot, out, snapshot);
    return snapshot;
  });
}

export function sealKnowhowLifecycleSnapshot(
  projectRoot: string,
  snapshotPath: string,
): KnowhowLifecycleSnapshot {
  return withLifecycleLock(projectRoot, () => {
    recoverLifecycleUnlocked(projectRoot);
    const path = resolveSnapshotPath(projectRoot, snapshotPath, 'existing-file');
    const snapshot = readJson<KnowhowLifecycleSnapshot>(projectRoot, path);
    assertSnapshot(snapshot);
    if (snapshot.sealedAt) return snapshot;
    const sealed: KnowhowLifecycleSnapshot = {
      ...snapshot,
      sealedAt: new Date().toISOString(),
      targets: snapshot.targets.map(target => ({
        ...target,
        afterHash: hashFile(
          projectRoot,
          resolveLifecyclePath(projectRoot, target.path, 'delete-target'),
        ),
      })),
    };
    writeJsonAtomic(projectRoot, path, sealed);
    return sealed;
  });
}

function restorePaths(snapshotPath: string): { intentPath: string; receiptPath: string } {
  return {
    intentPath: `${snapshotPath}.restore.intent.json`,
    receiptPath: `${snapshotPath}.restore.receipt.json`,
  };
}

function restoreRequestPayload(intent: Pick<
  KnowhowRestoreIntent,
  'requestId' | 'operation' | 'subject' | 'claimedRun' | 'targets'
>): unknown {
  return {
    requestId: intent.requestId,
    operation: intent.operation,
    subject: intent.subject,
    claimedRun: intent.claimedRun,
    targets: intent.targets.map(target => ({
      path: target.path,
      beforeHash: target.beforeHash,
      afterHash: target.afterHash,
      restoreHash: target.restoreHash,
    })),
  };
}

function restoreResultPayload(intent: KnowhowRestoreIntent): unknown {
  return {
    status: intent.status,
    targets: intent.targets.map(target => ({
      path: target.path,
      restoreHash: target.restoreHash,
      completed: target.completed,
    })),
    conflict: intent.conflict,
  };
}

function assertRestoreIntent(intent: KnowhowRestoreIntent): void {
  if (intent.schema_version !== 'knowhow-restore-intent/1.0'
    || intent.operation !== 'restore'
    || !Array.isArray(intent.targets)
    || sha256(stableJson(restoreRequestPayload(intent))) !== intent.requestHash) {
    throw new Error('Invalid or unbound knowhow restore intent');
  }
}

function createRestoreReceipt(intent: KnowhowRestoreIntent): KnowhowRestoreReceipt {
  return {
    schema_version: 'knowhow-restore-receipt/1.0',
    requestId: intent.requestId,
    operation: intent.operation,
    status: intent.status === 'conflict' ? 'conflict' : 'completed',
    subject: intent.subject,
    claimedRun: intent.claimedRun,
    requestHash: intent.requestHash,
    resultHash: sha256(stableJson(restoreResultPayload(intent))),
    targets: intent.targets.map(target => ({ ...target })),
    ...(intent.conflict ? { conflict: { ...intent.conflict } } : {}),
  };
}

function assertRestoreReceipt(
  receipt: KnowhowRestoreReceipt,
  intent: KnowhowRestoreIntent,
): void {
  if (receipt.schema_version !== 'knowhow-restore-receipt/1.0'
    || receipt.requestId !== intent.requestId
    || receipt.operation !== intent.operation
    || receipt.status !== intent.status
    || receipt.subject !== intent.subject
    || receipt.claimedRun !== intent.claimedRun
    || receipt.requestHash !== intent.requestHash
    || stableJson(receipt.targets) !== stableJson(intent.targets)
    || receipt.resultHash !== sha256(stableJson(restoreResultPayload(intent)))) {
    throw new Error('Invalid or unbound knowhow restore receipt');
  }
}

function markRestoreConflict(
  projectRoot: string,
  intentPath: string,
  receiptPath: string,
  intent: KnowhowRestoreIntent,
  target: RestoreTargetState,
  expectedHash: ContentHash,
  actualHash: ContentHash,
): RestoreKnowhowResult {
  intent.status = 'conflict';
  intent.conflict = { path: target.path, expectedHash, actualHash };
  writeJsonAtomic(projectRoot, intentPath, intent);
  const receipt = createRestoreReceipt(intent);
  writeJsonAtomic(projectRoot, receiptPath, receipt);
  return {
    success: false,
    replayed: false,
    intent,
    receipt,
    code: 'KNOWHOW_RESTORE_CONFLICT',
    error: `Restore conflict at ${target.path}: expected ${expectedHash}, got ${actualHash}`,
  };
}

function restoreTarget(
  projectRoot: string,
  snapshotTarget: KnowhowSnapshotTarget,
  target: RestoreTargetState,
): void {
  const path = resolveLifecyclePath(projectRoot, target.path, 'delete-target');
  const currentHash = hashFile(projectRoot, path);
  if (currentHash !== target.afterHash) {
    throw new Error(`Restore fence changed before write: ${target.path}`);
  }
  if (snapshotTarget.beforeBase64 === null) {
    removeLifecycleFile(projectRoot, path);
  } else {
    const content = Buffer.from(snapshotTarget.beforeBase64, 'base64').toString('utf8');
    resolveLifecyclePath(projectRoot, path, 'write-target');
    updateLifecycleFileAtomic(projectRoot, path, current => {
      const currentHashInside = current === null ? null : sha256(Buffer.from(current, 'utf8'));
      if (currentHashInside !== target.afterHash) {
        throw new Error(`Restore fence changed before write: ${target.path}`);
      }
      return content;
    });
    resolveLifecyclePath(projectRoot, path, 'existing-file');
  }
  if (hashFile(projectRoot, path) !== target.restoreHash) {
    throw new Error(`Restore output hash mismatch: ${target.path}`);
  }
}

export function restoreKnowhowLifecycleSnapshot(
  projectRoot: string,
  snapshotPathInput: string,
  options?: RestoreKnowhowOptions,
): RestoreKnowhowResult {
  try {
    return withLifecycleLock(projectRoot, () => {
      recoverLifecycleUnlocked(projectRoot);
      const snapshotPath = resolveSnapshotPath(projectRoot, snapshotPathInput, 'existing-file');
      const snapshot = readJson<KnowhowLifecycleSnapshot>(projectRoot, snapshotPath);
      assertSnapshot(snapshot);
      if (!snapshot.sealedAt) throw new Error('Knowhow lifecycle snapshot must be sealed before restore');
      for (const target of snapshot.targets) {
        resolveLifecyclePath(projectRoot, target.path, 'delete-target');
      }

      const rawRestorePaths = restorePaths(snapshotPath);
      const intentPath = resolveLifecyclePath(
        projectRoot,
        rawRestorePaths.intentPath,
        'write-target',
      );
      const receiptPath = resolveLifecyclePath(
        projectRoot,
        rawRestorePaths.receiptPath,
        'write-target',
      );
      let intent: KnowhowRestoreIntent;
      let replayed = false;
      if (existsSync(intentPath)) {
        intent = readJson<KnowhowRestoreIntent>(projectRoot, intentPath);
        assertRestoreIntent(intent);
        replayed = true;
      } else {
        const subject = relativePath(projectRoot, snapshotPath);
        const claimedRun = options?.claimedRun
          ?? process.env.MAESTRO_RUN_ID
          ?? 'standalone';
        const targets: RestoreTargetState[] = snapshot.targets
          .map(target => ({
            path: target.path,
            beforeHash: target.beforeHash,
            afterHash: target.afterHash,
            restoreHash: target.beforeHash,
            completed: false,
          }))
          .sort((left, right) => left.path.localeCompare(right.path));
        const base = {
          requestId: `restore_${randomUUID()}`,
          operation: 'restore' as const,
          subject,
          claimedRun,
          targets,
        };
        intent = {
          schema_version: 'knowhow-restore-intent/1.0',
          ...base,
          status: 'pending',
          requestHash: sha256(stableJson(restoreRequestPayload(base))),
        };
        writeJsonAtomic(projectRoot, intentPath, intent);
      }

      if (intent.subject !== relativePath(projectRoot, snapshotPath)) {
        throw new Error('Restore intent subject does not match snapshot');
      }
      const snapshotByPath = new Map(snapshot.targets.map(target => [target.path, target]));
      if (intent.targets.length !== snapshot.targets.length
        || intent.targets.some(target => {
          const source = snapshotByPath.get(target.path);
          resolveLifecyclePath(projectRoot, target.path, 'delete-target');
          return !source
            || source.beforeHash !== target.beforeHash
            || source.afterHash !== target.afterHash
            || source.beforeHash !== target.restoreHash;
        })) {
        throw new Error('Restore intent targets do not match snapshot');
      }

      if (intent.status === 'conflict') {
        const receipt = existsSync(receiptPath)
          ? readJson<KnowhowRestoreReceipt>(projectRoot, receiptPath)
          : createRestoreReceipt(intent);
        assertRestoreReceipt(receipt, intent);
        return {
          success: false,
          replayed: true,
          intent,
          receipt,
          code: 'KNOWHOW_RESTORE_CONFLICT',
          error: `Restore remains in conflict at ${intent.conflict?.path ?? 'unknown target'}`,
        };
      }

      for (const target of intent.targets) {
        const actualHash = hashFile(
          projectRoot,
          resolveLifecyclePath(projectRoot, target.path, 'delete-target'),
        );
        const expectedHash = target.completed ? target.restoreHash : target.afterHash;
        if (actualHash !== expectedHash) {
          return markRestoreConflict(
            projectRoot,
            intentPath,
            receiptPath,
            intent,
            target,
            expectedHash,
            actualHash,
          );
        }
      }

      if (intent.status === 'completed') {
        if (!existsSync(receiptPath)) {
          writeJsonAtomic(projectRoot, receiptPath, createRestoreReceipt(intent));
        }
        const receipt = readJson<KnowhowRestoreReceipt>(projectRoot, receiptPath);
        assertRestoreReceipt(receipt, intent);
        return { success: true, replayed: true, intent, receipt };
      }

      let completedCount = intent.targets.filter(target => target.completed).length;
      for (const target of intent.targets) {
        if (target.completed) continue;
        const snapshotTarget = snapshotByPath.get(target.path)!;
        restoreTarget(projectRoot, snapshotTarget, target);
        target.completed = true;
        completedCount++;
        writeJsonAtomic(projectRoot, intentPath, intent);
        options?.afterTarget?.(target.path, completedCount);
      }

      intent.status = 'completed';
      writeJsonAtomic(projectRoot, intentPath, intent);
      const receipt = createRestoreReceipt(intent);
      writeJsonAtomic(projectRoot, receiptPath, receipt);
      assertRestoreReceipt(receipt, intent);
      return { success: true, replayed, intent, receipt };
    }, options);
  } catch (error) {
    let safeSnapshotPath: string | null = null;
    let persistedIntent: KnowhowRestoreIntent | null = null;
    try {
      safeSnapshotPath = resolveSnapshotPath(projectRoot, snapshotPathInput, 'delete-target');
      const candidateIntentPath = resolveLifecyclePath(
        projectRoot,
        restorePaths(safeSnapshotPath).intentPath,
        'delete-target',
      );
      if (existsSync(candidateIntentPath)) {
        persistedIntent = readJson<KnowhowRestoreIntent>(projectRoot, candidateIntentPath);
      }
    } catch {
      safeSnapshotPath = null;
      persistedIntent = null;
    }
    const fallback: KnowhowRestoreIntent = persistedIntent ?? {
        schema_version: 'knowhow-restore-intent/1.0',
        requestId: '',
        operation: 'restore',
        status: 'conflict',
        subject: safeSnapshotPath
          ? relativePath(projectRoot, safeSnapshotPath)
          : snapshotPathInput.replaceAll('\\', '/'),
        claimedRun: options?.claimedRun ?? 'standalone',
        requestHash: '',
        targets: [],
      };
    return {
      success: false,
      replayed: persistedIntent !== null,
      intent: fallback,
      code: 'KNOWHOW_RESTORE_FAILED',
      error: (error as Error).message,
    };
  }
}

export function recoverKnowhowRestoreIntent(
  projectRoot: string,
  snapshotPath: string,
  options?: RestoreKnowhowOptions,
): RestoreKnowhowResult {
  return restoreKnowhowLifecycleSnapshot(projectRoot, snapshotPath, options);
}
