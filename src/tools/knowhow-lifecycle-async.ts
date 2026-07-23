import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

import type {
  KnowhowEvolutionLink,
  KnowhowLifecycleResult,
} from './knowhow-lifecycle.js';

const LIFECYCLE_WORKER_TIMEOUT_MS = 15_000;

export type KnowhowLifecycleWorkerRequest =
  | {
    operation: 'supersede';
    projectRoot: string;
    oldId: string;
    newId: string;
  }
  | {
    operation: 'history';
    projectRoot: string;
    id: string;
  }
  | {
    operation: 'recover';
    projectRoot: string;
  };

export type KnowhowLifecycleWorkerResult =
  | {
    operation: 'supersede';
    result: KnowhowLifecycleResult;
  }
  | {
    operation: 'history';
    entries: KnowhowEvolutionLink[];
  }
  | {
    operation: 'recover';
    result: KnowhowLifecycleResult;
  };

export type KnowhowLifecycleWorkerMessage =
  | {
    type: 'knowhow-lifecycle-result';
    ok: true;
    result: KnowhowLifecycleWorkerResult;
  }
  | {
    type: 'knowhow-lifecycle-result';
    ok: false;
    error: string;
  };

export interface KnowhowLifecycleWorkerBridgeOptions {
  workerUrl?: URL;
  timeoutMs?: number;
}

function defaultLifecycleWorkerUrl(): URL {
  const colocated = new URL('./knowhow-lifecycle-worker.js', import.meta.url);
  if (existsSync(fileURLToPath(colocated))) return colocated;
  return new URL('../../dist/src/tools/knowhow-lifecycle-worker.js', import.meta.url);
}

export function runKnowhowLifecycleAsync(
  request: KnowhowLifecycleWorkerRequest,
  options: KnowhowLifecycleWorkerBridgeOptions = {},
): Promise<KnowhowLifecycleWorkerResult> {
  const workerUrl = options.workerUrl ?? defaultLifecycleWorkerUrl();
  const timeoutMs = options.timeoutMs ?? LIFECYCLE_WORKER_TIMEOUT_MS;

  return new Promise<KnowhowLifecycleWorkerResult>((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(workerUrl, {
        execArgv: process.execArgv.filter(argument => !argument.startsWith('--input-type')),
      });
    } catch (error) {
      reject(error);
      return;
    }

    let settled = false;
    const cleanup = (): void => {
      clearTimeout(timer);
      worker.off('message', onMessage);
      worker.off('error', onError);
      worker.off('exit', onExit);
    };
    const terminate = (): void => {
      void worker.terminate().catch(() => undefined);
    };
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      terminate();
      reject(error);
    };
    const succeed = (result: KnowhowLifecycleWorkerResult): void => {
      if (settled) return;
      settled = true;
      cleanup();
      terminate();
      resolve(result);
    };
    const onMessage = (message: KnowhowLifecycleWorkerMessage): void => {
      if (message?.type !== 'knowhow-lifecycle-result') {
        fail(new Error('Knowhow lifecycle worker returned an invalid message'));
        return;
      }
      if (!message.ok) {
        fail(new Error(message.error));
        return;
      }
      if (message.result.operation !== request.operation) {
        fail(new Error('Knowhow lifecycle worker returned a mismatched operation'));
        return;
      }
      succeed(message.result);
    };
    const onError = (error: Error): void => {
      fail(new Error(`Knowhow lifecycle worker error: ${error.message}`));
    };
    const onExit = (code: number): void => {
      fail(new Error(`Knowhow lifecycle worker exited with code ${code}`));
    };
    const timer = setTimeout(() => {
      fail(new Error(`Knowhow lifecycle worker timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    worker.once('message', onMessage);
    worker.once('error', onError);
    worker.once('exit', onExit);
    try {
      worker.postMessage(request);
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)));
    }
  });
}
