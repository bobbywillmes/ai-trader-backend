import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getMe, login, logout } from "./api";
import { setAdminToken, clearAdminToken } from "../../lib/api";

export const authKeys = {
  me: ["me"] as const,
};

export function useMe(token: string | null) {
  return useQuery({
    queryKey: authKeys.me,
    queryFn: () => getMe(token as string),
    enabled: Boolean(token),
    retry: false,
    staleTime: 5 * 60 * 1000,
  });
}

export function useLogin() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ email, password }: { email: string; password: string }) =>
      login(email, password),
    onSuccess: (data) => {
      setAdminToken(data.token);
      queryClient.setQueryData(authKeys.me, data);
    },
  });
}

export function useLogout(token: string | null) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () => (token ? logout(token) : Promise.resolve()),
    onSettled: () => {
      clearAdminToken();
      queryClient.clear();
    },
  });
}
