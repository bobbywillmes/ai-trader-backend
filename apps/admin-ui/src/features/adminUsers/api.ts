import { getAdminToken } from "../../lib/api";
import type { AdminUser, AdminUserTradingAccountAccess } from "./types";

const API_BASE = "http://localhost:3000/api";

export async function listAdminUsers(): Promise<AdminUser[]> {
  const token = getAdminToken();
  const response = await fetch(`${API_BASE}/admin-users`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch admin users: ${response.statusText}`);
  }

  return response.json();
}

export async function getAdminUser(id: number): Promise<AdminUser> {
  const token = getAdminToken();
  const response = await fetch(`${API_BASE}/admin-users/${id}`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch admin user: ${response.statusText}`);
  }

  return response.json();
}

export async function getAdminUserTradingAccountAccess(
  userId: number
): Promise<AdminUserTradingAccountAccess[]> {
  const token = getAdminToken();
  const response = await fetch(
    `${API_BASE}/admin-users/${userId}/trading-account-access`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    }
  );

  if (!response.ok) {
    throw new Error(
      `Failed to fetch trading account access: ${response.statusText}`
    );
  }

  return response.json();
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
  const response = await fetch(`${API_BASE}/admin-users/${id}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(data),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.message || `Failed to update admin user`);
  }

  return response.json();
}

export async function upsertTradingAccountAccess(
  userId: number,
  accountId: number,
  data: { role: string } | null
): Promise<AdminUserTradingAccountAccess | null> {
  const token = getAdminToken();
  const response = await fetch(
    `${API_BASE}/admin-users/${userId}/trading-account-access/${accountId}`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(data),
    }
  );

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.message || `Failed to update trading account access`);
  }

  return response.json();
}
