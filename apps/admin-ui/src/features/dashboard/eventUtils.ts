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
    case "position.closed":
      return { label: "Closed", description: `${p.symbol as string}`, color: "cyan" };
    case "position.close_requested":
      return { label: "Close Req", description: `${p.symbol as string}`, color: "cyan" };
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
