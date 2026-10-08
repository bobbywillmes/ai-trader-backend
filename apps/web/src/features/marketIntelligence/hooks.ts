import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import * as api from "./api";
import type { DimensionKey } from "./types";
export const useMarketIntelligenceSummary = (enabled = true) => useQuery({ queryKey: ["market-intelligence-summary"], queryFn: api.getSummary, enabled, refetchInterval: 60_000, staleTime: 30_000 });
export const useAssessmentHistory = (dimension: DimensionKey | "breadthV2", enabled = true) => useInfiniteQuery({ queryKey: ["market-intelligence-history", dimension], queryFn: ({ pageParam }) => api.getAssessments(dimension, pageParam), initialPageParam: undefined as number | undefined, getNextPageParam: page => page.length === 30 ? page.at(-1)?.id : undefined, enabled });
export const useAssessmentDetail = (dimension: DimensionKey | "breadthV2", id: number | null) => useQuery({ queryKey: ["market-intelligence-detail", dimension, id], queryFn: () => api.getAssessment(dimension, id!), enabled: id !== null });
