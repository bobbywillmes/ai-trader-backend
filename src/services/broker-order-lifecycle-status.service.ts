export const TERMINAL_BROKER_ORDER_STATUSES = [
  'filled',
  'canceled',
  'expired',
  'rejected',
  'replaced',
  'done_for_day',
  'calculated',
] as const;

const TERMINAL_BROKER_ORDER_STATUS_SET = new Set<string>(
  TERMINAL_BROKER_ORDER_STATUSES
);

export function normalizeBrokerOrderStatus(status: string) {
  return status.trim().toLowerCase();
}

export function isTerminalBrokerOrderStatus(status: string) {
  return TERMINAL_BROKER_ORDER_STATUS_SET.has(
    normalizeBrokerOrderStatus(status)
  );
}

export function isNonterminalBrokerOrderStatus(status: string) {
  return !isTerminalBrokerOrderStatus(status);
}

export const NONTERMINAL_BROKER_ORDER_PRISMA_FILTER = {
  notIn: [...TERMINAL_BROKER_ORDER_STATUSES],
};
