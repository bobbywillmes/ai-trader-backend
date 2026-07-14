import type { ReactNode } from "react";
import {
  Alert,
  Box,
  Card,
  Group,
  Loader,
  SegmentedControl,
  SimpleGrid,
  Stack,
  Text,
} from "@mantine/core";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type {
  AccountSubscriptionMarketContextItem,
  AccountSubscriptionPriceHistoryRange,
  AccountSubscriptionPriceHistoryResponse,
} from "../../../types";
import { DetailItem } from "../../components/DetailItem";
import { formatMoney, formatQuantity } from "../../utils/formatters";
import type { AccountSubscriptionDraft } from "./types";
import {
  formatMarketDate,
  formatShareLabel,
  priceHistoryRangeOptions,
} from "./utils";

export function PreviewMetric({
  label,
  value,
}: {
  label: string;
  value: ReactNode;
}) {
  return (
    <Box>
      <Text size="xs" c="dimmed">
        {label}
      </Text>
      <Text size="sm" fw={600}>
        {value}
      </Text>
    </Box>
  );
}

export function MarketContextCell({
  context,
  currency,
  loading,
}: {
  context: AccountSubscriptionMarketContextItem | undefined;
  currency: string;
  loading: boolean;
}) {
  if (loading) {
    return (
      <Group gap="xs" wrap="nowrap">
        <Loader size="xs" color="cyan" />
        <Text size="xs" c="dimmed">
          Loading...
        </Text>
      </Group>
    );
  }

  if (!context) {
    return (
      <Text size="sm" c="dimmed">
        Price unavailable
      </Text>
    );
  }

  if (context.latestPrice === null) {
    return (
      <Stack gap={2}>
        <Text size="sm" c="dimmed">
          Price unavailable
        </Text>
        {context.warnings.slice(0, 1).map((warning) => (
          <Text key={warning} size="xs" c="orange">
            {warning}
          </Text>
        ))}
      </Stack>
    );
  }

  return (
    <Stack gap={2}>
      <Text size="sm" fw={600}>
        Latest: {formatMoney(context.latestPrice, currency)}
      </Text>
      <Text size="xs" c="dimmed">
        52W: {formatMoney(context.week52Low, currency)} -{" "}
        {formatMoney(context.week52High, currency)}
      </Text>
      {context.sizingType === "MAX_NOTIONAL" ? (
        <>
          <Text size="xs">
            Budget: {formatMoney(context.maxPositionNotional, currency)}{" "}
            {"->"}{" "}
            {formatShareLabel(context.estimatedQty)}
          </Text>
          {context.dollarsToNextShare !== null &&
            context.nextShareQty !== null &&
            context.dollarsToNextShare > 0 && (
              <Text size="xs" c="dimmed">
                +{formatMoney(context.dollarsToNextShare, currency)} to reach{" "}
                {formatShareLabel(context.nextShareQty)}
              </Text>
            )}
        </>
      ) : (
        <>
          <Text size="xs">
            Fixed qty: {formatQuantity(context.fixedQty)}
          </Text>
          <Text size="xs" c="dimmed">
            Estimated notional:{" "}
            {formatMoney(context.estimatedNotional, currency)}
          </Text>
        </>
      )}
      {context.latestPriceAt && (
        <Text size="xs" c="dimmed">
          As of {formatMarketDate(context.latestPriceAt)}
        </Text>
      )}
      {context.warnings.slice(0, 1).map((warning) => (
        <Text key={warning} size="xs" c="orange">
          {warning}
        </Text>
      ))}
    </Stack>
  );
}

function PriceHistoryTooltip({
  active,
  label,
  payload,
  currency,
}: {
  active?: boolean;
  label?: string | number;
  payload?: Array<{ value?: number | string | null }>;
  currency: string;
}) {
  if (!active || !payload?.length) {
    return null;
  }

  const value = payload[0]?.value;
  const close = value === null || value === undefined ? null : Number(value);

  return (
    <Box
      p="xs"
      style={{
        background: "#111827",
        border: "1px solid rgba(148, 163, 184, 0.28)",
        borderRadius: 8,
        boxShadow: "0 12px 30px rgba(0, 0, 0, 0.35)",
      }}
    >
      <Text size="xs" fw={700} c="gray.2">
        {label}
      </Text>
      <Text size="xs" c="gray.2">
        Close: {Number.isFinite(close) ? formatMoney(close, currency) : "-"}
      </Text>
    </Box>
  );
}

