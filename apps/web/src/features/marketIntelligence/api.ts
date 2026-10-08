import { apiRequest, getAdminToken } from "../../lib/api";
import type { Assessment, DimensionKey, IntelligenceSummary } from "./types";
const root = "/api/market-data";
const options = () => ({ token: getAdminToken() ?? "" });
const paths: Record<DimensionKey | "breadthV2", string> = { trend: "trend-assessments", volatility: "volatility-assessments", breadth: "breadth-assessments", participation: "participation-assessments", intradayStress: "intraday-stress-assessments", breadthV2: "breadth-v2-assessments" };
export const getSummary = () => apiRequest<IntelligenceSummary>(`${root}/intelligence/summary`, options());
export const getAssessments = (dimension: DimensionKey | "breadthV2", beforeId?: number) => apiRequest<Assessment[]>(`${root}/${paths[dimension]}?${new URLSearchParams({ limit: "30", ...(beforeId ? { beforeId: String(beforeId) } : {}) })}`, options());
export const getAssessment = (dimension: DimensionKey | "breadthV2", id: number) => apiRequest<Assessment>(`${root}/${paths[dimension]}/${id}`, options());
