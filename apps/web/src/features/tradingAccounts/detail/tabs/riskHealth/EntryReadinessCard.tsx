import {
  Alert,
  Badge,
  Box,
  Button,
  Card,
  Group,
  Loader,
  SimpleGrid,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import { useTradingAccountRiskHealth } from "../../../hooks";
import type {
  TradingAccount,
  TradingAccountEnvironment,
  TradingAccountRiskHealth,
  TradingAccountRiskHealthCheck,
  TradingAccountRiskHealthStatus,
} from "../../../types";
import { DetailItem } from "../../components/DetailItem";
import {
  formatDateTime,
  formatMoney,
  formatStatus,
} from "../../utils/formatters";

function environmentColor(environment: TradingAccountEnvironment) {
  return environment === "LIVE" ? "red" : "blue";
}

function riskHealthStatusColor(status: TradingAccountRiskHealthStatus) {
  switch (status) {
    case "READY":
      return "teal";
    case "READY_WITH_WARNINGS":
      return "yellow";
    case "BLOCKED":
      return "red";
    default:
      return "gray";
  }
}

function riskHealthStatusLabel(status: TradingAccountRiskHealthStatus) {
  switch (status) {
    case "READY":
      return "Ready";
    case "READY_WITH_WARNINGS":
      return "Ready with warnings";
    case "BLOCKED":
      return "Blocked";
    default:
      return status;
  }
}

function formatSurplus(value: number | null | undefined, currency = "USD") {
  if (value === null || value === undefined) return "-";

  const formatted = formatMoney(Math.abs(value), currency);

  return value >= 0 ? `${formatted} surplus` : `${formatted} deficit`;
}

function HealthCheckList({
  title,
  checks,
  color,
}: {
  title: string;
  checks: TradingAccountRiskHealthCheck[];
  color: string;
}) {
  if (checks.length === 0) {
    return null;
  }

  return (
    <Stack gap="xs">
      <Group gap="xs">
        <Text size="sm" fw={700}>
          {title}
        </Text>
        <Badge color={color} variant="light">
          {checks.length}
        </Badge>
      </Group>
      <Stack gap={6}>
        {checks.map((check) => (
          <Box
            key={check.id}
            p="xs"
            style={{
              border: "1px solid var(--mantine-color-gray-3)",
              borderRadius: 8,
            }}
          >
            <Group justify="space-between" gap="xs" align="flex-start">
              <Text size="sm" fw={600}>
                {check.label}
              </Text>
              <Badge size="xs" color={color} variant="light">
                {check.status}
              </Badge>
            </Group>
            <Text size="sm" c="dimmed">
              {check.message}
            </Text>
          </Box>
        ))}
      </Stack>
    </Stack>
  );
}
export function EntryReadinessCard({
  account,
  token,
}: {
  account: TradingAccount;
  token: string | null;
}) {
  const { data, isLoading, isError, error, refetch, isFetching } =
    useTradingAccountRiskHealth(account.id, token);
  const riskHealth = data?.riskHealth;

  function metricItems(health: TradingAccountRiskHealth) {
    return [
      {
        label: "Broker portfolio value",
        value: formatMoney(
          health.capital.brokerPortfolioValue,
          account.baseCurrency
        ),
      },
      {
        label: "Open position notional",
        value: formatMoney(
          health.capital.openPositionNotional,
          account.baseCurrency
        ),
      },
      {
        label: "Pending entry notional",
        value: formatMoney(
          health.capital.pendingEntryNotional,
          account.baseCurrency
        ),
      },
      {
        label: "Current account exposure",
        value: formatMoney(
          health.capital.currentAccountExposure,
          account.baseCurrency
        ),
      },
      {
        label: "Remaining deployable capacity",
        value: formatSurplus(
          health.capital.remainingDeployableNotional,
          account.baseCurrency
        ),
      },
      {
        label: "Allocation budget total",
        value: formatMoney(
          health.capital.allocationBudgetTotal,
          account.baseCurrency
        ),
      },
      {
        label: "Active subscription budget",
        value: formatMoney(
          health.capital.activeSubscriptionBudgetTotal,
          account.baseCurrency
        ),
      },
      {
        label: "Max simultaneous exposure",
        value: formatMoney(
          health.capital.maxSimultaneousAllocationExposure,
          account.baseCurrency
        ),
      },
      {
        label: "Allocation budget surplus",
        value: formatSurplus(
          health.capital.allocationBudgetSurplus,
          account.baseCurrency
        ),
      },
      {
        label: "Active subscription surplus",
        value: formatSurplus(
          health.capital.activeSubscriptionBudgetSurplus,
          account.baseCurrency
        ),
      },
      {
        label: "Max exposure surplus",
        value: formatSurplus(
          health.capital.maxSimultaneousExposureSurplus,
          account.baseCurrency
        ),
      },
    ];
  }

  return (
    <Card withBorder radius="md" p="lg">
      <Stack gap="md">
        <Group justify="space-between" align="flex-start">
          <div>
            <Title order={3}>Entry Readiness</Title>
            <Text size="sm" c="dimmed">
              Read-only ownership, configuration, and projected exposure
              diagnostics. Pending entries consume capital and position capacity.
            </Text>
          </div>
          <Group gap="xs">
            {riskHealth && (
              <>
                <Badge
                  color={riskHealthStatusColor(riskHealth.status)}
                  variant="light"
                >
                  {riskHealthStatusLabel(riskHealth.status)}
                </Badge>
                <Badge color={environmentColor(riskHealth.profile)} variant="light">
                  {riskHealth.profile}
                </Badge>
              </>
            )}
            <Button
              size="xs"
              variant="default"
              onClick={() => void refetch()}
              loading={isFetching && !isLoading}
            >
              Refresh
            </Button>
          </Group>
        </Group>

        {isLoading && (
          <Group gap="sm">
            <Loader size="sm" color="cyan" />
            <Text size="sm" c="dimmed">
              Loading entry readiness...
            </Text>
          </Group>
        )}

        {isError && (
          <Alert color="red" title="Failed to load entry readiness">
            {error instanceof Error ? error.message : "Unknown error."}
          </Alert>
        )}

        {!isLoading && !isError && !riskHealth && (
          <Alert color="yellow">Entry readiness is unavailable.</Alert>
        )}

        {riskHealth && (
          <>
            <SimpleGrid cols={{ base: 1, sm: 2, lg: 4 }}>
              <DetailItem
                label="Status"
                value={
                  <Badge color={riskHealthStatusColor(riskHealth.status)}>
                    {riskHealthStatusLabel(riskHealth.status)}
                  </Badge>
                }
              />
              <DetailItem
                label="Ready for entries"
                value={
                  <Badge color={riskHealth.readyForEntries ? "teal" : "red"}>
                    {riskHealth.readyForEntries ? "Yes" : "No"}
                  </Badge>
                }
              />
              <DetailItem label="Profile" value={riskHealth.profile} />
              <DetailItem
                label="Generated"
                value={formatDateTime(riskHealth.generatedAt)}
              />
              <DetailItem
                label="Broker sync"
                value={formatDateTime(riskHealth.capital.brokerPortfolioValueAt)}
              />
              <DetailItem
                label="Broker cash"
                value={formatMoney(
                  riskHealth.capital.brokerCash,
                  account.baseCurrency
                )}
              />
              <DetailItem
                label="Broker buying power"
                value={formatMoney(
                  riskHealth.capital.brokerBuyingPower,
                  account.baseCurrency
                )}
              />
              <DetailItem
                label="Capital source"
                value={formatStatus(riskHealth.capital.capitalSource)}
              />
            </SimpleGrid>

            {riskHealth.effectiveEntryLimits.usingLegacyGlobalFallback && (
              <Alert color="yellow" title="Routine limits use legacy fallback">
                Configure all four routine fields in Account Risk Controls to
                remove global fallback ownership for this account.
              </Alert>
            )}

            <SimpleGrid cols={{ base: 1, sm: 2, lg: 4 }}>
              {metricItems(riskHealth).map((item) => (
                <DetailItem
                  key={item.label}
                  label={item.label}
                  value={item.value}
                />
              ))}
            </SimpleGrid>

            <SimpleGrid cols={{ base: 1, lg: 3 }}>
              <HealthCheckList
                title="Blockers"
                checks={riskHealth.blockers}
                color="red"
              />
              <HealthCheckList
                title="Warnings"
                checks={riskHealth.warnings}
                color="yellow"
              />
              <HealthCheckList
                title="Info"
                checks={riskHealth.info.slice(0, 6)}
                color="blue"
              />
            </SimpleGrid>
          </>
        )}
      </Stack>
    </Card>
  );
}
