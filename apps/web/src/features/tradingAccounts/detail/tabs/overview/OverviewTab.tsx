import { Stack } from "@mantine/core";
import type { TradingAccount } from "../../../types";
import { AccountSummaryCard } from "./AccountSummaryCard";
import { BrokerSnapshotCard } from "./BrokerSnapshotCard";
import { CredentialStatusCard } from "./CredentialStatusCard";
import { SafetyNotesCard } from "./SafetyNotesCard";
import { OperationalSummaryCards } from "./OperationalSummaryCards";

export function OverviewTab({
  account,
  token,
}: {
  account: TradingAccount;
  token: string | null;
}) {
  return (
    <Stack gap="lg">
      <AccountSummaryCard account={account} />
      <OperationalSummaryCards account={account} token={token} />
      <BrokerSnapshotCard account={account} />
      <CredentialStatusCard account={account} />
      <SafetyNotesCard account={account} />
    </Stack>
  );
}
