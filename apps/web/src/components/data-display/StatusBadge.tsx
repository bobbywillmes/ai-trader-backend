import { Badge } from "@mantine/core";
import classes from "./StatusBadge.module.css";
import { formatStatusLabel, toneColor, type StatusTone } from "./status";

type Props = {
  status: string;
  label?: string;
  tone?: StatusTone;
  size?: "compact" | "normal";
  className?: string;
};

export function StatusBadge({ status, label, tone = "neutral", size = "normal", className }: Props) {
  const fullLabel = label ?? formatStatusLabel(status);
  return <Badge className={`${classes.badge} ${className ?? ""}`} color={toneColor[tone]} variant="light" size={size === "compact" ? "sm" : "md"} aria-label={`${fullLabel} status`} data-tone={tone}>{fullLabel}</Badge>;
}
