import { useMemo, useState } from "react";
import { Alert, Anchor, Badge, Box, Card, Group, Loader, SegmentedControl, SimpleGrid, Skeleton, Stack, Text, Title } from "@mantine/core";
import { IconAlertTriangle, IconCircleCheck } from "@tabler/icons-react";
import { CartesianGrid, Legend, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Link, useLocation } from "react-router-dom";
import { DataState } from "../components/data-display";
import { getAdminToken } from "../lib/api";
import { useDashboardAccountsOverview, useIndexIntraday, useIndexPerformance, useTradingAccountDashboard } from "../features/dashboard/hooks";
import type { BrokerOpenOrder, BrokerPosition, DashboardOverviewRow, EntryReadiness, IndexChartRange, IndexIntradaySymbol, IndexPerformanceSymbol, RiskStatus } from "../features/dashboard/types";
import { describeRegularSession, formatMarketDateTime, getTradingTransition, marketContext, normalizeSeries, rangePosition } from "../features/dashboard/dashboardView";
import { useTradingAccountScope } from "../features/tradingAccountScope/useTradingAccountScope";
import { TradingAccountScopeSelector } from "../features/tradingAccountScope/TradingAccountScopeSelector";
import { createScopedNavigationTarget } from "../app/navigationUtils";
import classes from "./DashboardPage.module.css";
import { useAuth } from "../features/auth/useAuth";
import { getDashboardDescription } from "./dashboardPresentation";
import { DashboardOperationalAttention } from "../features/operationalAttention/DashboardOperationalAttention";

const ranges: Array<{ label: string; value: IndexChartRange }> = [
  { label: "1D", value: "1d" }, { label: "7D", value: "7d" }, { label: "14D", value: "14d" },
  { label: "30D", value: "30d" }, { label: "6M", value: "6m" }, { label: "1Y", value: "1y" },
];
const series = [
  { key: "SPY", color: "#22d3ee", dash: undefined }, { key: "QQQ", color: "#a78bfa", dash: "8 3" },
  { key: "DIA", color: "#fbbf24", dash: "3 3" }, { key: "IWM", color: "#fb7185", dash: "10 3 2 3" },
] as const;

function money(value: number | null | undefined) {
  return value == null || !Number.isFinite(value) ? "Unavailable" : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value);
}
function signedMoney(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return "Unavailable";
  return `${value > 0 ? "+" : value < 0 ? "−" : "±"}${money(Math.abs(value))}`;
}
function signedPercent(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return "Unavailable";
  return `${value > 0 ? "+" : value < 0 ? "−" : "±"}${Math.abs(value).toFixed(2)}%`;
}
function tone(value: number | null | undefined) { return value == null || value === 0 ? "gray" : value > 0 ? "teal" : "red"; }
function sessionLabel(status: RiskStatus["entrySession"]["status"]) { return status.replaceAll("_", " "); }

function Metric({ label, value, detail, pnl }: { label: string; value: string; detail?: string; pnl?: number | null }) {
  return <Card withBorder p="md"><Text size="xs" c="dimmed" fw={700} tt="uppercase">{label}</Text><Text className={classes.metricValue} mt={4} size="xl" fw={700} c={pnl == null ? undefined : tone(pnl)}>{value}</Text>{detail && <Text size="xs" c={pnl == null ? "dimmed" : tone(pnl)}>{detail}</Text>}</Card>;
}

