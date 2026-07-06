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
