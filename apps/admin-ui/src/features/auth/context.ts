import { createContext } from "react";
import type { AdminUser, AdminAccess } from "./types";

export type AuthContextType = {
  adminUser: AdminUser | null;
  access: AdminAccess | null;
  isLoading: boolean;
};

export const AuthContext = createContext<AuthContextType | null>(null);