function TradingReadiness({ risk }: { risk: EntryReadiness | undefined }) {
  if (!risk) return <Card withBorder p="md"><DataState state="empty" title="Trading readiness unavailable" message="Account readiness could not be evaluated." /></Card>;
  const session = risk.entrySession;
  if (!session) return <Card withBorder p="md"><Text fw={700}>Trading Readiness</Text><Badge mt="sm" color="orange">{risk.status}</Badge><Stack mt="sm" gap="xs">{risk.blockers.map((reason) => <Text size="sm" key={reason}>{reason}</Text>)}</Stack></Card>;
  const transition = getTradingTransition(session);
  return <Card withBorder p="md" aria-labelledby="trading-readiness-title">
    <Group justify="space-between" align="flex-start" mb="md"><div><Text id="trading-readiness-title" fw={700}>Trading Readiness</Text><Text size="xs" c="dimmed">Authoritative account and regular-session entry state</Text></div><Badge color={session.canEnterNow ? "teal" : session.degraded ? "yellow" : "orange"} variant="light">{session.canEnterNow ? "Entries permitted" : sessionLabel(session.status)}</Badge></Group>
    <div className={classes.readinessGrid}>
      <Datum label="Overall status" value={risk.canEnter ? "Operational — entries may proceed" : `Blocked — ${risk.blockers[0] ?? "entry requirements not met"}`} />
      <Datum label="Market state" value={session.marketOpen == null ? "Unavailable" : session.marketOpen ? "Open" : "Closed"} />
      <Datum label="Regular session" value={describeRegularSession(session)} />
      <Datum label={transition.label} value={formatMarketDateTime(transition.value)} />
      <Datum label="Evaluated" value={formatMarketDateTime(session.evaluatedAt)} />
    </div>
    {session.error && <Alert mt="md" color="yellow" title="Market-session provider warning">{session.error.message}</Alert>}
  </Card>;
}
function Datum({ label, value }: { label: string; value: string }) { return <div className={classes.datum}><div className={classes.datumLabel}>{label}</div><Text className={classes.datumValue} size="sm" fw={600}>{value}</Text></div>; }

function MarketTooltip({ active, label, payload }: { active?: boolean; label?: string; payload?: Array<{ name?: string; value?: number; color?: string }> }) {
  if (!active || !payload?.length) return null;
  return <Card p="xs" withBorder><Text size="xs" c="dimmed">{formatMarketDateTime(label)}</Text>{payload.map((item) => <Text key={item.name} size="xs" style={{ color: item.color }}>{item.name}: {signedPercent(item.value)}</Text>)}</Card>;
}

