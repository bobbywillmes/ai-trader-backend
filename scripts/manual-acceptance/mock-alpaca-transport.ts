import { MANUAL_ACCEPTANCE_SENTINEL } from '../../src/services/manual-acceptance-environment.js';

type MockRequest = {
  host: string;
  method: string;
  path: string;
  body: unknown;
  occurredAt: string;
};

const ALPACA_HOSTS = new Set(['api.alpaca.markets', 'paper-api.alpaca.markets']);
const MASSIVE_HOST = 'api.massive.com';
const MASSIVE_RSP_SNAPSHOT_PATH = '/v2/snapshot/locale/us/markets/stocks/tickers/RSP';
const MASSIVE_RSP_PRICE = 250;
const MASSIVE_RSP_PRICE_AT = Date.parse('2026-08-18T17:00:00.000Z');
const MARKET_TIME_ZONE = 'America/New_York';
const requests: MockRequest[] = [];
let nextOrderId = 1;
let submittedOrder: Record<string, unknown> | null = null;

function filledOrder() {
  if (!submittedOrder) return null;
  return {
    ...submittedOrder,
    status: 'filled',
    filled_qty: submittedOrder.qty,
    filled_avg_price: String(MASSIVE_RSP_PRICE),
    filled_at: submittedOrder.submitted_at,
  };
}

function filledPosition() {
  if (!submittedOrder) return null;
  const qty = String(submittedOrder.qty);
  const notional = Number(qty) * MASSIVE_RSP_PRICE;
  return {
    asset_id: 'manual-acceptance-rsp-asset',
    symbol: 'RSP',
    qty,
    avg_entry_price: String(MASSIVE_RSP_PRICE),
    market_value: String(notional),
    cost_basis: String(notional),
    unrealized_pl: '0',
    unrealized_plpc: '0',
    current_price: String(MASSIVE_RSP_PRICE),
    side: 'long',
  };
}

function fillActivity() {
  if (!submittedOrder) return null;
  const qty = String(submittedOrder.qty);
  return {
    id: `fill-${String(submittedOrder.id)}`,
    activity_type: 'FILL',
    type: 'fill',
    symbol: 'RSP',
    side: 'buy',
    qty,
    cum_qty: qty,
    leaves_qty: '0',
    price: String(MASSIVE_RSP_PRICE),
    net_amount: String(-(Number(qty) * MASSIVE_RSP_PRICE)),
    order_id: submittedOrder.id,
    transaction_time: submittedOrder.submitted_at,
  };
}

function marketDateParts(now: Date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: MARKET_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const values = new Map(parts.map((part) => [part.type, part.value]));
  return `${values.get('year')}-${values.get('month')}-${values.get('day')}`;
}

function addCalendarDays(date: string, days: number) {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year!, month! - 1, day! + days)).toISOString().slice(0, 10);
}

function isWeekday(date: string) {
  const day = new Date(`${date}T12:00:00.000Z`).getUTCDay();
  return day !== 0 && day !== 6;
}

function nextTradingDate(date: string) {
  let candidate = addCalendarDays(date, 1);
  while (!isWeekday(candidate)) candidate = addCalendarDays(candidate, 1);
  return candidate;
}

function marketInstant(date: string, hour: number, minute: number) {
  const [year, month, day] = date.split('-').map(Number);
  const wallClockAsUtc = new Date(Date.UTC(year!, month! - 1, day!, hour, minute));
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: MARKET_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(wallClockAsUtc);
  const values = new Map(parts.map((part) => [part.type, part.value]));
  const representedAsUtc = Date.UTC(
    Number(values.get('year')),
    Number(values.get('month')) - 1,
    Number(values.get('day')),
    Number(values.get('hour')),
    Number(values.get('minute')),
    Number(values.get('second')),
  );
  return new Date(wallClockAsUtc.getTime() - (representedAsUtc - wallClockAsUtc.getTime()));
}

