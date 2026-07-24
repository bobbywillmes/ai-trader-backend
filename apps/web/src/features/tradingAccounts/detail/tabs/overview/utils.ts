import type {
  BrokerCredentialStatus,
  TradingAccount,
  TradingAccountEnvironment,
  TradingAccountStatus,
} from "../../../types";
import type { AccountSettingsDraft } from "./types";

export function accountToSettingsDraft(
  account: TradingAccount
): AccountSettingsDraft {
  return {
    displayName: account.displayName,
    estimatedTradingCapital: account.estimatedTradingCapital,
    maxDeployableNotional: account.maxDeployableNotional,
    pausedReason: account.pausedReason ?? "",
    notes: account.notes ?? "",
  };
}

export function settingsDraftChanged(
  account: TradingAccount,
  draft: AccountSettingsDraft
) {
  return (
    account.displayName !== draft.displayName ||
    account.estimatedTradingCapital !== draft.estimatedTradingCapital ||
    account.maxDeployableNotional !== draft.maxDeployableNotional ||
    (account.pausedReason ?? "") !== draft.pausedReason ||
    (account.notes ?? "") !== draft.notes
  );
}

export function accountStatusColor(status: TradingAccountStatus) {
  switch (status) {
    case "ACTIVE":
      return "teal";
    case "PAUSED":
      return "yellow";
    case "NEEDS_CREDENTIALS":
      return "orange";
    case "ERROR":
      return "red";
    case "DISABLED":
      return "gray";
    default:
      return "gray";
  }
}

export function credentialStatusColor(status: BrokerCredentialStatus | null) {
  switch (status) {
    case "ACTIVE":
      return "teal";
    case "INVALID":
      return "red";
    case "REVOKED":
      return "gray";
    default:
      return "yellow";
  }
}

export function environmentColor(environment: TradingAccountEnvironment) {
  return environment === "LIVE" ? "red" : "blue";
}
