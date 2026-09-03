import { randomUUID } from 'node:crypto';

import { assertLifecycleRepairAcceptanceEnvironment } from './guard.js';
import { installMockAlpacaTransport } from '../manual-acceptance/mock-alpaca-transport.js';
import { MANUAL_ACCEPTANCE_SENTINEL } from '../../src/services/manual-acceptance-environment.js';

assertLifecycleRepairAcceptanceEnvironment();
process.env.MANUAL_ACCEPTANCE_HARNESS = MANUAL_ACCEPTANCE_SENTINEL;
installMockAlpacaTransport();

const [{ prisma }, { hashPassword }, attentionService] = await Promise.all([
  import('../../src/db/prisma.js'),
  import('../../src/services/auth.service.js'),
  import('../../src/services/operational-attention.service.js'),
]);

const suffix = randomUUID();
const fillAt = new Date('2031-04-08T15:30:00.000Z');
const owner = await prisma.user.create({ data: {
  email: `lifecycle-owner-${suffix}@example.invalid`, name: 'Lifecycle Repair Acceptance Owner',
  platformRole: 'SYSTEM_OWNER', passwordHash: await hashPassword('LifecycleRepairAcceptanceOnly!2031'),
  emailVerifiedAt: new Date(), setupCompletedAt: new Date(),
} });
const account = await prisma.tradingAccount.create({ data: {
  accountHolderUserId: owner.id, displayName: `Synthetic Lifecycle PAPER ${suffix.slice(0, 8)}`,
  environment: 'PAPER', status: 'ACTIVE', tradingEnabled: false, killSwitchEnabled: true,
  brokerAccountId: `synthetic-paper-${suffix}`,
} });
const security = await prisma.security.create({ data: { symbol: `ZX${suffix.slice(0, 4).toUpperCase()}`, name: 'Synthetic Acceptance Equity', assetType: 'STOCK' } });
const strategy = await prisma.strategy.create({ data: { key: `synthetic_strategy_${suffix}`, name: 'Synthetic Acceptance Strategy' } });
const exitProfile = await prisma.exitProfile.create({ data: { key: `synthetic_exit_${suffix}`, name: 'Synthetic Acceptance Exit', exitMode: 'market', takeProfitBehavior: 'close' } });
const subscription = await prisma.subscription.create({ data: { key: `synthetic_subscription_${suffix}`, name: 'Synthetic Acceptance Subscription', symbol: security.symbol, securityId: security.id, strategyId: strategy.id, exitProfileId: exitProfile.id } });
const assignment = await prisma.tradingAccountSubscription.create({ data: { tradingAccountId: account.id, subscriptionId: subscription.id, fixedQty: 1 } });
const preceding = await prisma.trackedPosition.create({ data: {
  tradingAccountId: account.id, broker: 'alpaca', securityId: security.id, symbol: security.symbol, side: 'long', qty: 1,
  avgEntryPrice: 98, currentPrice: 99, marketValue: 99, costBasis: 98, unrealizedPnL: 1, unrealizedPnLPct: 0.0102,
  status: 'closed', openedAt: new Date(fillAt.getTime() - 86_400_000), closedAt: new Date(fillAt.getTime() - 60_000), lastSyncedAt: fillAt,
  rawPositionJson: { fixture: true, identity: randomUUID() }, subscriptionId: subscription.id, tradingAccountSubscriptionId: assignment.id,
} });
const candidate = await prisma.trackedPosition.create({ data: {
  tradingAccountId: account.id, broker: 'alpaca', securityId: security.id, symbol: security.symbol, side: 'long', qty: 1,
  avgEntryPrice: 100.5, currentPrice: 104, marketValue: 104, costBasis: 100.5, unrealizedPnL: 3.5, unrealizedPnLPct: 0.0348,
  status: 'closed', openedAt: new Date(fillAt.getTime() + 1_000), closedAt: new Date(fillAt.getTime() + 86_400_000), lastSyncedAt: new Date(fillAt.getTime() + 86_400_000),
  rawPositionJson: { fixture: true, identity: randomUUID() }, subscriptionId: subscription.id, tradingAccountSubscriptionId: assignment.id,
  configSnapshotJson: { subscriptionResolutionSource: 'local_order_intent', fixture: true }, configSnapshotCapturedAt: new Date(fillAt.getTime() + 2_000),
} });
const clientOrderId = `acceptance-${randomUUID()}`;
const intent = await prisma.orderIntent.create({ data: {
  source: 'acceptance-fixture', symbol: security.symbol, side: 'buy', orderType: 'market', timeInForce: 'day', qty: 1,
  clientOrderId, status: 'new', rawRequestJson: { fixture: true, identity: randomUUID() }, tradingAccountId: account.id,
  subscriptionId: subscription.id, subscriptionKey: subscription.key, tradingAccountSubscriptionId: assignment.id, createdAt: new Date(fillAt.getTime() - 2_000),
} });
const brokerOrderId = randomUUID();
const order = await prisma.brokerOrder.create({ data: {
  orderIntentId: intent.id, tradingAccountId: account.id, broker: 'alpaca', brokerOrderId, clientOrderId,
  securityId: security.id, symbol: security.symbol, side: 'buy', status: 'new', rawBrokerJson: { id: brokerOrderId, status: 'new', filled_qty: '0', fixture: true }, createdAt: new Date(fillAt.getTime() - 1_000),
} });
const entryActivity = await prisma.brokerActivity.create({ data: {
  tradingAccountId: account.id, broker: 'alpaca', mode: 'paper', activityId: randomUUID(), activityType: 'FILL', symbol: security.symbol, side: 'buy',
  qty: 1, cumQty: 1, leavesQty: 0, price: 100, orderId: brokerOrderId, orderIntentId: intent.id, brokerOrderRecordId: order.id,
  transactionTime: fillAt, rawBrokerJson: { order_status: 'filled', qty: '1', cum_qty: '1', leaves_qty: '0', price: '100', fixture: true },
} });
await prisma.brokerActivity.create({ data: {
  tradingAccountId: account.id, broker: 'alpaca', mode: 'paper', activityId: randomUUID(), activityType: 'FILL', symbol: security.symbol, side: 'sell',
  qty: 1, cumQty: 1, leavesQty: 0, price: 104, orderId: randomUUID(), trackedPositionId: candidate.id,
  trackedPositionLinkSource: 'broker_order', trackedPositionLinkedAt: new Date(fillAt.getTime() + 86_400_000), transactionTime: new Date(fillAt.getTime() + 86_400_000), rawBrokerJson: { fixture: true, exit: true },
} });
const fingerprint = `account:${account.id}|historical-entry-lifecycle:brokerOrder:${order.id}`;
const opened = await attentionService.openOrObserveOperationalAttention({
  tradingAccountId: account.id, brokerOrderId: order.id, orderIntentId: intent.id,
  code: attentionService.OPERATIONAL_ATTENTION_CODES.HISTORICAL_ENTRY_LIFECYCLE_INCOMPLETE,
  source: attentionService.OPERATIONAL_ATTENTION_SOURCES.RECONCILIATION, severity: 'WARNING',
  title: `${security.symbol} historical entry lifecycle is incomplete`,
  message: `Historical ${security.symbol} BUY BrokerOrder has full-fill evidence but retains a nonterminal local status. Its position link is unresolved.`,
  details: { fixture: true, unresolvedComponents: ['STALE_ORDER_STATUS', 'MISSING_POSITION_LINK'], entryActivityId: entryActivity.id, candidatePositionId: candidate.id, precedingPositionId: preceding.id },
  fingerprint, materialFingerprint: `synthetic-material-${suffix}`, resolutionPolicy: 'AUTHORITATIVE_ONLY',
});

console.log(JSON.stringify({ login: { email: owner.email, password: 'LifecycleRepairAcceptanceOnly!2031' }, accountId: account.id, attentionId: opened.attention.id, brokerOrderRecordId: order.id, candidateTrackedPositionId: candidate.id }, null, 2));
await prisma.$disconnect();
