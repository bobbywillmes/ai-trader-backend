import { describe, expect, it } from 'vitest';

import {
  isNonterminalBrokerOrderStatus,
  isTerminalBrokerOrderStatus,
  TERMINAL_BROKER_ORDER_STATUSES,
} from './broker-order-lifecycle-status.service.js';

const SUPPORTED_ALPACA_ORDER_STATUSES = [
  'new',
  'partially_filled',
  'filled',
  'done_for_day',
  'canceled',
  'expired',
  'replaced',
  'pending_cancel',
  'pending_replace',
  'accepted',
  'pending_new',
  'accepted_for_bidding',
  'stopped',
  'rejected',
  'suspended',
  'calculated',
  'held',
] as const;

describe('broker order lifecycle status policy', () => {
  it.each(SUPPORTED_ALPACA_ORDER_STATUSES)(
    'classifies %s consistently',
    (status) => {
      const expectedTerminal = TERMINAL_BROKER_ORDER_STATUSES.includes(
        status as (typeof TERMINAL_BROKER_ORDER_STATUSES)[number]
      );
      expect(isTerminalBrokerOrderStatus(status)).toBe(expectedTerminal);
      expect(isNonterminalBrokerOrderStatus(status)).toBe(!expectedTerminal);
    }
  );

  it('normalizes broker status casing and whitespace', () => {
    expect(isTerminalBrokerOrderStatus(' FILLED ')).toBe(true);
    expect(isNonterminalBrokerOrderStatus(' SUSPENDED ')).toBe(true);
  });
});
