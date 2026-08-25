import { useQuery } from "@tanstack/react-query";
import { getLiveOperations } from "./api";
export function useLiveOperations(token: string | null, tradingAccountId?: number) {
  return useQuery({ queryKey: ["live-operations", tradingAccountId ?? "all"], queryFn: () => getLiveOperations(token as string, tradingAccountId), enabled: Boolean(token), refetchInterval: 15_000 });
}
