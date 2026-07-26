import { Stack } from "@mantine/core";
import type { TradingAccount } from "../../../types";
import { AccountRiskControlsCard } from "./AccountRiskControlsCard";
import { EntryReadinessCard } from "./EntryReadinessCard";
import { AccountWorkerHealthCard } from "./AccountWorkerHealthCard";

export function RiskHealthTab({
  account,
  token,
}: {
  account: TradingAccount;
  token: string | null;
}) {
  return (
    <Stack gap="lg">
      <AccountRiskControlsCard account={account} token={token} />
      <EntryReadinessCard account={account} token={token} />
      <AccountWorkerHealthCard account={account} token={token} />
    </Stack>
  );
}
