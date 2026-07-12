import { createContext } from "react";
import type { AccessMetadata, User } from "./types";

export type AuthContextType = {
  user: User | null;
  access: AccessMetadata | null;
  isLoading: boolean;
};

export const AuthContext = createContext<AuthContextType | null>(null);
