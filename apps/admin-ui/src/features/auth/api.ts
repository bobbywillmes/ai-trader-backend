import { apiRequest } from "../../lib/api";
import type {
  CompleteSetupAccountResponse,
  LoginResponse,
  MeResponse,
  SetupAccountTokenResponse,
} from "./types";

export function getMe(token: string) {
  return apiRequest<MeResponse>("/api/auth/me", { token });
}

export function login(email: string, password: string) {
  return apiRequest<LoginResponse>("/api/auth/login", {
    method: "POST",
    body: { email, password },
  });
}

export function logout(token: string) {
  return apiRequest<void>("/api/auth/logout", {
    method: "POST",
    token,
  });
}

export function verifyPassword(token: string, password: string) {
  return apiRequest<{ ok: boolean }>("/api/auth/verify-password", {
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
  return apiRequest<{ ok: boolean }>("/api/auth/change-password", {
    method: "POST",
    token,
    body: { currentPassword, newPassword },
  });
}

export function validateSetupAccountToken(token: string) {
  return apiRequest<SetupAccountTokenResponse>(
    `/api/auth/setup/${encodeURIComponent(token)}`
  );
}

export function completeSetupAccount(
  token: string,
  password: string,
  confirmPassword: string
) {
  return apiRequest<CompleteSetupAccountResponse>(
    `/api/auth/setup/${encodeURIComponent(token)}`,
    {
      method: "POST",
      body: { password, confirmPassword },
    }
  );
}
