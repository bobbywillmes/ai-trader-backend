import { apiRequest, getAdminToken } from "../../lib/api";
import type {
  CreateUserInvitationInput,
  CreateUserInvitationResponse,
  ReplaceTradingAccountMembershipsInput,
  TradingAccountMembership,
  UpdateUserInput,
  User,
  UserSetupLink,
} from "./types";

export async function listUsers(): Promise<User[]> {
  return apiRequest<User[]>("/api/users", { token: getAdminToken() });
}

export async function getUser(id: number): Promise<User> {
  return apiRequest<User>(`/api/users/${id}`, { token: getAdminToken() });
}

export async function updateUser(id: number, data: UpdateUserInput): Promise<User> {
  return apiRequest<User>(`/api/users/${id}`, {
    method: "PATCH",
    token: getAdminToken(),
    body: data,
  });
}

export async function createUserInvitation(
  data: CreateUserInvitationInput
): Promise<CreateUserInvitationResponse> {
  return apiRequest<CreateUserInvitationResponse>("/api/users/invitations", {
    method: "POST",
    token: getAdminToken(),
    body: data,
  });
}

export async function regenerateUserSetupLink(
  id: number
): Promise<{ setupLink: UserSetupLink }> {
  return apiRequest<{ setupLink: UserSetupLink }>(`/api/users/${id}/setup-link`, {
    method: "POST",
    token: getAdminToken(),
  });
}

export async function listUserTradingAccountMemberships(
  userId: number
): Promise<TradingAccountMembership[]> {
  return apiRequest<TradingAccountMembership[]>(
    `/api/users/${userId}/trading-account-memberships`,
    { token: getAdminToken() }
  );
}

export async function replaceUserTradingAccountMemberships(
  userId: number,
  data: ReplaceTradingAccountMembershipsInput
): Promise<TradingAccountMembership[]> {
  return apiRequest<TradingAccountMembership[]>(
    `/api/users/${userId}/trading-account-memberships`,
    {
      method: "PUT",
      token: getAdminToken(),
      body: data,
    }
  );
}
