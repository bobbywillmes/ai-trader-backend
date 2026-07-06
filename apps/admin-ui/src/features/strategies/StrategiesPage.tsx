import { useMemo, useState } from "react";
import {
  Alert,
  Badge,
  Card,
  Group,
  Loader,
  ScrollArea,
  Select,
  SimpleGrid,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { getAdminToken } from "../../lib/api";
import { useSubscriptions } from "../subscriptions/hooks";
import type { Subscription } from "../subscriptions/types";
import { useStrategies } from "./hooks";
import type { Strategy } from "./types";

type StrategyRow = {
  strategy: Strategy;
  subscriptions: Subscription[];
  symbols: string[];
  exitProfiles: string[];
  tradingAccountIds: number[];
};

type StatusFilter = "all" | "enabled" | "disabled";

function getAllowedSymbols(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((symbol): symbol is string => typeof symbol === "string")
    .map((symbol) => symbol.trim().toUpperCase())
    .filter(Boolean);
}

function uniqueSorted(values: Array<string | null | undefined>) {
  return Array.from(
    new Set(values.filter((value): value is string => Boolean(value)))
  ).sort((a, b) => a.localeCompare(b));
}

function formatList(values: string[], emptyLabel = "-") {
  if (values.length === 0) {
    return <Text c="dimmed">{emptyLabel}</Text>;
  }

  const visible = values.slice(0, 4);
  const hiddenCount = values.length - visible.length;

  return (
    <Group gap={4}>
      {visible.map((value) => (
        <Badge key={value} size="sm" variant="light" color="gray">
          {value}
        </Badge>
      ))}
      {hiddenCount > 0 && (
        <Text size="xs" c="dimmed">
          +{hiddenCount}
        </Text>
      )}
    </Group>
  );
}

function formatDateTime(value: string | null | undefined) {
  if (!value) {
    return "-";
  }

  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function SummaryCard({
  label,
  value,
  detail,
}: {
  label: string;
  value: string | number;
  detail: string;
}) {
  return (
    <Card withBorder radius="md" p="md">
      <Text size="xs" c="dimmed" tt="uppercase" fw={700}>
        {label}
      </Text>
      <Text size="xl" fw={700} mt={4}>
        {typeof value === "number" ? value.toLocaleString() : value}
      </Text>
      <Text size="xs" c="dimmed" mt={2}>
        {detail}
      </Text>
    </Card>
  );
}

export function StrategiesPage() {
  const [token] = useState<string | null>(() => getAdminToken());
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const {
    data: strategies = [],
    isLoading: isLoadingStrategies,
    isError: isStrategiesError,
    error: strategiesError,
  } = useStrategies(token);
  const {
    data: subscriptions = [],
    isLoading: isLoadingSubscriptions,
    isError: isSubscriptionsError,
    error: subscriptionsError,
  } = useSubscriptions(token);

  const rows = useMemo<StrategyRow[]>(() => {
    return strategies.map((strategy) => {
      const strategySubscriptions = subscriptions.filter((subscription) => {
        return (
          subscription.strategyId === strategy.id ||
          subscription.strategy?.id === strategy.id ||
          subscription.strategy?.key === strategy.key
        );
      });

      const symbols = uniqueSorted([
        ...strategySubscriptions.map((subscription) => subscription.symbol),
        ...getAllowedSymbols(strategy.allowedSymbolsJson),
      ]);
      const exitProfiles = uniqueSorted(
        strategySubscriptions.map((subscription) => {
          return (
            subscription.exitProfile?.name ??
            subscription.exitProfile?.key ??
            (subscription.exitProfileId
              ? `Exit profile ${subscription.exitProfileId}`
              : null)
          );
        })
      );
      const tradingAccountIds = Array.from(
        new Set(
          strategySubscriptions
            .map((subscription) => subscription.tradingAccountId)
            .filter((id): id is number => typeof id === "number")
        )
      ).sort((a, b) => a - b);

      return {
        strategy,
        subscriptions: strategySubscriptions,
        symbols,
        exitProfiles,
        tradingAccountIds,
      };
    });
  }, [strategies, subscriptions]);

  const summary = useMemo(() => {
    const activeSubscriptions = new Set<number>();
    const tradingAccountIds = new Set<number>();

    for (const row of rows) {
      for (const subscription of row.subscriptions) {
        if (subscription.enabled) {
          activeSubscriptions.add(subscription.id);
        }

        if (typeof subscription.tradingAccountId === "number") {
          tradingAccountIds.add(subscription.tradingAccountId);
        }
      }
    }

    return {
      totalStrategies: rows.length,
      enabledStrategies: rows.filter((row) => row.strategy.enabled).length,
      activeSubscriptions: activeSubscriptions.size,
      tradingAccounts: tradingAccountIds.size,
      hasTradingAccountData: tradingAccountIds.size > 0,
    };
  }, [rows]);

  const filteredRows = useMemo(() => {
    const normalizedSearch = search.trim().toLowerCase();

    return rows.filter((row) => {
      if (statusFilter === "enabled" && !row.strategy.enabled) {
        return false;
      }

      if (statusFilter === "disabled" && row.strategy.enabled) {
        return false;
      }

      if (!normalizedSearch) {
        return true;
      }

      const searchable = [
        row.strategy.name,
        row.strategy.key,
        row.strategy.description,
        ...row.symbols,
      ]
        .filter((value): value is string => Boolean(value))
        .join(" ")
        .toLowerCase();

      return searchable.includes(normalizedSearch);
    });
  }, [rows, search, statusFilter]);

  const isLoading = isLoadingStrategies || isLoadingSubscriptions;
  const isError = isStrategiesError || isSubscriptionsError;
  const error = strategiesError ?? subscriptionsError;

  return (
    <Stack gap="lg">
      <Group justify="space-between" align="flex-start">
        <div>
          <Title order={2} size="h3">Strategy Library</Title>
          <Text size="sm" c="dimmed">
            Review strategy definitions and where they are used.
          </Text>
        </div>
        <Badge color="cyan" variant="light">Read only</Badge>
      </Group>

      <SimpleGrid cols={{ base: 1, sm: 2, lg: summary.hasTradingAccountData ? 4 : 3 }} spacing="md">
        <SummaryCard
          label="Total strategies"
          value={summary.totalStrategies}
          detail="Configured strategy records"
        />
        <SummaryCard
          label="Enabled strategies"
          value={summary.enabledStrategies}
          detail="Available to linked subscriptions"
        />
        <SummaryCard
          label="Active subscriptions"
          value={summary.activeSubscriptions}
          detail="Enabled subscriptions using strategies"
        />
        {summary.hasTradingAccountData && (
          <SummaryCard
            label="Trading accounts"
            value={summary.tradingAccounts}
            detail="Accounts represented in loaded subscriptions"
          />
        )}
      </SimpleGrid>

      <Card withBorder radius="md" p="md">
        {isError && (
          <Alert color="red" mb="md">
            {error instanceof Error ? error.message : "Failed to load strategies."}
          </Alert>
        )}

        {isLoading && (
          <Group gap="sm">
            <Loader size="sm" color="cyan" />
            <Text size="sm" c="dimmed">Loading strategy library...</Text>
          </Group>
        )}

        {!isLoading && rows.length === 0 && (
          <Stack gap="xs">
            <Text fw={600}>No strategies found.</Text>
            <Text size="sm" c="dimmed">
              Strategies are currently configured through backend data and
              subscriptions. This page only displays real configured strategies.
            </Text>
          </Stack>
        )}

        {rows.length > 0 && (
          <Stack gap="md">
            <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
              <TextInput
                label="Search"
                placeholder="Strategy name, key, or symbol"
                value={search}
                onChange={(event) => setSearch(event.currentTarget.value)}
              />
              <Select
                label="Status"
                value={statusFilter}
                onChange={(value) => setStatusFilter((value ?? "all") as StatusFilter)}
                data={[
                  { value: "all", label: "All statuses" },
                  { value: "enabled", label: "Enabled" },
                  { value: "disabled", label: "Disabled" },
                ]}
              />
            </SimpleGrid>

            <Group justify="space-between" gap="sm">
              <Text size="sm" c="dimmed">
                Showing {filteredRows.length.toLocaleString()} of{" "}
                {rows.length.toLocaleString()} strategies
              </Text>
            </Group>

            {filteredRows.length === 0 ? (
              <Text size="sm" c="dimmed">
                No strategies match the current filters.
              </Text>
            ) : (
              <ScrollArea>
                <Table striped highlightOnHover style={{ minWidth: 920 }}>
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th>Strategy Name</Table.Th>
                      <Table.Th>Strategy Key</Table.Th>
                      <Table.Th>Status</Table.Th>
                      <Table.Th>Subscriptions</Table.Th>
                      <Table.Th>Symbols</Table.Th>
                      <Table.Th>Exit Profiles Used</Table.Th>
                      <Table.Th>Updated At</Table.Th>
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {filteredRows.map(({ strategy, subscriptions: strategySubscriptions, symbols, exitProfiles }) => (
                      <Table.Tr key={strategy.id}>
                        <Table.Td>
                          <Stack gap={2}>
                            <Text fw={600}>{strategy.name}</Text>
                            {strategy.description && (
                              <Text size="xs" c="dimmed" lineClamp={1}>
                                {strategy.description}
                              </Text>
                            )}
                          </Stack>
                        </Table.Td>
                        <Table.Td>
                          <Text size="sm" ff="monospace">{strategy.key}</Text>
                        </Table.Td>
                        <Table.Td>
                          <Badge
                            size="sm"
                            color={strategy.enabled ? "teal" : "gray"}
                            variant="light"
                          >
                            {strategy.enabled ? "Enabled" : "Disabled"}
                          </Badge>
                        </Table.Td>
                        <Table.Td>
                          <Text fw={600}>
                            {strategySubscriptions.length.toLocaleString()}
                          </Text>
                        </Table.Td>
                        <Table.Td>{formatList(symbols)}</Table.Td>
                        <Table.Td>{formatList(exitProfiles)}</Table.Td>
                        <Table.Td>
                          <Text size="sm">{formatDateTime(strategy.updatedAt)}</Text>
                        </Table.Td>
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
              </ScrollArea>
            )}
          </Stack>
        )}
      </Card>
    </Stack>
  );
}
