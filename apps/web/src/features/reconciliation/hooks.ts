import { useMutation } from "@tanstack/react-query";

import { runReconciliation, type RunReconciliationPayload } from "./api";

export function useRunReconciliation(token: string | null) {
  return useMutation({
    mutationFn: (payload: RunReconciliationPayload = {}) => {
      if (!token) {
        throw new Error("Admin session is missing. Please log in again.");
      }

      return runReconciliation(token, payload);
    },
  });
}