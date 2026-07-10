import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  cancelStalePendingHandoffs: vi.fn(),
  confirmActiveCandidates: vi.fn(),
  generateMomentumCandidatesFromCatalysts: vi.fn(),
  listMomentumScannerHandoffs: vi.fn(),
  markMomentumScannerHandoffFailed: vi.fn(),
  markMomentumScannerHandoffSent: vi.fn(),
  listMomentumUniverseMembers: vi.fn(),
  createMomentumUniverseMember: vi.fn(),
  updateMomentumUniverseMember: vi.fn(),
  deleteMomentumUniverseMember: vi.fn(),
  getMomentumResearchOverview: vi.fn(),
  getMomentumResearchCandidate: vi.fn(),
  getMomentumSymbolResearch: vi.fn(),
  listMomentumResearchCandidates: vi.fn(),
  listMomentumResearchCatalysts: vi.fn(),
  prepareReadyMomentumScannerHandoffs: vi.fn(),
  recordEntryDecision: vi.fn(),
  runMassiveNewsWorkerOnce: vi.fn(),
  submitOrder: vi.fn(),
}));

vi.mock('../workers/massive-news.worker.js', () => ({
  runMassiveNewsWorkerOnce: mocks.runMassiveNewsWorkerOnce,
}));

vi.mock('../services/momentum-candidates.service.js', () => ({
  generateMomentumCandidatesFromCatalysts:
    mocks.generateMomentumCandidatesFromCatalysts,
}));

vi.mock('../services/momentum-price-confirmation.service.js', () => ({
  confirmActiveCandidates: mocks.confirmActiveCandidates,
}));

vi.mock('../services/momentum-scanner-handoff.service.js', () => ({
  cancelStalePendingHandoffs: mocks.cancelStalePendingHandoffs,
  getMomentumScannerHandoffById: vi.fn(),
  listMomentumScannerHandoffs: mocks.listMomentumScannerHandoffs,
  markMomentumScannerHandoffAcknowledged: vi.fn(),
  markMomentumScannerHandoffFailed: mocks.markMomentumScannerHandoffFailed,
  markMomentumScannerHandoffSent: mocks.markMomentumScannerHandoffSent,
  prepareReadyMomentumScannerHandoffs:
    mocks.prepareReadyMomentumScannerHandoffs,
}));

vi.mock('../services/momentum-universe.service.js', () => ({
  listMomentumUniverseMembers: mocks.listMomentumUniverseMembers,
  createMomentumUniverseMember: mocks.createMomentumUniverseMember,
  updateMomentumUniverseMember: mocks.updateMomentumUniverseMember,
  deleteMomentumUniverseMember: mocks.deleteMomentumUniverseMember,
}));

vi.mock('../services/momentum-research.service.js', () => ({
  getMomentumResearchOverview: mocks.getMomentumResearchOverview,
  getMomentumResearchCandidate: mocks.getMomentumResearchCandidate,
  getMomentumSymbolResearch: mocks.getMomentumSymbolResearch,
  listMomentumResearchCandidates: mocks.listMomentumResearchCandidates,
  listMomentumResearchCatalysts: mocks.listMomentumResearchCatalysts,
}));

vi.mock('../services/place-order.service.js', () => ({
  submitOrder: mocks.submitOrder,
}));

vi.mock('../services/entry-decision.service.js', () => ({
  recordEntryDecision: mocks.recordEntryDecision,
}));

const SIGNAL_KEY = 'test-signal-key-123456';
const ADMIN_KEY = 'test-admin-key-123456';

function handoff(overrides: Record<string, unknown> = {}) {
  return {
    id: 'handoff-1',
    momentumCandidateId: 'candidate-1',
    symbol: 'AAPL',
    status: 'PENDING',
    lastError: null,
    payload: {
      type: 'momentum_candidate.ready',
      symbol: 'AAPL',
      review: {
        headline: 'AAPL momentum catalyst',
      },
    },
    ...overrides,
  };
}

