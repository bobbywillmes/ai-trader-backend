export type StatusTone = "positive" | "warning" | "danger" | "informational" | "neutral";

export const toneColor: Record<StatusTone, string> = {
  positive: "teal", warning: "yellow", danger: "red", informational: "cyan", neutral: "gray",
};

const statusLabels: Record<string, string> = {
  NEEDS_CREDENTIALS: "Needs credentials",
  PAUSED: "Paused",
  TRADING_DISABLED: "Trading disabled",
  ENTRY_BLOCKED: "Entry blocked",
  TRAILING_STOP_ACTIVE: "Trail active",
  ENABLED: "Enabled",
  DISABLED: "Disabled",
  OPEN: "Open",
  CLOSED: "Closed",
};

export function formatStatusLabel(value: string) {
  return statusLabels[value] ?? value.toLowerCase().replaceAll("_", " ").replace(/^./, (letter) => letter.toUpperCase());
}
