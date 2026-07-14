export function formatQuantity(value: number | null | undefined) {
  if (value === null || value === undefined) return "-";
  return value.toLocaleString();
}

export function formatDateTime(value: string | null | undefined) {
  if (!value) return "-";

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

export function formatMoney(
  value: number | null | undefined,
  currency = "USD"
) {
  if (value === null || value === undefined) return "-";

  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency,
    maximumFractionDigits: 2,
  }).format(value);
}

export function formatStatus(value: string | null | undefined) {
  if (!value) return "-";
  return value.replace(/_/g, " ");
}

export function formatSignedMoney(
  value: number | null | undefined,
  currency = "USD"
) {
  if (value === null || value === undefined) return "-";

  const sign = value > 0 ? "+" : "";
  return `${sign}${formatMoney(value, currency)}`;
}

export function formatPercentValue(value: number | null | undefined) {
  if (value === null || value === undefined) return "-";

  return `${value.toFixed(2)}%`;
}

export function formatOrderValue(
  value: string | number | null | undefined
) {
  if (value === null || value === undefined || value === "") return "-";

  return String(value);
}
