import type { Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ latest: vi.fn(), list: vi.fn(), get: vi.fn(), publish: vi.fn() }));
vi.mock('../services/participation-assessment.service.js', () => ({ latestParticipationV1Assessment: mocks.latest, listParticipationV1Assessments: mocks.list, getParticipationV1Assessment: mocks.get, publishParticipationAssessments: mocks.publish }));

import { createApp } from '../app/app.js';

let server: Server | undefined;
async function request(path: string, init?: RequestInit) {
  server = createApp().listen(0);
  await new Promise<void>(resolve => server?.once('listening', resolve));
  const address = server!.address();
  if (!address || typeof address === 'string') throw new Error('Missing test address');
  return fetch(`http://127.0.0.1:${address.port}${path}`, init);
}
afterEach(async () => { await new Promise<void>(resolve => server?.close(() => resolve())); server = undefined; vi.clearAllMocks(); });

describe('mounted PARTICIPATION_V1 API authentication', () => {
  it.each([['GET', '/latest'], ['GET', ''], ['GET', '/1'], ['POST', '/run']])('rejects unauthenticated %s %s before reaching the service', async (method, suffix) => {
    const response = await request(`/api/market-data/participation-assessments${suffix}`, { method, ...(method === 'POST' ? { headers: { 'content-type': 'application/json' }, body: '{}' } : {}) });
    expect(response.status).toBe(401);
    for (const mock of Object.values(mocks)) expect(mock).not.toHaveBeenCalled();
  });
});
