import type {
  TradingAccountRiskSettings,
  TradingAccountRiskSettingsInput,
} from "../../../types";

export type AccountRiskSettingsDraft = {
  enabled: boolean;
  maxDailyEntryOrders: number | null;
  maxDailyEntryNotional: number | null;
  maxOpenPositions: number | null;
  maxTotalOpenNotional: number | null;
  maxSymbolOpenNotional: number | null;
  maxSubscriptionOpenNotional: number | null;
  notes: string;
};

export function riskSettingsToDraft(
  riskSettings: TradingAccountRiskSettings
): AccountRiskSettingsDraft {
  return {
    enabled: riskSettings.enabled,
    maxDailyEntryOrders: riskSettings.maxDailyEntryOrders,
    maxDailyEntryNotional: riskSettings.maxDailyEntryNotional,
    maxOpenPositions: riskSettings.maxOpenPositions,
    maxTotalOpenNotional: riskSettings.maxTotalOpenNotional,
    maxSymbolOpenNotional: riskSettings.maxSymbolOpenNotional,
    maxSubscriptionOpenNotional: riskSettings.maxSubscriptionOpenNotional,
    notes: riskSettings.notes ?? "",
  };
}

export function riskSettingsDraftChanged(
  riskSettings: TradingAccountRiskSettings,
  draft: AccountRiskSettingsDraft
) {
  return (
    riskSettings.enabled !== draft.enabled ||
    riskSettings.maxDailyEntryOrders !== draft.maxDailyEntryOrders ||
    riskSettings.maxDailyEntryNotional !== draft.maxDailyEntryNotional ||
    riskSettings.maxOpenPositions !== draft.maxOpenPositions ||
    riskSettings.maxTotalOpenNotional !== draft.maxTotalOpenNotional ||
    riskSettings.maxSymbolOpenNotional !== draft.maxSymbolOpenNotional ||
    riskSettings.maxSubscriptionOpenNotional !==
      draft.maxSubscriptionOpenNotional ||
    (riskSettings.notes ?? "") !== draft.notes
  );
}

export function validateAccountRiskSettingsDraft(
  draft: AccountRiskSettingsDraft
) {
  if (
    draft.maxDailyEntryOrders !== null &&
    (!Number.isInteger(draft.maxDailyEntryOrders) ||
      draft.maxDailyEntryOrders <= 0)
  ) {
    return "Account max daily entry orders must be empty or a positive whole number.";
  }

  if (
    draft.maxOpenPositions !== null &&
    (!Number.isInteger(draft.maxOpenPositions) || draft.maxOpenPositions <= 0)
  ) {
    return "Account max open positions must be empty or a positive whole number.";
  }

  const dollarLimits = [
    draft.maxDailyEntryNotional,
    draft.maxTotalOpenNotional,
    draft.maxSymbolOpenNotional,
    draft.maxSubscriptionOpenNotional,
  ];

  if (dollarLimits.some((value) => value !== null && value <= 0)) {
    return "Account dollar limits must be empty or greater than zero.";
  }

  return null;
}

export function riskSettingsDraftToPayload(
  draft: AccountRiskSettingsDraft
): TradingAccountRiskSettingsInput {
  const notes = draft.notes.trim();

  return {
    enabled: draft.enabled,
    maxDailyEntryOrders: draft.maxDailyEntryOrders,
    maxDailyEntryNotional: draft.maxDailyEntryNotional,
    maxOpenPositions: draft.maxOpenPositions,
    maxTotalOpenNotional: draft.maxTotalOpenNotional,
    maxSymbolOpenNotional: draft.maxSymbolOpenNotional,
    maxSubscriptionOpenNotional: draft.maxSubscriptionOpenNotional,
    notes: notes.length > 0 ? notes : null,
  };
}

export function normalizeNumberInput(value: string | number) {
  if (value === "") return null;

  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
