import { apiRequest } from "../../lib/api";
import type { RuntimeTradingConfig } from "../dashboard/types";

export function getConfig(token: string) {
  return apiRequest<RuntimeTradingConfig>("/api/config", { token });
}

export function updateConfig(
  token: string,
  payload: Partial<RuntimeTradingConfig>
) {
  return apiRequest<RuntimeTradingConfig>("/api/config/settings", {
    method: "PATCH",
    token,
    body: payload,
  });
}
