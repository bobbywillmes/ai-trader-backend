import type { PlatformRole } from "../features/auth/types";

type SelectedAccount = {
  displayName: string;
  accountHolderName: string | null;
  broker: string;
};

export function getDashboardDescription(
  role: PlatformRole | undefined,
  isAll: boolean,
  selectedAccount: SelectedAccount | null,
) {
  if (role === "ACCOUNT_USER") {
    return "Overview of your Trading Accounts and trading activity";
  }

  if (isAll) return "Operational overview across all Trading Accounts";
  if (selectedAccount) {
    return `${selectedAccount.displayName} · ${selectedAccount.accountHolderName ?? "Account holder"} · ${selectedAccount.broker}`;
  }
  return "Operational command center";
}
