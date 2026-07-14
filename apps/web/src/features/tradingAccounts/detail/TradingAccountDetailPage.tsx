import { useState } from "react";
import {
  Alert,
  Button,
  Card,
  Group,
  Loader,
  Stack,
  Tabs,
  Text,
} from "@mantine/core";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { getAdminToken } from "../../../lib/api";
import { useTradingAccount } from "../hooks";
import { AccountDetailHeader } from "./components/AccountDetailHeader";
import { ActivityTab } from "./tabs/activity/ActivityTab";
import { OverviewTab } from "./tabs/overview/OverviewTab";
import { OrdersTab } from "./tabs/orders/OrdersTab";
import { PositionsTab } from "./tabs/positions/PositionsTab";
import { RiskHealthTab } from "./tabs/riskHealth/RiskHealthTab";
import { SubscriptionsTab } from "./tabs/subscriptions/SubscriptionsTab";
import type { TradingAccountDetailTab } from "./types";
import {
  isTradingAccountDetailTab,
  resolveTradingAccountDetailTab,
  tradingAccountDetailTabs,
  updateTradingAccountDetailTabSearchParams,
} from "./utils/tabRouting";

export function TradingAccountDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [token] = useState<string | null>(() => getAdminToken());
  const accountId = id ? Number(id) : undefined;
  const requestedTab = searchParams.get("tab");
  const activeTab: TradingAccountDetailTab =
    resolveTradingAccountDetailTab(requestedTab);
  const validAccountId =
    accountId !== undefined && Number.isInteger(accountId) && accountId > 0
      ? accountId
      : undefined;
  const { data, isLoading, isError, error } = useTradingAccount(
    validAccountId,
    token
  );
  const account = data?.account;

  function setActiveTab(value: string | null) {
    if (!isTradingAccountDetailTab(value)) return;

    setSearchParams((current) =>
      updateTradingAccountDetailTabSearchParams(current, value)
    );
  }

  if (!validAccountId) {
    return (
      <Stack gap="md">
        <Button variant="subtle" onClick={() => navigate("/trading-accounts")}>
          Back to Trading Accounts
        </Button>
        <Alert color="red">Invalid trading account id.</Alert>
      </Stack>
    );
  }

  return (
    <Stack gap="lg">
      <AccountDetailHeader displayName={account?.displayName} />

      {isError && (
        <Alert color="red" title="Failed to load trading account">
          {error instanceof Error ? error.message : "Unknown error."}
        </Alert>
      )}

      {isLoading && (
        <Card withBorder radius="md" p="md">
          <Group gap="sm">
            <Loader size="sm" color="cyan" />
            <Text size="sm" c="dimmed">
              Loading trading account...
            </Text>
          </Group>
        </Card>
      )}

      {!isLoading && !isError && !account && (
        <Alert color="red">Trading account not found.</Alert>
      )}

      {account && (
        <Tabs value={activeTab} onChange={setActiveTab} keepMounted={false}>
          <Tabs.List>
            {tradingAccountDetailTabs.map((tab) => (
              <Tabs.Tab key={tab.value} value={tab.value}>
                {tab.label}
              </Tabs.Tab>
            ))}
          </Tabs.List>

          <Tabs.Panel value="overview" pt="lg">
            <OverviewTab account={account} token={token} />
          </Tabs.Panel>

          <Tabs.Panel value="positions" pt="lg">
            <PositionsTab account={account} token={token} />
          </Tabs.Panel>

          <Tabs.Panel value="orders" pt="lg">
            <OrdersTab account={account} token={token} />
          </Tabs.Panel>

          <Tabs.Panel value="subscriptions" pt="lg">
            <SubscriptionsTab account={account} token={token} />
          </Tabs.Panel>

          <Tabs.Panel value="risk-health" pt="lg">
            <RiskHealthTab account={account} token={token} />
          </Tabs.Panel>

          <Tabs.Panel value="activity" pt="lg">
            <ActivityTab />
          </Tabs.Panel>
        </Tabs>
      )}
    </Stack>
  );
}
