import { useMemo } from "react";
import type { ReactNode } from "react";
import { AuthContext } from "./context";
import type { AdminUser, AdminAccess } from "./types";

type AuthProviderProps = {
  children: ReactNode;
  adminUser: AdminUser | null;
  access: AdminAccess | null;
  isLoading?: boolean;
};

export function AuthProvider({
  children,
  adminUser,
  access,
  isLoading = false,
}: AuthProviderProps) {
  const value = useMemo(
    () => ({
      adminUser,
      access,
      isLoading,
    }),
    [adminUser, access, isLoading]
  );

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
}
