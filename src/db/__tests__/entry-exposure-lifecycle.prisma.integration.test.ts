import { randomUUID } from 'node:crypto';
import 'dotenv/config';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdaptivePollingDecision } from '../../services/adaptive-polling.service.js';
import { createDisposablePostgresDatabase, type DisposablePostgresDatabase } from './disposable-postgres.js';
import { AlpacaRateLimitDeferredError } from '../../errors/alpaca-rate-limit-deferred-error.js';

const enabled = process.env.RUN_ENTRY_EXPOSURE_PRISMA_TESTS === '1' && process.env.DATABASE_URL;
const describePrisma = enabled ? describe : describe.skip;
const originalDatabaseUrl = process.env.DATABASE_URL;

const broker = vi.hoisted(() => ({
  ordersById: new Map<string, Record<string, unknown>>(),
  ordersByClientId: new Map<string, Record<string, unknown>>(),
  openBuysByAccount: new Map<number, Array<Record<string, unknown>>>(),
  positionsByAccount: new Map<number, Array<Record<string, unknown>>>(),
  failCompleteOrdersForAccount: new Set<number>(),
  failClientOrderLookupForAccount: new Set<number>(),
  clientLookupErrorsByAccount: new Map<number, Error[]>(),
  clientLookupCalls: [] as Array<{ accountId: number; clientOrderId: string }>,
  submitCalls: [] as unknown[],
  openOrderCalls: [] as number[],
  orderByIdCalls: [] as Array<{ accountId: number; orderId: string }>,
}));

vi.mock('../../integrations/alpaca/orders.adapter.js', () => ({
  getAlpacaOrderById: vi.fn(async (accountId: number, id: string) => {
    broker.orderByIdCalls.push({ accountId, orderId: id });
    return broker.ordersById.get(id) ?? null;
  }),
  getAlpacaOrderByClientOrderId: vi.fn(async (accountId: number, id: string) => {
    broker.clientLookupCalls.push({ accountId, clientOrderId: id });
    const queuedError = broker.clientLookupErrorsByAccount.get(accountId)?.shift();
    if (queuedError) throw queuedError;
    if (broker.failClientOrderLookupForAccount.has(accountId)) throw new Error('broker lookup unavailable');
    return broker.ordersByClientId.get(id) ?? null;
  }),
  getCompleteOpenAlpacaBuyOrders: vi.fn(async (accountId: number) => {
    if (broker.failCompleteOrdersForAccount.has(accountId)) throw new Error('incomplete broker pagination');
    return broker.openBuysByAccount.get(accountId) ?? [];
  }),
  getCompleteOpenAlpacaBuyOrdersForSymbol: vi.fn(async (accountId: number, symbol: string) => {
    if (broker.failCompleteOrdersForAccount.has(accountId)) throw new Error('incomplete broker pagination');
    return (broker.openBuysByAccount.get(accountId) ?? []).filter((order) => order.symbol === symbol);
  }),
  getOpenAlpacaOrders: vi.fn(async (accountId: number) => {
    broker.openOrderCalls.push(accountId);
    return broker.openBuysByAccount.get(accountId) ?? [];
  }),
  submitAlpacaEntryOrder: vi.fn(async (...args: unknown[]) => {
    broker.submitCalls.push(args);
    throw new Error('Broker POST is prohibited in lifecycle integration tests.');
  }),
  submitVerifiedAlpacaExitOrder: vi.fn(),
  cancelAlpacaOrder: vi.fn(),
  cancelAllAlpacaOrders: vi.fn(),
}));

vi.mock('../../integrations/alpaca/positions.adapter.js', () => ({
  getAlpacaPositions: vi.fn(async (accountId: number) => broker.positionsByAccount.get(accountId) ?? []),
  getAlpacaPositionBySymbol: vi.fn(async (accountId: number, symbol: string) =>
    (broker.positionsByAccount.get(accountId) ?? []).find((position) => position.symbol === symbol) ?? null),
}));

vi.mock('../../services/assignment-entry-evaluation.service.js', () => ({
  evaluateAssignmentEntry: vi.fn(async () => null),
}));

vi.mock('../../services/risk-gate.service.js', () => ({
  evaluateOrderRisk: vi.fn(async () => ({ allowed: true, reason: 'allowed', statusCode: 200, details: {} })),
  logRiskGateBlockedOrder: vi.fn(),
}));

vi.mock('../../services/trading-reference-price.service.js', () => ({
  getTradingReferencePrice: vi.fn(async () => ({
    usable: true, price: 100, observedAt: '2026-10-18T00:00:00.000Z', fetchedAt: '2026-10-18T00:00:00.000Z',
    provider: 'FIXTURE', basis: 'FIXTURE', ageMs: 0, sessionPhase: 'REGULAR', rejectionReason: null,
  })),
}));

let disposable: DisposablePostgresDatabase;
let prisma: typeof import('../prisma.js').prisma;
let acquireEntryExposureClaim: typeof import('../../services/entry-exposure-claim.service.js').acquireEntryExposureClaim;
let attachEntryExposureClaimToPosition: typeof import('../../services/entry-exposure-claim.service.js').attachEntryExposureClaimToPosition;
let previewEntryExposureClaimRemediation: typeof import('../../services/entry-exposure-claim.service.js').previewEntryExposureClaimRemediation;
let releaseConfirmedTerminalEntryClaim: typeof import('../../services/entry-exposure-claim.service.js').releaseConfirmedTerminalEntryClaim;
let releaseEntryExposureClaimForClosedPosition: typeof import('../../services/entry-exposure-claim.service.js').releaseEntryExposureClaimForClosedPosition;
let transitionEntryExposureClaim: typeof import('../../services/entry-exposure-claim.service.js').transitionEntryExposureClaim;
let assessEntryExposureReadiness: typeof import('../../services/entry-exposure-readiness.service.js').assessEntryExposureReadiness;
let reconcileTradingAccount: typeof import('../../services/reconciliation.service.js').reconcileTradingAccount;
let syncSubmittedOrdersForAccountUnlocked: typeof import('../../workers/order.worker.js').syncSubmittedOrdersForAccountUnlocked;
let processPendingOrdersForAccount: typeof import('../../workers/order.worker.js').processPendingOrdersForAccount;
let recoverStaleSubmittingIntentsForAccount: typeof import('../../workers/order.worker.js').recoverStaleSubmittingIntentsForAccount;
let adaptivePollingCoordinator: typeof import('../../services/adaptive-polling.service.js').adaptivePollingCoordinator;
let disarmLiveEntries: typeof import('../../services/live-entry-arming.service.js').disarmLiveEntries;
let submitOrder: typeof import('../../services/place-order.service.js').submitOrder;

type Account = Awaited<ReturnType<typeof createAccount>>;

function alpacaOrder(args: { id: string; clientOrderId: string; symbol: string; status: string; filledQty?: string; side?: 'buy' | 'sell' }) {
  return {
    id: args.id, client_order_id: args.clientOrderId, symbol: args.symbol, side: args.side ?? 'buy', type: 'limit',
    time_in_force: 'gtc', status: args.status, submitted_at: '2026-10-18T00:00:00Z',
    qty: '10', filled_qty: args.filledQty ?? '0',
  };
}

function alpacaPosition(symbol: string, qty = '10') {
  return {
    asset_id: `asset-${symbol}`, symbol, qty, avg_entry_price: '100', market_value: '1000', cost_basis: '1000',
    unrealized_pl: '0', unrealized_plpc: '0', current_price: '100', side: 'long',
  };
}

