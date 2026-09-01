import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ findAttention: vi.fn(), event: vi.fn(), attention: vi.fn() }));
vi.mock('../config/env.js', () => ({ env: { NODE_ENV: 'test', LIVE_WRITE_DEPLOYMENT_ROLE: 'OBSERVATION_ONLY' } }));
vi.mock('../db/prisma.js', () => ({ prisma: { operationalAttention: { findUnique: mocks.findAttention } } }));
vi.mock('./system-event.service.js', () => ({ createSystemEvent: mocks.event }));
vi.mock('./operational-attention.service.js', () => ({
  OPERATIONAL_ATTENTION_CODES: { UNEXPECTED_SHORT_POSITION: 'UNEXPECTED_SHORT_POSITION' },
  OPERATIONAL_ATTENTION_SOURCES: { RECONCILIATION: 'RECONCILIATION' },
  openOrObserveOperationalAttention: mocks.attention,
}));

import { observeUnexpectedShortExposure, unexpectedShortSeverity } from './unexpected-short-exposure.service.js';

describe('unexpected short exposure observation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findAttention.mockResolvedValue(null);
    mocks.event.mockResolvedValue({ id: 91 });
    mocks.attention.mockResolvedValue({});
  });

  it('marks Paper at ERROR and observation-only Live honestly at WARNING', () => {
    expect(unexpectedShortSeverity('PAPER')).toBe('ERROR');
    expect(unexpectedShortSeverity('LIVE')).toBe('WARNING');
  });

  it('creates sanitized immutable evidence and authoritative-only attention', async () => {
    await observeUnexpectedShortExposure({ tradingAccountId: 7, environment: 'PAPER', symbol: 'spy', brokerQty: '-3', brokerSide: 'short' });
    expect(mocks.event).toHaveBeenCalledWith(expect.objectContaining({
      type: 'broker.unexpected_short_position_observed', tradingAccountId: 7, severity: 'ERROR',
      payloadJson: expect.objectContaining({ symbol: 'SPY', brokerSide: 'short', brokerQty: '-3', automatedAction: 'BLOCK_SELLS_NO_AUTO_COVER' }),
    }));
    expect(mocks.attention).toHaveBeenCalledWith(expect.objectContaining({
      fingerprint: 'account:7|unexpected-short:SPY', resolutionPolicy: 'AUTHORITATIVE_ONLY', severity: 'ERROR',
    }));
  });

  it('refreshes one episode without poll-spam SystemEvents', async () => {
    mocks.findAttention.mockResolvedValue({ id: 33 });
    await observeUnexpectedShortExposure({ tradingAccountId: 7, environment: 'PAPER', symbol: 'SPY', brokerQty: '-3', brokerSide: 'short' });
    expect(mocks.event).not.toHaveBeenCalled();
    expect(mocks.attention).toHaveBeenCalledOnce();
  });
});
