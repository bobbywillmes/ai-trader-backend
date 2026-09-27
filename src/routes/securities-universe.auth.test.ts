import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../app/app.js';

let server: Server | undefined;
async function request(path: string, method: 'GET' | 'POST') {
  server = createApp().listen(0);
  await new Promise<void>(resolve => server?.once('listening', resolve));
  const address = server!.address();
  if (!address || typeof address === 'string') throw new Error('Missing test address');
  return fetch(`http://127.0.0.1:${address.port}/api/securities/${path}`, { method, ...(method === 'POST' ? { headers: { 'content-type': 'application/json' }, body: '{}' } : {}) });
}
afterEach(async () => { if (server) await new Promise<void>(resolve => server?.close(() => resolve())); server = undefined; });

describe('owned Security universe HTTP authentication', () => {
  it.each([
    ['universe-import/preview', 'POST'], ['universe-import/apply', 'POST'],
    ['breadth-revision/preview', 'POST'], ['breadth-revision/freeze', 'POST'],
    ['exports/universe-snapshot', 'GET'], ['exports/security-catalog', 'GET'],
  ] as const)('rejects unauthenticated %s', async (path, method) => {
    expect((await request(path, method)).status).toBe(401);
  });
});
