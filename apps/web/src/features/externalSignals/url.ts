import { updateOwnedSearchParams } from "../../app/searchParams";
import { events, rejectionCodes, statuses, timeframes, type Section } from "./types";
export const sections = { sources: "Sources", bindings: "Strategy Bindings", signals: "Signals", deliveries: "Deliveries" };
const filterKeys = ["signalSourceId", "strategyId", "symbol", "event", "timeframe", "status", "rejectionCode", "signalId", "from", "to"] as const;
const ownedKeys = ["section", "page", "pageSize", "detail", ...filterKeys];
const supported: Record<Section, readonly string[]> = {
  sources: ["signalSourceId"], bindings: ["signalSourceId", "strategyId"],
  signals: ["signalSourceId", "strategyId", "symbol", "event", "timeframe", "from", "to"],
  deliveries: ["signalSourceId", "status", "rejectionCode", "signalId", "from", "to"],
};
export function positiveId(value: string | null) { return value && /^\d+$/.test(value) && Number(value) > 0 && Number(value) <= 2147483647 ? Number(value) : null; }
export function readExternalParams(params: URLSearchParams) {
  const raw = params.get("section") ?? "sources";
  const section: Section = Object.hasOwn(sections, raw) ? raw as Section : "sources";
  const page = Math.min(positiveId(params.get("page")) ?? 1, 1000000);
  const pageSize = [25, 50, 100].includes(Number(params.get("pageSize"))) ? Number(params.get("pageSize")) : 25;
  const query = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
  for (const key of supported[section]) {
    const value = params.get(key)?.trim();
    if (!value) continue;
    if (key.endsWith("Id") && !positiveId(value)) continue;
    if (key === "event" && !events.some(item => item === value)) continue;
    if (key === "status" && !statuses.some(item => item === value)) continue;
    if (key === "timeframe" && !timeframes.some(item => item === value)) continue;
    if (key === "rejectionCode" && !rejectionCodes.some(item => item === value)) continue;
    if ((key === "from" || key === "to") && !Number.isFinite(Date.parse(value))) continue;
    query.set(key, key === "symbol" ? value.toUpperCase().slice(0, 32) : value);
  }
  return { section, page, pageSize, detail: positiveId(params.get("detail")), query };
}
export function changeExternalParams(current: URLSearchParams, changes: Record<string, string | null>, resetPage = true) {
  const owned = new URLSearchParams([...current].filter(([key]) => ownedKeys.includes(key)));
  if (changes.section && changes.section !== readExternalParams(current).section) {
    for (const key of [...filterKeys, "detail"]) owned.delete(key);
  }
  if (resetPage) owned.set("page", "1");
  for (const [key, value] of Object.entries(changes)) { if (value) owned.set(key, value); else owned.delete(key); }
  return updateOwnedSearchParams(current, ownedKeys, owned);
}
export function clearExternalFilters(current: URLSearchParams) {
  return changeExternalParams(current, Object.fromEntries(filterKeys.map(key => [key, null])));
}