async function createAccount(environment: 'PAPER' | 'LIVE' = 'PAPER') {
  const suffix = randomUUID();
  const user = await prisma.user.create({ data: { email: `entry-lifecycle-${suffix}@example.invalid`, platformRole: 'SYSTEM_OWNER' } });
  return prisma.tradingAccount.create({ data: {
    accountHolderUserId: user.id, displayName: `${environment} ${suffix}`, environment,
    status: environment === 'LIVE' ? 'ACTIVE' : 'ACTIVE', tradingEnabled: false, killSwitchEnabled: true,
  } });
}

async function createSecurity(prefix = 'T') {
  const symbol = `${prefix}${randomUUID().replaceAll('-', '').slice(0, 7)}`.toUpperCase();
  return prisma.security.create({ data: { symbol, name: symbol, assetType: 'STOCK' } });
}

async function createAssignment(account: Account, security: Awaited<ReturnType<typeof createSecurity>>, label: string) {
  const key = `${label}-${randomUUID()}`;
  const strategy = await prisma.strategy.create({ data: { key: `strategy-${key}`, name: `Strategy ${key}` } });
  const exitProfile = await prisma.exitProfile.create({ data: {
    key: `exit-${key}`, name: `Exit ${key}`, exitMode: 'manual', takeProfitBehavior: 'manual',
  } });
  const subscription = await prisma.subscription.create({ data: {
    key: `subscription-${key}`, name: `Subscription ${key}`, symbol: security.symbol,
    strategyId: strategy.id, exitProfileId: exitProfile.id, securityId: security.id,
  } });
  const allocation = await prisma.tradingAccountAllocation.create({ data: {
    tradingAccountId: account.id, key: `allocation-${key}`, name: `Allocation ${key}`,
    maxAllocatedNotional: 100_000, maxPositionNotional: 10_000,
  } });
  return prisma.tradingAccountSubscription.create({ data: {
    tradingAccountId: account.id, subscriptionId: subscription.id, allocationId: allocation.id,
    sizingType: 'FIXED_QTY', fixedQty: 10, reservedNotional: 10_000,
  } });
}

async function acquire(account: Account, security: Awaited<ReturnType<typeof createSecurity>>, ownerKey: string = randomUUID()) {
  return prisma.$transaction((tx) => acquireEntryExposureClaim({
    tx, tradingAccountId: account.id, symbol: security.symbol, ownerKey,
    createIntent: () => tx.orderIntent.create({ data: {
      source: 'integration_test', symbol: security.symbol, side: 'buy', orderType: 'market', timeInForce: 'day',
      qty: 10, clientOrderId: `client-${ownerKey}`, status: 'pending', rawRequestJson: {}, tradingAccountId: account.id,
    } }),
  }));
}

async function createLocalBrokerOrder(account: Account, security: Awaited<ReturnType<typeof createSecurity>>, intentId: number, order: ReturnType<typeof alpacaOrder>) {
  broker.ordersById.set(order.id, order);
  broker.ordersByClientId.set(order.client_order_id, order);
  return prisma.brokerOrder.create({ data: {
    orderIntentId: intentId, broker: 'alpaca', brokerOrderId: order.id, clientOrderId: order.client_order_id,
    symbol: security.symbol, side: order.side, status: order.status, rawBrokerJson: order,
    securityId: security.id, tradingAccountId: account.id,
  } });
}

async function createPosition(account: Account, security: Awaited<ReturnType<typeof createSecurity>>, status = 'open') {
  return prisma.trackedPosition.create({ data: {
    broker: 'alpaca', symbol: security.symbol, side: 'long', qty: 10, avgEntryPrice: 100, currentPrice: 100,
    marketValue: 1000, costBasis: 1000, unrealizedPnL: 0, unrealizedPnLPct: 0, status,
    rawPositionJson: alpacaPosition(security.symbol), securityId: security.id, tradingAccountId: account.id,
    ...(status === 'closed' ? { closedAt: new Date() } : {}),
  } });
}

