import { apiRequest } from "../../lib/api";
import type { OrderOperationalEvidenceResponse } from "./types";

export function getOrderOperationalEvidence(orderIntentId: number, opportunityPage: number, token: string) {
  const search = new URLSearchParams({ opportunityPage: String(opportunityPage), opportunityPageSize: "10", eventPageSize: "25", rawEvidence: "false" });
  return apiRequest<OrderOperationalEvidenceResponse>(`/api/order-intents/${orderIntentId}/operational-evidence?${search}`, { token });
}
