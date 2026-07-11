import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getMe,
  login,
  logout,
  changePassword,
  completeSetupAccount,
  validateSetupAccountToken,
  verifyPassword,
} from "./api";
import { setAdminToken, clearAdminToken } from "../../lib/api";
import type { MeResponse, LoginResponse } from "./types";

export const authKeys = {
  me: ["me"] as const,
  setupAccount: (token: string | null) => ["setupAccount", token] as const,
};

export function useMe(token: string | null) {
  return useQuery<MeResponse>({
    queryKey: authKeys.me,
    queryFn: () => getMe(token as string),
    enabled: Boolean(token),
    retry: false,
    staleTime: 5 * 60 * 1000,
  });
}

export function useLogin() {
  const queryClient = useQueryClient();

  return useMutation<LoginResponse, Error, { email: string; password: string }>({
    mutationFn: ({ email, password }: { email: string; password: string }) =>
      login(email, password),
    onSuccess: (data) => {
      setAdminToken(data.token);
      queryClient.setQueryData(authKeys.me, {
        ok: true,
        user: data.user,
        access: data.access,
        session: data.session,
      } as MeResponse);
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

export function useVerifyPassword(token: string) {
  return useMutation({
    mutationFn: (password: string) => verifyPassword(token, password),
  });
}

export function useChangePassword(token: string) {
  return useMutation({
    mutationFn: ({
      currentPassword,
      newPassword,
    }: {
      currentPassword: string;
      newPassword: string;
    }) => changePassword(token, currentPassword, newPassword),
  });
}

export function useSetupAccountToken(token: string | null) {
  return useQuery({
    queryKey: authKeys.setupAccount(token),
    queryFn: () => validateSetupAccountToken(token as string),
    enabled: Boolean(token),
    retry: false,
  });
}

export function useCompleteSetupAccount(token: string) {
  return useMutation({
    mutationFn: ({
      password,
      confirmPassword,
    }: {
      password: string;
      confirmPassword: string;
    }) => completeSetupAccount(token, password, confirmPassword),
  });
}