describePrisma('entry exposure lifecycle with real Prisma services', () => {
  beforeAll(async () => {
    disposable = await createDisposablePostgresDatabase(process.env.DATABASE_URL!, 'entry_lifecycle');
    await disposable.migrate();
    await disposable.verify();
    process.env.DATABASE_URL = disposable.url;

    ({ prisma } = await import('../prisma.js'));
    ({
      acquireEntryExposureClaim,
      attachEntryExposureClaimToPosition,
      previewEntryExposureClaimRemediation,
      releaseConfirmedTerminalEntryClaim,
      releaseEntryExposureClaimForClosedPosition,
      transitionEntryExposureClaim,
    } = await import('../../services/entry-exposure-claim.service.js'));
    ({ assessEntryExposureReadiness } = await import('../../services/entry-exposure-readiness.service.js'));
    ({ reconcileTradingAccount } = await import('../../services/reconciliation.service.js'));
    ({ syncSubmittedOrdersForAccountUnlocked, processPendingOrdersForAccount, recoverStaleSubmittingIntentsForAccount } = await import('../../workers/order.worker.js'));
    ({ adaptivePollingCoordinator } = await import('../../services/adaptive-polling.service.js'));
    ({ disarmLiveEntries } = await import('../../services/live-entry-arming.service.js'));
    ({ submitOrder } = await import('../../services/place-order.service.js'));
  }, 180_000);

  afterAll(async () => {
    const { closeBrokerObservationPrisma } = await import('../broker-observation-prisma.js');
    const { closeTradingAccountWorkflowLockPool } = await import('../../services/trading-account-workflow-lock.service.js');
    await closeBrokerObservationPrisma();
    await closeTradingAccountWorkflowLockPool();
    await prisma?.$disconnect();
    await disposable?.drop();
    process.env.DATABASE_URL = originalDatabaseUrl;
  });

  beforeEach(() => {
    broker.failCompleteOrdersForAccount.clear();
    broker.failClientOrderLookupForAccount.clear();
    broker.clientLookupErrorsByAccount.clear();
    broker.clientLookupCalls.length = 0;
    broker.submitCalls.length = 0;
    broker.openOrderCalls.length = 0;
    broker.orderByIdCalls.length = 0;
    vi.spyOn(adaptivePollingCoordinator, 'getDecision').mockResolvedValue({
      due: true,
      reason: 'startup_due',
      mode: 'market_open_active',
      effectiveIntervalMs: 0,
      nextDueAt: null,
    } as AdaptivePollingDecision);
  });

  it('1. serializes competing strategy admissions for one account and Security', async () => {
    const account = await createAccount(); const security = await createSecurity('A');
    await prisma.tradingAccount.update({ where: { id: account.id }, data: { tradingEnabled: true, killSwitchEnabled: false } });
    await prisma.tradingAccountCredential.create({ data: {
      tradingAccountId: account.id, status: 'ACTIVE', apiKeyCiphertext: 'fixture', apiSecretCiphertext: 'fixture', verifiedAt: new Date(),
    } });
    const [firstAssignment, secondAssignment] = await Promise.all([
      createAssignment(account, security, 'one'), createAssignment(account, security, 'two'),
    ]);
    const runKey = randomUUID();
    const results = await Promise.allSettled([
      submitOrder({ tradingAccountSubscriptionId: firstAssignment.id, extendedHours: false }, { clientOrderId: `${runKey}-strategy-one` }),
      submitOrder({ tradingAccountSubscriptionId: secondAssignment.id, extendedHours: false }, { clientOrderId: `${runKey}-strategy-two` }),
    ]);
    if (results.every((result) => result.status === 'rejected')) {
      throw new Error(results.map((result) => result.status === 'rejected' ? String(result.reason) : '').join(' | '));
    }
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(await prisma.entryExposureClaim.count({ where: { tradingAccountId: account.id, securityId: security.id, releasedAt: null } })).toBe(1);
    expect(broker.submitCalls).toHaveLength(0);
  });

  it('2. returns the same intent for a stable owner-key retry', async () => {
    const account = await createAccount(); const security = await createSecurity('B');
    const ownerKey = `${randomUUID()}-stable-owner`;
    const first = await acquire(account, security, ownerKey);
    const retry = await acquire(account, security, ownerKey);
    expect(retry.duplicate).toBe(true); expect(retry.intent.id).toBe(first.intent.id);
    expect(await prisma.orderIntent.count({ where: { tradingAccountId: account.id, symbol: security.symbol } })).toBe(1);
  });

  it('3. preserves normal fill ownership through position closure and verified release', async () => {
    const account = await createAccount(); const security = await createSecurity('C'); const owned = await acquire(account, security);
    await transitionEntryExposureClaim({ orderIntentId: owned.intent.id, status: 'ENTRY_SUBMITTING', eventType: 'TEST_SUBMITTING' });
    await transitionEntryExposureClaim({ orderIntentId: owned.intent.id, status: 'BROKER_ORDER_ACTIVE', eventType: 'TEST_ACTIVE' });
    const order = alpacaOrder({ id: `order-${randomUUID()}`, clientOrderId: owned.intent.clientOrderId!, symbol: security.symbol, status: 'filled', filledQty: '10' });
    const localOrder = await createLocalBrokerOrder(account, security, owned.intent.id, order);
    await prisma.brokerActivity.create({ data: { broker: 'alpaca', mode: 'paper', activityId: `fill-${randomUUID()}`, activityType: 'FILL', symbol: security.symbol, side: 'buy', qty: 10, orderId: order.id, orderIntentId: owned.intent.id, brokerOrderRecordId: localOrder.id, rawBrokerJson: {}, tradingAccountId: account.id } });
    await releaseConfirmedTerminalEntryClaim({ orderIntentId: owned.intent.id, brokerStatus: 'filled' });
    expect((await prisma.entryExposureClaim.findUniqueOrThrow({ where: { id: owned.claimId } })).status).toBe('FILLED_AWAITING_POSITION');
    const position = await createPosition(account, security);
    await prisma.$transaction((tx) => attachEntryExposureClaimToPosition({ tx, tradingAccountId: account.id, securityId: security.id, trackedPositionId: position.id, symbol: security.symbol, expectedOrderIntentId: owned.intent.id }));
    await prisma.trackedPosition.update({ where: { id: position.id }, data: { status: 'closed', closedAt: new Date() } });
    broker.positionsByAccount.set(account.id, []); broker.openBuysByAccount.set(account.id, []);
    await releaseEntryExposureClaimForClosedPosition({ trackedPositionId: position.id });
    const released = await prisma.entryExposureClaim.findUniqueOrThrow({ where: { id: owned.claimId } });
    expect(released.status).toBe('RELEASED'); expect(released.releasedAt).not.toBeNull();
    expect((await prisma.entryExposureClaimEvent.findMany({ where: { claimId: owned.claimId } })).some((event) => event.eventType.includes('UNRESOLVED'))).toBe(false);
  });

  it('4. retains partial-fill ownership while executable quantity remains', async () => {
    const account = await createAccount(); const security = await createSecurity('D'); const owned = await acquire(account, security);
    await transitionEntryExposureClaim({ orderIntentId: owned.intent.id, status: 'ENTRY_SUBMITTING', eventType: 'TEST' });
    await transitionEntryExposureClaim({ orderIntentId: owned.intent.id, status: 'BROKER_ORDER_ACTIVE', eventType: 'TEST' });
    await transitionEntryExposureClaim({ orderIntentId: owned.intent.id, status: 'PARTIALLY_FILLED', eventType: 'TEST_PARTIAL' });
    const order = alpacaOrder({ id: `order-${randomUUID()}`, clientOrderId: owned.intent.clientOrderId!, symbol: security.symbol, status: 'partially_filled', filledQty: '3' });
    await createLocalBrokerOrder(account, security, owned.intent.id, order); broker.openBuysByAccount.set(account.id, [order]);
    await releaseConfirmedTerminalEntryClaim({ orderIntentId: owned.intent.id, brokerStatus: 'expired' });
    expect((await prisma.entryExposureClaim.findUniqueOrThrow({ where: { id: owned.claimId } })).status).toBe('PARTIALLY_FILLED');
  });

  it('5. refuses release while another broker BUY is executable', async () => {
    const account = await createAccount(); const security = await createSecurity('E'); const owned = await acquire(account, security);
    await transitionEntryExposureClaim({ orderIntentId: owned.intent.id, status: 'ENTRY_SUBMITTING', eventType: 'TEST' });
    await transitionEntryExposureClaim({ orderIntentId: owned.intent.id, status: 'BROKER_ORDER_ACTIVE', eventType: 'TEST' });
    const origin = alpacaOrder({ id: `order-${randomUUID()}`, clientOrderId: owned.intent.clientOrderId!, symbol: security.symbol, status: 'expired' });
    await createLocalBrokerOrder(account, security, owned.intent.id, origin);
    const other = alpacaOrder({ id: `manual-${randomUUID()}`, clientOrderId: `manual-${randomUUID()}`, symbol: security.symbol, status: 'new' });
    broker.openBuysByAccount.set(account.id, [other]);
    await releaseConfirmedTerminalEntryClaim({ orderIntentId: owned.intent.id, brokerStatus: 'expired' });
    expect((await prisma.entryExposureClaim.findUniqueOrThrow({ where: { id: owned.claimId } })).releasedAt).toBeNull();
  });

  it('6. retries a transient closed-position release failure during reconciliation', async () => {
    const account = await createAccount(); const security = await createSecurity('F'); const owned = await acquire(account, security);
    await transitionEntryExposureClaim({ orderIntentId: owned.intent.id, status: 'ENTRY_SUBMITTING', eventType: 'TEST' });
    await transitionEntryExposureClaim({ orderIntentId: owned.intent.id, status: 'BROKER_ORDER_ACTIVE', eventType: 'TEST' });
    const order = alpacaOrder({ id: `order-${randomUUID()}`, clientOrderId: owned.intent.clientOrderId!, symbol: security.symbol, status: 'filled' });
    await createLocalBrokerOrder(account, security, owned.intent.id, order);
    const position = await createPosition(account, security, 'closed');
    await prisma.entryExposureClaim.update({ where: { id: owned.claimId }, data: { trackedPositionId: position.id, status: 'POSITION_OPEN' } });
    broker.failCompleteOrdersForAccount.add(account.id);
    await releaseEntryExposureClaimForClosedPosition({ trackedPositionId: position.id });
    expect((await prisma.entryExposureClaim.findUniqueOrThrow({ where: { id: owned.claimId } })).releasedAt).toBeNull();
    broker.failCompleteOrdersForAccount.delete(account.id); broker.openBuysByAccount.set(account.id, []); broker.positionsByAccount.set(account.id, []);
    await reconcileTradingAccount(account.id);
    expect((await prisma.entryExposureClaim.findUniqueOrThrow({ where: { id: owned.claimId } })).status).toBe('RELEASED');
  });

  it('7. serializes position attachment against a competing admission', async () => {
    const account = await createAccount(); const security = await createSecurity('G'); const owned = await acquire(account, security); const position = await createPosition(account, security);
    const results = await Promise.allSettled([
      prisma.$transaction((tx) => attachEntryExposureClaimToPosition({ tx, tradingAccountId: account.id, securityId: security.id, trackedPositionId: position.id, symbol: security.symbol, expectedOrderIntentId: owned.intent.id })),
      acquire(account, security, 'racing-admission'),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect((await prisma.entryExposureClaim.findUniqueOrThrow({ where: { id: owned.claimId } })).trackedPositionId).toBe(position.id);
  });

  it('8. prevents a stale service transition from overwriting UNRESOLVED', async () => {
    const account = await createAccount(); const security = await createSecurity('H'); const owned = await acquire(account, security);
    await prisma.entryExposureClaim.update({ where: { id: owned.claimId }, data: { status: 'UNRESOLVED' } });
    await expect(transitionEntryExposureClaim({ orderIntentId: owned.intent.id, status: 'BROKER_ORDER_ACTIVE', eventType: 'STALE' })).rejects.toMatchObject({ statusCode: 409 });
    expect((await prisma.entryExposureClaim.findUniqueOrThrow({ where: { id: owned.claimId } })).status).toBe('UNRESOLVED');
  });

  it('9. synchronizes active order progression to terminal zero-fill release', async () => {
    const account = await createAccount(); const security = await createSecurity('I'); const owned = await acquire(account, security);
    await prisma.orderIntent.update({ where: { id: owned.intent.id }, data: { status: 'submitted' } });
    await prisma.entryExposureClaim.update({ where: { id: owned.claimId }, data: { status: 'BROKER_ORDER_ACTIVE' } });
    const order = alpacaOrder({ id: `order-${randomUUID()}`, clientOrderId: owned.intent.clientOrderId!, symbol: security.symbol, status: 'new' });
    await createLocalBrokerOrder(account, security, owned.intent.id, order);
    for (const status of ['new', 'accepted', 'expired']) {
      order.status = status; broker.ordersById.set(order.id, { ...order }); broker.openBuysByAccount.set(account.id, status === 'expired' ? [] : [{ ...order }]);
      await syncSubmittedOrdersForAccountUnlocked(account.id);
    }
    expect((await prisma.entryExposureClaim.findUniqueOrThrow({ where: { id: owned.claimId } })).status).toBe('RELEASED');
  });

  it('10. preserves submitting ownership when LIVE disarm loses the race', async () => {
    const account = await createAccount('LIVE'); const security = await createSecurity('J'); const owned = await acquire(account, security);
    await prisma.orderIntent.update({ where: { id: owned.intent.id }, data: { status: 'submitting' } });
    await prisma.entryExposureClaim.update({ where: { id: owned.claimId }, data: { status: 'ENTRY_SUBMITTING' } });
    const result = await disarmLiveEntries(account.id, null, 'Integration-test disarm race.');
    expect(result.entryIntentsBlocked).toBe(0);
    expect((await prisma.orderIntent.findUniqueOrThrow({ where: { id: owned.intent.id } })).status).toBe('submitting');
    expect((await prisma.entryExposureClaim.findUniqueOrThrow({ where: { id: owned.claimId } })).status).toBe('ENTRY_SUBMITTING');
  });

  it('11. adopts a verified legacy open position as protected without liquidation', async () => {
    const account = await createAccount(); const security = await createSecurity('K'); const position = await createPosition(account, security);
    broker.positionsByAccount.set(account.id, [alpacaPosition(security.symbol)]); broker.openBuysByAccount.set(account.id, []);
    const report = await assessEntryExposureReadiness({ apply: true, tradingAccountIds: [account.id] });
    const claim = await prisma.entryExposureClaim.findUniqueOrThrow({ where: { trackedPositionId: position.id } });
    expect(claim.status).toBe('POSITION_OPEN'); expect(report.protectedLegacyOpenPositions).toHaveLength(1);
    expect((await prisma.trackedPosition.findUniqueOrThrow({ where: { id: position.id } })).status).toBe('open');
  });

  it('12. rehearses safe adoption and never-submitted disposition to ready', async () => {
    const account = await createAccount(); const security = await createSecurity('L'); const pendingSecurity = await createSecurity('O'); const position = await createPosition(account, security);
    await prisma.orderIntent.create({ data: { source: 'legacy', symbol: pendingSecurity.symbol, side: 'buy', orderType: 'market', timeInForce: 'day', status: 'pending', rawRequestJson: {}, tradingAccountId: account.id } });
    broker.positionsByAccount.set(account.id, [alpacaPosition(security.symbol)]); broker.openBuysByAccount.set(account.id, []);
    expect((await assessEntryExposureReadiness({ tradingAccountIds: [account.id] })).ready).toBe(false);
    const applied = await assessEntryExposureReadiness({ apply: true, tradingAccountIds: [account.id] });
    expect(applied.ready).toBe(true); expect(applied.assessment).toBe('BROKER_VERIFIED_READY');
    expect((await prisma.trackedPosition.findUniqueOrThrow({ where: { id: position.id } })).status).toBe('open');
  });

  it('13. fails readiness closed on incomplete broker pagination', async () => {
    const account = await createAccount(); broker.failCompleteOrdersForAccount.add(account.id);
    const report = await assessEntryExposureReadiness({ tradingAccountIds: [account.id] });
    expect(report.ready).toBe(false); expect(report.assessment).toBe('BROKER_EVIDENCE_UNAVAILABLE');
  });

  it('14. isolates PAPER/LIVE accounts and Securities', async () => {
    const paper = await createAccount('PAPER'); const live = await createAccount('LIVE'); const spy = await createSecurity('M'); const qqq = await createSecurity('N');
    const runKey = randomUUID();
    await Promise.all([acquire(paper, spy, `${runKey}-paper-spy`), acquire(live, spy, `${runKey}-live-spy`), acquire(paper, qqq, `${runKey}-paper-qqq`)]);
    expect(await prisma.entryExposureClaim.count({ where: { releasedAt: null, OR: [
      { tradingAccountId: paper.id, securityId: spy.id }, { tradingAccountId: live.id, securityId: spy.id }, { tradingAccountId: paper.id, securityId: qqq.id },
    ] } })).toBe(3);
    expect(broker.submitCalls).toHaveLength(0);
  });

  it('15. treats closed fills and protected open fills as history while preserving unattributed current exposure', async () => {
    const account = await createAccount();
    const closedSecurity = await createSecurity('P'); const openSecurity = await createSecurity('Q'); const ambiguousSecurity = await createSecurity('R');
    const closedIntent = await prisma.orderIntent.create({ data: { source: 'legacy', symbol: closedSecurity.symbol, side: 'buy', orderType: 'market', timeInForce: 'day', status: 'filled', rawRequestJson: {}, tradingAccountId: account.id } });
    const closedPosition = await createPosition(account, closedSecurity, 'closed');
    await prisma.orderIntent.update({ where: { id: closedIntent.id }, data: { trackedPositionId: closedPosition.id } });
    const protectedOwned = await acquire(account, openSecurity); const openPosition = await createPosition(account, openSecurity);
    await prisma.orderIntent.update({ where: { id: protectedOwned.intent.id }, data: { status: 'filled', trackedPositionId: openPosition.id } });
    await prisma.entryExposureClaim.update({ where: { id: protectedOwned.claimId }, data: { status: 'POSITION_OPEN', trackedPositionId: openPosition.id } });
    await prisma.orderIntent.create({ data: { source: 'legacy', symbol: ambiguousSecurity.symbol, side: 'buy', orderType: 'market', timeInForce: 'day', status: 'filled', rawRequestJson: {}, tradingAccountId: account.id } });
    broker.positionsByAccount.set(account.id, [alpacaPosition(openSecurity.symbol), alpacaPosition(ambiguousSecurity.symbol)]); broker.openBuysByAccount.set(account.id, []);
    const report = await assessEntryExposureReadiness({ tradingAccountIds: [account.id] });
    expect(report.historicalFilledIntents.map((intent) => intent.id)).toContain(closedIntent.id);
    expect(report.unclaimedUnresolvedBuyIntents.map((intent) => intent.symbol)).toContain(ambiguousSecurity.symbol);
    expect(report.unclaimedUnresolvedBuyIntents.map((intent) => intent.symbol)).not.toContain(openSecurity.symbol);
  });

  it('16. releases a provably pre-dispatch disabled-assignment failure with zero broker POSTs', async () => {
    const account = await createAccount(); const security = await createSecurity('S');
    await prisma.tradingAccount.update({ where: { id: account.id }, data: { tradingEnabled: true, killSwitchEnabled: false } });
    await prisma.tradingAccountCredential.create({ data: { tradingAccountId: account.id, status: 'ACTIVE', apiKeyCiphertext: 'fixture', apiSecretCiphertext: 'fixture', verifiedAt: new Date() } });
    const assignment = await createAssignment(account, security, 'worker-disable');
    const admitted = await submitOrder({ tradingAccountSubscriptionId: assignment.id, extendedHours: false }, { clientOrderId: `disabled-${randomUUID()}` });
    await prisma.tradingAccountSubscription.update({ where: { id: assignment.id }, data: { enabled: false } });
    await processPendingOrdersForAccount(account.id);
    const intent = await prisma.orderIntent.findUniqueOrThrow({ where: { id: admitted.intentId } });
    const claim = await prisma.entryExposureClaim.findUniqueOrThrow({ where: { orderIntentId: intent.id } });
    expect(intent.status).toBe('failed'); expect(claim.status).toBe('RELEASED'); expect(claim.releasedAt).not.toBeNull(); expect(broker.submitCalls).toHaveLength(0);
  });

  // Phase 3C.3 final correction: a failed lookup is still never proof of absence and never sends, but a
  // failure before the adapter-invocation marker of a marker-protocol claim is proven never sent.
  it('17. never sends when the broker idempotency lookup fails, releasing ownership only from structured pre-dispatch evidence', async () => {
    const account = await createAccount(); const security = await createSecurity('U');
    await prisma.tradingAccount.update({ where: { id: account.id }, data: { tradingEnabled: true, killSwitchEnabled: false } });
    await prisma.tradingAccountCredential.create({ data: { tradingAccountId: account.id, status: 'ACTIVE', apiKeyCiphertext: 'fixture', apiSecretCiphertext: 'fixture', verifiedAt: new Date() } });
    const assignment = await createAssignment(account, security, 'lookup-failure');
    const admitted = await submitOrder({ tradingAccountSubscriptionId: assignment.id, extendedHours: false }, { clientOrderId: `lookup-${randomUUID()}` });
    broker.failClientOrderLookupForAccount.add(account.id);
    await processPendingOrdersForAccount(account.id);
    broker.failClientOrderLookupForAccount.delete(account.id);
    const claim = await prisma.entryExposureClaim.findUniqueOrThrow({ where: { orderIntentId: admitted.intentId }, include: { events: { orderBy: { id: 'asc' } } } });
    expect(broker.submitCalls).toHaveLength(0);
    expect(claim.events.map((event) => event.eventType)).toEqual(['ACQUIRED', 'WORKER_CLAIMED_FOR_SUBMISSION', 'NOT_SENT_EVIDENCE_RECORDED', 'RELEASED_NO_BROKER_EXPOSURE']);
    expect(claim.events[2]!.evidenceJson).toMatchObject({ classification: 'NOT_SENT_PRE_DISPATCH', producer: 'WORKER_PRE_BOUNDARY_FAILURE', proof: { basis: 'ADAPTER_MARKER_V1_NO_INVOCATION_MARKER' } });
    expect(claim).toMatchObject({ status: 'RELEASED', releaseReason: 'WORKER_PROVEN_PRE_DISPATCH_BOUNDARY_FAILURE' });
    expect(await prisma.orderIntent.findUniqueOrThrow({ where: { id: admitted.intentId } })).toMatchObject({ status: 'failed', blockReason: 'LOCAL_PRE_DISPATCH_FAILURE:broker lookup unavailable' });
  });

  it('18. blocks readiness for executable BUYs backed only by released or absent claims', async () => {
    const account = await createAccount(); const security = await createSecurity('V'); const owned = await acquire(account, security);
    await prisma.entryExposureClaim.update({ where: { id: owned.claimId }, data: { status: 'RELEASED', releasedAt: new Date(), releaseReason: 'fixture' } });
    const active = alpacaOrder({ id: `active-${randomUUID()}`, clientOrderId: owned.intent.clientOrderId!, symbol: security.symbol, status: 'accepted' });
    await createLocalBrokerOrder(account, security, owned.intent.id, active); broker.openBuysByAccount.set(account.id, [active]);
    const brokerOnlySecurity = await createSecurity('W');
    broker.openBuysByAccount.set(account.id, [active, alpacaOrder({ id: `manual-${randomUUID()}`, clientOrderId: `manual-${randomUUID()}`, symbol: brokerOnlySecurity.symbol, status: 'new' })]);
    const report = await assessEntryExposureReadiness({ tradingAccountIds: [account.id] });
    expect(report.assessment).toBe('BLOCKED'); expect(report.unclaimedActiveBrokerBuys).toHaveLength(1); expect(report.brokerOnlyOpenBuys).toHaveLength(1);
  });

  it('19. rotates synchronization beyond an older full batch and releases a newer expired BUY', async () => {
    const account = await createAccount();
    for (let index = 0; index < 11; index += 1) {
      const security = await createSecurity('X'); const owned = await acquire(account, security, `old-${index}-${randomUUID()}`);
      await prisma.orderIntent.update({ where: { id: owned.intent.id }, data: { status: 'submitted' } });
      await prisma.entryExposureClaim.update({ where: { id: owned.claimId }, data: { status: 'BROKER_ORDER_ACTIVE' } });
      await createLocalBrokerOrder(account, security, owned.intent.id, alpacaOrder({ id: `old-${index}-${randomUUID()}`, clientOrderId: owned.intent.clientOrderId!, symbol: security.symbol, status: 'new' }));
    }
    const newerSecurity = await createSecurity('Y'); const newer = await acquire(account, newerSecurity, `new-${randomUUID()}`);
    await prisma.orderIntent.update({ where: { id: newer.intent.id }, data: { status: 'submitted' } });
    await prisma.entryExposureClaim.update({ where: { id: newer.claimId }, data: { status: 'BROKER_ORDER_ACTIVE' } });
    const activeNewer = alpacaOrder({ id: `expired-${randomUUID()}`, clientOrderId: newer.intent.clientOrderId!, symbol: newerSecurity.symbol, status: 'new' });
    await createLocalBrokerOrder(account, newerSecurity, newer.intent.id, activeNewer);
    broker.ordersById.set(activeNewer.id, { ...activeNewer, status: 'expired' });
    await syncSubmittedOrdersForAccountUnlocked(account.id); await syncSubmittedOrdersForAccountUnlocked(account.id);
    expect((await prisma.entryExposureClaim.findUniqueOrThrow({ where: { id: newer.claimId } })).status).toBe('RELEASED');
  });

  it('20. remediates historical delivery uncertainty only after exact terminal fill proof', async () => {
    const account = await createAccount(); const security = await createSecurity('Z'); const owned = await acquire(account, security);
    await prisma.orderIntent.update({ where: { id: owned.intent.id }, data: { status: 'filled', blockReason: 'BROKER_WRITE_DELIVERY:DELIVERY_UNCERTAIN:timeout' } });
    await prisma.entryExposureClaim.update({ where: { id: owned.claimId }, data: { status: 'UNRESOLVED' } });
    const filled = alpacaOrder({ id: `filled-${randomUUID()}`, clientOrderId: owned.intent.clientOrderId!, symbol: security.symbol, status: 'filled', filledQty: '10' });
    const local = await createLocalBrokerOrder(account, security, owned.intent.id, filled);
    await prisma.brokerActivity.create({ data: { broker: 'alpaca', mode: 'paper', activityId: `fill-${randomUUID()}`, activityType: 'FILL', symbol: security.symbol, side: 'buy', qty: 10, orderId: filled.id, orderIntentId: owned.intent.id, brokerOrderRecordId: local.id, rawBrokerJson: {}, tradingAccountId: account.id } });
    broker.positionsByAccount.set(account.id, []); broker.openBuysByAccount.set(account.id, []);
    const preview = await previewEntryExposureClaimRemediation(owned.claimId);
    expect(preview.eligible).toBe(true); expect(preview.blockers).not.toContain('DELIVERY_UNCERTAIN');
    const released = await releaseConfirmedTerminalEntryClaim({ orderIntentId: owned.intent.id, brokerStatus: 'filled', allowUnresolved: true });
    expect(released?.status).toBe('RELEASED'); expect(released?.releasedAt).not.toBeNull();
  });

  it('21. synchronizes a stale locally active BUY to broker-canceled before readiness', async () => {
    const account = await createAccount(); const security = await createSecurity('C'); const owned = await acquire(account, security);
    await prisma.orderIntent.update({ where: { id: owned.intent.id }, data: { status: 'accepted' } });
    await prisma.entryExposureClaim.update({ where: { id: owned.claimId }, data: { status: 'BROKER_ORDER_ACTIVE' } });
    const stale = alpacaOrder({ id: `stale-${randomUUID()}`, clientOrderId: owned.intent.clientOrderId!, symbol: security.symbol, status: 'accepted' });
    await createLocalBrokerOrder(account, security, owned.intent.id, stale);
    broker.ordersById.set(stale.id, { ...stale, status: 'canceled' }); broker.openBuysByAccount.set(account.id, []);
    expect((await assessEntryExposureReadiness({ tradingAccountIds: [account.id] })).staleLocalActiveBrokerBuys).toHaveLength(1);
    await syncSubmittedOrdersForAccountUnlocked(account.id);
    const report = await assessEntryExposureReadiness({ tradingAccountIds: [account.id] });
    expect(report.staleLocalActiveBrokerBuys).toHaveLength(0); expect(report.assessment).toBe('BROKER_VERIFIED_READY');
  });

  it('22. rotates past missing local broker-order records without requeueing or broker POSTs', async () => {
    const account = await createAccount();
    const missing: Array<{ intentId: number; claimId: number }> = [];
    for (let index = 0; index < 10; index += 1) {
      const security = await createSecurity('D'); const owned = await acquire(account, security, `missing-${index}-${randomUUID()}`);
      await prisma.orderIntent.update({ where: { id: owned.intent.id }, data: { status: 'submitted' } });
      await prisma.entryExposureClaim.update({ where: { id: owned.claimId }, data: { status: 'BROKER_ORDER_ACTIVE' } });
      missing.push({ intentId: owned.intent.id, claimId: owned.claimId });
    }
    const newerSecurity = await createSecurity('E'); const newer = await acquire(account, newerSecurity, `newer-${randomUUID()}`);
    await prisma.orderIntent.update({ where: { id: newer.intent.id }, data: { status: 'submitted' } });
    await prisma.entryExposureClaim.update({ where: { id: newer.claimId }, data: { status: 'BROKER_ORDER_ACTIVE' } });
    const local = alpacaOrder({ id: `newer-${randomUUID()}`, clientOrderId: newer.intent.clientOrderId!, symbol: newerSecurity.symbol, status: 'new' });
    await createLocalBrokerOrder(account, newerSecurity, newer.intent.id, local);
    broker.ordersById.set(local.id, { ...local, status: 'expired' }); broker.openBuysByAccount.set(account.id, []);

    await syncSubmittedOrdersForAccountUnlocked(account.id);
    await syncSubmittedOrdersForAccountUnlocked(account.id);

    expect((await prisma.entryExposureClaim.findUniqueOrThrow({ where: { id: newer.claimId } })).status).toBe('RELEASED');
    const olderIntents = await prisma.orderIntent.findMany({ where: { id: { in: missing.map((item) => item.intentId) } }, orderBy: { id: 'asc' } });
    expect(olderIntents.every((intent) => intent.status === 'submitted' && intent.lastSubmittedOrderSyncAt !== null)).toBe(true);
    const olderClaims = await prisma.entryExposureClaim.findMany({ where: { id: { in: missing.map((item) => item.claimId) } }, orderBy: { id: 'asc' } });
    expect(olderClaims.every((claim) => claim.status === 'BROKER_ORDER_ACTIVE' && claim.releasedAt === null)).toBe(true);
    const diagnostics = await prisma.entryExposureClaimEvent.findMany({ where: {
      claimId: { in: missing.map((item) => item.claimId) }, eventType: 'SUBMITTED_ORDER_LOCAL_BROKER_ORDER_MISSING',
    } });
    expect(diagnostics).toHaveLength(10);
    await syncSubmittedOrdersForAccountUnlocked(account.id);
    expect(await prisma.entryExposureClaimEvent.count({ where: {
      claimId: { in: missing.map((item) => item.claimId) }, eventType: 'SUBMITTED_ORDER_LOCAL_BROKER_ORDER_MISSING',
    } })).toBe(10);
    expect(broker.submitCalls).toHaveLength(0);
  });

  it('23. removes 21 coherent terminal orders from polling while retaining actionable and contradictory evidence', async () => {
    const account = await createAccount();

    for (let index = 0; index < 21; index += 1) {
      const security = await createSecurity('Z');
      const position = await createPosition(account, security, 'closed');
      const intent = await prisma.orderIntent.create({ data: {
        source: 'historical_exit_fixture', symbol: security.symbol, side: 'sell', orderType: 'market', timeInForce: 'day',
        qty: 10, clientOrderId: `terminal-${randomUUID()}`, status: 'submitted', rawRequestJson: {},
        tradingAccountId: account.id, trackedPositionId: position.id,
      } });
      await createLocalBrokerOrder(account, security, intent.id, alpacaOrder({
        id: `terminal-order-${randomUUID()}`, clientOrderId: intent.clientOrderId!, symbol: security.symbol,
        status: 'filled', filledQty: '10', side: 'sell',
      }));
    }

    const activeSecurity = await createSecurity('U');
    const activeIntent = await prisma.orderIntent.create({ data: {
      source: 'active_fixture', symbol: activeSecurity.symbol, side: 'buy', orderType: 'market', timeInForce: 'day',
      qty: 10, clientOrderId: `active-${randomUUID()}`, status: 'submitted', rawRequestJson: {}, tradingAccountId: account.id,
    } });
    const activeOrder = alpacaOrder({ id: `active-order-${randomUUID()}`, clientOrderId: activeIntent.clientOrderId!, symbol: activeSecurity.symbol, status: 'new' });
    await createLocalBrokerOrder(account, activeSecurity, activeIntent.id, activeOrder);

    const partialSecurity = await createSecurity('V');
    const partialIntent = await prisma.orderIntent.create({ data: {
      source: 'partial_fixture', symbol: partialSecurity.symbol, side: 'buy', orderType: 'market', timeInForce: 'day',
      qty: 10, clientOrderId: `partial-${randomUUID()}`, status: 'submitted', rawRequestJson: {}, tradingAccountId: account.id,
    } });
    const partialOrder = alpacaOrder({ id: `partial-order-${randomUUID()}`, clientOrderId: partialIntent.clientOrderId!, symbol: partialSecurity.symbol, status: 'partially_filled', filledQty: '3' });
    await createLocalBrokerOrder(account, partialSecurity, partialIntent.id, partialOrder);

    const missingSecurity = await createSecurity('W');
    await prisma.orderIntent.create({ data: {
      source: 'missing_link_fixture', symbol: missingSecurity.symbol, side: 'buy', orderType: 'market', timeInForce: 'day',
      qty: 10, clientOrderId: `missing-${randomUUID()}`, status: 'submitted', rawRequestJson: {}, tradingAccountId: account.id,
    } });

    const replacementSecurity = await createSecurity('X');
    const replacementIntent = await prisma.orderIntent.create({ data: {
      source: 'replacement_fixture', symbol: replacementSecurity.symbol, side: 'buy', orderType: 'market', timeInForce: 'day',
      qty: 10, clientOrderId: `replacement-${randomUUID()}`, status: 'replaced', rawRequestJson: {}, tradingAccountId: account.id,
    } });
    const replacementOrder = alpacaOrder({ id: `replacement-order-${randomUUID()}`, clientOrderId: replacementIntent.clientOrderId!, symbol: replacementSecurity.symbol, status: 'replaced' });
    await createLocalBrokerOrder(account, replacementSecurity, replacementIntent.id, replacementOrder);

    const contradictorySecurity = await createSecurity('Y');
    const contradictoryPosition = await createPosition(account, contradictorySecurity, 'closed');
    const contradictoryIntent = await prisma.orderIntent.create({ data: {
      source: 'contradictory_fixture', symbol: contradictorySecurity.symbol, side: 'sell', orderType: 'market', timeInForce: 'day',
      qty: 10, clientOrderId: `contradictory-${randomUUID()}`, status: 'submitted', rawRequestJson: {},
      tradingAccountId: account.id, trackedPositionId: contradictoryPosition.id,
    } });
    await createLocalBrokerOrder(account, contradictorySecurity, contradictoryIntent.id, alpacaOrder({
      id: `contradictory-filled-${randomUUID()}`, clientOrderId: contradictoryIntent.clientOrderId!, symbol: contradictorySecurity.symbol,
      status: 'filled', filledQty: '10',
    }));
    const contradictoryOrder = alpacaOrder({
      id: `contradictory-rejected-${randomUUID()}`, clientOrderId: `contradictory-rejected-${randomUUID()}`,
      symbol: contradictorySecurity.symbol, status: 'rejected',
    });
    await createLocalBrokerOrder(account, contradictorySecurity, contradictoryIntent.id, contradictoryOrder);

    const result = await syncSubmittedOrdersForAccountUnlocked(account.id);

    expect(result).toMatchObject({ found: 5, polled: true });
    expect(broker.openOrderCalls).toEqual([account.id]);
    expect(broker.orderByIdCalls).toHaveLength(4);
    expect(broker.orderByIdCalls.map((call) => call.orderId)).toEqual(expect.arrayContaining([
      activeOrder.id, partialOrder.id, replacementOrder.id,
    ]));
    expect(broker.orderByIdCalls.some((call) => call.orderId.startsWith('terminal-order-'))).toBe(false);
    expect(broker.submitCalls).toHaveLength(0);

    // Before the selection correction, the batch cap would have produced one
    // open-order request plus ten per-order lookups on this first tick.
    expect(broker.openOrderCalls.length + broker.orderByIdCalls.length).toBe(5);
    expect(1 + 10).toBeGreaterThan((broker.openOrderCalls.length + broker.orderByIdCalls.length) * 2);
  });

  it.each(['PAPER', 'LIVE'] as const)('24. recovers a stale %s exit with a NULL block reason', async (environment) => {
    const account = await createAccount(environment);
    const security = await createSecurity(environment === 'PAPER' ? 'NP' : 'NL');
    const clientOrderId = `null-block-${environment.toLowerCase()}-${randomUUID()}`;
    const intent = await prisma.orderIntent.create({ data: {
      source: 'null_block_exit_fixture', symbol: security.symbol, side: 'sell', orderType: 'market', timeInForce: 'day',
      qty: 10, clientOrderId, status: 'submitting', blockReason: null, rawRequestJson: { signalType: 'exit' },
      tradingAccountId: account.id, updatedAt: new Date(Date.now() - 10 * 60_000),
    } });
    const found = alpacaOrder({
      id: `null-block-order-${randomUUID()}`, clientOrderId, symbol: security.symbol, status: 'accepted', side: 'sell',
    });
    broker.ordersByClientId.set(clientOrderId, found);

    const result = await recoverStaleSubmittingIntentsForAccount(account.id, new Date());
    const recovered = await prisma.orderIntent.findUniqueOrThrow({
      where: { id: intent.id }, include: { brokerOrders: true },
    });

    expect(result).toMatchObject({ found: 1, linked: 1, retained: 0 });
    expect(recovered).toMatchObject({ status: 'submitted', blockReason: null });
    expect(recovered.brokerOrders).toHaveLength(1);
    expect(recovered.brokerOrders[0]).toMatchObject({
      brokerOrderId: found.id, clientOrderId, side: 'sell', status: 'accepted',
    });
    expect(broker.submitCalls).toHaveLength(0);
  });

  it('25. bounds deferred uncertain-exit rechecks and links a later broker order', async () => {
    const account = await createAccount('PAPER');
    const security = await createSecurity('DU');
    const clientOrderId = `deferred-uncertain-${randomUUID()}`;
    const startedAt = new Date();
    const intent = await prisma.orderIntent.create({ data: {
      source: 'deferred_exit_fixture', symbol: security.symbol, side: 'sell', orderType: 'market', timeInForce: 'day',
      qty: 10, clientOrderId, status: 'submitting',
      blockReason: 'BROKER_WRITE_DELIVERY:DELIVERY_UNCERTAIN:timeout', rawRequestJson: { signalType: 'exit' },
      tradingAccountId: account.id, updatedAt: new Date(startedAt.getTime() - 10 * 60_000),
    } });

    const first = await recoverStaleSubmittingIntentsForAccount(account.id, startedAt);
    expect(first).toMatchObject({ found: 1, linked: 0, retained: 1 });
    expect(broker.ordersByClientId.has(clientOrderId)).toBe(false);
    const deferred = await prisma.orderIntent.findUniqueOrThrow({ where: { id: intent.id } });
    expect(deferred).toMatchObject({
      status: 'submitting',
      blockReason: 'BROKER_WRITE_DELIVERY:DELIVERY_UNCERTAIN:timeout:RECOVERY_DEFERRED_EVENT_RECORDED',
      lastSubmittedOrderSyncAt: startedAt,
    });

    expect(broker.clientLookupCalls).toEqual([{ accountId: account.id, clientOrderId }]);
    await recoverStaleSubmittingIntentsForAccount(account.id, new Date(startedAt.getTime() + 2_000));
    expect(broker.clientLookupCalls).toHaveLength(1);

    const found = alpacaOrder({
      id: `deferred-found-${randomUUID()}`, clientOrderId, symbol: security.symbol, status: 'accepted', side: 'sell',
    });
    broker.ordersByClientId.set(clientOrderId, found);
    const rechecked = await recoverStaleSubmittingIntentsForAccount(
      account.id,
      new Date(startedAt.getTime() + 5 * 60_000 + 10_000)
    );
    expect(rechecked).toMatchObject({ found: 1, linked: 1 });
    expect(broker.clientLookupCalls).toHaveLength(2);
    expect(await prisma.orderIntent.findUniqueOrThrow({ where: { id: intent.id } })).toMatchObject({
      status: 'submitted', blockReason: null,
    });
    expect(broker.submitCalls).toHaveLength(0);
  });

  it('26. bounds legacy deferred-marker misses and rate-limit errors without weakening uncertainty', async () => {
    const account = await createAccount('LIVE');
    const security = await createSecurity('LD');
    const clientOrderId = `legacy-deferred-${randomUUID()}`;
    const startedAt = new Date();
    const originalBlockReason = 'legacy unclassified timeout:RECOVERY_DEFERRED_EVENT_RECORDED';
    const intent = await prisma.orderIntent.create({ data: {
      source: 'legacy_deferred_exit_fixture', symbol: security.symbol, side: 'sell', orderType: 'market', timeInForce: 'day',
      qty: 10, clientOrderId, status: 'submitting', blockReason: originalBlockReason,
      rawRequestJson: { signalType: 'exit' }, tradingAccountId: account.id,
      updatedAt: new Date(startedAt.getTime() - 10 * 60_000),
      lastSubmittedOrderSyncAt: new Date(startedAt.getTime() - 10 * 60_000),
    } });

    await recoverStaleSubmittingIntentsForAccount(account.id, startedAt);
    const afterMiss = await prisma.orderIntent.findUniqueOrThrow({ where: { id: intent.id } });
    expect(afterMiss).toMatchObject({ status: 'submitting', blockReason: originalBlockReason, lastSubmittedOrderSyncAt: startedAt });

    await recoverStaleSubmittingIntentsForAccount(account.id, new Date(startedAt.getTime() + 2_000));
    expect(broker.clientLookupCalls).toHaveLength(1);
    expect((await prisma.orderIntent.findUniqueOrThrow({ where: { id: intent.id } })).lastSubmittedOrderSyncAt).toEqual(startedAt);

    const rateLimitedAt = new Date(startedAt.getTime() + 5 * 60_000 + 10_000);
    broker.clientLookupErrorsByAccount.set(account.id, [new AlpacaRateLimitDeferredError({
      metadata: {
        operation: 'pending_order_idempotency_check', endpoint: 'GET /v2/orders:by_client_order_id', method: 'GET',
        requestClass: 'synchronization_read', operationClass: 'LIFECYCLE_READ', deferDuringRateLimit: true,
      },
      backoffUntil: new Date(rateLimitedAt.getTime() + 60_000),
    })]);
    const rateLimited = await recoverStaleSubmittingIntentsForAccount(account.id, rateLimitedAt);
    expect(rateLimited).toMatchObject({ retained: 1, failures: [{ orderIntentId: intent.id }] });
    expect(broker.clientLookupCalls).toHaveLength(2);
    expect(await prisma.orderIntent.findUniqueOrThrow({ where: { id: intent.id } })).toMatchObject({
      status: 'submitting', blockReason: originalBlockReason, lastSubmittedOrderSyncAt: rateLimitedAt,
    });

    await recoverStaleSubmittingIntentsForAccount(account.id, new Date(rateLimitedAt.getTime() + 2_000));
    expect(broker.clientLookupCalls).toHaveLength(2);

    const repeatedMissAt = new Date(rateLimitedAt.getTime() + 5 * 60_000 + 10_000);
    const repeatedMiss = await recoverStaleSubmittingIntentsForAccount(account.id, repeatedMissAt);
    expect(repeatedMiss).toMatchObject({ found: 1, linked: 0, retained: 1, failures: [] });
    expect(broker.clientLookupCalls).toHaveLength(3);
    expect(await prisma.orderIntent.findUniqueOrThrow({ where: { id: intent.id } })).toMatchObject({
      status: 'submitting', blockReason: originalBlockReason, lastSubmittedOrderSyncAt: repeatedMissAt,
    });

    await recoverStaleSubmittingIntentsForAccount(account.id, new Date(repeatedMissAt.getTime() + 2_000));
    expect(broker.clientLookupCalls).toHaveLength(3);
    expect(await prisma.brokerOrder.count({ where: { orderIntentId: intent.id } })).toBe(0);
    expect(broker.submitCalls).toHaveLength(0);
  });

  it('27. recovers a legacy deferred exit whose recovery-progress timestamp is NULL', async () => {
    const account = await createAccount('PAPER');
    const security = await createSecurity('NT');
    const clientOrderId = `null-recovery-progress-${randomUUID()}`;
    const startedAt = new Date();
    const originalBlockReason =
      'BROKER_WRITE_DELIVERY:DELIVERY_UNCERTAIN:legacy timeout:RECOVERY_DEFERRED_EVENT_RECORDED';
    const intent = await prisma.orderIntent.create({ data: {
      source: 'null_recovery_progress_fixture', symbol: security.symbol, side: 'sell',
      orderType: 'market', timeInForce: 'day', qty: 10, clientOrderId,
      status: 'submitting', blockReason: originalBlockReason,
      rawRequestJson: { signalType: 'exit' }, tradingAccountId: account.id,
      updatedAt: new Date(startedAt.getTime() - 10 * 60_000),
      lastSubmittedOrderSyncAt: null,
    } });

    const first = await recoverStaleSubmittingIntentsForAccount(account.id, startedAt);
    expect(first).toMatchObject({ found: 1, linked: 0, retained: 1, failures: [] });
    expect(broker.clientLookupCalls).toEqual([{ accountId: account.id, clientOrderId }]);
    expect(await prisma.orderIntent.findUniqueOrThrow({ where: { id: intent.id } })).toMatchObject({
      status: 'submitting', blockReason: originalBlockReason,
      lastSubmittedOrderSyncAt: startedAt,
    });

    await recoverStaleSubmittingIntentsForAccount(
      account.id,
      new Date(startedAt.getTime() + 2_000)
    );
    expect(broker.clientLookupCalls).toHaveLength(1);

    const found = alpacaOrder({
      id: `null-progress-found-${randomUUID()}`, clientOrderId,
      symbol: security.symbol, status: 'accepted', side: 'sell',
    });
    broker.ordersByClientId.set(clientOrderId, found);
    const rechecked = await recoverStaleSubmittingIntentsForAccount(
      account.id,
      new Date(startedAt.getTime() + 5 * 60_000 + 10_000)
    );
    expect(rechecked).toMatchObject({ found: 1, linked: 1, failures: [] });
    expect(broker.clientLookupCalls).toHaveLength(2);
    expect(await prisma.orderIntent.findUniqueOrThrow({ where: { id: intent.id } })).toMatchObject({
      status: 'submitted', blockReason: null,
    });
    expect(await prisma.brokerOrder.count({
      where: { orderIntentId: intent.id, brokerOrderId: found.id },
    })).toBe(1);
    expect(await prisma.entryExposureClaim.count({ where: { orderIntentId: intent.id } })).toBe(0);
    expect(broker.submitCalls).toHaveLength(0);
  });
});
