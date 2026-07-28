import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { cancelLifecycleExercise, getLifecycleExercise, launchLifecycleExercise, listLifecycleExercises, previewLifecycleExercise, reconcileLifecycleTarget } from "./api";

export const lifecycleExerciseKeys = {
  all: ["lifecycleExercises"] as const,
  detail: (id: number) => ["lifecycleExercises", id] as const,
};

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
  return {
    preview: useMutation({ mutationFn: (input: Parameters<typeof previewLifecycleExercise>[1]) => previewLifecycleExercise(token as string, input), onSuccess: refresh }),
    launch: useMutation({ mutationFn: (id: number) => launchLifecycleExercise(token as string, id), onSuccess: refresh }),
    cancel: useMutation({ mutationFn: ({ id, reason }: { id: number; reason: string }) => cancelLifecycleExercise(token as string, id, reason), onSuccess: refresh }),
    reconcile: useMutation({ mutationFn: ({ exerciseId, targetId }: { exerciseId: number; targetId: number }) => reconcileLifecycleTarget(token as string, exerciseId, targetId), onSuccess: refresh }),
  };
}
