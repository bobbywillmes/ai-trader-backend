import http from 'node:http';

import { installMockAlpacaTransport, mockAlpacaState } from './mock-alpaca-transport.js';
import { MANUAL_ACCEPTANCE_ENTRYPOINT } from '../../src/services/manual-acceptance-environment.js';

const databaseUrl = process.env.DATABASE_URL ?? '';
if (new URL(databaseUrl).pathname !== '/ai_trader_live_entry_acceptance') {
  throw new Error('Manual acceptance server refuses DATABASE_URL unless the database is ai_trader_live_entry_acceptance.');
}
if (process.env.NODE_ENV !== 'production') {
  throw new Error('Manual acceptance server requires NODE_ENV=production for the real PRODUCTION_EXECUTOR policy gate.');
}

installMockAlpacaTransport();
process.env.MANUAL_ACCEPTANCE_ENTRYPOINT = MANUAL_ACCEPTANCE_ENTRYPOINT;

const controlToken = process.env.MANUAL_ACCEPTANCE_CONTROL_TOKEN;
if (!controlToken || controlToken.length < 16) throw new Error('MANUAL_ACCEPTANCE_CONTROL_TOKEN must be at least 16 characters.');

const { prisma } = await import('../../src/db/prisma.js');
const { processEntryForAccountSubscription } = await import('../../src/services/signal-entry.service.js');
const { processPendingOrders } = await import('../../src/workers/order.worker.js');

function response(res: http.ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(value, null, 2));
}

const control = http.createServer(async (req, res) => {
  try {
    if (req.headers.authorization !== `Bearer ${controlToken}`) return response(res, 401, { error: 'Unauthorized' });
    if (req.method === 'GET' && req.url === '/state') {
      const account = await prisma.tradingAccount.findUnique({
        where: { displayName: 'Synthetic Live Acceptance' },
        include: { liveEntryArmings: { include: { terminations: true } }, orderIntents: true },
      });
      return response(res, 200, { mock: mockAlpacaState(), account });
    }
    if (req.method === 'POST' && req.url === '/entry') {
      const assignment = await prisma.tradingAccountSubscription.findFirstOrThrow({
        where: { tradingAccount: { displayName: 'Synthetic Live Acceptance' }, subscription: { key: 'rsp_dip_core' } },
      });
      const entry = await processEntryForAccountSubscription({
        tradingAccountSubscriptionId: assignment.id,
        source: 'manual_acceptance_harness',
        idempotencyKey: `manual-acceptance-${Date.now()}`,
        signal: { source: 'manual_acceptance_harness', reason: 'One-shot Live entry acceptance proof', score: 100, confidence: 1 },
      });
      const worker = await processPendingOrders();
      return response(res, 200, { entry, worker, mock: mockAlpacaState() });
    }
    if (req.method === 'POST' && req.url === '/retry-consumed') {
      const intent = await prisma.orderIntent.findFirstOrThrow({
        where: { tradingAccount: { displayName: 'Synthetic Live Acceptance' } }, orderBy: { id: 'desc' },
      });
      await prisma.orderIntent.update({ where: { id: intent.id }, data: { status: 'received', blockReason: null } });
      const worker = await processPendingOrders();
      return response(res, 200, { retriedOrderIntentId: intent.id, worker, mock: mockAlpacaState() });
    }
    return response(res, 404, { error: 'Not found' });
  } catch (error) {
    return response(res, 500, { error: error instanceof Error ? error.message : String(error), mock: mockAlpacaState() });
  }
});

control.listen(3101, '127.0.0.1');
await import('../../src/app/server.js');
