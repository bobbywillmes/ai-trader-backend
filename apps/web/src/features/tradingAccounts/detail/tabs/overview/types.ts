import type { TradingAccountStatus } from "../../../types";

export type AccountSettingsDraft = {
  displayName: string;
  estimatedTradingCapital: number | null;
  maxDeployableNotional: number | null;
  status: TradingAccountStatus;
  tradingEnabled: boolean;
  killSwitchEnabled: boolean;
  pausedReason: string;
  notes: string;
};

export type CredentialDraft = {
  apiKey: string;
  apiSecret: string;
};
