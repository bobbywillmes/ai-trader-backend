export function formatMoney(value: number | null | undefined) {
  if (value === null || value === undefined) return "-";

  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(value);
}

export function formatNumber(value: number | null | undefined) {
  if (value === null || value === undefined) return "-";

  return value.toLocaleString(undefined, {
    maximumFractionDigits: 4,
  });
}

export function formatPreciseNumber(value: number | null | undefined) {
  if (value === null || value === undefined) return "-";

  return value.toLocaleString(undefined, {
    maximumFractionDigits: 8,
  });
}

export function formatPercent(value: number | null | undefined) {
  if (value === null || value === undefined) return "-";

  return `${(value * 100).toFixed(2)}%`;
}

export function formatDate(value: string | null | undefined) {
  if (!value) return "-";

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) return "-";

  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "2-digit",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

export function formatDuration(ms: number | null | undefined) {
  if (ms === null || ms === undefined) return "-";

  const totalMinutes = Math.max(0, Math.round(ms / 60_000));
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

export function pnlColor(value: number | null | undefined) {
  if (value === null || value === undefined) return "dimmed";
  if (value > 0) return "teal";
  if (value < 0) return "red";
  return "dimmed";
}
