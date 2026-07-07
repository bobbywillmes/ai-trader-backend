import { apiRequest, getAdminToken } from "../../lib/api";
import type {
  AdminUser,
  AdminUserTradingAccountAccess,
  CreateAdminUserInvitationInput,
  CreateAdminUserInvitationResponse,
  AdminUserSetupLink,
} from "./types";

export async function listAdminUsers(): Promise<AdminUser[]> {
  const token = getAdminToken();
  return apiRequest<AdminUser[]>("/api/admin-users", { token });
}

export async function getAdminUser(id: number): Promise<AdminUser> {
  const token = getAdminToken();
  return apiRequest<AdminUser>(`/api/admin-users/${id}`, { token });
}

export async function getAdminUserTradingAccountAccess(
  userId: number
): Promise<AdminUserTradingAccountAccess[]> {
  const token = getAdminToken();
  return apiRequest<AdminUserTradingAccountAccess[]>(
    `/api/admin-users/${userId}/trading-account-access`,
    { token }
  );
}

export async function updateAdminUser(
  id: number,
  data: {
    name?: string | null;
    role?: string;
    enabled?: boolean;
  }
): Promise<AdminUser> {
  const token = getAdminToken();
  return apiRequest<AdminUser>(`/api/admin-users/${id}`, {
    method: "PATCH",
    token,
    body: data,
  });
}

export async function createAdminUserInvitation(
  data: CreateAdminUserInvitationInput
): Promise<CreateAdminUserInvitationResponse> {
  const token = getAdminToken();
  return apiRequest<CreateAdminUserInvitationResponse>(
    "/api/admin-users/invitations",
    {
      method: "POST",
      token,
      body: data,
    }
  );
}

export async function regenerateAdminUserSetupLink(
  id: number
): Promise<{ setupLink: AdminUserSetupLink }> {
  const token = getAdminToken();
  return apiRequest<{ setupLink: AdminUserSetupLink }>(
    `/api/admin-users/${id}/setup-link`,
    {
      method: "POST",
      token,
    }
  );
}

export async function upsertTradingAccountAccess(
  userId: number,
  accountId: number,
  data: { role: string } | null
): Promise<AdminUserTradingAccountAccess | null> {
  const token = getAdminToken();
  return apiRequest<AdminUserTradingAccountAccess | null>(
    `/api/admin-users/${userId}/trading-account-access/${accountId}`,
    {
      method: "PUT",
      token,
      body: data,
    }
  );
}
