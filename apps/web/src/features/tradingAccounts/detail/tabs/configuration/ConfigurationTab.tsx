import { Stack } from "@mantine/core";
import type { TradingAccount } from "../../../types";
import { CredentialManagementCard } from "../overview/CredentialManagementCard";
import { SafetyNotesCard } from "../overview/SafetyNotesCard";
import { SafetySettingsCard } from "../overview/SafetySettingsCard";
import { SizingAndAllocationsSection } from "../overview/SizingAndAllocationsSection";

export function ConfigurationTab({ account, token }: { account: TradingAccount; token: string | null }) {
  return <Stack gap="lg">
    <SafetySettingsCard key={`settings-${account.id}-${account.updatedAt}`} account={account} token={token} />
    <SizingAndAllocationsSection account={account} token={token} />
    <CredentialManagementCard account={account} token={token} />
    <SafetyNotesCard account={account} />
  </Stack>;
}
