export type ExitProfile = {
  id: number;
  key: string;
  name: string;
  description: string | null;
  targetPct: number | null;
  stopLossPct: number | null;
  trailingStopPct: number | null;
  maxHoldDays: number | null;
  exitMode: string;
  takeProfitBehavior: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

export type CreateExitProfilePayload = {
  key: string;
  name: string;
  description?: string | null;
  targetPct?: number | null;
  stopLossPct?: number | null;
  trailingStopPct?: number | null;
  maxHoldDays?: number | null;
  exitMode: string;
  takeProfitBehavior: string;
  enabled?: boolean;
};

export type UpdateExitProfilePayload = {
  name?: string;
  description?: string | null;
  targetPct?: number | null;
  stopLossPct?: number | null;
  trailingStopPct?: number | null;
  maxHoldDays?: number | null;
  exitMode?: string;
  takeProfitBehavior?: string;
  enabled?: boolean;
};

export type ExitProfileForm = {
  key: string;
  name: string;
  description: string;
  targetPct: string;
  stopLossPct: string;
  trailingStopPct: string;
  maxHoldDays: string;
  exitMode: string;
  takeProfitBehavior: string;
  enabled: boolean;
};
