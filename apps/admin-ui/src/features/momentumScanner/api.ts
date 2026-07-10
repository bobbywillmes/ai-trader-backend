import { apiRequest } from "../../lib/api";
import type {
  CatalystEvent,
  CatalystEventQuery,
  ConfirmMomentumPricesRequest,
  ConfirmMomentumPricesResponse,
  GenerateMomentumCandidatesRequest,
  GenerateMomentumCandidatesResponse,
  MomentumCandidate,
  MomentumCandidatePriceCheck,
  MomentumCandidateQuery,
  MomentumScannerHandoff,
  MomentumScannerHandoffQuery,
  PrepareMomentumScannerHandoffsRequest,
  PrepareMomentumScannerHandoffsResponse,
  RunMassiveNewsWorkerResponse,
  MomentumUniverseMember,
  MomentumUniverseQuery,
  MomentumUniverseResponse,
  CreateMomentumUniverseMemberRequest,
  UpdateMomentumUniverseMemberRequest,
  MomentumResearchOverview,
} from "./types";

export function getMomentumResearchOverview(token: string) {
  return apiRequest<MomentumResearchOverview>(
    "/api/momentum-scanner/research/overview",
    { token }
  );
}

const DEFAULT_GENERATE_REQUEST: Required<
  Pick<GenerateMomentumCandidatesRequest, "minCatalystScore" | "take" | "expiresInHours">
> = {
  minCatalystScore: 60,
  take: 20,
  expiresInHours: 24,
};

function buildQuery(params: Record<string, unknown>) {
  const search = new URLSearchParams();

  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      search.set(key, String(value));
    }
  }

  const query = search.toString();

  return query ? `?${query}` : "";
}

export function listCatalystEvents(
  token: string,
  query: CatalystEventQuery = {}
) {
  return apiRequest<CatalystEvent[]>(
    `/api/catalyst-events${buildQuery(query)}`,
    { token }
  );
}

export function getCatalystEvent(token: string, id: string) {
  return apiRequest<CatalystEvent>(
    `/api/catalyst-events/${encodeURIComponent(id)}`,
    { token }
  );
}

export function runMassiveNewsWorker(token: string) {
  return apiRequest<RunMassiveNewsWorkerResponse>(
    "/api/catalyst-events/workers/massive-news/run-once",
    {
      method: "POST",
      token,
      body: {},
    }
  );
}

export function listMomentumCandidates(
  token: string,
  query: MomentumCandidateQuery = {}
) {
  return apiRequest<MomentumCandidate[]>(
    `/api/momentum-candidates${buildQuery(query)}`,
    { token }
  );
}

export function getMomentumCandidate(token: string, id: string) {
  return apiRequest<MomentumCandidate>(
    `/api/momentum-candidates/${encodeURIComponent(id)}`,
    { token }
  );
}

export function generateMomentumCandidates(
  token: string,
  request: GenerateMomentumCandidatesRequest = {}
) {
  return apiRequest<GenerateMomentumCandidatesResponse>(
    "/api/momentum-candidates/generate-from-catalysts",
    {
      method: "POST",
      token,
      body: {
        ...DEFAULT_GENERATE_REQUEST,
        ...request,
      },
    }
  );
}

export function confirmMomentumCandidatePrices(
  token: string,
  request: ConfirmMomentumPricesRequest = {}
) {
  return apiRequest<ConfirmMomentumPricesResponse>(
    "/api/momentum-candidates/confirm-prices",
    {
      method: "POST",
      token,
      body: request,
    }
  );
}

export function listMomentumCandidatePriceChecks(
  token: string,
  candidateId: string,
  query: { limit?: number } = {}
) {
  return apiRequest<MomentumCandidatePriceCheck[]>(
    `/api/momentum-candidates/${encodeURIComponent(candidateId)}/price-checks${buildQuery(query)}`,
    { token }
  );
}

export function listMomentumScannerHandoffs(
  token: string,
  query: MomentumScannerHandoffQuery = {}
) {
  return apiRequest<MomentumScannerHandoff[]>(
    `/api/momentum-scanner/handoffs${buildQuery(query)}`,
    { token }
  );
}

export function getMomentumScannerHandoff(token: string, id: string) {
  return apiRequest<MomentumScannerHandoff>(
    `/api/momentum-scanner/handoffs/${encodeURIComponent(id)}`,
    { token }
  );
}

export function prepareMomentumScannerHandoffs(
  token: string,
  request: PrepareMomentumScannerHandoffsRequest = {}
) {
  return apiRequest<PrepareMomentumScannerHandoffsResponse>(
    "/api/momentum-scanner/handoffs/prepare",
    {
      method: "POST",
      token,
      body: request,
    }
  );
}

export function listMomentumUniverse(
  token: string,
  query: MomentumUniverseQuery = {}
) {
  return apiRequest<MomentumUniverseResponse>(
    `/api/momentum-scanner/universe${buildQuery(query)}`,
    { token }
  );
}

export function createMomentumUniverseMember(
  token: string,
  request: CreateMomentumUniverseMemberRequest
) {
  return apiRequest<MomentumUniverseMember>("/api/momentum-scanner/universe", {
    method: "POST",
    token,
    body: request,
  });
}

export function updateMomentumUniverseMember(
  token: string,
  id: string,
  request: UpdateMomentumUniverseMemberRequest
) {
  return apiRequest<MomentumUniverseMember>(
    `/api/momentum-scanner/universe/${encodeURIComponent(id)}`,
    { method: "PATCH", token, body: request }
  );
}

export function deleteMomentumUniverseMember(token: string, id: string) {
  return apiRequest<MomentumUniverseMember>(
    `/api/momentum-scanner/universe/${encodeURIComponent(id)}`,
    { method: "DELETE", token }
  );
}
