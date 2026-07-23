import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const bridgeControl = vi.hoisted(() => ({
  options: null as { workerUrl: URL; timeoutMs: number } | null,
}));

vi.mock('../knowhow-lifecycle-async.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../knowhow-lifecycle-async.js')>();
  return {
    ...actual,
    runKnowhowLifecycleAsync: (
      request: import('../knowhow-lifecycle-async.js').KnowhowLifecycleWorkerRequest,
      options?: import('../knowhow-lifecycle-async.js').KnowhowLifecycleWorkerBridgeOptions,
    ) => actual.runKnowhowLifecycleAsync(
      request,
      bridgeControl.options ?? options,
    ),
  };
});

import { ccwResultToMcp } from '../../types/tool-schema.js';
import * as lifecycle from '../knowhow-lifecycle.js';
import { handler } from '../store-knowhow.js';

const OLD_STEM = 'tip-20260723-mcp-old';
const NEW_STEM = 'tip-20260723-mcp-new';
const OLD_ID = `knowhow-${OLD_STEM}`;
const NEW_ID = `knowhow-${NEW_STEM}`;

function dataWorker(source: string): URL {
  return new URL(`data:text/javascript,${encodeURIComponent(source)}`);
}

async function settleWithin<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

describe('store_knowhow MCP lifecycle worker', () => {
  let root: string;
  let previousRoot: string | undefined;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'maestro-store-knowhow-worker-'));
    previousRoot = process.env.MAESTRO_PROJECT_ROOT;
    process.env.MAESTRO_PROJECT_ROOT = root;
    bridgeControl.options = null;
    for (const stem of [OLD_STEM, NEW_STEM]) {
      expect(await handler({
        operation: 'add',
        id: stem,
        type: 'tip',
        title: stem,
        body: 'worker lifecycle fixture',
      })).toMatchObject({ success: true });
    }
  });

  afterEach(() => {
    bridgeControl.options = null;
    vi.restoreAllMocks();
    if (previousRoot === undefined) delete process.env.MAESTRO_PROJECT_ROOT;
    else process.env.MAESTRO_PROJECT_ROOT = previousRoot;
    rmSync(root, { recursive: true, force: true });
  });

  it('keeps the MCP event loop responsive during lifecycle lock contention', async () => {
    const knowhowDir = join(root, '.workflow', 'knowhow');
    const lockPath = join(knowhowDir, '.lifecycle.lock');
    mkdirSync(knowhowDir, { recursive: true });
    writeFileSync(lockPath, JSON.stringify({
      schema_version: 'knowhow-lifecycle-lock/1.0',
      token: 'live-mcp-contention-token',
      pid: process.pid,
      acquiredAt: Date.now(),
    }));

    const supersede = handler({
      operation: 'supersede',
      oldId: OLD_ID,
      newId: NEW_ID,
    });
    let timerFired = false;
    const mainThreadTimer = new Promise<void>(resolve => {
      setTimeout(() => {
        timerFired = true;
        resolve();
      }, 25);
    });
    const parallelHistory = handler({ operation: 'history', id: OLD_ID });

    const [_timer, historyResult] = await settleWithin(
      Promise.all([mainThreadTimer, parallelHistory]),
      750,
      'MCP event loop did not remain responsive during lifecycle lock contention',
    );
    expect(timerFired).toBe(true);
    expect(ccwResultToMcp(historyResult)).toMatchObject({
      content: [{ type: 'text' }],
    });
    expect(ccwResultToMcp(historyResult).isError).not.toBe(true);
    expect(existsSync(lockPath)).toBe(true);

    rmSync(lockPath);
    const supersedeResult = await settleWithin(
      supersede,
      1_000,
      'store_knowhow supersede did not finish within 1s after lock release',
    );
    expect(supersedeResult).toMatchObject({
      success: true,
      result: {
        schema_version: 'knowhow-supersede-result/1.0',
        operation: 'supersede',
        oldId: OLD_ID,
        newId: NEW_ID,
      },
    });
    expect(ccwResultToMcp(supersedeResult).isError).not.toBe(true);
  });

  it('never falls back to synchronous lifecycle work when the worker is unavailable', async () => {
    const synchronous = [
      vi.spyOn(lifecycle, 'supersedeKnowhowEntry'),
      vi.spyOn(lifecycle, 'getKnowhowEvolutionChain'),
      vi.spyOn(lifecycle, 'recoverKnowhowLifecycleIntent'),
    ];
    const scenarios = [
      {
        name: 'missing worker',
        options: {
          workerUrl: pathToFileURL(join(root, 'missing-lifecycle-worker.mjs')),
          timeoutMs: 200,
        },
      },
      {
        name: 'worker error',
        options: {
          workerUrl: dataWorker('throw new Error("injected lifecycle worker error");'),
          timeoutMs: 200,
        },
      },
      {
        name: 'worker timeout',
        options: {
          workerUrl: dataWorker(
            'import { parentPort } from "node:worker_threads"; parentPort.on("message", () => {});',
          ),
          timeoutMs: 40,
        },
      },
      {
        name: 'non-zero worker exit',
        options: {
          workerUrl: dataWorker('process.exit(7);'),
          timeoutMs: 200,
        },
      },
    ];

    for (const scenario of scenarios) {
      bridgeControl.options = scenario.options;
      const before = synchronous.map(spy => spy.mock.calls.length);
      const result = await handler({
        operation: 'supersede',
        oldId: OLD_ID,
        newId: NEW_ID,
      });
      const mcp = ccwResultToMcp(result);

      expect(result.success, scenario.name).toBe(false);
      expect(mcp.isError, scenario.name).toBe(true);
      expect(
        synchronous.map((spy, index) => spy.mock.calls.length - before[index]),
        scenario.name,
      ).toEqual([0, 0, 0]);
    }
  });
});
