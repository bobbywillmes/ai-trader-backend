import { Stack } from "@mantine/core";
import type { TradingAccount } from "../../../types";
import { AccountSummaryCard } from "./AccountSummaryCard";
import { BrokerSnapshotCard } from "./BrokerSnapshotCard";
import { CredentialStatusCard } from "./CredentialStatusCard";
import { SafetyNotesCard } from "./SafetyNotesCard";
import { OperationalSummaryCards } from "./OperationalSummaryCards";
import { useIsAccountUser } from "../../../../auth/useAuth";

export function OverviewTab({
  account,
  token,
}: {
  account: TradingAccount;
  token: string | null;
}) {
  const isAccountUser = useIsAccountUser();
  return (
    <Stack gap="lg">
      <AccountSummaryCard account={account} />
      {!isAccountUser && <OperationalSummaryCards account={account} token={token} />}
      <BrokerSnapshotCard account={account} />
      <CredentialStatusCard account={account} />
      <SafetyNotesCard account={account} />
    </Stack>
  );
}