async function jsonResponse(response: Response) {
  return response.json() as Promise<Record<string, unknown>>;
}

describe('momentum scanner routes', () => {
  let server: Server | null = null;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.env = {
      ...originalEnv,
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://trader:traderpass@localhost:5432/ai_trader',
      ALPACA_API_KEY: 'test-alpaca-key',
      ALPACA_API_SECRET: 'test-alpaca-secret',
      MASSIVE_API_KEY: 'test-massive-key',
      AI_TRADER_SIGNAL_API_KEY: SIGNAL_KEY,
      AI_TRADER_ADMIN_API_KEY: ADMIN_KEY,
    };

    mocks.runMassiveNewsWorkerOnce.mockResolvedValue({
      enabled: true,
      skipped: false,
      symbolsProcessed: 1,
    });
    mocks.generateMomentumCandidatesFromCatalysts.mockResolvedValue({
      created: 1,
      updated: 0,
      skipped: 0,
      candidates: [{ id: 'candidate-1', symbol: 'AAPL' }],
    });
    mocks.confirmActiveCandidates.mockResolvedValue({
      checked: 1,
      confirmed: 1,
      skipped: 0,
      failed: 0,
      results: [
        {
          candidateId: 'candidate-1',
          symbol: 'AAPL',
          action: 'confirmed',
          priceCheck: {
            id: 'price-check-1',
            dayVolume: 123n,
            recentVolume: 45n,
            rawPayload: { nestedVolume: 678n },
            metadata: { scoreVolume: 90n },
          },
        },
      ],
    });
    mocks.prepareReadyMomentumScannerHandoffs.mockResolvedValue({
      prepared: 1,
      skipped: 0,
      handoffs: [handoff()],
      results: [{ candidateId: 'candidate-1', handoff: handoff() }],
    });
    mocks.listMomentumScannerHandoffs.mockResolvedValue([handoff()]);
    mocks.cancelStalePendingHandoffs.mockResolvedValue({
      scanned: 0,
      cancelled: 0,
      handoffs: [],
    });
    mocks.markMomentumScannerHandoffSent.mockResolvedValue(
      handoff({ status: 'SENT', attempts: 1 })
    );
    mocks.markMomentumScannerHandoffFailed.mockResolvedValue(
      handoff({
        status: 'FAILED',
        lastError: 'n8n momentum scanner workflow reported failure',
      })
    );
    mocks.listMomentumUniverseMembers.mockResolvedValue({
      data: [],
      pagination: { page: 1, pageSize: 50, total: 0, totalPages: 1 },
    });
    mocks.createMomentumUniverseMember.mockResolvedValue({ id: 'member-1' });
    mocks.updateMomentumUniverseMember.mockResolvedValue({
      id: 'member-1',
      enabled: false,
    });
    mocks.deleteMomentumUniverseMember.mockResolvedValue({ id: 'member-1' });
    mocks.getMomentumResearchOverview.mockResolvedValue({
      summary: { activeCandidates: 0 },
    });
    mocks.getMomentumResearchCandidate.mockResolvedValue({
      candidate: { id: 'candidate-1', symbol: 'AAPL' },
    });
    mocks.getMomentumSymbolResearch.mockResolvedValue({
      security: { id: 1, symbol: 'AAPL' },
    });
    mocks.listMomentumResearchCandidates.mockResolvedValue({
      data: [],
      pagination: { page: 1, pageSize: 25, total: 0, totalPages: 1 },
    });
    mocks.listMomentumResearchCatalysts.mockResolvedValue({
      data: [],
      pagination: { page: 1, pageSize: 25, total: 0, totalPages: 1 },
    });
  });

  afterEach(async () => {
    process.env = originalEnv;

    if (server) {
      await new Promise<void>((resolve, reject) => {
        server?.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
      server = null;
    }
  });

  async function listen() {
    const { createApp } = await import('../app/app.js');
    const app = createApp();

    server = app.listen(0);

    await new Promise<void>((resolve) => {
      server?.once('listening', () => resolve());
    });

    const address = server.address();

    if (address === null || typeof address === 'string') {
      throw new Error('Expected local test server address.');
    }

    return `http://127.0.0.1:${address.port}`;
  }

  function signalHeaders() {
    return {
      'signal-key': SIGNAL_KEY,
      'content-type': 'application/json',
    };
  }

  it('requires a valid signal API key for scanner signal routes', async () => {
    const baseUrl = await listen();

    const missingKey = await fetch(
      `${baseUrl}/api/signals/momentum-scanner/run-news-worker`,
      { method: 'POST' }
    );
    const invalidKey = await fetch(
      `${baseUrl}/api/signals/momentum-scanner/run-news-worker`,
      {
        method: 'POST',
        headers: { 'signal-key': 'wrong-key' },
      }
    );

    expect(missingKey.status).toBe(401);
    await expect(jsonResponse(missingKey)).resolves.toMatchObject({
      error: 'Unauthorized',
      message: 'Missing or invalid API key.',
    });
    expect(invalidKey.status).toBe(401);
    expect(mocks.runMassiveNewsWorkerOnce).not.toHaveBeenCalled();
  });

  it('accepts the signal API key without admin auth for scanner signal routes', async () => {
    const baseUrl = await listen();

    const response = await fetch(
      `${baseUrl}/api/signals/momentum-scanner/run-news-worker`,
      {
        method: 'POST',
        headers: { 'signal-key': SIGNAL_KEY },
      }
    );

    expect(response.status).toBe(200);
    await expect(jsonResponse(response)).resolves.toMatchObject({
      ok: true,
      result: {
        enabled: true,
        skipped: false,
        symbolsProcessed: 1,
      },
    });
    expect(mocks.runMassiveNewsWorkerOnce).toHaveBeenCalledWith({
      enabled: true,
    });
  });

  it('rejects ai-trader-api-key for signal routes when signal-key is missing', async () => {
    const baseUrl = await listen();

    const response = await fetch(
      `${baseUrl}/api/signals/momentum-scanner/run-news-worker`,
      {
        method: 'POST',
        headers: { 'ai-trader-api-key': SIGNAL_KEY },
      }
    );

    expect(response.status).toBe(401);
    await expect(jsonResponse(response)).resolves.toMatchObject({
      error: 'Unauthorized',
      message: 'Missing or invalid API key.',
    });
    expect(mocks.runMassiveNewsWorkerOnce).not.toHaveBeenCalled();
  });

  it('keeps existing admin scanner endpoints behind admin auth', async () => {
    const baseUrl = await listen();

    const missingAdmin = await fetch(`${baseUrl}/api/momentum-scanner/handoffs`);
    const signalKeyOnly = await fetch(
      `${baseUrl}/api/momentum-scanner/handoffs`,
      { headers: { 'signal-key': SIGNAL_KEY } }
    );
    const adminKey = await fetch(
      `${baseUrl}/api/momentum-scanner/handoffs`,
      { headers: { 'ai-trader-api-key': ADMIN_KEY } }
    );

    expect(missingAdmin.status).toBe(401);
    await expect(jsonResponse(missingAdmin)).resolves.toMatchObject({
      error: 'Unauthorized',
      message: 'Admin API key or admin session token required.',
    });
    expect(signalKeyOnly.status).toBe(401);
    expect(adminKey.status).toBe(200);
  });

  it('provides owner-protected momentum universe CRUD endpoints', async () => {
    const baseUrl = await listen();

    const unauthorized = await fetch(`${baseUrl}/api/momentum-scanner/universe`);
    const listed = await fetch(
      `${baseUrl}/api/momentum-scanner/universe?enabled=true&search=aapl&page=2&pageSize=10`,
      { headers: { 'ai-trader-api-key': ADMIN_KEY } }
    );
    const created = await fetch(`${baseUrl}/api/momentum-scanner/universe`, {
      method: 'POST',
      headers: {
        'ai-trader-api-key': ADMIN_KEY,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ securityId: 1, pullIntervalMin: 30 }),
    });
    const updated = await fetch(
      `${baseUrl}/api/momentum-scanner/universe/member-1`,
      {
        method: 'PATCH',
        headers: {
          'ai-trader-api-key': ADMIN_KEY,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ enabled: false }),
      }
    );
    const deleted = await fetch(
      `${baseUrl}/api/momentum-scanner/universe/member-1`,
      {
        method: 'DELETE',
        headers: { 'ai-trader-api-key': ADMIN_KEY },
      }
    );

    expect(unauthorized.status).toBe(401);
    expect(listed.status).toBe(200);
    expect(created.status).toBe(201);
    expect(updated.status).toBe(200);
    expect(deleted.status).toBe(200);
    expect(mocks.listMomentumUniverseMembers).toHaveBeenCalledWith({
      enabled: true,
      search: 'aapl',
      page: 2,
      pageSize: 10,
    });
    expect(mocks.createMomentumUniverseMember).toHaveBeenCalledWith({
      securityId: 1,
      pullIntervalMin: 30,
    });
    expect(mocks.updateMomentumUniverseMember).toHaveBeenCalledWith('member-1', {
      enabled: false,
    });
    expect(mocks.deleteMomentumUniverseMember).toHaveBeenCalledWith('member-1');
  });

  it('provides owner-only read-only momentum research endpoints', async () => {
    const baseUrl = await listen();
    const headers = { 'ai-trader-api-key': ADMIN_KEY };

    const unauthorized = await fetch(
      `${baseUrl}/api/momentum-scanner/research/overview`
    );
    const overview = await fetch(
      `${baseUrl}/api/momentum-scanner/research/overview`,
      { headers }
    );
    const candidates = await fetch(
      `${baseUrl}/api/momentum-scanner/research/candidates?page=2&pageSize=10&search=aapl&minTotalScore=80&entryReady=true&sortBy=totalScore&sortDirection=asc`,
      { headers }
    );
    const catalysts = await fetch(
      `${baseUrl}/api/momentum-scanner/research/catalysts?pageSize=15&publisher=wire&sentiment=POSITIVE&sortBy=receivedAt`,
      { headers }
    );

    expect(unauthorized.status).toBe(401);
    expect(overview.status).toBe(200);
    expect(candidates.status).toBe(200);
    expect(catalysts.status).toBe(200);
    expect(mocks.getMomentumResearchOverview).toHaveBeenCalledOnce();
    expect(mocks.listMomentumResearchCandidates).toHaveBeenCalledWith(
      expect.objectContaining({
        page: 2,
        pageSize: 10,
        search: 'aapl',
        minTotalScore: 80,
        entryReady: true,
        sortBy: 'totalScore',
        sortDirection: 'asc',
      })
    );
    expect(mocks.listMomentumResearchCatalysts).toHaveBeenCalledWith(
      expect.objectContaining({
        page: 1,
        pageSize: 15,
        publisher: 'wire',
        sentiment: 'POSITIVE',
        sortBy: 'receivedAt',
        sortDirection: 'desc',
      })
    );
  });

  it('rejects unsupported momentum research filters and sort fields', async () => {
    const baseUrl = await listen();
    const headers = { 'ai-trader-api-key': ADMIN_KEY };

    const invalidCandidateSort = await fetch(
      `${baseUrl}/api/momentum-scanner/research/candidates?sortBy=rawSql`,
      { headers }
    );
    const invalidCatalystDate = await fetch(
      `${baseUrl}/api/momentum-scanner/research/catalysts?from=not-a-date`,
      { headers }
    );

    expect(invalidCandidateSort.status).toBe(400);
    expect(invalidCatalystDate.status).toBe(400);
    expect(mocks.listMomentumResearchCandidates).not.toHaveBeenCalled();
    expect(mocks.listMomentumResearchCatalysts).not.toHaveBeenCalled();
  });

  it('provides owner-only candidate and normalized symbol research details', async () => {
    const baseUrl = await listen();
    const headers = { 'ai-trader-api-key': ADMIN_KEY };

    const candidate = await fetch(
      `${baseUrl}/api/momentum-scanner/research/candidates/candidate-1`,
      { headers }
    );
    const symbol = await fetch(
      `${baseUrl}/api/momentum-scanner/research/symbols/aapl`,
      { headers }
    );

    expect(candidate.status).toBe(200);
    expect(symbol.status).toBe(200);
    expect(mocks.getMomentumResearchCandidate).toHaveBeenCalledWith('candidate-1');
    expect(mocks.getMomentumSymbolResearch).toHaveBeenCalledWith('AAPL');
  });

  it('rejects invalid momentum universe CRUD input', async () => {
    const baseUrl = await listen();
    const headers = {
      'ai-trader-api-key': ADMIN_KEY,
      'content-type': 'application/json',
    };

    const invalidCreate = await fetch(`${baseUrl}/api/momentum-scanner/universe`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ securityId: 0 }),
    });
    const invalidUpdate = await fetch(
      `${baseUrl}/api/momentum-scanner/universe/member-1`,
      {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ pullIntervalMin: 0 }),
      }
    );

    expect(invalidCreate.status).toBe(400);
    expect(invalidUpdate.status).toBe(400);
    expect(mocks.createMomentumUniverseMember).not.toHaveBeenCalled();
    expect(mocks.updateMomentumUniverseMember).not.toHaveBeenCalled();
  });

  it('generates candidates with empty and explicit workflow options', async () => {
    const baseUrl = await listen();

    const emptyOptions = await fetch(
      `${baseUrl}/api/signals/momentum-scanner/generate-candidates`,
      {
        method: 'POST',
        headers: signalHeaders(),
        body: JSON.stringify({}),
      }
    );
    const explicitOptions = await fetch(
      `${baseUrl}/api/signals/momentum-scanner/generate-candidates`,
      {
        method: 'POST',
        headers: signalHeaders(),
        body: JSON.stringify({
          minCatalystScore: 70,
          take: 5,
          expiresInHours: 12,
        }),
      }
    );

    expect(emptyOptions.status).toBe(200);
    expect(explicitOptions.status).toBe(200);
    expect(mocks.generateMomentumCandidatesFromCatalysts).toHaveBeenNthCalledWith(
      1,
      {}
    );
    expect(mocks.generateMomentumCandidatesFromCatalysts).toHaveBeenNthCalledWith(
      2,
      {
        minCatalystScore: 70,
        take: 5,
        expiresInHours: 12,
      }
    );
  });

  it('confirms prices with empty options and returns BigInt-safe JSON', async () => {
    const baseUrl = await listen();

    const response = await fetch(
      `${baseUrl}/api/signals/momentum-scanner/confirm-prices`,
      {
        method: 'POST',
        headers: { 'signal-key': SIGNAL_KEY },
      }
    );
    const body = await jsonResponse(response);

    expect(response.status).toBe(200);
    expect(mocks.confirmActiveCandidates).toHaveBeenCalledWith({});
    expect(body).toMatchObject({
      checked: 1,
      results: [
        {
          priceCheck: {
            dayVolume: '123',
            recentVolume: '45',
            rawPayload: { nestedVolume: '678' },
            metadata: { scoreVolume: '90' },
          },
        },
      ],
    });
  });

  it('prepares handoffs with empty options and returns the handoff summary', async () => {
    const baseUrl = await listen();

    const response = await fetch(
      `${baseUrl}/api/signals/momentum-scanner/prepare-handoffs`,
      {
        method: 'POST',
        headers: { 'signal-key': SIGNAL_KEY },
      }
    );

    expect(response.status).toBe(200);
    await expect(jsonResponse(response)).resolves.toMatchObject({
      prepared: 1,
      skipped: 0,
      handoffs: [{ id: 'handoff-1', status: 'PENDING' }],
    });
    expect(mocks.prepareReadyMomentumScannerHandoffs).toHaveBeenCalledWith({});
  });

  it('defaults handoff listing to currently valid pending handoffs for n8n polling', async () => {
    const baseUrl = await listen();

    const response = await fetch(
      `${baseUrl}/api/signals/momentum-scanner/handoffs?take=3&symbol=AAPL`,
      { headers: { 'signal-key': SIGNAL_KEY } }
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject([
      { id: 'handoff-1', status: 'PENDING' },
    ]);
    expect(mocks.listMomentumScannerHandoffs).toHaveBeenCalledWith({
      status: 'PENDING',
      limit: 3,
      symbol: 'AAPL',
      currentlyEligibleOnly: true,
    });
    expect(mocks.cancelStalePendingHandoffs).toHaveBeenCalledWith({
      limit: 3,
      symbol: 'AAPL',
    });
  });

  it('marks handoffs sent with optional metadata', async () => {
    const baseUrl = await listen();

    const response = await fetch(
      `${baseUrl}/api/signals/momentum-scanner/handoffs/handoff-1/mark-sent`,
      {
        method: 'POST',
        headers: signalHeaders(),
        body: JSON.stringify({ metadata: { slackTs: '123.456' } }),
      }
    );

    expect(response.status).toBe(200);
    await expect(jsonResponse(response)).resolves.toMatchObject({
      id: 'handoff-1',
      status: 'SENT',
    });
    expect(mocks.markMomentumScannerHandoffSent).toHaveBeenCalledWith(
      'handoff-1',
      { metadata: { slackTs: '123.456' } }
    );
  });

  it('marks handoffs failed with a safe default error', async () => {
    const baseUrl = await listen();

    const response = await fetch(
      `${baseUrl}/api/signals/momentum-scanner/handoffs/handoff-1/mark-failed`,
      {
        method: 'POST',
        headers: { 'signal-key': SIGNAL_KEY },
      }
    );

    expect(response.status).toBe(200);
    await expect(jsonResponse(response)).resolves.toMatchObject({
      id: 'handoff-1',
      status: 'FAILED',
      lastError: 'n8n momentum scanner workflow reported failure',
    });
    expect(mocks.markMomentumScannerHandoffFailed).toHaveBeenCalledWith(
      'handoff-1',
      'n8n momentum scanner workflow reported failure',
      {}
    );
  });

  it('does not invoke entry signal, order, or broker-facing behavior', async () => {
    const baseUrl = await listen();

    await fetch(`${baseUrl}/api/signals/momentum-scanner/run-news-worker`, {
      method: 'POST',
      headers: { 'signal-key': SIGNAL_KEY },
    });
    await fetch(`${baseUrl}/api/signals/momentum-scanner/generate-candidates`, {
      method: 'POST',
      headers: { 'signal-key': SIGNAL_KEY },
    });
    await fetch(`${baseUrl}/api/signals/momentum-scanner/confirm-prices`, {
      method: 'POST',
      headers: { 'signal-key': SIGNAL_KEY },
    });
    await fetch(`${baseUrl}/api/signals/momentum-scanner/prepare-handoffs`, {
      method: 'POST',
      headers: { 'signal-key': SIGNAL_KEY },
    });
    await fetch(`${baseUrl}/api/signals/momentum-scanner/handoffs`, {
      headers: { 'signal-key': SIGNAL_KEY },
    });
    await fetch(
      `${baseUrl}/api/signals/momentum-scanner/handoffs/handoff-1/mark-sent`,
      {
        method: 'POST',
        headers: { 'signal-key': SIGNAL_KEY },
      }
    );
    await fetch(
      `${baseUrl}/api/signals/momentum-scanner/handoffs/handoff-1/mark-failed`,
      {
        method: 'POST',
        headers: { 'signal-key': SIGNAL_KEY },
      }
    );

    expect(mocks.submitOrder).not.toHaveBeenCalled();
    expect(mocks.recordEntryDecision).not.toHaveBeenCalled();
  });
});