function marketClock(now = new Date()) {
  const today = marketDateParts(now);
  const todayOpen = marketInstant(today, 9, 30);
  const todayClose = marketInstant(today, 16, 0);
  const todayIsTradingDay = isWeekday(today);
  const isOpen = todayIsTradingDay && now >= todayOpen && now < todayClose;
  const useToday = todayIsTradingDay && now < todayOpen;
  const upcomingDate = useToday ? today : nextTradingDate(today);

  return {
    timestamp: now.toISOString(),
    is_open: isOpen,
    next_open: marketInstant(upcomingDate, 9, 30).toISOString(),
    next_close: (isOpen ? todayClose : marketInstant(upcomingDate, 16, 0)).toISOString(),
  };
}

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
  if (process.env.MANUAL_ACCEPTANCE_HARNESS !== MANUAL_ACCEPTANCE_SENTINEL) {
    throw new Error('Manual acceptance transport requires the explicit harness sentinel.');
  }
  requests.length = 0;
  nextOrderId = 1;
  submittedOrder = null;

  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const rawUrl = input instanceof Request ? input.url : String(input);
    const url = new URL(rawUrl);
    const isAlpacaHost = ALPACA_HOSTS.has(url.hostname);
    const isMassiveHost = url.hostname === MASSIVE_HOST;
    if (url.protocol !== 'https:' || (!isAlpacaHost && !isMassiveHost)) {
      throw new Error(`Manual acceptance network deny: ${url.origin}${url.pathname}`);
    }

    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const bodyText = typeof init?.body === 'string' ? init.body : null;
    const body = bodyText ? JSON.parse(bodyText) : null;
    requests.push({ host: url.hostname, method, path: `${url.pathname}${url.search}`, body, occurredAt: new Date().toISOString() });

    if (isMassiveHost) {
      const onlyCacheBuster = [...url.searchParams.keys()].every((key) => key === '_') &&
        url.searchParams.getAll('_').length <= 1;
      if (method !== 'GET' || url.pathname !== MASSIVE_RSP_SNAPSHOT_PATH || !onlyCacheBuster) {
        throw new Error(`Manual acceptance Massive mock has no route for ${method} ${url.pathname}${url.search}`);
      }
      return json({
        ticker: {
          ticker: 'RSP',
          lastTrade: { p: MASSIVE_RSP_PRICE, t: MASSIVE_RSP_PRICE_AT },
          updated: MASSIVE_RSP_PRICE_AT,
        },
      });
    }

    if (url.pathname === '/v2/account') return json(account());
    if (url.pathname === '/v2/positions') {
      const position = filledPosition();
      return json(position ? [position] : []);
    }
    if (url.pathname === '/v2/orders' && method === 'GET') return json([]);
    if (url.pathname.startsWith('/v2/orders:by_client_order_id') && method === 'GET') {
      const order = filledOrder();
      return order && url.searchParams.get('client_order_id') === order.client_order_id
        ? json(order)
        : json({ message: 'not found' }, 404);
    }
    if (url.pathname.startsWith('/v2/orders/') && method === 'GET') {
      const order = filledOrder();
      return order && url.pathname === `/v2/orders/${String(order.id)}`
        ? json(order)
        : json({ message: 'not found' }, 404);
    }
    if (url.pathname === '/v2/orders' && method === 'POST') {
      const order = body as Record<string, unknown>;
      submittedOrder = {
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
      };
      return json(submittedOrder);
    }
    if (url.pathname === '/v2/calendar') {
      const day = url.searchParams.get('start') ?? marketDateParts(new Date());
      return json(isWeekday(day) ? [{ date: day, open: '09:30', close: '16:00' }] : []);
    }
    if (url.pathname === '/v2/clock') {
      return json(marketClock());
    }
    if (url.pathname.startsWith('/v2/account/activities')) {
      const activity = fillActivity();
      return json(activity ? [activity] : []);
    }

    throw new Error(`Manual acceptance Alpaca mock has no route for ${method} ${url.pathname}${url.search}`);
  };
}

export function mockAlpacaState() {
  return {
    totalRequests: requests.length,
    getCount: requests.filter((item) => item.method === 'GET').length,
    postCount: requests.filter((item) => ALPACA_HOSTS.has(item.host) && item.method === 'POST').length,
    submittedOrder: filledOrder(),
    recentRequests: requests.slice(-50),
  };
}
