import { apiRequest } from "../../lib/api";
import type {
  ExitProfile,
  CreateExitProfilePayload,
  UpdateExitProfilePayload,
} from "./types";

export function getExitProfiles(token: string) {
  return apiRequest<ExitProfile[]>("/api/exit-profiles", { token });
}

export function createExitProfile(
  payload: CreateExitProfilePayload,
  token: string
) {
  return apiRequest<ExitProfile>("/api/exit-profiles", {
    method: "POST",
    token,
    body: payload,
  });
}

export function updateExitProfile(
  id: number,
  payload: UpdateExitProfilePayload,
  token: string
) {
  return apiRequest<ExitProfile>(`/api/exit-profiles/${id}`, {
    method: "PATCH",
    token,
    body: payload,
  });
}

export function setExitProfileEnabled(
  id: number,
  enabled: boolean,
  token: string
) {
  return apiRequest<ExitProfile>(`/api/exit-profiles/${id}`, {
    method: "PATCH",
    token,
    body: { enabled },
  });
}
