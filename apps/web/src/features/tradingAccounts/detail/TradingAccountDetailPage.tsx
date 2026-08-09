import { useState } from "react";
import {
  Alert,
  Button,
  Card,
  Group,
  Loader,
  Select,
  Stack,
  Tabs,
  Text,
} from "@mantine/core";
import { useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { createScopedNavigationTarget } from "../../../app/navigationUtils";
import { getAdminToken } from "../../../lib/api";
import { useTradingAccount } from "../hooks";
import { AccountDetailHeader } from "./components/AccountDetailHeader";
import { ActivityTab } from "./tabs/activity/ActivityTab";
import { OverviewTab } from "./tabs/overview/OverviewTab";
import { OrdersTab } from "./tabs/orders/OrdersTab";
import { PositionsTab } from "./tabs/positions/PositionsTab";
import { RiskHealthTab } from "./tabs/riskHealth/RiskHealthTab";
import { SubscriptionsTab } from "./tabs/subscriptions/SubscriptionsTab";
import { ReadinessTab } from "./tabs/readiness/ReadinessTab";
import { ConfigurationTab } from "./tabs/configuration/ConfigurationTab";
import type { TradingAccountDetailTab } from "./types";
import {
  isTradingAccountDetailTab,
  resolveTradingAccountDetailTab,
  tradingAccountDetailTabs,
  updateTradingAccountDetailTabSearchParams,
} from "./utils/tabRouting";
import classes from "./TradingAccountDetailPage.module.css";

export function TradingAccountDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const location = useLocation();
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
        <Button variant="subtle" onClick={() => navigate(createScopedNavigationTarget("/trading-accounts", location.search))}>
          Back to Trading Accounts
        </Button>
        <Alert color="red">Invalid trading account id.</Alert>
      </Stack>
    );
  }

  return (
    <main className={classes.page}><Stack gap="lg">
      <AccountDetailHeader account={account} backTo={createScopedNavigationTarget("/trading-accounts", location.search)} />

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
          <Select className={classes.sectionSelect} label="Account section" aria-label="Account section" value={activeTab} onChange={setActiveTab} data={tradingAccountDetailTabs} allowDeselect={false} />
          <Tabs.List className={classes.tabs} aria-label="Account sections">
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

          <Tabs.Panel value="readiness" pt="lg">
            <ReadinessTab account={account} token={token} />
          </Tabs.Panel>

          <Tabs.Panel value="activity" pt="lg">
            <ActivityTab />
          </Tabs.Panel>

          <Tabs.Panel value="configuration" pt="lg">
            <ConfigurationTab account={account} token={token} />
          </Tabs.Panel>
        </Tabs>
      )}
    </Stack></main>
  );
}
