import type { StatusTone } from "../../components/data-display";
import type { ReconciliationFinding, ReconciliationSeverity } from "./api";

export function reconciliationSeverityTone(severity: ReconciliationSeverity): StatusTone {
  if (severity === "critical") return "danger";
  if (severity === "warn") return "warning";
  return "informational";
}

export function findingIdentity(finding: ReconciliationFinding, index = 0) {
  return `${finding.code}-${finding.entityType}-${finding.entityId}-${index}`;
}
