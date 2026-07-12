import { useMemo } from "react";
import type { ReactNode } from "react";
import { AuthContext } from "./context";
import type { AccessMetadata, User } from "./types";

type AuthProviderProps = {
  children: ReactNode;
  user: User | null;
  access: AccessMetadata | null;
  isLoading?: boolean;
};

export function AuthProvider({
  children,
  user,
  access,
  isLoading = false,
}: AuthProviderProps) {
  const value = useMemo(
    () => ({
      user,
      access,
      isLoading,
    }),
    [user, access, isLoading]
  );

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
}
