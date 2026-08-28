import { getAdminToken } from "../../lib/api";
import { useAuth } from "../auth/useAuth";
import { useAcknowledgeAttention, useAttentionSummary } from "./hooks";

export function useDashboardOperationalAttention(account: string) {
  const { access } = useAuth();
  const visible = access?.permissions.includes("operationalAttention.read") === true;
  const token = getAdminToken();
  const query = useAttentionSummary(token, account, visible);
  const acknowledge = useAcknowledgeAttention(token);

  return { account, visible, query, acknowledge };
}

export type DashboardAttentionState = ReturnType<
  typeof useDashboardOperationalAttention
>;
