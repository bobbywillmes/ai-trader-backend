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
  listMomentumResearchCandidates,
  listMomentumResearchCatalysts,
  getMomentumResearchCandidate,
  getMomentumSymbolResearch,
  getMomentumMarketChart,
  getLatestMomentumPipelineRuns,
  listMomentumPipelineRuns,
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
  MomentumResearchCandidatesQuery,
  MomentumResearchCatalystsQuery,
  MomentumMarketChartQuery,
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
  researchCandidates: (query: MomentumResearchCandidatesQuery) =>
    [...momentumScannerKeys.all, "research", "candidates", query] as const,
  researchCatalysts: (query: MomentumResearchCatalystsQuery) =>
    [...momentumScannerKeys.all, "research", "catalysts", query] as const,
  researchCandidate: (candidateId: string | null) =>
    [...momentumScannerKeys.all, "research", "candidate", candidateId] as const,
  symbolResearch: (symbol: string | null) =>
    [...momentumScannerKeys.all, "research", "symbol", symbol] as const,
  marketChart: (symbol: string | null, query: MomentumMarketChartQuery) =>
    [...momentumScannerKeys.all, "research", "marketChart", symbol, query] as const,
  pipelineRunsLatest: () =>
    [...momentumScannerKeys.all, "research", "pipelineRuns", "latest"] as const,
  pipelineRuns: (pageSize: number) =>
    [...momentumScannerKeys.all, "research", "pipelineRuns", pageSize] as const,
};

export function useLatestMomentumPipelineRuns(token: string | null) {
  return useQuery({
    queryKey: momentumScannerKeys.pipelineRunsLatest(),
    queryFn: () => getLatestMomentumPipelineRuns(token as string),
    enabled: Boolean(token),
    refetchInterval: 15_000,
  });
}

export function useMomentumPipelineRuns(token: string | null, pageSize = 10) {
  return useQuery({
    queryKey: momentumScannerKeys.pipelineRuns(pageSize),
    queryFn: () => listMomentumPipelineRuns(token as string, pageSize),
    enabled: Boolean(token),
    refetchInterval: 30_000,
  });
}

export function useMomentumResearchOverview(token: string | null) {
  return useQuery({
    queryKey: momentumScannerKeys.researchOverview(),
    queryFn: () => getMomentumResearchOverview(token as string),
    enabled: Boolean(token),
    staleTime: 15000,
  });
}

export function useMomentumResearchCandidates(
  token: string | null,
  query: MomentumResearchCandidatesQuery
) {
  return useQuery({
    queryKey: momentumScannerKeys.researchCandidates(query),
    queryFn: () => listMomentumResearchCandidates(token as string, query),
    enabled: Boolean(token),
    placeholderData: (previous) => previous,
  });
}

export function useMomentumResearchCatalysts(
  token: string | null,
  query: MomentumResearchCatalystsQuery
) {
  return useQuery({
    queryKey: momentumScannerKeys.researchCatalysts(query),
    queryFn: () => listMomentumResearchCatalysts(token as string, query),
    enabled: Boolean(token),
    placeholderData: (previous) => previous,
  });
}

export function useMomentumResearchCandidate(
  token: string | null,
  candidateId: string | null
) {
  return useQuery({
    queryKey: momentumScannerKeys.researchCandidate(candidateId),
    queryFn: () => getMomentumResearchCandidate(token as string, candidateId as string),
    enabled: Boolean(token) && Boolean(candidateId),
  });
}

export function useMomentumSymbolResearch(token: string | null, symbol: string | null) {
  return useQuery({
    queryKey: momentumScannerKeys.symbolResearch(symbol),
    queryFn: () => getMomentumSymbolResearch(token as string, symbol as string),
    enabled: Boolean(token) && Boolean(symbol),
  });
}

export function useMomentumMarketChart(
  token: string | null,
  symbol: string | null,
  query: MomentumMarketChartQuery
) {
  return useQuery({
    queryKey: momentumScannerKeys.marketChart(symbol, query),
    queryFn: () => getMomentumMarketChart(token as string, symbol as string, query),
    enabled: Boolean(token) && Boolean(symbol),
    staleTime: query.interval === "1m" ? 15_000 : 60_000,
    placeholderData: (previous) => previous,
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
