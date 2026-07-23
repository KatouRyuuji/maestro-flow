import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';

import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { registerKnowhowCommand } from '../../commands/knowhow.js';
import {
  normalizeKnowhowReplayPayload,
  resolveKnowhowFilename,
} from '../../utils/frontmatter.js';
import {
  createKnowhowLifecycleSnapshot,
  getKnowhowEvolutionChain,
  recoverKnowhowLifecycleIntent,
  resolveLifecyclePath,
  restoreKnowhowLifecycleSnapshot,
  sealKnowhowLifecycleSnapshot,
  supersedeKnowhowEntry,
} from '../knowhow-lifecycle.js';
import * as lifecycleAsync from '../knowhow-lifecycle-async.js';
import { handler } from '../store-knowhow.js';

const OLD_STEM = 'tip-20260723-old-rule';
const NEW_STEM = 'tip-20260723-new-rule';
const THIRD_STEM = 'tip-20260723-third-rule';
const OLD_ID = `knowhow-${OLD_STEM}`;
const NEW_ID = `knowhow-${NEW_STEM}`;
const THIRD_ID = `knowhow-${THIRD_STEM}`;

describe('knowhow replay-safe lifecycle', () => {
  let root: string;
  const externalRoots: string[] = [];
  let previousRoot: string | undefined;
  let previousExitCode: number | string | null | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'maestro-knowhow-lifecycle-'));
    previousRoot = process.env.MAESTRO_PROJECT_ROOT;
    previousExitCode = process.exitCode;
    process.env.MAESTRO_PROJECT_ROOT = root;
    process.exitCode = undefined;
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-23T01:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    if (previousRoot === undefined) delete process.env.MAESTRO_PROJECT_ROOT;
    else process.env.MAESTRO_PROJECT_ROOT = previousRoot;
    process.exitCode = previousExitCode;
    rmSync(root, { recursive: true, force: true });
    for (const externalRoot of externalRoots.splice(0)) {
      rmSync(externalRoot, { recursive: true, force: true });
    }
  });

  function knowhowDir(): string {
    return join(root, '.workflow', 'knowhow');
  }

  function pathFor(stem: string): string {
    const prefix = stem.slice(0, 3).toUpperCase();
    return join(knowhowDir(), `${prefix}${stem.slice(3)}.md`);
  }

  function lifecycleLockPath(): string {
    return join(knowhowDir(), '.lifecycle.lock');
  }

  function writeLifecycleLock(pid: number, token: string, acquiredAt = Date.now()): Buffer {
    mkdirSync(knowhowDir(), { recursive: true });
    const bytes = Buffer.from(JSON.stringify({
      schema_version: 'knowhow-lifecycle-lock/1.0',
      token,
      pid,
      acquiredAt,
    }), 'utf8');
    writeFileSync(lifecycleLockPath(), bytes);
    return bytes;
  }

  function advanceLifecycleLockClock(): void {
    vi.spyOn(Atomics, 'wait').mockImplementation((_array, _index, _value, timeout) => {
      vi.setSystemTime(new Date(Date.now() + Number(timeout ?? 0)));
      return 'timed-out';
    });
  }

  async function add(stem: string, overrides: Record<string, unknown> = {}) {
    return handler({
      operation: 'add',
      id: stem,
      type: 'tip',
      title: stem,
      description: 'stable description',
      category: 'coding',
      keywords: ['beta', 'alpha'],
      tags: ['two', 'one'],
      body: 'stable body',
      ...overrides,
    });
  }

  async function seedPair(): Promise<void> {
    expect((await add(OLD_STEM)).success).toBe(true);
    expect((await add(NEW_STEM)).success).toBe(true);
  }

  function sha256(value: string | Buffer): string {
    return `sha256:${createHash('sha256').update(value).digest('hex')}`;
  }

  function treeState(path: string, base = path): Array<{
    path: string;
    type: 'directory' | 'file';
    mtimeMs: number;
    bytes?: string;
  }> {
    if (!existsSync(path)) return [];
    const state: ReturnType<typeof treeState> = [];
    for (const name of readdirSync(path).sort()) {
      const child = join(path, name);
      const stat = lstatSync(child);
      const itemPath = relative(base, child).replaceAll('\\', '/');
      if (stat.isDirectory()) {
        state.push({ path: itemPath, type: 'directory', mtimeMs: stat.mtimeMs });
        state.push(...treeState(child, base));
      } else {
        state.push({
          path: itemPath,
          type: 'file',
          mtimeMs: stat.mtimeMs,
          bytes: readFileSync(child).toString('base64'),
        });
      }
    }
    return state;
  }

  function tryCreateSymlink(
    target: string,
    path: string,
    type: 'file' | 'dir' | 'junction',
  ): boolean {
    try {
      symlinkSync(target, path, type);
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (process.platform === 'win32' && (code === 'EPERM' || code === 'EACCES')) {
        return false;
      }
      throw error;
    }
  }

  it('normalizes only caller-owned fields with fixed set and newline semantics', () => {
    const first = normalizeKnowhowReplayPayload({
      type: 'tip',
      category: undefined,
      title: 'T',
      keywords: [' b ', 'a', 'a'],
      tags: ['z', ' y ', 'z'],
      body: 'line 1\r\nline 2\r\n\r\n',
      explicitId: 'TIP-20260723-X',
      created: 'date-a',
      updated: 'date-b',
      status: 'deprecated',
      indexScore: 42,
    });
    const second = normalizeKnowhowReplayPayload({
      type: 'tip',
      category: null,
      title: 'T',
      keywords: ['a', 'b'],
      tags: ['y', 'z'],
      body: 'line 1\nline 2\n',
      explicitId: 'tip-20260723-x',
      created: 'other',
    });

    expect(first).toEqual(second);
    expect(JSON.parse(first.canonical)).toEqual({
      type: 'tip',
      category: null,
      title: 'T',
      description: null,
      keywords: ['a', 'b'],
      tags: ['y', 'z'],
      body: 'line 1\nline 2\n',
      explicitId: 'tip-20260723-x',
    });
  });

  it('resolves explicit ids independently of title and clock', () => {
    vi.setSystemTime(new Date('2027-12-31T23:59:59.000Z'));
    expect(resolveKnowhowFilename('recipe', 'ignored', 'rcp-20260723-stable-entry')).toEqual({
      id: 'knowhow-rcp-20260723-stable-entry',
      filename: 'RCP-20260723-stable-entry.md',
      explicitId: 'rcp-20260723-stable-entry',
    });
  });

  it('preserves created, bytes, size and mtime across a later-date replay', async () => {
    const first = await add(OLD_STEM);
    expect(first.success).toBe(true);
    expect(first.result).toMatchObject({
      schema_version: 'knowhow-add-result/1.0',
      id: OLD_ID,
      filename: 'TIP-20260723-old-rule.md',
      path: 'knowhow/TIP-20260723-old-rule.md',
      created: '2026-07-23T01:00:00.000Z',
      replayed: false,
    });
    const path = pathFor(OLD_STEM);
    const before = readFileSync(path);
    const beforeStat = statSync(path);

    vi.setSystemTime(new Date('2026-08-24T02:00:00.000Z'));
    const replay = await add(OLD_STEM, {
      keywords: ['alpha', 'beta', 'alpha'],
      tags: ['one', 'two', 'one'],
      body: 'stable body\r\n',
    });
    expect(replay.success).toBe(true);
    expect(replay.result).toMatchObject({
      created: '2026-07-23T01:00:00.000Z',
      replayed: true,
    });
    expect(readFileSync(path)).toEqual(before);
    const afterStat = statSync(path);
    expect(afterStat.size).toBe(beforeStat.size);
    expect(afterStat.mtimeMs).toBe(beforeStat.mtimeMs);
  });

  it.each([
    ['type', { type: 'recipe' }],
    ['category', { category: 'arch' }],
    ['title', { title: 'different title' }],
    ['description', { description: 'different description' }],
    ['keywords', { keywords: ['different'] }],
    ['tags', { tags: ['different'] }],
    ['body', { body: 'different body' }],
  ])('fails closed for divergent caller field %s', async (_field, override) => {
    await add(OLD_STEM);
    const path = pathFor(OLD_STEM);
    const before = readFileSync(path);
    const listing = readdirSync(knowhowDir()).sort();
    const result = await add(OLD_STEM, override);
    expect(result.success).toBe(false);
    expect(result.error).toContain('CALLER_PAYLOAD_CONFLICT');
    expect(readFileSync(path)).toEqual(before);
    expect(readdirSync(knowhowDir()).sort()).toEqual(listing);
  });

  it('ignores server-owned metadata without rewriting it during replay', async () => {
    await add(OLD_STEM);
    const path = pathFor(OLD_STEM);
    const changed = readFileSync(path, 'utf8')
      .replace('created: 2026-07-23T01:00:00.000Z', 'created: 2020-01-01T00:00:00.000Z')
      .replace('---\n\n', 'updated: 2030-01-01T00:00:00.000Z\nindexRank: 7\n---\n\n');
    writeFileSync(path, changed, 'utf8');
    const before = readFileSync(path);

    const result = await add(OLD_STEM);
    expect(result.success).toBe(true);
    expect(result.result).toMatchObject({
      replayed: true,
      created: '2020-01-01T00:00:00.000Z',
    });
    expect(readFileSync(path)).toEqual(before);
  });

  it('enforces the CLI body/body-file XOR before creating files', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const invoke = async (...args: string[]) => {
      process.exitCode = undefined;
      const program = new Command();
      registerKnowhowCommand(program);
      await program.parseAsync(['node', 'maestro', 'knowhow', 'add', ...args]);
      return process.exitCode;
    };
    expect(await invoke('--type', 'tip', '--title', 'none')).toBe(1);
    expect(existsSync(knowhowDir())).toBe(false);
    expect(await invoke(
      '--type', 'tip', '--title', 'both', '--body', 'inline',
      '--body-file', join(root, 'missing.md'),
    )).toBe(1);
    expect(existsSync(knowhowDir())).toBe(false);

    expect(await invoke(
      '--type', 'tip', '--id', OLD_STEM, '--title', 'inline', '--body', 'inline',
    )).toBeUndefined();
    writeFileSync(join(root, 'body.md'), 'from file', 'utf8');
    expect(await invoke(
      '--type', 'tip', '--id', NEW_STEM, '--title', 'file',
      '--body-file', join(root, 'body.md'),
    )).toBeUndefined();
    expect(readdirSync(knowhowDir()).filter(name => name.endsWith('.md'))).toHaveLength(2);
  });

  it('replays an established pair without changing either document', async () => {
    await seedPair();
    expect(supersedeKnowhowEntry(root, OLD_ID, NEW_ID)).toMatchObject({
      success: true,
      replayed: false,
    });
    const beforeOld = readFileSync(pathFor(OLD_STEM));
    const beforeNew = readFileSync(pathFor(NEW_STEM));

    expect(supersedeKnowhowEntry(root, OLD_ID, NEW_ID)).toMatchObject({
      success: true,
      replayed: true,
    });
    expect(readFileSync(pathFor(OLD_STEM))).toEqual(beforeOld);
    expect(readFileSync(pathFor(NEW_STEM))).toEqual(beforeNew);
    expect(existsSync(join(knowhowDir(), '.lifecycle.intent.json'))).toBe(false);
  });

  it('does not reclaim an aged lock owned by a live PID', () => {
    advanceLifecycleLockClock();
    const lockPath = lifecycleLockPath();
    const bytes = writeLifecycleLock(
      process.pid,
      'aged-live-owner-token',
      Date.now() - 120_000,
    );
    const old = new Date(Date.now() - 120_000);
    utimesSync(lockPath, old, old);

    const result = recoverKnowhowLifecycleIntent(root);

    expect(result).toMatchObject({
      success: false,
      error: expect.stringContaining('Timed out acquiring knowhow lifecycle lock'),
    });
    expect(readFileSync(lockPath)).toEqual(bytes);
  });

  it('treats EPERM as live-or-unknown and reclaims only ESRCH', () => {
    advanceLifecycleLockClock();
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
    });
    const lockPath = lifecycleLockPath();
    const epermBytes = writeLifecycleLock(424_241, 'eperm-owner-token');

    expect(recoverKnowhowLifecycleIntent(root)).toMatchObject({
      success: false,
      error: expect.stringContaining('Timed out acquiring knowhow lifecycle lock'),
    });
    expect(readFileSync(lockPath)).toEqual(epermBytes);

    rmSync(lockPath);
    writeLifecycleLock(424_242, 'dead-owner-token');
    kill.mockImplementation(() => {
      throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
    });

    expect(recoverKnowhowLifecycleIntent(root)).toEqual({
      success: true,
      replayed: false,
    });
    expect(existsSync(lockPath)).toBe(false);
  });

  it('preserves a replacement lock generation on reclaim and release', () => {
    advanceLifecycleLockClock();
    const lockPath = lifecycleLockPath();
    writeLifecycleLock(424_242, 'dead-owner-token');
    const kill = vi.spyOn(process, 'kill').mockImplementation(pid => {
      if (pid === 424_242) {
        throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
      }
      return true;
    });
    let reclaimReplacement = Buffer.alloc(0);

    const reclaim = recoverKnowhowLifecycleIntent(root, {
      beforeLockDelete: phase => {
        if (phase !== 'reclaim') return;
        rmSync(lockPath);
        reclaimReplacement = writeLifecycleLock(
          process.pid,
          'same-pid-reclaim-replacement-token',
        );
      },
    });

    expect(reclaim).toMatchObject({
      success: false,
      error: expect.stringContaining('Timed out acquiring knowhow lifecycle lock'),
    });
    expect(readFileSync(lockPath)).toEqual(reclaimReplacement);

    rmSync(lockPath);
    kill.mockImplementation(() => true);
    let releaseReplacement = Buffer.alloc(0);
    const release = recoverKnowhowLifecycleIntent(root, {
      beforeLockDelete: phase => {
        if (phase !== 'release') return;
        rmSync(lockPath);
        releaseReplacement = writeLifecycleLock(
          process.pid,
          'same-pid-release-replacement-token',
        );
      },
    });

    expect(release).toEqual({ success: true, replayed: false });
    expect(readFileSync(lockPath)).toEqual(releaseReplacement);
  });

  it('keeps CLI lifecycle commands synchronous when the worker is unavailable', async () => {
    await seedPair();
    const worker = vi.spyOn(lifecycleAsync, 'runKnowhowLifecycleAsync')
      .mockRejectedValue(new Error('worker unavailable'));
    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation(value => output.push(String(value)));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const invoke = async (...args: string[]): Promise<Record<string, unknown>> => {
      process.exitCode = undefined;
      const program = new Command();
      registerKnowhowCommand(program);
      await program.parseAsync(['node', 'maestro', 'knowhow', ...args]);
      expect(process.exitCode).toBeUndefined();
      return JSON.parse(output.at(-1) ?? '{}') as Record<string, unknown>;
    };

    expect(await invoke('supersede', OLD_ID, '--by', NEW_ID, '--json')).toMatchObject({
      success: true,
      operation: 'supersede',
      oldId: OLD_ID,
      newId: NEW_ID,
    });
    expect(await invoke('history', OLD_ID, '--json')).toMatchObject({
      schema_version: 'knowhow-history-result/1.0',
      operation: 'history',
      id: OLD_ID,
      entries: [
        { id: OLD_ID },
        { id: NEW_ID },
      ],
    });
    expect(await invoke('recover', '--json')).toMatchObject({
      success: true,
      replayed: false,
    });
    expect(worker).not.toHaveBeenCalled();
  });

  it('rejects an unbound supersede intent without touching targets', async () => {
    await seedPair();
    const packagePath = join(root, 'package.json');
    writeFileSync(packagePath, '{"name":"protected"}\n', 'utf8');
    const crashed = supersedeKnowhowEntry(root, OLD_ID, NEW_ID, {
      afterTarget: (_path, completed) => {
        if (completed === 1) throw new Error('injected crash');
      },
    });
    expect(crashed.success).toBe(false);
    const intentPath = join(knowhowDir(), '.lifecycle.intent.json');
    const intent = JSON.parse(readFileSync(intentPath, 'utf8')) as {
      targets: Array<{
        id: string;
        path: string;
        beforeHash: string | null;
        afterHash: string | null;
        beforeBase64: string | null;
        afterBase64: string | null;
      }>;
    };
    const beforePackage = readFileSync(packagePath);
    const afterPackage = Buffer.from('{"name":"overwritten"}\n', 'utf8');
    intent.targets[0] = {
      ...intent.targets[0],
      path: 'package.json',
      beforeHash: sha256(beforePackage),
      afterHash: sha256(afterPackage),
      beforeBase64: beforePackage.toString('base64'),
      afterBase64: afterPackage.toString('base64'),
    };
    writeFileSync(intentPath, `${JSON.stringify(intent, null, 2)}\n`, 'utf8');
    const protectedPaths = [packagePath, pathFor(OLD_STEM), pathFor(NEW_STEM), intentPath];
    const before = protectedPaths.map(path => ({
      path,
      bytes: readFileSync(path),
      mtimeMs: statSync(path).mtimeMs,
    }));

    expect(recoverKnowhowLifecycleIntent(root)).toMatchObject({
      success: false,
      code: 'KNOWHOW_LIFECYCLE_CONFLICT',
    });
    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation(value => output.push(String(value)));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    process.exitCode = undefined;
    const recoverProgram = new Command();
    registerKnowhowCommand(recoverProgram);
    await recoverProgram.parseAsync(['node', 'maestro', 'knowhow', 'recover', '--json']);
    expect(process.exitCode).toBe(1);
    expect(JSON.parse(output.at(-1) ?? '{}')).toMatchObject({
      success: false,
      code: 'KNOWHOW_LIFECYCLE_CONFLICT',
    });
    for (const item of before) {
      expect(readFileSync(item.path)).toEqual(item.bytes);
      expect(statSync(item.path).mtimeMs).toBe(item.mtimeMs);
    }
    expect(existsSync(join(knowhowDir(), '.lifecycle.lock'))).toBe(false);
  });

  it('keeps history read-only when recovery is pending', async () => {
    await seedPair();
    const crashed = supersedeKnowhowEntry(root, OLD_ID, NEW_ID, {
      afterTarget: (_path, completed) => {
        if (completed === 1) throw new Error('injected crash');
      },
    });
    expect(crashed.success).toBe(false);
    const intentPath = join(knowhowDir(), '.lifecycle.intent.json');
    expect(existsSync(intentPath)).toBe(true);
    const before = treeState(knowhowDir());
    const beforeDirectoryMtime = statSync(knowhowDir()).mtimeMs;
    const expectReadOnlyState = () => {
      expect(treeState(knowhowDir())).toEqual(before);
      expect(statSync(knowhowDir()).mtimeMs).toBe(beforeDirectoryMtime);
      expect(existsSync(join(knowhowDir(), '.lifecycle.lock'))).toBe(false);
    };

    expect(() => getKnowhowEvolutionChain(root, OLD_ID)).toThrow(
      /KNOWHOW_LIFECYCLE_RECOVERY_REQUIRED/,
    );
    expectReadOnlyState();

    const errors: string[] = [];
    const output: string[] = [];
    vi.spyOn(console, 'error').mockImplementation(value => errors.push(String(value)));
    vi.spyOn(console, 'log').mockImplementation(value => output.push(String(value)));
    const historyProgram = new Command();
    registerKnowhowCommand(historyProgram);
    await historyProgram.parseAsync([
      'node', 'maestro', 'knowhow', 'history', OLD_ID, '--json',
    ]);
    expect(process.exitCode).toBe(1);
    expect(errors.at(-1)).toContain('KNOWHOW_LIFECYCLE_RECOVERY_REQUIRED');
    expectReadOnlyState();

    process.exitCode = undefined;
    const toolHistory = await handler({ operation: 'history', id: OLD_ID });
    expect(toolHistory).toMatchObject({ success: false });
    expect(toolHistory.error).toContain('KNOWHOW_LIFECYCLE_RECOVERY_REQUIRED');
    expectReadOnlyState();

    const recoverProgram = new Command();
    registerKnowhowCommand(recoverProgram);
    await recoverProgram.parseAsync(['node', 'maestro', 'knowhow', 'recover', '--json']);
    expect(process.exitCode).toBeUndefined();
    expect(JSON.parse(output.at(-1) ?? '{}')).toMatchObject({
      success: true,
      replayed: true,
    });
    expect(existsSync(intentPath)).toBe(false);

    const readableProgram = new Command();
    registerKnowhowCommand(readableProgram);
    await readableProgram.parseAsync([
      'node', 'maestro', 'knowhow', 'history', OLD_ID, '--json',
    ]);
    expect(JSON.parse(output.at(-1) ?? '{}')).toMatchObject({
      schema_version: 'knowhow-history-result/1.0',
      operation: 'history',
      id: OLD_ID,
      entries: [
        { id: OLD_ID, deprecated: true, current: false },
        { id: NEW_ID, deprecated: false, current: true },
      ],
    });
  });

  it('rejects self links, cycles and a different successor without writing', async () => {
    await seedPair();
    await add(THIRD_STEM);
    const original = new Map(
      [OLD_STEM, NEW_STEM, THIRD_STEM].map(stem => [stem, readFileSync(pathFor(stem))]),
    );
    expect(supersedeKnowhowEntry(root, OLD_ID, OLD_ID).success).toBe(false);
    for (const [stem, bytes] of original) expect(readFileSync(pathFor(stem))).toEqual(bytes);

    expect(supersedeKnowhowEntry(root, OLD_ID, NEW_ID).success).toBe(true);
    const established = new Map(
      [OLD_STEM, NEW_STEM, THIRD_STEM].map(stem => [stem, readFileSync(pathFor(stem))]),
    );
    expect(supersedeKnowhowEntry(root, NEW_ID, OLD_ID).success).toBe(false);
    expect(supersedeKnowhowEntry(root, OLD_ID, THIRD_ID).success).toBe(false);
    for (const [stem, bytes] of established) expect(readFileSync(pathFor(stem))).toEqual(bytes);

    expect(supersedeKnowhowEntry(root, NEW_ID, THIRD_ID).success).toBe(true);
    const threeNode = new Map(
      [OLD_STEM, NEW_STEM, THIRD_STEM].map(stem => [stem, readFileSync(pathFor(stem))]),
    );
    expect(supersedeKnowhowEntry(root, THIRD_ID, OLD_ID).success).toBe(false);
    for (const [stem, bytes] of threeNode) expect(readFileSync(pathFor(stem))).toEqual(bytes);
  });

  function prepareSnapshot(): string {
    const extraPath = join(root, 'src', 'fixture.json');
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(extraPath, 'before fixture', 'utf8');
    const snapshotPath = join(root, '.workflow', 'knowhow', '.snapshots', 'migration.json');
    createKnowhowLifecycleSnapshot(root, {
      oldId: OLD_ID,
      newId: NEW_ID,
      newPath: 'knowhow/TIP-20260723-new-rule.md',
      includeRelative: ['src/fixture.json'],
      out: snapshotPath,
    });
    return snapshotPath;
  }

  it('rejects lifecycle targets through external symlinks', async () => {
    const externalRoot = mkdtempSync(join(tmpdir(), 'maestro-knowhow-external-'));
    externalRoots.push(externalRoot);
    const sentinelPath = join(externalRoot, 'sentinel.txt');
    writeFileSync(sentinelPath, 'external sentinel', 'utf8');
    const sentinelBefore = {
      bytes: readFileSync(sentinelPath),
      mtimeMs: statSync(sentinelPath).mtimeMs,
    };
    const linkPath = join(root, 'external-link');
    const linkCreated = tryCreateSymlink(
      externalRoot,
      linkPath,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    if (!linkCreated) {
      expect(process.platform).toBe('win32');
      return;
    }
    const assertSentinelUnchanged = () => {
      expect(readFileSync(sentinelPath)).toEqual(sentinelBefore.bytes);
      expect(statSync(sentinelPath).mtimeMs).toBe(sentinelBefore.mtimeMs);
    };

    await seedPair();
    const pairBefore = new Map([
      [pathFor(OLD_STEM), readFileSync(pathFor(OLD_STEM))],
      [pathFor(NEW_STEM), readFileSync(pathFor(NEW_STEM))],
    ]);
    expect(supersedeKnowhowEntry(root, OLD_ID, NEW_ID, {
      afterTarget: (_path, completed) => {
        if (completed === 1) throw new Error('injected crash');
      },
    }).success).toBe(false);
    const intentPath = join(knowhowDir(), '.lifecycle.intent.json');
    const intent = JSON.parse(readFileSync(intentPath, 'utf8')) as {
      targets: Array<{ id: string; path: string }>;
    };
    intent.targets[0].path = 'external-link/sentinel.txt';
    writeFileSync(intentPath, `${JSON.stringify(intent, null, 2)}\n`, 'utf8');
    expect(recoverKnowhowLifecycleIntent(root).success).toBe(false);
    assertSentinelUnchanged();
    for (const [path, bytes] of pairBefore) writeFileSync(path, bytes);
    rmSync(intentPath, { force: true });

    expect(() => createKnowhowLifecycleSnapshot(root, {
      oldId: OLD_ID,
      newId: NEW_ID,
      newPath: 'knowhow/TIP-20260723-new-rule.md',
      includeRelative: ['external-link/sentinel.txt'],
      out: join(knowhowDir(), '.snapshots', 'external-create.json'),
    })).toThrow(/Unsafe knowhow lifecycle path/);
    assertSentinelUnchanged();

    const sealSnapshotPath = join(knowhowDir(), '.snapshots', 'external-seal.json');
    createKnowhowLifecycleSnapshot(root, {
      oldId: OLD_ID,
      newId: NEW_ID,
      newPath: 'knowhow/TIP-20260723-new-rule.md',
      out: sealSnapshotPath,
    });
    const sealSnapshot = JSON.parse(readFileSync(sealSnapshotPath, 'utf8')) as {
      targets: Array<{ path: string }>;
    };
    sealSnapshot.targets[0].path = 'external-link/sentinel.txt';
    writeFileSync(sealSnapshotPath, `${JSON.stringify(sealSnapshot, null, 2)}\n`, 'utf8');
    expect(() => sealKnowhowLifecycleSnapshot(root, sealSnapshotPath)).toThrow(
      /Unsafe knowhow lifecycle path/,
    );
    assertSentinelUnchanged();

    const deleteTargetPath = join(root, 'src', 'delete-target.txt');
    const restoreSnapshotPath = join(knowhowDir(), '.snapshots', 'external-restore.json');
    createKnowhowLifecycleSnapshot(root, {
      oldId: OLD_ID,
      newId: NEW_ID,
      newPath: 'src/delete-target.txt',
      out: restoreSnapshotPath,
    });
    mkdirSync(dirname(deleteTargetPath), { recursive: true });
    writeFileSync(deleteTargetPath, 'created after snapshot', 'utf8');
    sealKnowhowLifecycleSnapshot(root, restoreSnapshotPath);
    const sealedRestoreDocument = readFileSync(restoreSnapshotPath, 'utf8');
    const writeSnapshotPath = join(knowhowDir(), '.snapshots', 'external-restore-write.json');
    const writeSnapshot = JSON.parse(sealedRestoreDocument) as {
      targets: Array<{ path: string; expectedAbsent: boolean }>;
    };
    const writeTarget = writeSnapshot.targets.find(target => !target.expectedAbsent);
    expect(writeTarget).toBeDefined();
    writeTarget!.path = 'external-link/sentinel.txt';
    writeFileSync(writeSnapshotPath, `${JSON.stringify(writeSnapshot, null, 2)}\n`, 'utf8');
    expect(restoreKnowhowLifecycleSnapshot(root, writeSnapshotPath)).toMatchObject({
      success: false,
      code: 'KNOWHOW_RESTORE_FAILED',
    });
    assertSentinelUnchanged();

    expect(restoreKnowhowLifecycleSnapshot(
      root,
      join(linkPath, 'sentinel.txt'),
    )).toMatchObject({
      success: false,
      code: 'KNOWHOW_RESTORE_FAILED',
    });
    assertSentinelUnchanged();

    const restoreSnapshot = JSON.parse(sealedRestoreDocument) as {
      targets: Array<{ path: string; expectedAbsent: boolean }>;
    };
    const deleteTarget = restoreSnapshot.targets.find(target => target.expectedAbsent);
    expect(deleteTarget).toBeDefined();
    deleteTarget!.path = 'external-link/sentinel.txt';
    writeFileSync(restoreSnapshotPath, `${JSON.stringify(restoreSnapshot, null, 2)}\n`, 'utf8');
    expect(restoreKnowhowLifecycleSnapshot(root, restoreSnapshotPath)).toMatchObject({
      success: false,
      code: 'KNOWHOW_RESTORE_FAILED',
    });
    assertSentinelUnchanged();
  });

  it.skipIf(process.platform !== 'win32')(
    'rejects a Windows junction outside projectRoot',
    async () => {
      const externalRoot = mkdtempSync(join(tmpdir(), 'maestro-knowhow-junction-'));
      externalRoots.push(externalRoot);
      writeFileSync(join(externalRoot, 'sentinel.txt'), 'junction sentinel', 'utf8');
      const before = treeState(externalRoot);
      const junctionPath = join(root, 'junction');
      symlinkSync(externalRoot, junctionPath, 'junction');
      const missingTarget = join(junctionPath, 'missing-parent', 'snapshot.json');

      expect(() => resolveLifecyclePath(root, missingTarget, 'write-target')).toThrow(
        /symbolic link or junction component/,
      );
      await add(OLD_STEM);
      expect(() => createKnowhowLifecycleSnapshot(root, {
        oldId: OLD_ID,
        newId: NEW_ID,
        newPath: 'knowhow/TIP-20260723-new-rule.md',
        out: missingTarget,
      })).toThrow(/symbolic link or junction component/);
      expect(treeState(externalRoot)).toEqual(before);
    },
  );

  it('keeps in-root lifecycle paths compatible with mixed separators and Windows casing', async () => {
    await add(OLD_STEM);
    const fixturePath = join(root, 'src', 'fixture.json');
    mkdirSync(dirname(fixturePath), { recursive: true });
    writeFileSync(fixturePath, 'before fixture', 'utf8');
    const snapshotPath = join(knowhowDir(), '.snapshots', 'mixed-path.json');
    const mixedSnapshotPath = snapshotPath.replaceAll(sep, sep === '\\' ? '/' : '\\');
    createKnowhowLifecycleSnapshot(root, {
      oldId: OLD_ID,
      newId: NEW_ID,
      newPath: 'knowhow\\TIP-20260723-new-rule.md',
      includeRelative: ['src\\fixture.json'],
      out: mixedSnapshotPath,
    });
    await add(NEW_STEM);
    expect(supersedeKnowhowEntry(root, OLD_ID, NEW_ID).success).toBe(true);
    writeFileSync(fixturePath, 'after fixture', 'utf8');

    const equivalentSnapshotPath = process.platform === 'win32'
      ? mixedSnapshotPath.toUpperCase()
      : mixedSnapshotPath;
    sealKnowhowLifecycleSnapshot(root, equivalentSnapshotPath);
    expect(restoreKnowhowLifecycleSnapshot(root, equivalentSnapshotPath).success).toBe(true);
    expect(readFileSync(fixturePath, 'utf8')).toBe('before fixture');
    expect(existsSync(pathFor(NEW_STEM))).toBe(false);
    expect(resolveLifecyclePath(root, pathFor(OLD_STEM), 'existing-file')).toBe(
      realpathSync.native(pathFor(OLD_STEM)),
    );
  });

  it('restores only pending targets after a crash and writes an auditable receipt', async () => {
    await add(OLD_STEM);
    const oldBefore = readFileSync(pathFor(OLD_STEM));
    const snapshotPath = prepareSnapshot();
    await add(NEW_STEM);
    supersedeKnowhowEntry(root, OLD_ID, NEW_ID);
    writeFileSync(join(root, 'src', 'fixture.json'), 'after fixture', 'utf8');
    sealKnowhowLifecycleSnapshot(root, snapshotPath);

    const completedPaths: string[] = [];
    const first = restoreKnowhowLifecycleSnapshot(root, snapshotPath, {
      claimedRun: 'run-002',
      afterTarget: (path, completed) => {
        completedPaths.push(path);
        if (completed === 1) throw new Error('restore crash');
      },
    });
    expect(first.success).toBe(false);
    expect(completedPaths).toHaveLength(1);

    const secondPaths: string[] = [];
    const second = restoreKnowhowLifecycleSnapshot(root, snapshotPath, {
      claimedRun: 'ignored-on-replay',
      afterTarget: path => secondPaths.push(path),
    });
    expect(second.success).toBe(true);
    expect(second.replayed).toBe(true);
    expect(secondPaths).not.toContain(completedPaths[0]);
    expect(second.receipt).toMatchObject({
      schema_version: 'knowhow-restore-receipt/1.0',
      status: 'completed',
      claimedRun: 'run-002',
    });
    expect(second.receipt?.targets.every(target => target.completed)).toBe(true);
    expect(readFileSync(pathFor(OLD_STEM))).toEqual(oldBefore);
    expect(existsSync(pathFor(NEW_STEM))).toBe(false);
    expect(readFileSync(join(root, 'src', 'fixture.json'), 'utf8')).toBe('before fixture');
  });

  it('keeps completed-target conflicts auditable without overwriting them', async () => {
    await add(OLD_STEM);
    const snapshotPath = prepareSnapshot();
    await add(NEW_STEM);
    supersedeKnowhowEntry(root, OLD_ID, NEW_ID);
    writeFileSync(join(root, 'src', 'fixture.json'), 'after fixture', 'utf8');
    sealKnowhowLifecycleSnapshot(root, snapshotPath);

    let completedPath = '';
    restoreKnowhowLifecycleSnapshot(root, snapshotPath, {
      afterTarget: (path, completed) => {
        completedPath = path;
        if (completed === 1) throw new Error('restore crash');
      },
    });
    const absoluteCompleted = join(root, completedPath);
    writeFileSync(absoluteCompleted, 'third-party content', 'utf8');
    const conflict = restoreKnowhowLifecycleSnapshot(root, snapshotPath);
    expect(conflict).toMatchObject({
      success: false,
      code: 'KNOWHOW_RESTORE_CONFLICT',
      intent: { status: 'conflict' },
      receipt: { status: 'conflict' },
    });
    expect(readFileSync(absoluteCompleted, 'utf8')).toBe('third-party content');
    expect(existsSync(`${snapshotPath}.restore.intent.json`)).toBe(true);
    expect(existsSync(`${snapshotPath}.restore.receipt.json`)).toBe(true);
  });
});
