import { useQuery } from "@tanstack/react-query";
import { getStrategies } from "./api";

export function useStrategies(token: string | null) {
  return useQuery({
    queryKey: ["strategies"],
    queryFn: () => getStrategies(token as string),
    enabled: Boolean(token),
  });
}
