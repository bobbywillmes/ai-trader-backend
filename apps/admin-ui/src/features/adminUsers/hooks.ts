import { useQuery } from "@tanstack/react-query";
import {
  listAdminUsers,
  getAdminUser,
  getAdminUserTradingAccountAccess,
} from "./api";

export function useAdminUsers() {
  return useQuery({
    queryKey: ["adminUsers"],
    queryFn: listAdminUsers,
    staleTime: 1000 * 60 * 5, // 5 minutes
  });
}

export function useAdminUser(id: number | null) {
  return useQuery({
    queryKey: ["adminUsers", id],
    queryFn: () => getAdminUser(id!),
    enabled: !!id,
    staleTime: 1000 * 60 * 5, // 5 minutes
  });
}

export function useAdminUserTradingAccountAccess(id: number | null) {
  return useQuery({
    queryKey: ["adminUsers", id, "tradingAccountAccess"],
    queryFn: () => getAdminUserTradingAccountAccess(id!),
    enabled: !!id,
    staleTime: 1000 * 60 * 5, // 5 minutes
  });
}
