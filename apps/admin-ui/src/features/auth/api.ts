import { apiRequest } from "../../lib/api";
import type { LoginResponse, MeResponse } from "./types";

export function getMe(token: string) {
  return apiRequest<MeResponse>("/api/admin-auth/me", { token });
}

export function login(email: string, password: string) {
  return apiRequest<LoginResponse>("/api/admin-auth/login", {
    method: "POST",
    body: { email, password },
  });
}

export function logout(token: string) {
  return apiRequest<void>("/api/admin-auth/logout", {
    method: "POST",
    token,
  });
}

export function verifyPassword(token: string, password: string) {
  return apiRequest<{ ok: boolean }>("/api/admin-auth/verify-password", {
    method: "POST",
    token,
    body: { password },
  });
}

export function changePassword(
  token: string,
  currentPassword: string,
  newPassword: string,
) {
  return apiRequest<{ ok: boolean }>("/api/admin-auth/change-password", {
    method: "POST",
    token,
    body: { currentPassword, newPassword },
  });
}
