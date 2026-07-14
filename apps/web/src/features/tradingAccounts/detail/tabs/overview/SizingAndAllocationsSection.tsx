import { Alert, Stack, Text, Title } from "@mantine/core";
import type { TradingAccount } from "../../../types";
import { AllocationManagementCard } from "../subscriptions/AllocationManagementCard";

export function SizingAndAllocationsSection({
  account,
  token,
}: {
  account: TradingAccount;
  token: string | null;
}) {
  return (
    <Stack gap="md">
      <div>
        <Title order={3}>Sizing & Allocations</Title>
        <Text size="sm" c="dimmed">
          Account-specific capital buckets used to group subscription budgets.
        </Text>
      </div>

      <Alert color="blue" title="Runtime sizing note">
        New entry orders now use account-specific sizing from
        TradingAccountSubscription. FIXED_QTY buys a fixed share quantity.
        MAX_NOTIONAL calculates a whole-share quantity from backend-owned latest
        market data. Allocation bucket limits are enforced for new entries
        assigned to that allocation.
      </Alert>

      <AllocationManagementCard account={account} token={token} />
    </Stack>
  );
}


