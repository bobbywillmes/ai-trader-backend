import { describe, expect, it } from 'vitest';

import type { RuntimeTradingConfig } from './config.service.js';
import {
  getNewYorkDailyEntryWindow,
  representsDailyEntryActivity,
  representsPendingEntryExposure,
  resolveEffectiveAccountEntryLimits,
} from './trading-account-entry-risk-limits.service.js';

const globalConfig: RuntimeTradingConfig = {
  tradingEnabled: true,
  paperMode: true,
  killSwitchEnabled: false,
  maxDailyEntryOrders: 5,
  maxDailyEntryNotional: 10_000,
  maxOpenPositions: 5,
  maxTotalOpenNotional: 25_000,
  maxSymbolOpenNotional: 5_000,
  maxSubscriptionOpenNotional: 5_000,
  entrySessionGuardEnabled: true,
  entryStartMinutesAfterOpen: 15,
  entryCutoffMinutesBeforeClose: 30,
  failClosedOnMarketClockError: true,
  reconciliationWorkerEnabled: false,
  reconciliationWorkerIntervalMinutes: 15,
};

function accountRiskSettings() {
  return {
    enabled: true,
    maxDailyEntryOrders: 8,
    maxDailyEntryNotional: null,
    maxOpenPositions: 9,
    maxTotalOpenNotional: 12_000,
    maxSymbolOpenNotional: 10_000,
    maxSubscriptionOpenNotional: 3_000,
  };
}

describe('effective account entry limit resolution', () => {
  it('uses configured account values field by field without taking the lower global value', () => {
    const result = resolveEffectiveAccountEntryLimits({
      tradingAccountId: 7,
      maxDeployableNotional: 50_000,
      accountRiskSettings: accountRiskSettings(),
      globalConfig,
    });

    expect(result).toMatchObject({
      tradingAccountId: 7,
      usingLegacyGlobalFallback: true,
      limits: {
        maxDailyEntryOrders: { value: 8, source: 'ACCOUNT' },
        maxDailyEntryNotional: {
          value: 10_000,
          source: 'LEGACY_GLOBAL_FALLBACK',
        },
        maxOpenPositions: { value: 9, source: 'ACCOUNT' },
        maxSymbolOpenNotional: { value: 10_000, source: 'ACCOUNT' },
      },
      authoritativeTotalExposure: {
        field: 'maxDeployableNotional',
        value: 50_000,
        source: 'TRADING_ACCOUNT',
      },
    });
  });

  it('uses every global fallback when account risk settings are disabled', () => {
    const settings = { ...accountRiskSettings(), enabled: false };
    const result = resolveEffectiveAccountEntryLimits({
      tradingAccountId: 7,
      maxDeployableNotional: 50_000,
      accountRiskSettings: settings,
      globalConfig,
    });

    expect(result.accountRiskSettingsEnabled).toBe(false);
    expect(Object.values(result.limits)).toEqual([
      { value: 5, source: 'LEGACY_GLOBAL_FALLBACK' },
      { value: 10_000, source: 'LEGACY_GLOBAL_FALLBACK' },
      { value: 5, source: 'LEGACY_GLOBAL_FALLBACK' },
      { value: 5_000, source: 'LEGACY_GLOBAL_FALLBACK' },
    ]);
  });
});

describe('New York daily entry boundaries', () => {
  it('uses EST boundaries on a winter date', () => {
    const result = getNewYorkDailyEntryWindow(
      new Date('2026-01-15T17:00:00.000Z')
    );

    expect(result).toMatchObject({ date: '2026-01-15' });
    expect(result.start.toISOString()).toBe('2026-01-15T05:00:00.000Z');
    expect(result.nextStart.toISOString()).toBe('2026-01-16T05:00:00.000Z');
  });

  it('uses EDT boundaries on a summer date', () => {
    const result = getNewYorkDailyEntryWindow(
      new Date('2026-07-15T17:00:00.000Z')
    );

    expect(result).toMatchObject({ date: '2026-07-15' });
    expect(result.start.toISOString()).toBe('2026-07-15T04:00:00.000Z');
    expect(result.nextStart.toISOString()).toBe('2026-07-16T04:00:00.000Z');
  });

  it('keeps an instant just before New York midnight in the prior date', () => {
    expect(
      getNewYorkDailyEntryWindow(
        new Date('2026-07-16T03:59:59.999Z')
      ).date
    ).toBe('2026-07-15');
  });

  it('moves an instant at New York midnight into the next date', () => {
    expect(
      getNewYorkDailyEntryWindow(new Date('2026-07-16T04:00:00.000Z')).date
    ).toBe('2026-07-16');
  });
});

describe('entry intent lifecycle classification', () => {
  it('keeps accepted broker orders in daily activity after a terminal status', () => {
    expect(
      representsDailyEntryActivity({
        side: 'buy',
        status: 'canceled',
        blockReason: null,
        brokerOrderCount: 1,
      })
    ).toBe(true);
  });

  it('does not classify blocked or failed pre-broker intents as daily activity', () => {
    expect(
      representsDailyEntryActivity({
        side: 'buy',
        status: 'blocked',
        blockReason: 'risk blocked',
      })
    ).toBe(false);
    expect(
      representsDailyEntryActivity({ side: 'buy', status: 'failed' })
    ).toBe(false);
  });

  it('treats a filled unlinked intent as pending exposure until materialization', () => {
    expect(
      representsPendingEntryExposure({
        side: 'buy',
        status: 'filled',
        trackedPositionId: null,
      })
    ).toBe(true);
  });

  it('does not double-count an intent linked to a tracked position', () => {
    expect(
      representsPendingEntryExposure({
        side: 'buy',
        status: 'filled',
        trackedPositionId: 101,
      })
    ).toBe(false);
  });
});