function MarketChart({ symbols }: { symbols: IndexIntradaySymbol[] }) {
  const data = useMemo(() => normalizeSeries(symbols), [symbols]);
  const summary = series.map(({ key }) => { const values = data.map((point) => point[key]).filter((value): value is number => typeof value === "number"); return `${key} ${signedPercent(values.at(-1))}`; }).join(", ");
  if (!data.length) return <DataState state="empty" title="Performance history unavailable" message="No bars were returned for this range." />;
  return <Box pos="relative"><Text className={classes.chartSummary}>Relative performance, normalized to zero percent at the beginning of the range. {summary}.</Text><div className={classes.chart} role="img" aria-label={`ETF relative-performance chart. ${summary}`}>
    <ResponsiveContainer width="100%" height="100%"><LineChart data={data} margin={{ top: 8, right: 8, bottom: 4, left: -12 }} accessibilityLayer>
      <CartesianGrid stroke="rgba(148,163,184,.14)" vertical={false} /><XAxis dataKey="time" minTickGap={45} tickFormatter={(v) => new Date(v).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/New_York" })} tick={{ fontSize: 11 }} /><YAxis tickFormatter={(v) => `${Number(v).toFixed(1)}%`} tick={{ fontSize: 11 }} width={54} /><ReferenceLine y={0} stroke="rgba(226,232,240,.65)" strokeWidth={1.5} /><Tooltip content={<MarketTooltip />} /><Legend wrapperStyle={{ fontSize: 12 }} />
      {series.map((item) => <Line key={item.key} type="monotone" dataKey={item.key} name={item.key} connectNulls={false} stroke={item.color} strokeDasharray={item.dash} strokeWidth={2.25} dot={false} isAnimationActive={false} />)}
    </LineChart></ResponsiveContainer>
  </div></Box>;
}

function EtfTile({ quote, history }: { quote: IndexPerformanceSymbol; history?: IndexIntradaySymbol }) {
  const current = quote.lastPrice; const currentPos = rangePosition(current, quote.dayLow, quote.dayHigh); const previousPos = rangePosition(quote.previousClose, quote.dayLow, quote.dayHigh);
  return <Card withBorder p="md"><Group justify="space-between"><Text fw={800}>{quote.symbol}</Text><Badge color={tone(quote.todayChangePercent)} variant="light">{signedPercent(quote.todayChangePercent)}</Badge></Group><Text size="xl" fw={700} mt="xs">{money(current)}</Text><Text size="sm" c={tone(quote.todayChange)}>{signedMoney(quote.todayChange)} today</Text>
    <div className={classes.range} aria-hidden="true">{previousPos != null && <span className={classes.previousMarker} style={{ left: `${previousPos}%` }} />}{currentPos != null && <span className={classes.rangeMarker} style={{ left: `${currentPos}%` }} />}</div>
    <Group justify="space-between"><Text size="xs" c="dimmed">Low {money(quote.dayLow)}</Text><Text size="xs" c="dimmed">High {money(quote.dayHigh)}</Text></Group><Text size="xs" c="dimmed" mt={4}>Previous close {money(quote.previousClose)}. {currentPos == null ? "Range position unavailable." : `Current price is ${currentPos.toFixed(0)}% through today’s low-to-high range.`}</Text>
    {history && history.points.length > 1 && <Box h={42} mt="xs" aria-hidden="true"><ResponsiveContainer width="100%" height="100%"><LineChart data={history.points}><Line type="monotone" dataKey="close" stroke={quote.todayChange && quote.todayChange < 0 ? "#fb7185" : "#2dd4bf"} dot={false} strokeWidth={1.5} isAnimationActive={false} /><YAxis hide domain={["dataMin", "dataMax"]} /></LineChart></ResponsiveContainer></Box>}
  </Card>;
}

function MarketPulse({ range, setRange, quotes, history, loading, error }: { range: IndexChartRange; setRange: (v: IndexChartRange) => void; quotes: IndexPerformanceSymbol[]; history: IndexIntradaySymbol[]; loading: boolean; error: Error | null }) {
  const context = marketContext(quotes); const historyMap = new Map(history.map((item) => [item.symbol, item]));
  return <Card withBorder p="md" aria-labelledby="market-pulse-title"><Group justify="space-between" align="flex-start" mb="md"><div><Text id="market-pulse-title" fw={700}>ETF Market Pulse</Text><Text size="xs" c="dimmed">Relative performance; each series begins at 0%</Text></div><SegmentedControl aria-label="Market Pulse range" data={ranges} value={range} onChange={(v) => setRange(v as IndexChartRange)} size="xs" /></Group>
    {error ? <DataState state="error" message={error.message} /> : loading && !quotes.length ? <Skeleton height={280} /> : <Stack gap="md"><Group gap="lg"><Text size="sm"><b>{context.positive}/{context.available}</b> positive</Text><Text size="sm">Leader <b>{context.leader?.symbol ?? "Unavailable"}</b></Text><Text size="sm">Laggard <b>{context.laggard?.symbol ?? "Unavailable"}</b></Text>{loading && <Loader size="xs" />}</Group><MarketChart symbols={history} /><SimpleGrid cols={{ base: 1, xs: 2, lg: 4 }}>{quotes.map((quote) => <EtfTile key={quote.symbol} quote={quote} history={historyMap.get(quote.symbol)} />)}</SimpleGrid></Stack>}
  </Card>;
}

function PositionRows({ records }: { records: BrokerPosition[] }) { return <>{records.slice(0, 4).map((p) => <div className={classes.record} key={p.symbol}><Text fw={700}>{p.symbol}</Text><Datum label="Quantity" value={String(p.qty)} /><div className={classes.recordValue}><Datum label="Value" value={money(p.marketValue)} /></div><div className={classes.recordValue}><Datum label="P/L" value={`${signedMoney(p.unrealizedPnL)} (${signedPercent(p.unrealizedPnLPct * 100)})`} /></div></div>)}</>; }
function OrderRows({ records }: { records: BrokerOpenOrder[] }) { return <>{records.slice(0, 4).map((o) => <div className={classes.record} key={o.id}><Text fw={700}>{o.symbol}</Text><Datum label="Side / quantity" value={`${o.side.toUpperCase()} ${o.qty ?? (o.notional != null ? money(o.notional) : "Unavailable")}`} /><div className={classes.recordValue}><Datum label="Type" value={o.orderType.replaceAll("_", " ")} /></div><div className={classes.recordValue}><Datum label="Status" value={o.status} /></div></div>)}</>; }
function SummaryCard({ title, count, to, loading, empty, children }: { title: string; count: number; to: string; loading: boolean; empty: string; children: React.ReactNode }) { return <Card withBorder p="md"><Group justify="space-between" mb="xs"><Group gap="xs"><Text fw={700}>{title}</Text><Badge variant="light">{count}</Badge></Group><Anchor component={Link} to={to} size="sm">View all {title.toLowerCase()}</Anchor></Group>{loading ? <Skeleton height={100} /> : count ? children : <DataState state="empty" title={empty} message="There are no current records to review." />}</Card>; }

function Attention({ dataAvailable, accountBlocked, risk, reconciliationTo, eventsTo }: { dataAvailable: boolean; accountBlocked: boolean; risk?: EntryReadiness; reconciliationTo: string; eventsTo: string }) {
  const issues = [
    ...(accountBlocked ? [{ severity: "Critical", text: "Broker account reports trading is blocked.", to: "/trading-accounts" }] : []),
    ...(risk?.entrySession?.degraded || risk?.entrySession?.error ? [{ severity: "Warning", text: risk.entrySession?.error?.message ?? "Market-session status is degraded.", to: "/system/events" }] : []),
    ...(!risk?.canEnter && risk?.blockers?.length ? risk.blockers.slice(0, 3).map((text) => ({ severity: "Blocked", text, to: "/settings" })) : []),
  ].slice(0, 5);
  return <Card withBorder p="md"><Text fw={700} mb="sm">Attention &amp; Exceptions</Text>{issues.length ? <Stack gap="sm">{issues.map((item, index) => <div className={classes.attentionItem} key={`${item.text}-${index}`}><IconAlertTriangle size={18} aria-hidden="true" /><Badge color={item.severity === "Critical" ? "red" : "orange"} variant="light">{item.severity}</Badge><Anchor component={Link} to={item.to} size="sm">{item.text}</Anchor></div>)}</Stack> : dataAvailable ? <Group gap="sm"><IconCircleCheck color="var(--mantine-color-teal-5)" aria-hidden="true" /><Text size="sm">No current issues require attention. <Anchor component={Link} to={eventsTo}>Review system events</Anchor> or <Anchor component={Link} to={reconciliationTo}>reconciliation</Anchor>.</Text></Group> : <DataState state="empty" title="Health status unavailable" message="There is not enough observed account data to report a healthy state." />}</Card>;
}

function OverviewAccount({ row, onSelect }: { row: DashboardOverviewRow; onSelect: () => void }) {
  return <Card withBorder p="md"><Group justify="space-between" align="flex-start"><div><Text fw={750}>{row.account.displayName}</Text><Text size="sm" c="dimmed">{row.account.accountHolderName} · {row.account.broker}</Text></div><Badge color={row.account.environment === "LIVE" ? "red" : "blue"}>{row.account.environment}</Badge></Group><SimpleGrid cols={{ base: 2, sm: 4 }} mt="md"><Datum label="Portfolio" value={row.financialSnapshot ? money(row.financialSnapshot.portfolioValue) : "Unavailable"} /><Datum label="Readiness" value={row.readiness.status} /><Datum label="Positions / orders" value={`${row.exposure.openPositionCount} / ${row.exposure.openOrderCount}`} /><Datum label="Observed" value={row.freshness.observedAt ? formatMarketDateTime(row.freshness.observedAt) : "Unavailable"} /></SimpleGrid>{row.readiness.blockers.length > 0 && <Alert mt="md" color="orange" title={row.readiness.primaryBlocker ?? "Attention required"}>{row.readiness.blockers.slice(1).join(" · ") || "Review this Trading Account."}</Alert>}<Anchor component="button" type="button" mt="md" onClick={onSelect}>View account Dashboard</Anchor></Card>;
}

export function DashboardPage() {
  const [token] = useState(() => getAdminToken()); const [range, setRange] = useState<IndexChartRange>("1d");
  const { access } = useAuth();
  const scope = useTradingAccountScope();
  const location = useLocation();
  const selectedId = scope.scope.type === "ACCOUNT" ? scope.scope.tradingAccountId : null;
  const selected = useTradingAccountDashboard(token, selectedId); const overview = useDashboardAccountsOverview(token, scope.isAll);
  const performance = useIndexPerformance(token); const intraday = useIndexIntraday(token, range);
  const account = selected.data?.broker.account; const risk = selected.data?.readiness; const positions = selected.data?.exposure.positions ?? []; const orders = selected.data?.exposure.openOrders ?? [];
  const exposure = risk?.usage?.totalOpenNotional;
  return <Stack className={classes.page} gap="lg">
    <Group className={classes.header} justify="space-between" align="flex-start"><div><Title order={2}>Dashboard</Title><Text size="sm" c="dimmed">{getDashboardDescription(access?.platformRole, scope.isAll, scope.selectedAccount)}</Text></div><TradingAccountScopeSelector mode="ACCOUNT_FILTERABLE" expanded variant="dashboard" /></Group>
    <DashboardOperationalAttention account={selectedId ? String(selectedId) : "all"} />
    {scope.isAll ? <><div className={classes.metricGrid}><Metric label="Trading Accounts" value={String(overview.data?.summary.tradingAccountCount ?? "—")} detail={overview.data ? `${overview.data.summary.paperCount} PAPER · ${overview.data.summary.liveCount} LIVE` : undefined} /><Metric label="Readiness" value={overview.data ? `${overview.data.summary.readyCount} ready` : "—"} detail={overview.data ? `${overview.data.summary.blockedCount} blocked · ${overview.data.summary.unavailableCount} unavailable` : undefined} /><Metric label="Open Positions" value={String(overview.data?.summary.openPositionCount ?? "—")} /><Metric label="Accounts Requiring Attention" value={String(overview.data?.summary.attentionCount ?? "—")} detail={overview.data ? `${overview.data.summary.openOrderCount} open orders` : undefined} /></div>{overview.error && <Alert color="red" title="Accounts overview unavailable">{overview.error.message}</Alert>}<Stack gap="md">{overview.data?.accounts.map((row) => <OverviewAccount key={row.account.id} row={row} onSelect={() => scope.setScope({ type: "ACCOUNT", tradingAccountId: row.account.id })} />)}</Stack></> : <>{selected.error && <Alert color="red" title="Account overview unavailable">{selected.error.message}</Alert>}<Group gap="xs"><Badge color={selected.data?.account.environment === "LIVE" ? "red" : "blue"}>{selected.data?.account.environment ?? scope.selectedAccount?.environment}</Badge>{risk && <Badge color={risk.canEnter ? "teal" : "orange"}>{risk.status}</Badge>}{selected.isFetching && <Loader size="xs" />}</Group><div className={classes.metricGrid}><Metric label="Portfolio value" value={money(account?.portfolioValue)} /><Metric label="Day P/L" value={signedMoney(account?.dayPnL)} detail={signedPercent(account == null ? null : account.dayPnLPct * 100)} pnl={account?.dayPnL} /><Metric label="Open exposure" value={money(exposure)} detail={selected.data?.exposure.openPositionCount == null ? "Unavailable" : `${selected.data.exposure.openPositionCount} open positions`} /><Metric label="Buying power" value={money(account?.buyingPower)} /></div><TradingReadiness risk={risk} /></>}
    <MarketPulse range={range} setRange={setRange} quotes={performance.data?.symbols ?? []} history={intraday.data?.symbols ?? []} loading={performance.isLoading || intraday.isLoading} error={performance.error ?? intraday.error} />
    {!scope.isAll && selectedId && <><SimpleGrid cols={{ base: 1, lg: 2 }}>{selected.data && selected.data.exposure.positions === null ? <Card withBorder><DataState state="empty" title="Open positions unavailable" message="Broker position state could not be observed." /></Card> : <SummaryCard title="Open Positions" count={positions.length} to={createScopedNavigationTarget("/positions/open", location.search)} loading={selected.isLoading} empty="No open positions"><PositionRows records={positions} /></SummaryCard>}{selected.data && selected.data.exposure.openOrders === null ? <Card withBorder><DataState state="empty" title="Open orders unavailable" message="Broker order state could not be observed." /></Card> : <SummaryCard title="Open Orders" count={orders.length} to={createScopedNavigationTarget("/orders/open", location.search)} loading={selected.isLoading} empty="No open orders"><OrderRows records={orders} /></SummaryCard>}</SimpleGrid><Attention dataAvailable={Boolean(selected.data)} accountBlocked={account?.tradingBlocked ?? false} risk={risk} eventsTo={createScopedNavigationTarget("/system/events", location.search)} reconciliationTo={createScopedNavigationTarget(`/trading-accounts/${selectedId}/reconciliation`, location.search)} /></>}
  </Stack>;
}
