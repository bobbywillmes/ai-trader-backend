import type { IndexIntradaySymbol, IndexPerformanceSymbol, RiskStatus } from "./types";

const MARKET_TIME_ZONE = "America/New_York";

export type TradingTransition = { label: string; value: string | null };

export function formatMarketDateTime(value: string | null | undefined) {
  if (!value) return "Unavailable";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unavailable";
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short", month: "short", day: "numeric", hour: "numeric",
    minute: "2-digit", timeZone: MARKET_TIME_ZONE, timeZoneName: "short",
  }).format(date);
}

export function getTradingTransition(session: RiskStatus["entrySession"]): TradingTransition {
  switch (session.status) {
    case "open_buffer": return { label: "Entries open", value: session.entryAllowedAt };
    case "allowed": return { label: "Entry cutoff", value: session.entryCutoffAt ?? session.sessionCloseAt };
    case "close_buffer": return { label: "Market closes", value: session.sessionCloseAt };
    case "market_closed": return { label: "Next market open", value: session.nextOpenAt };
    default:
      if (session.marketOpen) return { label: "Market closes", value: session.sessionCloseAt };
      return { label: "Next market open", value: session.nextOpenAt };
  }
}

export function describeRegularSession(session: RiskStatus["entrySession"]) {
  if (session.sessionOpenAt && session.sessionCloseAt) {
    return `${formatMarketDateTime(session.sessionOpenAt)} – ${formatMarketDateTime(session.sessionCloseAt)}`;
  }
  if (session.status === "market_closed") return "Regular session is closed";
  if (session.status === "disabled") return "Entry-session guard is disabled";
  return "Current session details unavailable";
}

export function normalizeSeries(symbols: IndexIntradaySymbol[]) {
  const times = Array.from(new Set(symbols.flatMap((symbol) => symbol.points.map((point) => point.time)))).sort();
  const baselines = new Map(symbols.map((symbol) => [symbol.symbol, symbol.points[0]?.close]));
  const pointMaps = new Map(symbols.map((symbol) => [symbol.symbol, new Map(symbol.points.map((point) => [point.time, point.close]))]));
  return times.map((time) => {
    const row: Record<string, string | number | null> = { time };
    for (const symbol of symbols) {
      const baseline = baselines.get(symbol.symbol);
      const close = pointMaps.get(symbol.symbol)?.get(time);
      row[symbol.symbol] = baseline && close != null ? ((close / baseline) - 1) * 100 : null;
    }
    return row;
  });
}

export function rangePosition(value: number | null, low: number | null, high: number | null) {
  if (value == null || low == null || high == null || high <= low) return null;
  return Math.max(0, Math.min(100, ((value - low) / (high - low)) * 100));
}

export function marketContext(symbols: IndexPerformanceSymbol[]) {
  const available = symbols.filter((symbol) => symbol.todayChangePercent != null);
  const ranked = [...available].sort((a, b) => (b.todayChangePercent ?? 0) - (a.todayChangePercent ?? 0));
  return {
    positive: available.filter((symbol) => (symbol.todayChangePercent ?? 0) > 0).length,
    available: available.length,
    leader: ranked[0] ?? null,
    laggard: ranked.at(-1) ?? null,
  };
}
