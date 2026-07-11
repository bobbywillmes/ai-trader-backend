import type { PlatformRole } from "../auth/types";

export const platformRoleLabels: Record<PlatformRole, string> = {
  SYSTEM_OWNER: "System Owner",
  OPERATOR: "Operator",
  ACCOUNT_USER: "Account User",
};

export function getPlatformRoleLabel(role: PlatformRole) {
  return platformRoleLabels[role];
}

export function getPlatformRoleColor(role: PlatformRole) {
  if (role === "SYSTEM_OWNER") return "red";
  if (role === "OPERATOR") return "blue";
  return "gray";
}
