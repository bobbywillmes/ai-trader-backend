import { Stack } from "@mantine/core";
import type { TradingAccount } from "../../../types";
import { AccountSummaryCard } from "./AccountSummaryCard";
import { BrokerSnapshotCard } from "./BrokerSnapshotCard";
import { CredentialManagementCard } from "./CredentialManagementCard";
import { CredentialStatusCard } from "./CredentialStatusCard";
import { SafetyNotesCard } from "./SafetyNotesCard";
import { SafetySettingsCard } from "./SafetySettingsCard";
import { SizingAndAllocationsSection } from "./SizingAndAllocationsSection";

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
      <BrokerSnapshotCard account={account} />
      <CredentialStatusCard account={account} />
      <SafetySettingsCard
        key={`settings-${account.id}-${account.updatedAt}`}
        account={account}
        token={token}
      />
      <SizingAndAllocationsSection account={account} token={token} />
      <CredentialManagementCard account={account} token={token} />
      <SafetyNotesCard account={account} />
    </Stack>
  );
}
