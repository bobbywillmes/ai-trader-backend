export type AccountSettingsDraft = {
  displayName: string;
  estimatedTradingCapital: number | null;
  maxDeployableNotional: number | null;
  pausedReason: string;
  notes: string;
};

export type CredentialDraft = {
  apiKey: string;
  apiSecret: string;
};
