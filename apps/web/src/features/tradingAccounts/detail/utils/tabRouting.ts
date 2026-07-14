import type { TradingAccountDetailTab } from "../types";

export const tradingAccountDetailTabs: {
  value: TradingAccountDetailTab;
  label: string;
}[] = [
  { value: "overview", label: "Overview" },
  { value: "positions", label: "Positions" },
  { value: "orders", label: "Orders" },
  { value: "subscriptions", label: "Subscriptions" },
  { value: "risk-health", label: "Risk Health" },
  { value: "activity", label: "Activity" },
];

const tradingAccountDetailTabValues: ReadonlySet<string> = new Set(
  tradingAccountDetailTabs.map((tab) => tab.value)
);

export function isTradingAccountDetailTab(
  value: string | null
): value is TradingAccountDetailTab {
  return value !== null && tradingAccountDetailTabValues.has(value);
}

export function resolveTradingAccountDetailTab(
  value: string | null
): TradingAccountDetailTab {
  return isTradingAccountDetailTab(value) ? value : "overview";
}

export function updateTradingAccountDetailTabSearchParams(
  current: URLSearchParams,
  tab: TradingAccountDetailTab
) {
  const next = new URLSearchParams(current);

  if (tab === "overview") {
    next.delete("tab");
  } else {
    next.set("tab", tab);
  }

  return next;
}
