import { apiRequest } from "../../lib/api";
import type { TrackedPosition } from "./types";

export function getOpenPositions(token: string) {
  return apiRequest<TrackedPosition[]>("/api/tracked-positions", { token });
}

export function closePosition(symbol: string, token: string) {
  return apiRequest<void>(`/api/positions/${encodeURIComponent(symbol)}`, {
    method: "DELETE",
    token,
  });
}
