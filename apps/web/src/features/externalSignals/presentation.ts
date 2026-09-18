import type { Provider } from "./types";
export const providerLabels: Record<Provider, string> = { TRADINGVIEW: "TradingView", TRENDSPIDER: "TrendSpider", GENERIC_WEBHOOK: "Generic webhook" };
export const stamp = (value: string | null) => value ? new Date(value).toLocaleString() : "Not provided";
export const label = (value: string) => value.toLowerCase().replaceAll("_", " ").replace(/^./, char => char.toUpperCase());
