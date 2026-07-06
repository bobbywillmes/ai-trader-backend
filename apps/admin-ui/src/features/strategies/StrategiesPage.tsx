import { useMemo, useState } from "react";
import {
  Alert,
  Badge,
  Card,
  Group,
  Loader,
  ScrollArea,
  Stack,
  Table,
  Text,
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
};

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

export function StrategiesPage() {
  const [token] = useState<string | null>(() => getAdminToken());
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

      return {
        strategy,
        subscriptions: strategySubscriptions,
        symbols,
        exitProfiles,
      };
    });
  }, [strategies, subscriptions]);

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
                {rows.map(({ strategy, subscriptions: strategySubscriptions, symbols, exitProfiles }) => (
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
      </Card>
    </Stack>
  );
}
