import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  entryDecisionCreate: vi.fn(),
  entryDecisionFindFirst: vi.fn(),
  entryDecisionFindUnique: vi.fn(),
  securityFindUnique: vi.fn(),
  subscriptionFindUnique: vi.fn(),
}));

vi.mock('../db/prisma.js', () => ({
  prisma: {
    entryDecision: {
      create: mocks.entryDecisionCreate,
      findFirst: mocks.entryDecisionFindFirst,
      findUnique: mocks.entryDecisionFindUnique,
    },
    security: {
      findUnique: mocks.securityFindUnique,
    },
    subscription: {
      findUnique: mocks.subscriptionFindUnique,
    },
  },
}));

import { recordEntryDecision } from './entry-decision.service.js';

function input(overrides: Record<string, unknown> = {}) {
  return {
    decisionKey: 'n8n:spy:2026-06-25T15:00',
    evaluatedAt: '2026-06-25T15:00:00.000Z',
    source: 'n8n-ai-trader',
    symbol: 'spy',
    decisionState: 'idle',
    decisionReason: 'above_dip_threshold',
    signalEligible: false,
    signalCreated: false,
    signalBlocked: false,
    dipPercent: -0.5,
    dipThresholdPercent: -1,
    allowOrderSignals: true,
    cooldownActive: false,
    paperMode: true,
    rawDecisionJson: {
      raw: true,
    },
    ...overrides,
  };
}

function decision(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    decisionKey: 'n8n:spy:previous',
    evaluatedAt: new Date('2026-06-25T14:59:00.000Z'),
    symbol: 'SPY',
    decisionState: 'idle',
    decisionReason: 'above_dip_threshold',
    signalCreated: false,
    signalBlocked: false,
    dipPercent: -0.5,
    dipThresholdPercent: -1,
    cooldownActive: false,
    allowOrderSignals: true,
    eventRisk: null,
    decisionFingerprint: 'same-fingerprint',
    ...overrides,
  };
}

describe('entry decision service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.entryDecisionFindUnique.mockResolvedValue(null);
    mocks.entryDecisionFindFirst.mockResolvedValue(null);
    mocks.securityFindUnique.mockResolvedValue({ id: 11, symbol: 'SPY' });
    mocks.subscriptionFindUnique.mockResolvedValue(null);
    mocks.entryDecisionCreate.mockImplementation(({ data }) =>
      Promise.resolve({
        id: 101,
        createdAt: new Date('2026-06-25T15:00:01.000Z'),
        updatedAt: new Date('2026-06-25T15:00:01.000Z'),
        ...data,
      })
    );
  });

  it('persists the first decision snapshot for a symbol', async () => {
    const result = await recordEntryDecision(input());

    expect(result.persisted).toBe(true);
    expect(result.persistenceReason).toBe('initial_state');
    expect(mocks.entryDecisionCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        decisionKey: 'n8n:spy:2026-06-25T15:00',
        symbol: 'SPY',
        decisionState: 'idle',
        persistenceReason: 'initial_state',
        securityId: 11,
      }),
    });
  });

  it('returns the existing row for duplicate decision keys', async () => {
    const existing = decision({ decisionKey: 'n8n:spy:2026-06-25T15:00' });
    mocks.entryDecisionFindUnique.mockResolvedValue(existing);

    const result = await recordEntryDecision(input());

    expect(result).toEqual({
      persisted: false,
      skipped: false,
      duplicate: true,
      persistenceReason: 'duplicate_decision_key',
      decision: existing,
    });
    expect(mocks.entryDecisionCreate).not.toHaveBeenCalled();
  });

  it('skips unchanged idle decisions inside the checkpoint interval', async () => {
    const decisionFingerprint = 'same-fingerprint';
    mocks.entryDecisionFindFirst.mockResolvedValue(
      decision({ decisionFingerprint })
    );

    const result = await recordEntryDecision(
      input({
        decisionKey: 'n8n:spy:2026-06-25T15:01',
        decisionFingerprint,
      })
    );

    expect(result).toEqual({
      persisted: false,
      skipped: true,
      duplicate: false,
      persistenceReason: null,
      decision: null,
    });
    expect(mocks.entryDecisionCreate).not.toHaveBeenCalled();
  });

  it('persists meaningful decision state changes', async () => {
    mocks.entryDecisionFindFirst.mockResolvedValue(decision());

    const result = await recordEntryDecision(
      input({
        decisionKey: 'n8n:spy:2026-06-25T15:02',
        decisionState: 'eligible',
        decisionReason: 'dip_threshold_met',
      })
    );

    expect(result.persisted).toBe(true);
    expect(result.persistenceReason).toBe('decision_state_changed');
    expect(mocks.entryDecisionCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        decisionState: 'eligible',
        persistenceReason: 'decision_state_changed',
      }),
    });
  });

  it('always persists signal-created decisions', async () => {
    mocks.entryDecisionFindFirst.mockResolvedValue(decision());

    const result = await recordEntryDecision(
      input({
        decisionKey: 'n8n:spy:2026-06-25T15:03',
        signalCreated: true,
        decisionState: 'signal_created',
      })
    );

    expect(result.persisted).toBe(true);
    expect(result.persistenceReason).toBe('signal_created');
  });

  it('enriches decision context from subscription keys', async () => {
    mocks.subscriptionFindUnique.mockResolvedValue({
      id: 22,
      key: 'spy_dip_core',
      securityId: 11,
      strategyId: 33,
      exitProfileId: 44,
      security: {
        id: 11,
        symbol: 'SPY',
      },
      strategy: {
        id: 33,
        key: 'dip_n_ride_etf',
      },
      exitProfile: {
        id: 44,
        key: 'quick_exit',
      },
    });

    await recordEntryDecision(
      input({
        subscriptionKey: 'spy_dip_core',
      })
    );

    expect(mocks.subscriptionFindUnique).toHaveBeenCalledWith({
      where: { key: 'spy_dip_core' },
      include: {
        strategy: true,
        exitProfile: true,
        security: true,
      },
    });
    expect(mocks.entryDecisionCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        securityId: 11,
        subscriptionId: 22,
        subscriptionKey: 'spy_dip_core',
        strategyId: 33,
        strategyKey: 'dip_n_ride_etf',
        exitProfileId: 44,
        exitProfileKey: 'quick_exit',
      }),
    });
  });
});
