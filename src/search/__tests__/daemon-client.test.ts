import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:net';

import { queryDaemon } from '../daemon-client.js';
import type { DaemonSearchRequest } from '../daemon-types.js';

let server: Server | null = null;

afterEach(() => {
  server?.close();
  server = null;
});

async function listenWithSilentServer(): Promise<number> {
  server = createServer(() => {
    // Intentionally keep the socket open so the client-side timeout is tested.
  });

  await new Promise<void>((resolve, reject) => {
    server!.once('error', reject);
    server!.listen(0, '127.0.0.1', () => resolve());
  });

  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('bad test server address');
  return addr.port;
}

describe('daemon client timeout', () => {
  it('serializes facet filters in the search request', async () => {
    let received: DaemonSearchRequest | null = null;
    server = createServer(socket => {
      let body = '';
      socket.on('data', chunk => {
        body += chunk.toString();
        if (!body.includes('\n')) return;
        received = JSON.parse(body.trim()) as DaemonSearchRequest;
        socket.end(JSON.stringify({ ok: true, results: [], filtersApplied: true }) + '\n');
      });
    });
    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject);
      server!.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('bad test server address');

    await queryDaemon(address.port, {
      action: 'search',
      query: 'transaction',
      limit: 5,
      filters: {
        type: 'spec',
        category: 'arch',
        tag: 'storage',
        keyword: 'atomic',
        workspace: 'shared',
        includeDeprecated: true,
      },
    });

    expect(received).toMatchObject({
      action: 'search',
      filters: {
        type: 'spec',
        category: 'arch',
        tag: 'storage',
        keyword: 'atomic',
        workspace: 'shared',
        includeDeprecated: true,
      },
    });
  });

  it('honors per-query timeout options', async () => {
    const port = await listenWithSilentServer();

    const start = Date.now();
    await expect(
      queryDaemon(port, { action: 'search', query: 'slow', limit: 1 }, { timeoutMs: 25 }),
    ).rejects.toThrow('timeout');

    expect(Date.now() - start).toBeLessThan(1000);
  });
});
