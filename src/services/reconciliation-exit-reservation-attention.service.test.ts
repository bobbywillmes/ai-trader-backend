import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findAttentions: vi.fn(),
  findIntent: vi.fn(),
  resolve: vi.fn(),
}));

vi.mock('../config/env.js', () => ({
  env: { NODE_ENV: 'test', LIVE_WRITE_DEPLOYMENT_ROLE: 'OBSERVATION_ONLY' },
}));
vi.mock('../db/prisma.js', () => ({
  prisma: {
    operationalAttention: { findMany: mocks.findAttentions },
    orderIntent: { findFirst: mocks.findIntent },
  },
}));
vi.mock('./operational-attention.service.js', () => ({
  OPERATIONAL_ATTENTION_CODES: {
    CONFLICTING_EXIT_RESERVATION: 'CONFLICTING_EXIT_RESERVATION',
  },
  OPERATIONAL_ATTENTION_SOURCES: {
    EXIT_VERIFICATION: 'EXIT_VERIFICATION',
    RECONCILIATION: 'RECONCILIATION',
  },
  openOrObserveOperationalAttention: vi.fn(),
  resolveOperationalAttentionAuthoritatively: mocks.resolve,
}));

import { resolveClearedExitReservationAttention } from './reconciliation-operational-attention.service.js';

const attention = {
  id: 4,
  revision: 1,
  trackedPositionId: 79,
};
const snapshots: Parameters<typeof resolveClearedExitReservationAttention>[0] = {
  tradingAccountId: 7,
  environment: 'PAPER',
  runIdentifier: 'reconciliation-qqq',
  trackedPositions: [{
    id: 79,
    tradingAccountId: 7,
    broker: 'alpaca',
    symbol: 'QQQ',
    status: 'open',
    side: 'long',
    qty: 3,
  }],
  brokerPositions: [{ broker: 'alpaca', symbol: 'QQQ', side: 'long', qty: '3.000' }],
  brokerOrders: [],
};

describe('authoritative exit-reservation attention resolution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findAttentions.mockResolvedValue([attention]);
    mocks.findIntent.mockResolvedValue(null);
    mocks.resolve.mockResolvedValue({ id: 4, status: 'RESOLVED' });
  });

  it('resolves the matching QQQ episode from a clean fresh reconciliation snapshot without submitting', async () => {
    await expect(resolveClearedExitReservationAttention(snapshots)).resolves.toBe(1);
    expect(mocks.resolve).toHaveBeenCalledWith(expect.objectContaining({
      id: 4,
      expectedRevision: 1,
      evidence: expect.objectContaining({
        trackedPositionId: 79,
        symbol: 'QQQ',
        brokerHeldQty: '3',
        localTrackedQty: '3',
        activeSellReservationCount: 0,
        brokerOpenOrdersReadSucceeded: true,
      }),
    }));
  });

  it('keeps the episode open while any active sell reservation remains', async () => {
    const order = { broker: 'alpaca', id: 'external-qqq', symbol: 'QQQ', side: 'sell', qty: '3', type: 'limit', status: 'new' };
    await expect(resolveClearedExitReservationAttention({ ...snapshots, brokerOrders: [order] })).resolves.toBe(0);
    await expect(resolveClearedExitReservationAttention({ ...snapshots, brokerOrders: [
      { ...order, id: 'terminal', status: 'canceled' },
      { ...order, id: 'remaining', qty: '1', status: 'partially_filled' },
    ] })).resolves.toBe(0);
    expect(mocks.resolve).not.toHaveBeenCalled();
  });

  it.each([
    ['missing position', { brokerPositions: [] }],
    ['short position', { brokerPositions: [{ broker: 'alpaca', symbol: 'QQQ', side: 'short', qty: '3' }] }],
    ['malformed quantity', { brokerPositions: [{ broker: 'alpaca', symbol: 'QQQ', side: 'long', qty: 'NaN' }] }],
    ['quantity mismatch', { brokerPositions: [{ broker: 'alpaca', symbol: 'QQQ', side: 'long', qty: '2' }] }],
    ['closing local position', { trackedPositions: [{ ...snapshots.trackedPositions[0], status: 'closing' }] }],
  ])('does not resolve on %s', async (_label, overrides) => {
    await expect(resolveClearedExitReservationAttention({
      ...snapshots,
      ...(overrides as Partial<typeof snapshots>),
    })).resolves.toBe(0);
    expect(mocks.resolve).not.toHaveBeenCalled();
  });

  it('does not resolve while a pending, submitting, or submitted AI Trader close remains', async () => {
    mocks.findIntent.mockResolvedValue({ id: 273 });
    await expect(resolveClearedExitReservationAttention(snapshots)).resolves.toBe(0);
    expect(mocks.resolve).not.toHaveBeenCalled();
  });

  it('does not resolve Live attention from a non-authoritative observer', async () => {
    await expect(resolveClearedExitReservationAttention({ ...snapshots, environment: 'LIVE' })).resolves.toBe(0);
    expect(mocks.findAttentions).not.toHaveBeenCalled();
  });
});
