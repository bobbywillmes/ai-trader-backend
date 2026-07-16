import type { MomentumMarketChartInterval, MomentumMarketChartResponse } from "./types";

export type MomentumChartLayer = "volume" | "decisionMarkers" | "catalystMarkers" | "allPriceChecks" | "aggregateVwap" | "sessionVwap" | "previousClose" | "premarketHigh" | "regularSessionHigh";
export type MomentumChartLayers = Record<MomentumChartLayer, boolean>;
export type MomentumChartPreferences = { layers: MomentumChartLayers; extendedHours: boolean };
export type MomentumChartRange = "decision" | "session" | "all";

export const momentumChartPreferenceKey = "momentum-market-chart-preferences:v1";
export const defaultMomentumChartLayers: MomentumChartLayers = {
  volume: true, decisionMarkers: true, catalystMarkers: true, allPriceChecks: false,
  aggregateVwap: false, sessionVwap: true, previousClose: true, premarketHigh: false,
  regularSessionHigh: false,
};

export function parseMomentumChartPreferences(value: string | null): MomentumChartPreferences {
  const fallback = { layers: { ...defaultMomentumChartLayers }, extendedHours: false };
  if (!value) return fallback;
  try {
    const parsed = JSON.parse(value) as Partial<MomentumChartPreferences>;
    const layers = { ...fallback.layers };
    if (parsed.layers && typeof parsed.layers === "object") {
      for (const key of Object.keys(layers) as MomentumChartLayer[]) {
        if (typeof parsed.layers[key] === "boolean") layers[key] = parsed.layers[key];
      }
    }
    return { layers, extendedHours: typeof parsed.extendedHours === "boolean" ? parsed.extendedHours : false };
  } catch { return fallback; }
}

function newYorkParts(timestamp: string) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(timestamp));
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  return { weekday: get("weekday"), minutes: Number(get("hour")) * 60 + Number(get("minute")) };
}

export function isRegularMarketTime(timestamp: string) {
  const { weekday, minutes } = newYorkParts(timestamp);
  return !["Sat", "Sun"].includes(weekday) && minutes >= 570 && minutes < 960;
}

export function hasEventOutsideRegularHours(markers: MomentumMarketChartResponse["markers"]) {
  return markers.some((marker) => marker.type !== "PRICE_CHECK" && !isRegularMarketTime(marker.timestamp));
}

export function filterRegularSessionBars(bars: MomentumMarketChartResponse["bars"]) {
  return bars.filter((bar) => isRegularMarketTime(bar.timestamp));
}

export function priorityMarkers(markers: MomentumMarketChartResponse["markers"], layers: MomentumChartLayers) {
  const catalysts = markers.filter((marker) => marker.type.startsWith("CATALYST"));
  const checks = markers.filter((marker) => marker.type === "PRICE_CHECK");
  const firstOf = (type: MomentumMarketChartResponse["markers"][number]["type"]) => markers.find((marker) => marker.type === type);
  const lifecycle = [
    firstOf("CANDIDATE_DISCOVERED"), firstOf("ENTRY_READY"), firstOf("ENTRY_BLOCKED"),
    ...markers.filter((marker) => marker.type.startsWith("HANDOFF")),
  ].filter((marker): marker is MomentumMarketChartResponse["markers"][number] => Boolean(marker));
  const selected = [
    ...(layers.catalystMarkers ? catalysts : []),
    ...(layers.decisionMarkers ? lifecycle : []),
    ...(layers.decisionMarkers && checks.length ? [checks[0], checks.at(-1)!] : []),
    ...(layers.allPriceChecks ? checks : []),
  ];
  return [...new Map(selected.map((marker) => [marker.id, marker])).values()];
}

export function decisionWindow(markers: MomentumMarketChartResponse["markers"], bars: MomentumMarketChartResponse["bars"], interval: MomentumMarketChartInterval) {
  if (!bars.length || !markers.length) return null;
  const eventTimes = markers.map((marker) => new Date(marker.timestamp).getTime()).filter(Number.isFinite);
  if (!eventTimes.length) return null;
  const padding = interval === "1d" ? 24 * 60 * 60 * 1000 : interval === "15m" ? 90 * 60 * 1000 : 60 * 60 * 1000;
  const after = interval === "1d" ? padding : Math.max(30 * 60 * 1000, padding / 2);
  const firstBar = new Date(bars[0].timestamp).getTime();
  const lastBar = new Date(bars.at(-1)!.timestamp).getTime();
  return { from: Math.max(firstBar, Math.min(...eventTimes) - padding), to: Math.min(lastBar, Math.max(...eventTimes) + after) };
}

export function sessionWindow(bars: MomentumMarketChartResponse["bars"]) {
  if (!bars.length) return null;
  const latest = bars.at(-1)!.timestamp;
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(latest));
  const session = bars.filter((bar) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(bar.timestamp)) === day);
  return session.length ? { from: new Date(session[0].timestamp).getTime(), to: new Date(session.at(-1)!.timestamp).getTime() } : null;
}
