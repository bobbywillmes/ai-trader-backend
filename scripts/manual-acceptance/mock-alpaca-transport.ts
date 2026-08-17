type MockRequest = {
  method: string;
  path: string;
  body: unknown;
  occurredAt: string;
};

const ALPACA_HOSTS = new Set(['api.alpaca.markets', 'paper-api.alpaca.markets']);
const requests: MockRequest[] = [];
let nextOrderId = 1;

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function account() {
  return {
    id: 'manual-acceptance-live-account',
    account_number: 'TEST-LIVE-0001',
    status: 'ACTIVE',
    currency: 'USD',
    cash: '100000.00',
    buying_power: '200000.00',
    equity: '100000.00',
    portfolio_value: '100000.00',
    trading_blocked: false,
    transfers_blocked: false,
    account_blocked: false,
    shorting_enabled: false,
    pattern_day_trader: false,
    trade_suspended_by_user: false,
  };
}

export function installMockAlpacaTransport() {
  if (process.env.MANUAL_ACCEPTANCE_HARNESS !== 'I_UNDERSTAND_THIS_IS_SYNTHETIC') {
    throw new Error('Manual acceptance transport requires the explicit harness sentinel.');
  }

  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const rawUrl = input instanceof Request ? input.url : String(input);
    const url = new URL(rawUrl);
    if (url.protocol !== 'https:' || !ALPACA_HOSTS.has(url.hostname)) {
      throw new Error(`Manual acceptance network deny: ${url.origin}${url.pathname}`);
    }

    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const bodyText = typeof init?.body === 'string' ? init.body : null;
    const body = bodyText ? JSON.parse(bodyText) : null;
    requests.push({ method, path: `${url.pathname}${url.search}`, body, occurredAt: new Date().toISOString() });

    if (url.pathname === '/v2/account') return json(account());
    if (url.pathname === '/v2/positions') return json([]);
    if (url.pathname === '/v2/orders' && method === 'GET') return json([]);
    if (url.pathname.startsWith('/v2/orders:by_client_order_id') && method === 'GET') return json({ message: 'not found' }, 404);
    if (url.pathname.startsWith('/v2/orders/') && method === 'GET') return json({ message: 'not found' }, 404);
    if (url.pathname === '/v2/orders' && method === 'POST') {
      const order = body as Record<string, unknown>;
      return json({
        id: `mock-order-${nextOrderId++}`,
        client_order_id: order.client_order_id,
        symbol: order.symbol,
        side: order.side,
        type: order.type,
        time_in_force: order.time_in_force,
        qty: order.qty ?? null,
        notional: order.notional ?? null,
        status: 'accepted',
        created_at: new Date().toISOString(),
        submitted_at: new Date().toISOString(),
      });
    }
    if (url.pathname === '/v2/calendar') {
      const day = new Date().toISOString().slice(0, 10);
      return json([{ date: day, open: '00:00', close: '23:59' }]);
    }
    if (url.pathname === '/v2/clock') {
      return json({ timestamp: new Date().toISOString(), is_open: true, next_open: new Date().toISOString(), next_close: new Date(Date.now() + 3_600_000).toISOString() });
    }
    if (url.pathname.startsWith('/v2/account/activities')) return json([]);

    throw new Error(`Manual acceptance Alpaca mock has no route for ${method} ${url.pathname}${url.search}`);
  };
}

export function mockAlpacaState() {
  return {
    postCount: requests.filter((item) => item.method === 'POST').length,
    requests: [...requests],
  };
}
