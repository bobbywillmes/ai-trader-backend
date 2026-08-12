import type { ReactNode } from "react";
import { useAuth } from "../features/auth/useAuth";

export function RoleAwarePage({ accountUser, elevated }: { accountUser: ReactNode; elevated: ReactNode }) {
  return useAuth().access?.platformRole === "ACCOUNT_USER" ? accountUser : elevated;
}
