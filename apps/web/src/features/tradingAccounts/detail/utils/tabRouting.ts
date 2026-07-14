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
