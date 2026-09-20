import express from 'express';
import type { Server } from 'node:http';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Prisma } from '@prisma/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ latest: vi.fn(), list: vi.fn(), get: vi.fn(), publish: vi.fn() }));
vi.mock('../services/participation-assessment.service.js', () => ({ latestParticipationV1Assessment: mocks.latest, listParticipationV1Assessments: mocks.list, getParticipationV1Assessment: mocks.get, publishParticipationAssessments: mocks.publish }));
import router from './market-data.routes.js';
import { HttpError } from '../errors/http-error.js';
let server: Server; let base: string;
const owner = { role: 'SYSTEM_OWNER', 'content-type': 'application/json' };
const runResult = { published: 1, attempts: 1, suppressed: false, notDue: false, blocked: null };
const gap = { latestAttempt: { id: 12, status: 'UNAVAILABLE', reasonCode: 'MISSING_MARKET_DATA', rawState: null }, latestValid: { id: 9, status: 'VALID', rawState: 'NORMAL', effectiveState: 'NORMAL' } };
beforeEach(async () => {
  vi.clearAllMocks();
  mocks.latest.mockResolvedValue(gap); mocks.list.mockResolvedValue([]); mocks.get.mockResolvedValue({ id: 9, dimension: 'PARTICIPATION' }); mocks.publish.mockResolvedValue(runResult);
  const app = express(); app.use(express.json());
  // The role header stands in for an authenticated user in res.locals; real RBAC middleware runs unmocked.
  app.use((req, res, next) => { if (req.headers.role) Object.assign(res.locals, { user: { id: 1, platformRole: String(req.headers.role) } }); next(); });
  app.use('/api/market-data', router);
  app.use((error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => { res.status(error instanceof HttpError ? error.statusCode : 500).json({ message: error.message }); });
  server = app.listen(0); await new Promise<void>(resolve => server.once('listening', resolve)); base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/market-data/participation-assessments`;
});
afterEach(async () => { await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())); });
const post = (body?: unknown, headers: Record<string, string> = owner) => fetch(`${base}/run`, { method: 'POST', headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

describe('PARTICIPATION_V1 operator/read API', () => {
  it.each(['SYSTEM_OWNER', 'OPERATOR'])('allows %s reads and preserves the latestAttempt/latestValid gap', async role => {
    const headers = { role };
    expect(await (await fetch(`${base}/latest`, { headers })).json()).toEqual(gap);
    expect((await fetch(base, { headers })).status).toBe(200); expect(mocks.list).toHaveBeenLastCalledWith(20, undefined);
    expect((await fetch(`${base}?limit=5&beforeId=10`, { headers })).status).toBe(200); expect(mocks.list).toHaveBeenLastCalledWith(5, 10);
    expect((await fetch(`${base}?limit=100`, { headers })).status).toBe(200); expect(mocks.list).toHaveBeenLastCalledWith(100, undefined);
    expect(await (await fetch(`${base}/9`, { headers })).json()).toEqual({ id: 9, dimension: 'PARTICIPATION' }); expect(mocks.get).toHaveBeenCalledWith(9);
  });
  it.each(['?limit=0', '?limit=101', '?limit=-1', '?limit=1.5', '?limit=abc', '?beforeId=0', '?beforeId=-1', '?beforeId=x', '?symbol=SPY', '?date=2026-09-14', '?limit=5&extra=1', '/0', '/-1', '/nope', '/1.5'])('rejects invalid read input %s', async suffix => {
    expect((await fetch(base + suffix, { headers: { role: 'SYSTEM_OWNER' } })).status).toBe(400);
    expect(mocks.list).not.toHaveBeenCalled(); expect(mocks.get).not.toHaveBeenCalled();
  });
  it('maps a missing or other-dimension detail to 404', async () => {
    mocks.get.mockRejectedValueOnce(new HttpError(404, 'PARTICIPATION_V1 assessment not found.'));
    expect((await fetch(`${base}/8`, { headers: { role: 'OPERATOR' } })).status).toBe(404);
  });
  it.each([undefined, 'ACCOUNT_USER'])('denies reads and runs for %s', async role => {
    const headers: Record<string, string> = role ? { role } : {};
    for (const path of ['', '/latest', '/7']) expect((await fetch(base + path, { headers })).status).toBe(role ? 403 : 401);
    expect((await post({}, { ...headers, 'content-type': 'application/json' })).status).toBe(role ? 403 : 401);
    for (const mock of Object.values(mocks)) expect(mock).not.toHaveBeenCalled();
  });
  it('restricts runs to SYSTEM_OWNER and returns the service result unchanged', async () => {
    expect((await post({}, { role: 'OPERATOR', 'content-type': 'application/json' })).status).toBe(403);
    expect(mocks.publish).not.toHaveBeenCalled();
    for (const body of [{}, undefined]) { const response = await post(body); expect(response.status).toBe(200); expect(await response.json()).toEqual(runResult); }
    expect(mocks.publish).toHaveBeenCalledTimes(2); expect(mocks.publish).toHaveBeenCalledWith();
  });
  it.each([{ force: true }, { date: '2026-09-14' }, { symbol: 'SPY' }, { symbols: ['SPY'] }, { state: 'INTENSE' }, { skipMissing: true }, { mode: '4of5' }, { thresholds: {} }, { skipSplits: true }])('rejects arbitrary run controls %j', async body => {
    expect((await post(body)).status).toBe(400); expect(mocks.publish).not.toHaveBeenCalled();
  });
  it('propagates lock contention (409), no-target calendar errors and blocked results without leaking details', async () => {
    mocks.publish.mockRejectedValueOnce(new HttpError(409, 'PARTICIPATION_V1 publication is already running.'));
    expect((await post({})).status).toBe(409);
    mocks.publish.mockRejectedValueOnce(new HttpError(500, 'PARTICIPATION_V1 target calendar authority unavailable; operator review required.'));
    const failure = await post({}); expect(failure.status).toBe(500); expect(JSON.stringify(await failure.json())).not.toMatch(/apiKey|Bearer/);
    const blocked = { ...runResult, published: 0, blocked: { sessionDate: '2026-09-14', status: 'UNAVAILABLE', reasonCode: 'MISSING_MARKET_DATA' } };
    mocks.publish.mockResolvedValueOnce(blocked); expect(await (await post({})).json()).toEqual(blocked);
  });
  it('maps an unresolved attempt collision to a Participation-specific 409, not the calendar message', async () => {
    mocks.publish.mockRejectedValueOnce(new Prisma.PrismaClientKnownRequestError('unique', { code: 'P2002', clientVersion: 'test' }));
    const response = await post({}); expect(response.status).toBe(409); expect((await response.json() as { message: string }).message).toMatch(/PARTICIPATION_V1/);
  });
  it('does not expose mutation methods on immutable assessment resources', async () => {
    for (const method of ['PUT', 'PATCH', 'DELETE']) expect((await fetch(`${base}/7`, { method, headers: owner })).status).toBe(404);
  });
});

describe('PARTICIPATION_V1 manual-only publication boundary', () => {
  const walk = (dir: string): string[] => readdirSync(dir).flatMap(name => { const path = join(dir, name); return statSync(path).isDirectory() ? walk(path) : path.endsWith('.ts') ? [path.replaceAll('\\', '/')] : []; });
  const production = walk('src').filter(path => !/\.test\.ts$|\/__tests__\//.test(path));
  it('has exactly one production caller of the publisher: the owner-run controller', () => {
    const callers = production.filter(path => /publishParticipationAssessments/.test(readFileSync(path, 'utf8')) && path !== 'src/services/participation-assessment.service.ts');
    expect(callers).toEqual(['src/controllers/participation-assessment.controller.ts']);
  });
  it('adds no worker, scheduler, startup, WorkerHealth or shutdown wiring', () => {
    for (const path of ['src/app/server.ts', 'src/app/app.ts']) expect(readFileSync(path, 'utf8'), path).not.toMatch(/participation/i);
    for (const path of production.filter(p => p.startsWith('src/workers/') || /worker-health|market-data-sync|market-calendar|market-bar-ingestion/.test(p))) expect(readFileSync(path, 'utf8'), path).not.toMatch(/participation/i);
  });
  it('introduces no Participation reference into trading, signal, policy, order, broker or position code', () => {
    const trading = production.filter(path => /(?:order|signal|strategy|entry-decision|broker|alpaca|position|exit|subscription|trading-account|regime-policy|regime-composition)/i.test(path));
    expect(trading.length).toBeGreaterThan(10);
    for (const path of trading) expect(readFileSync(path, 'utf8'), path).not.toMatch(/participation/i);
  });
});
