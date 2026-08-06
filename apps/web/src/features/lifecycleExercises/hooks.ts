import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { cancelLifecycleExercise, getLifecycleExercise, launchLifecycleExercise, listLifecycleExercises, listSubscriptionEntryCandidates, previewExplicitAssignmentExercise, previewLifecycleExercise, reconcileLifecycleTarget, recoverLifecycleExerciseDispatches } from "./api";

export const lifecycleExerciseKeys = {
  all: ["lifecycleExercises"] as const,
  detail: (id: number) => ["lifecycleExercises", id] as const,
  candidates: (subscriptionId: number | null) => ["lifecycleExercises", "subscriptionEntryCandidates", subscriptionId] as const,
};

export function useSubscriptionEntryCandidates(token: string | null, subscriptionId: number | null) {
  return useQuery({ queryKey: lifecycleExerciseKeys.candidates(subscriptionId), queryFn: () => listSubscriptionEntryCandidates(token as string, subscriptionId as number), enabled: Boolean(token) && Boolean(subscriptionId) });
}

export function useLifecycleExercises(token: string | null) {
  return useQuery({ queryKey: lifecycleExerciseKeys.all, queryFn: () => listLifecycleExercises(token as string), enabled: Boolean(token) });
}

export function useLifecycleExercise(token: string | null, id: number) {
  return useQuery({
    queryKey: lifecycleExerciseKeys.detail(id),
    queryFn: () => getLifecycleExercise(token as string, id),
    enabled: Boolean(token) && id > 0,
    refetchInterval: (query) => {
      const status = query.state.data?.exercise.status;
      return status && ["LAUNCHING", "RUNNING", "PARTIAL", "ATTENTION_REQUIRED"].includes(status) ? 2500 : false;
    },
  });
}

export function useLifecycleExerciseMutations(token: string | null) {
  const client = useQueryClient();
  const refresh = async () => client.invalidateQueries({ queryKey: lifecycleExerciseKeys.all });
  const refreshExercise = async (id: number) => { await refresh(); await client.invalidateQueries({ queryKey: lifecycleExerciseKeys.detail(id) }); };
  return {
    preview: useMutation({ mutationFn: (input: Parameters<typeof previewLifecycleExercise>[1]) => previewLifecycleExercise(token as string, input), onSuccess: refresh }),
    previewExplicit: useMutation({ mutationFn: (input: Parameters<typeof previewExplicitAssignmentExercise>[1]) => previewExplicitAssignmentExercise(token as string, input), onSuccess: refresh }),
    launch: useMutation({ mutationFn: (id: number) => launchLifecycleExercise(token as string, id), onSuccess: (_data, id) => refreshExercise(id) }),
    cancel: useMutation({ mutationFn: ({ id, reason }: { id: number; reason: string }) => cancelLifecycleExercise(token as string, id, reason), onSuccess: refresh }),
    reconcile: useMutation({ mutationFn: ({ exerciseId, targetId }: { exerciseId: number; targetId: number }) => reconcileLifecycleTarget(token as string, exerciseId, targetId), onSuccess: refresh }),
    recover: useMutation({ mutationFn: (id: number) => recoverLifecycleExerciseDispatches(token as string, id), onSuccess: (_data, id) => refreshExercise(id) }),
  };
}
