import { apiRequest } from "../../lib/api";
import type { Strategy } from "./types";

export function getStrategies(token: string) {
  return apiRequest<Strategy[]>("/api/strategies", { token });
}
