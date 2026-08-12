import { Fragment, useState } from "react";
import { Accordion, Alert, Badge, Button, Card, Group, Stack, Table, Text, Title } from "@mantine/core";
import { modals } from "@mantine/modals";
import { notifications } from "@mantine/notifications";
import { IconChevronDown, IconChevronUp, IconTrash } from "@tabler/icons-react";
import {
  CompactRecordList, DataState, DataTable, MobileRecordCard, RecordDetailsGrid,
  ResponsiveActions, ResponsiveDataView, ResponsiveDetails, StatusBadge,
  type StatusTone, type SummaryField,
} from "../../components/data-display";
import { getAdminToken } from "../../lib/api";
import { useAllOpenOrders, useCancelOrder, useTradingAccountOpenOrders } from "./hooks";
import type { OpenOrder, OpenOrdersAccountResult } from "./types";
import { TradingAccountScopeSelector } from "../tradingAccountScope/TradingAccountScopeSelector";
import { useTradingAccountScope } from "../tradingAccountScope/useTradingAccountScope";
import classes from "./OrdersPage.module.css";

const MISSING_VALUE = "Not available";

function value(order: OpenOrder, camel: "filledQty" | "limitPrice" | "submittedAt" | "clientOrderId", snake: "filled_qty" | "limit_price" | "submitted_at" | "client_order_id") {
  return order[snake] ?? order[camel] ?? null;
}

function accountName(order: OpenOrder) {
  return order.tradingAccount?.displayName ?? (order.tradingAccountId !== null ? `Account ${order.tradingAccountId}` : "Unassigned account");
}

function accountContext(order: OpenOrder) {
  const account = order.tradingAccount;
  return `${accountName(order)} · ${account?.environment ?? "Environment unavailable"}${account?.accountHolderName ? ` · ${account.accountHolderName}` : ""}`;
}

