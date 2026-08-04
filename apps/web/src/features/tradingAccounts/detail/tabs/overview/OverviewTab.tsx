import { Stack } from "@mantine/core";
import type { TradingAccount } from "../../../types";
import { AccountSummaryCard } from "./AccountSummaryCard";
import { BrokerSnapshotCard } from "./BrokerSnapshotCard";
import { CredentialStatusCard } from "./CredentialStatusCard";
import { SafetyNotesCard } from "./SafetyNotesCard";

export function OverviewTab({
  account,
}: {
  account: TradingAccount;
}) {
  return (
    <Stack gap="lg">
      <AccountSummaryCard account={account} />
      <BrokerSnapshotCard account={account} />
      <CredentialStatusCard account={account} />
      <SafetyNotesCard account={account} />
    </Stack>
  );
}
