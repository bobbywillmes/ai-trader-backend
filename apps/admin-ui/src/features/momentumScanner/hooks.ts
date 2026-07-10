import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  confirmMomentumCandidatePrices,
  generateMomentumCandidates,
  getCatalystEvent,
  getMomentumCandidate,
  getMomentumScannerHandoff,
  listCatalystEvents,
  listMomentumCandidatePriceChecks,
  listMomentumCandidates,
  listMomentumScannerHandoffs,
  prepareMomentumScannerHandoffs,
  runMassiveNewsWorker,
  listMomentumUniverse,
  createMomentumUniverseMember,
  updateMomentumUniverseMember,
  deleteMomentumUniverseMember,
  getMomentumResearchOverview,
} from "./api";
import type {
  CatalystEventQuery,
  ConfirmMomentumPricesRequest,
  GenerateMomentumCandidatesRequest,
  MomentumCandidateQuery,
  MomentumScannerHandoffQuery,
  PrepareMomentumScannerHandoffsRequest,
  MomentumUniverseQuery,
  CreateMomentumUniverseMemberRequest,
  UpdateMomentumUniverseMemberRequest,
} from "./types";

export const momentumScannerKeys = {
  all: ["momentumScanner"] as const,
  catalystEvents: (query: CatalystEventQuery) =>
    [...momentumScannerKeys.all, "catalystEvents", query] as const,
  catalystEvent: (id: string | null) =>
    [...momentumScannerKeys.all, "catalystEvents", "detail", id] as const,
  candidates: (query: MomentumCandidateQuery) =>
    [...momentumScannerKeys.all, "candidates", query] as const,
  candidate: (id: string | null) =>
    [...momentumScannerKeys.all, "candidates", "detail", id] as const,
  priceChecks: (candidateId: string | null) =>
    [...momentumScannerKeys.all, "candidates", candidateId, "priceChecks"] as const,
  handoffs: (query: MomentumScannerHandoffQuery) =>
    [...momentumScannerKeys.all, "handoffs", query] as const,
  handoff: (id: string | null) =>
    [...momentumScannerKeys.all, "handoffs", "detail", id] as const,
  universe: (query: MomentumUniverseQuery) =>
    [...momentumScannerKeys.all, "universe", query] as const,
  researchOverview: () =>
    [...momentumScannerKeys.all, "research", "overview"] as const,
};

export function useMomentumResearchOverview(token: string | null) {
  return useQuery({
    queryKey: momentumScannerKeys.researchOverview(),
    queryFn: () => getMomentumResearchOverview(token as string),
    enabled: Boolean(token),
    staleTime: 15000,
  });
}

function invalidateMomentumScanner(queryClient: ReturnType<typeof useQueryClient>) {
  return queryClient.invalidateQueries({ queryKey: momentumScannerKeys.all });
}

export function useCatalystEvents(
  token: string | null,
  query: CatalystEventQuery = {}
) {
  return useQuery({
    queryKey: momentumScannerKeys.catalystEvents(query),
    queryFn: () => listCatalystEvents(token as string, query),
    enabled: Boolean(token),
    staleTime: 15000,
  });
}

export function useCatalystEvent(token: string | null, id: string | null) {
  return useQuery({
    queryKey: momentumScannerKeys.catalystEvent(id),
    queryFn: () => getCatalystEvent(token as string, id as string),
    enabled: Boolean(token) && id !== null,
    staleTime: 15000,
  });
}

export function useMomentumCandidates(
  token: string | null,
  query: MomentumCandidateQuery = {}
) {
  return useQuery({
    queryKey: momentumScannerKeys.candidates(query),
    queryFn: () => listMomentumCandidates(token as string, query),
    enabled: Boolean(token),
    staleTime: 15000,
  });
}

export function useMomentumCandidate(token: string | null, id: string | null) {
  return useQuery({
    queryKey: momentumScannerKeys.candidate(id),
    queryFn: () => getMomentumCandidate(token as string, id as string),
    enabled: Boolean(token) && id !== null,
    staleTime: 15000,
  });
}

export function useMomentumCandidatePriceChecks(
  token: string | null,
  candidateId: string | null
) {
  return useQuery({
    queryKey: momentumScannerKeys.priceChecks(candidateId),
    queryFn: () =>
      listMomentumCandidatePriceChecks(token as string, candidateId as string, {
        limit: 10,
      }),
    enabled: Boolean(token) && candidateId !== null,
    staleTime: 15000,
  });
}

export function useMomentumScannerHandoffs(
  token: string | null,
  query: MomentumScannerHandoffQuery = {}
) {
  return useQuery({
    queryKey: momentumScannerKeys.handoffs(query),
    queryFn: () => listMomentumScannerHandoffs(token as string, query),
    enabled: Boolean(token),
    staleTime: 15000,
  });
}

export function useMomentumScannerHandoff(
  token: string | null,
  id: string | null
) {
  return useQuery({
    queryKey: momentumScannerKeys.handoff(id),
    queryFn: () => getMomentumScannerHandoff(token as string, id as string),
    enabled: Boolean(token) && id !== null,
    staleTime: 15000,
  });
}

export function useRunMassiveNewsWorker(token: string | null) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () => runMassiveNewsWorker(token as string),
    onSuccess: () => invalidateMomentumScanner(queryClient),
  });
}

export function useGenerateMomentumCandidates(token: string | null) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (request?: GenerateMomentumCandidatesRequest) =>
      generateMomentumCandidates(token as string, request),
    onSuccess: () => invalidateMomentumScanner(queryClient),
  });
}

export function useConfirmMomentumCandidatePrices(token: string | null) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (request?: ConfirmMomentumPricesRequest) =>
      confirmMomentumCandidatePrices(token as string, request),
    onSuccess: () => invalidateMomentumScanner(queryClient),
  });
}

export function usePrepareMomentumScannerHandoffs(token: string | null) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (request?: PrepareMomentumScannerHandoffsRequest) =>
      prepareMomentumScannerHandoffs(token as string, request),
    onSuccess: () => invalidateMomentumScanner(queryClient),
  });
}

export function useMomentumUniverse(
  token: string | null,
  query: MomentumUniverseQuery
) {
  return useQuery({
    queryKey: momentumScannerKeys.universe(query),
    queryFn: () => listMomentumUniverse(token as string, query),
    enabled: Boolean(token),
    placeholderData: (previous) => previous,
  });
}

export function useCreateMomentumUniverseMember(token: string | null) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (request: CreateMomentumUniverseMemberRequest) =>
      createMomentumUniverseMember(token as string, request),
    onSuccess: () => invalidateMomentumScanner(queryClient),
  });
}

export function useUpdateMomentumUniverseMember(token: string | null) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      id,
      request,
    }: {
      id: string;
      request: UpdateMomentumUniverseMemberRequest;
    }) => updateMomentumUniverseMember(token as string, id, request),
    onSuccess: () => invalidateMomentumScanner(queryClient),
  });
}

export function useDeleteMomentumUniverseMember(token: string | null) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => deleteMomentumUniverseMember(token as string, id),
    onSuccess: () => invalidateMomentumScanner(queryClient),
  });
}