function titleCase(input: string | null | undefined) {
  if (!input) return MISSING_VALUE;
  return input.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatDate(input: string | null) {
  if (!input) return MISSING_VALUE;
  const date = new Date(input);
  return Number.isNaN(date.getTime()) ? MISSING_VALUE : date.toLocaleString();
}

function formatAge(input: string | null) {
  if (!input) return MISSING_VALUE;
  const date = new Date(input);
  if (Number.isNaN(date.getTime())) return MISSING_VALUE;
  const minutes = Math.max(0, Math.round((Date.now() - date.getTime()) / 60_000));
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function formatPrice(input: string | number | null) {
  if (input === null || input === "" || !Number.isFinite(Number(input))) return MISSING_VALUE;
  return Number(input).toLocaleString(undefined, { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function quantity(order: OpenOrder) { return order.qty ?? MISSING_VALUE; }
function filled(order: OpenOrder) { return value(order, "filledQty", "filled_qty") ?? "0"; }
function remaining(order: OpenOrder) {
  const total = Number(order.qty); const done = Number(filled(order));
  return Number.isFinite(total) && Number.isFinite(done) ? Math.max(0, total - done).toString() : MISSING_VALUE;
}
function orderType(order: OpenOrder) { return order.orderType ?? order.type ?? null; }
function orderPrice(order: OpenOrder) {
  const type = orderType(order)?.toLowerCase();
  if (type === "market") return "Market";
  const limit = value(order, "limitPrice", "limit_price") as string | number | null;
  const stop = order.stop_price ?? order.stopPrice ?? null;
  if (type === "stop_limit") return `${formatPrice(stop)} stop · ${formatPrice(limit)} limit`;
  if (type === "stop") return formatPrice(stop);
  return formatPrice(limit);
}
function statusTone(status: string | null | undefined): StatusTone {
  const normalized = status?.toLowerCase() ?? "";
  if (normalized.includes("partial")) return "informational";
  if (normalized.includes("reject") || normalized.includes("cancel") || normalized.includes("expire")) return "danger";
  return "warning";
}

export function OrdersDataView({ orders, token, showAccountIdentity = true, ariaLabel = "Open orders" }: { orders: readonly OpenOrder[]; token: string | null; showAccountIdentity?: boolean; ariaLabel?: string }) {
  const cancelMutation = useCancelOrder(token);
  const [expandedId, setExpandedId] = useState<string | number | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [detailOpener, setDetailOpener] = useState<HTMLElement | null>(null);
  const detailOrder = orders.find((order) => order.id === detailId) ?? null;

  function openDetails(order: OpenOrder, opener: HTMLElement) { setDetailOpener(opener); setDetailId(order.id); }
  function closeDetails() { const opener = detailOpener; setDetailId(null); window.setTimeout(() => opener?.focus(), 0); }
  function cancelOrder(order: OpenOrder) {
    if (cancelMutation.isPending || order.tradingAccountId === null) return;
    const environment = order.tradingAccount?.environment ?? "UNKNOWN";
    modals.openConfirmModal({
      title: "Cancel order",
      children: <Stack gap="xs"><Text size="sm">Cancel the <strong>{titleCase(order.side)} {quantity(order)} {order.symbol}</strong> {titleCase(orderType(order))} order ({orderPrice(order)}) in <strong>{accountName(order)} · {environment}</strong>?</Text>{environment === "LIVE" && <Text size="sm" c="red" fw={700}>This cancellation affects a LIVE brokerage account with real money at risk.</Text>}</Stack>,
      labels: { confirm: "Cancel order", cancel: "Keep" }, confirmProps: { color: "red" },
      onConfirm: async () => {
        if (cancelMutation.isPending || order.tradingAccountId === null) return;
        try {
          await cancelMutation.mutateAsync({ tradingAccountId: order.tradingAccountId, orderId: order.id });
          notifications.show({ message: `Order canceled for ${order.symbol}.`, color: "teal" });
          setDetailId(null); setExpandedId(null);
        } catch (error) {
          notifications.show({ message: error instanceof Error ? error.message : "Failed to cancel order.", color: "red" });
        }
      },
    });
  }

  const isCanceling = (order: OpenOrder) => cancelMutation.isPending && cancelMutation.variables?.orderId === order.id;
  const cancelAction = (order: OpenOrder) => ({
    label: isCanceling(order) ? "Canceling order" : `Cancel ${order.symbol} order`, icon: <IconTrash size={16} />, color: "red",
    disabled: cancelMutation.isPending || order.tradingAccountId === null, onClick: () => cancelOrder(order),
  });
  const identity = (order: OpenOrder) => <div className={classes.identity}><Text component="h3" fw={800}>{order.symbol}</Text>{showAccountIdentity && <Text size="xs" c="dimmed" className={classes.wrap}>{accountContext(order)}</Text>}</div>;
  const status = (order: OpenOrder) => <Group gap="xs" wrap="wrap"><StatusBadge status={order.side} label={titleCase(order.side)} tone={order.side?.toLowerCase() === "buy" ? "positive" : "danger"} size="compact" /><StatusBadge status={order.status} label={titleCase(order.status)} tone={statusTone(order.status)} size="compact" /></Group>;
  const fields = (order: OpenOrder): SummaryField[] => [
    { label: "Order", value: `${titleCase(orderType(order))} · ${orderPrice(order)}` },
    { label: "Quantity", value: `${quantity(order)} ${Number(order.qty) === 1 ? "share" : "shares"}` },
    { label: "Submitted", value: formatAge(value(order, "submittedAt", "submitted_at") as string | null) },
  ];
  const details = (order: OpenOrder, includeIdentity = false) => <div className={classes.detailComposition}>
    {includeIdentity && <div className={classes.drawerIdentity}>{identity(order)}{status(order)}</div>}
    <div className={classes.detailCards}>
      <section className={classes.detailCard} aria-labelledby={`order-${order.id}-order-heading`}><Title id={`order-${order.id}-order-heading`} order={3} size="h5" className={classes.detailHeading}>Order</Title><RecordDetailsGrid missingValue={MISSING_VALUE} sections={[{ items: [
        { label: "Symbol", value: order.symbol }, { label: "Trading Account", value: accountContext(order) }, { label: "Side", value: titleCase(order.side) },
        { label: "Quantity", value: quantity(order) }, { label: "Order type", value: titleCase(orderType(order)) }, { label: "Status", value: titleCase(order.status) },
        { label: "Submitted", value: formatDate(value(order, "submittedAt", "submitted_at") as string | null) },
      ] }]} /></section>
      <section className={`${classes.detailCard} ${classes.executionCard}`} aria-labelledby={`order-${order.id}-execution-heading`}><Title id={`order-${order.id}-execution-heading`} order={3} size="h5" className={classes.detailHeading}>Pricing &amp; execution</Title><RecordDetailsGrid missingValue={MISSING_VALUE} sections={[{ items: [
        { label: "Relevant price", value: orderPrice(order) }, { label: "Filled quantity", value: filled(order) }, { label: "Remaining quantity", value: remaining(order) }, { label: "Average fill price", value: formatPrice(order.filled_avg_price ?? order.filledAvgPrice ?? null) }, { label: "Time in force", value: titleCase(order.time_in_force ?? order.timeInForce) },
      ] }]} /></section>
    </div>
    <Accordion variant="contained" radius="md" className={classes.routingDisclosure}><Accordion.Item value="routing"><Accordion.Control><div><Text fw={700} size="sm">Routing &amp; identifiers</Text><Text size="xs" c="dimmed" className={classes.wrap}>{value(order, "clientOrderId", "client_order_id") ?? MISSING_VALUE}</Text></div></Accordion.Control><Accordion.Panel><RecordDetailsGrid missingValue={MISSING_VALUE} sections={[{ items: [
      { label: "Broker order ID", value: order.id, technical: true }, { label: "Client order ID", value: value(order, "clientOrderId", "client_order_id"), technical: true }, { label: "Trading account ID", value: order.tradingAccountId, technical: true },
    ] }]} /></Accordion.Panel></Accordion.Item></Accordion>
    <footer className={classes.detailActions}><Text fw={700} size="sm">Order actions</Text><ResponsiveActions compact secondary={[cancelAction(order)]} /></footer>
  </div>;

  const wide = (items: readonly OpenOrder[]) => <DataTable caption="Open broker orders" captionHidden density="compact"><Table.Thead><Table.Tr><Table.Th>Order</Table.Th><Table.Th>Side / quantity</Table.Th><Table.Th>Type / price</Table.Th><Table.Th>Status</Table.Th><Table.Th>Submitted</Table.Th><Table.Th className={classes.actionsHeading}>Actions</Table.Th></Table.Tr></Table.Thead><Table.Tbody>{items.map((order) => <Fragment key={order.id}><Table.Tr><Table.Td>{identity(order)}</Table.Td><Table.Td>{titleCase(order.side)} · {quantity(order)} {Number(order.qty) === 1 ? "share" : "shares"}</Table.Td><Table.Td>{titleCase(orderType(order))} · {orderPrice(order)}</Table.Td><Table.Td><StatusBadge status={order.status} label={titleCase(order.status)} tone={statusTone(order.status)} size="compact" /></Table.Td><Table.Td><Text size="sm">{formatAge(value(order, "submittedAt", "submitted_at") as string | null)}</Text><Text size="xs" c="dimmed">{formatDate(value(order, "submittedAt", "submitted_at") as string | null)}</Text></Table.Td><Table.Td><Group justify="flex-end" wrap="nowrap"><Button variant="default" size="compact-sm" onClick={() => setExpandedId(expandedId === order.id ? null : order.id)} aria-expanded={expandedId === order.id} aria-controls={`order-${order.id}-wide-details`} rightSection={expandedId === order.id ? <IconChevronUp size={15} /> : <IconChevronDown size={15} />}>Details</Button><ResponsiveActions compact secondary={[cancelAction(order)]} /></Group></Table.Td></Table.Tr>{expandedId === order.id && <Table.Tr><Table.Td colSpan={6} id={`order-${order.id}-wide-details`} className={classes.inlineDetails}>{details(order)}</Table.Td></Table.Tr>}</Fragment>)}</Table.Tbody></DataTable>;
  const compact = (items: readonly OpenOrder[]) => <CompactRecordList records={items} getRecordId={(order) => order.id} renderIdentity={(order) => <Stack gap="xs">{identity(order)}{status(order)}</Stack>} renderFields={fields} renderDetails={details} renderActions={(order) => <ResponsiveActions compact secondary={[cancelAction(order)]} />} expandedId={expandedId} onExpandedChange={setExpandedId} />;
  const narrow = (items: readonly OpenOrder[]) => <MobileRecordCard records={items} getRecordId={(order) => order.id} renderIdentity={identity} renderStatus={status} renderFields={fields} onDetails={openDetails} renderActions={(order) => <ResponsiveActions compact secondary={[cancelAction(order)]} />} />;

  return <><ResponsiveDataView records={orders} getRecordId={(order) => order.id} wide={wide} compact={compact} narrow={narrow} aria-label={ariaLabel} />{detailOrder && <ResponsiveDetails opened title={`${detailOrder.symbol} order details`} onClose={closeDetails}>{details(detailOrder, true)}</ResponsiveDetails>}</>;
}

export function OrdersPage() {
  const [token] = useState<string | null>(() => getAdminToken());
  const scope = useTradingAccountScope();
  const allQuery = useAllOpenOrders(token, scope.isAll);
  const accountQuery = useTradingAccountOpenOrders(scope.selectedAccount?.id, token);
  const ordersQuery = scope.isAll ? allQuery : accountQuery;
  const accountResults: OpenOrdersAccountResult[] = scope.isAll
    ? (allQuery.data?.accounts ?? [])
    : accountQuery.data ? [accountQuery.data] : [];
  const orders = accountResults.flatMap((result) => result.orders ?? []);
  const unavailable = accountResults.filter((result) => result.availability === "UNAVAILABLE");
  return <main className={classes.page}><Stack gap="lg">
    <Group justify="space-between" align="flex-end"><div><Title order={2} size="h3">Open Orders</Title><Text size="sm" c="dimmed">{scope.isAll ? "Live broker orders across accessible Trading Accounts." : `${scope.selectedAccount?.displayName} · ${scope.selectedAccount?.environment ?? ""} broker orders.`}</Text></div><TradingAccountScopeSelector mode="ACCOUNT_FILTERABLE" expanded variant="dashboard" /></Group>
    {!ordersQuery.isLoading && !ordersQuery.isError && <Text size="sm" c="dimmed">{orders.length} confirmed open {orders.length === 1 ? "order" : "orders"}{unavailable.length ? ` · ${unavailable.length} ${unavailable.length === 1 ? "account" : "accounts"} unavailable` : ""}</Text>}
    {unavailable.map((result) => <Alert key={result.account.id} color={result.account.environment === "LIVE" ? "red" : "orange"} title={`${result.account.displayName} · ${result.account.environment} — Broker order state unavailable`}><Text size="sm">{result.reason === "CREDENTIALS_MISSING" ? "Credentials missing. " : ""}{result.message}</Text><Text size="xs" c="dimmed">{result.account.accountHolderName} · {result.account.broker}</Text></Alert>)}
    {!scope.isAll && scope.selectedAccount && <Group gap="xs"><Badge color={scope.selectedAccount.environment === "LIVE" ? "red" : "blue"}>{scope.selectedAccount.environment}</Badge><Text size="sm" fw={600}>{scope.selectedAccount.displayName}</Text></Group>}
    <Card withBorder radius="md" p="md" className={classes.panel}>{ordersQuery.isLoading ? <DataState state="loading" message="Loading open broker orders…" /> : ordersQuery.isError ? <DataState state="error" title="Broker order state unavailable" message={ordersQuery.error instanceof Error ? ordersQuery.error.message : "Open orders could not be loaded."} onRetry={() => void ordersQuery.refetch()} /> : orders.length === 0 && unavailable.length === 0 ? <DataState state="empty" title="No open orders" message="The broker confirmed there are no orders awaiting execution or cancellation." /> : orders.length === 0 ? <DataState state="empty" title="No broker order data available" message="No accessible Trading Account returned confirmed broker order state." /> : <OrdersDataView orders={orders} token={token} showAccountIdentity={scope.isAll} />}</Card>
  </Stack></main>;
}