export function PriceHistoryChart({
  currency,
  data,
  isError,
  isLoading,
  range,
  onRangeChange,
}: {
  currency: string;
  data: AccountSubscriptionPriceHistoryResponse | undefined;
  isError: boolean;
  isLoading: boolean;
  range: AccountSubscriptionPriceHistoryRange;
  onRangeChange: (range: AccountSubscriptionPriceHistoryRange) => void;
}) {
  const candles = data?.candles ?? [];

  return (
    <Card withBorder radius="md" p="md">
      <Stack gap="md">
        <Group justify="space-between" align="flex-start">
          <div>
            <Text fw={700} size="sm">
              Price history
            </Text>
            <Text size="xs" c="dimmed">
              Daily close from backend market data.
            </Text>
          </div>
          <SegmentedControl
            size="xs"
            value={range}
            onChange={(value) =>
              onRangeChange(value as AccountSubscriptionPriceHistoryRange)
            }
            data={priceHistoryRangeOptions}
          />
        </Group>

        {isError && (
          <Alert color="yellow">Price history is unavailable.</Alert>
        )}

        {isLoading && (
          <Group gap="sm">
            <Loader size="sm" color="cyan" />
            <Text size="sm" c="dimmed">
              Loading price history...
            </Text>
          </Group>
        )}

        {!isLoading && !isError && candles.length === 0 && (
          <Alert color="gray">No daily candles are available.</Alert>
        )}

        {!isLoading && !isError && candles.length > 0 && (
          <>
            <SimpleGrid cols={{ base: 1, sm: 3 }}>
              <DetailItem
                label="Latest close"
                value={formatMoney(data?.summary.latestClose, currency)}
              />
              <DetailItem
                label="52-week high"
                value={formatMoney(data?.summary.week52High, currency)}
              />
              <DetailItem
                label="52-week low"
                value={formatMoney(data?.summary.week52Low, currency)}
              />
            </SimpleGrid>
            <Box h={220}>
              <ResponsiveContainer width="100%" height="100%">
                <LineChart
                  data={candles}
                  margin={{ top: 8, right: 8, bottom: 8, left: 0 }}
                >
                  <CartesianGrid stroke="rgba(148, 163, 184, 0.16)" />
                  <XAxis
                    dataKey="date"
                    tickFormatter={formatMarketDate}
                    minTickGap={28}
                    tickLine={false}
                    axisLine={false}
                  />
                  <YAxis
                    width={72}
                    tickFormatter={(value) =>
                      formatMoney(Number(value), currency)
                    }
                    tickLine={false}
                    axisLine={false}
                    domain={["dataMin", "dataMax"]}
                  />
                  <Tooltip
                    cursor={{ stroke: "rgba(203, 213, 225, 0.24)" }}
                    content={<PriceHistoryTooltip currency={currency} />}
                  />
                  <Line
                    type="monotone"
                    dataKey="close"
                    stroke="#0ea5e9"
                    strokeWidth={2}
                    dot={false}
                    isAnimationActive={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            </Box>
          </>
        )}
      </Stack>
    </Card>
  );
}

export function MarketContextPanel({
  context,
  currency,
  draft,
  loading,
}: {
  context: AccountSubscriptionMarketContextItem | undefined;
  currency: string;
  draft: AccountSubscriptionDraft;
  loading: boolean;
}) {
  const latestPrice = context?.latestPrice ?? null;
  const fixedQty = draft.sizingType === "FIXED_QTY" ? draft.fixedQty : null;
  const budget = draft.sizingType === "MAX_NOTIONAL"
    ? draft.maxPositionNotional
    : context?.maxPositionNotional ?? null;
  const estimatedQty =
    latestPrice === null
      ? null
      : draft.sizingType === "FIXED_QTY"
        ? fixedQty
        : budget === null || budget <= 0
          ? null
          : Math.floor(budget / latestPrice);
  const estimatedNotional =
    latestPrice !== null && estimatedQty !== null
      ? estimatedQty * latestPrice
      : null;
  const nextShareQty =
    latestPrice !== null &&
    draft.sizingType === "MAX_NOTIONAL" &&
    estimatedQty !== null
      ? estimatedQty + 1
      : null;
  const nextShareNotional =
    latestPrice !== null && nextShareQty !== null
      ? nextShareQty * latestPrice
      : null;
  const dollarsToNextShare =
    budget !== null && nextShareNotional !== null
      ? Math.max(0, nextShareNotional - budget)
      : null;

  return (
    <Card withBorder radius="md" p="md">
      <Stack gap="md">
        <div>
          <Text fw={700} size="sm">
            Market context
          </Text>
          <Text size="xs" c="dimmed">
            Runtime entry sizing uses this account-subscription configuration.
            MAX_NOTIONAL uses backend-owned latest market data to calculate a
            whole-share quantity.
          </Text>
        </div>

        {loading && (
          <Group gap="sm">
            <Loader size="sm" color="cyan" />
            <Text size="sm" c="dimmed">
              Loading market context...
            </Text>
          </Group>
        )}

        {!loading && !context && (
          <Alert color="gray">Price context is unavailable.</Alert>
        )}

        {!loading && context && (
          <>
            <SimpleGrid cols={{ base: 1, sm: 2 }}>
              <DetailItem
                label="Latest price"
                value={formatMoney(context.latestPrice, currency)}
              />
              <DetailItem
                label="Current budget"
                value={formatMoney(budget, currency)}
              />
              <DetailItem
                label="Estimated shares"
                value={formatShareLabel(estimatedQty)}
              />
              <DetailItem
                label="Estimated notional"
                value={formatMoney(estimatedNotional, currency)}
              />
              <DetailItem
                label="Next share requires"
                value={formatMoney(nextShareNotional, currency)}
              />
              <DetailItem
                label="Additional dollars needed"
                value={formatMoney(dollarsToNextShare, currency)}
              />
            </SimpleGrid>
            {context.warnings.length > 0 && (
              <Alert color="yellow">
                {context.warnings.slice(0, 2).join(" ")}
              </Alert>
            )}
          </>
        )}
      </Stack>
    </Card>
  );
}
