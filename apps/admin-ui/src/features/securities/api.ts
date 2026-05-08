import { apiRequest } from "../../lib/api";
import type {
  Security,
  CreateSecurityPayload,
  UpdateSecurityPayload,
} from "./types";

export async function getSecurities(token: string) {
  const result = await apiRequest<{ securities: Security[] }>("/api/securities", {
    token,
  });
  return result.securities;
}

export async function createSecurity(
  payload: CreateSecurityPayload,
  token: string
) {
  const result = await apiRequest<{ security: Security }>("/api/securities", {
    method: "POST",
    token,
    body: payload,
  });
  return result.security;
}

export async function updateSecurity(
  symbol: string,
  payload: UpdateSecurityPayload,
  token: string
) {
  const result = await apiRequest<{ security: Security }>(
    `/api/securities/${encodeURIComponent(symbol)}`,
    {
      method: "PATCH",
      token,
      body: payload,
    }
  );
  return result.security;
}
