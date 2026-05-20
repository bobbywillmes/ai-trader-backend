import type { SystemEvent } from "./types";

export type EventMeta = { label: string; description: string; color: string };

type EventPayload = Record<string, unknown>;

function parsePayload(ev: SystemEvent): EventPayload {
  if (!ev.payloadJson) return {};
  if (typeof ev.payloadJson === "object") return ev.payloadJson as EventPayload;
  try {
    return JSON.parse(ev.payloadJson) as EventPayload;
  } catch {
    return {};
  }
}

function cap(s: unknown) {
  if (typeof s !== "string" || !s) return "";
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function fmt(n: number) {
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function getNestedString(
  record: Record<string, unknown>,
  key: string,
  nestedKey: string
): string | undefined {
  const nested = record[key];

  if (!isRecord(nested)) {
    return undefined;
  }

  return getString(nested[nestedKey]);
}

function getSubscriptionName(p: Record<string, unknown>) {
  return (
    getNestedString(p, "after", "name") ??
    getNestedString(p, "before", "name") ??
    getString(p.subscriptionKey) ??
    getString(p.key) ??
    "Subscription"
  );
}

export function describeEvent(ev: SystemEvent): EventMeta {
  const p = parsePayload(ev);

  switch (ev.type) {
    case "order.submitted":
      return { label: "Submitted", description: `${cap(p.side)} ${p.symbol as string}`, color: "blue" };
    case "order.filled":
      return { label: "Filled", description: `${cap(p.side)} ${p.symbol as string}`, color: "green" };
    case "order.canceled":
      return { label: "Canceled", description: `${cap(p.side)} ${p.symbol as string}`, color: "orange" };
    case "order.rejected":
      return { label: "Rejected", description: `${cap(p.side)} ${p.symbol as string}`, color: "red" };
    case "order.expired":
      return { label: "Expired", description: `${cap(p.side)} ${p.symbol as string}`, color: "gray" };
    case "order.pending_cancel":
      return { label: "Canceling", description: `${cap(p.side)} ${p.symbol as string}`, color: "yellow" };
    case "position.opened": {
      const price = typeof p.avgEntryPrice === "number" ? ` @ $${fmt(p.avgEntryPrice)}` : "";
      return {
        label: "Opened",
        description: `${cap(p.side)} ${p.qty} ${p.symbol as string}${price}`,
        color: "teal",
      };
    }
    case "position.closed": {
      const qty = typeof p.closeQty === "number" ? `${p.closeQty} ` : "";
      const price =
        typeof p.closePrice === "number" ? ` @ $${fmt(p.closePrice)}` : "";
      return {
        label: "Closed",
        description: `${qty}${p.symbol as string}${price}`,
        color: "cyan",
      };
    }
    case "position.close_requested":
      return { label: "Close Req", description: `${p.symbol as string}`, color: "cyan" };
    case "subscription_enabled":
      return { label: "Enabled", description: `${getSubscriptionName(p)}`, color: "green" };
    case "subscription_disabled":
      return { label: "Disabled", description: `${getSubscriptionName(p)}`, color: "red" };

    case "exit.triggered": {
      const pct = typeof p.pnlPct === "number" ? p.pnlPct * 100 : null;
      const sign = pct != null && pct >= 0 ? "+" : "";
      const pctStr = pct != null ? ` (${sign}${pct.toFixed(2)}%)` : "";
      const reason =
        p.reason === "take_profit" ? "Take Profit" :
        p.reason === "stop_loss" ? "Stop Loss" :
        p.reason === "trailing_stop" ? "Trailing Stop" :
        p.reason === "max_hold_days" ? "Max Hold Days" :
        cap(p.reason);
      return {
        label: "Exit",
        description: `${p.symbol as string} — ${reason}${pctStr}`,
        color: "yellow",
      };
    }
    default:
      return {
        label: cap(ev.type.split(".").pop()),
        description: [ev.entityType, ev.entityId].filter(Boolean).join(" · "),
        color: "gray",
      };
  }
}

export function rawPayload(ev: SystemEvent): string {
  if (!ev.payloadJson) return "{}";
  if (typeof ev.payloadJson === "object") return JSON.stringify(ev.payloadJson, null, 2);
  try {
    return JSON.stringify(JSON.parse(ev.payloadJson), null, 2);
  } catch {
    return String(ev.payloadJson);
  }
}
