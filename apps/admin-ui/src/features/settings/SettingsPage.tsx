import { useEffect, useMemo, useState } from "react";
import {
  Alert,
  Badge,
  Button,
  Card,
  Divider,
  Grid,
  Group,
  Loader,
  NumberInput,
  SimpleGrid,
  Stack,
  Switch,
  Text,
  ThemeIcon,
  Title,
  useMantineTheme,
} from "@mantine/core";
import { modals } from "@mantine/modals";
import { notifications } from "@mantine/notifications";
import { getAdminToken } from "../../lib/api";
import { ChangePasswordModal } from "../auth/ChangePasswordModal";
import { useConfig, useSystemStatus, useUpdateConfig } from "./hooks";
import type { RuntimeTradingConfig } from "../dashboard/types";

type RiskLimitKey =
  | "maxDailyEntryOrders"
  | "maxDailyEntryNotional"
  | "maxOpenPositions"
  | "maxTotalOpenNotional"
  | "maxSymbolOpenNotional"
  | "maxSubscriptionOpenNotional";

type RiskLimitForm = Pick<RuntimeTradingConfig, RiskLimitKey>;

const riskLimitDefinitions: {
  key: RiskLimitKey;
  label: string;
  badge: string;
  description: string;
  placeholder: string;
}[] = [
  {
    key: "maxDailyEntryOrders",
    label: "Max Daily Entry Orders",
    badge: "daily count",
    description:
      "Maximum number of buy-side entry orders the system may create in one UTC day. This helps prevent signal storms from opening too many trades.",
    placeholder: "Example: 5",
  },
  {
    key: "maxDailyEntryNotional",
    label: "Max Daily Entry Notional",
    badge: "daily dollars",
    description:
      "Maximum total dollar value of entry orders allowed in one UTC day. Existing open exposure is not counted here; this only limits today's new entries.",
    placeholder: "Example: 10000",
  },
  {
    key: "maxOpenPositions",
    label: "Max Open Positions",
    badge: "portfolio count",
    description:
      "Maximum number of active tracked positions allowed at the same time. This protects against the system spreading across too many tickers.",
    placeholder: "Example: 5",
  },
  {
    key: "maxTotalOpenNotional",
    label: "Max Total Open Notional",
    badge: "portfolio dollars",
    description:
      "Maximum projected total open exposure after a new entry. This is the broad portfolio-level exposure cap.",
    placeholder: "Example: 25000",
  },
  {
    key: "maxSymbolOpenNotional",
    label: "Max Symbol Open Notional",
    badge: "ticker dollars",
    description:
      "Maximum dollar exposure allowed for a single ticker. This prevents one symbol from becoming too large.",
    placeholder: "Example: 5000",
  },
  {
    key: "maxSubscriptionOpenNotional",
    label: "Max Subscription Open Notional",
    badge: "strategy dollars",
    description:
      "Maximum dollar exposure allowed for one subscription. This helps separate risk between strategy/ticker subscriptions.",
    placeholder: "Example: 5000",
  },
];

function configToRiskForm(config: RuntimeTradingConfig): RiskLimitForm {
  return {
    maxDailyEntryOrders: config.maxDailyEntryOrders,
    maxDailyEntryNotional: config.maxDailyEntryNotional,
    maxOpenPositions: config.maxOpenPositions,
    maxTotalOpenNotional: config.maxTotalOpenNotional,
    maxSymbolOpenNotional: config.maxSymbolOpenNotional,
    maxSubscriptionOpenNotional: config.maxSubscriptionOpenNotional,
  };
}

function normalizeNumberInput(value: string | number): number | null {
  if (value === "") return null;

  const parsed = typeof value === "number" ? value : Number(value);

  return Number.isFinite(parsed) ? parsed : null;
}

function formatLimit(value: number | null) {
  return value === null ? "No limit" : value.toLocaleString();
}

function riskLimitChanged(
  config: RuntimeTradingConfig,
  riskForm: RiskLimitForm,
  key: RiskLimitKey
) {
  return config[key] !== riskForm[key];
}

function hasRiskLimitChanges(
  config: RuntimeTradingConfig,
  riskForm: RiskLimitForm | null
) {
  if (!riskForm) return false;

  return riskLimitDefinitions.some((definition) =>
    riskLimitChanged(config, riskForm, definition.key)
  );
}

function formatDateTime(value: string | null | undefined) {
  if (!value) return "-";

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) return "-";

  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "2-digit",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  }).format(date);
}

function formatUptime(seconds: number) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }

  return `${minutes}m`;
}

function StatusBadge({
  ok,
  trueLabel = "OK",
  falseLabel = "Issue",
}: {
  ok: boolean;
  trueLabel?: string;
  falseLabel?: string;
}) {
  return (
    <Badge color={ok ? "teal" : "red"} variant="light">
      {ok ? trueLabel : falseLabel}
    </Badge>
  );
}

export function SettingsPage() {
  const theme = useMantineTheme();
  const [token] = useState<string | null>(() => getAdminToken());
  const [changePasswordOpen, setChangePasswordOpen] = useState(false);
  const [riskForm, setRiskForm] = useState<RiskLimitForm | null>(null);
  const systemStatusQuery = useSystemStatus(token);
  const systemStatus = systemStatusQuery.data;

  const { data: config, isLoading, isError } = useConfig(token);
  const updateMutation = useUpdateConfig(token);

  useEffect(() => {
    if (config) {
      setRiskForm(configToRiskForm(config));
    }
  }, [config]);

  const entryStatus = useMemo(() => {
    if (!config) return null;

    if (!config.tradingEnabled) {
      return {
        color: "red",
        label: "Trading disabled",
        message:
          "The global trading master switch is off. Treat this as the broadest shutdown state for order submission.",
      };
    }

    if (config.killSwitchEnabled) {
      return {
        color: "orange",
        label: "Entries paused",
        message:
          "Trading is enabled, but the kill switch is active. New entries are blocked while the system can remain online for monitoring and exit handling.",
      };
    }

    return {
      color: "teal",
      label: "Entries allowed",
      message:
        "Trading is enabled and the kill switch is off. Entry signals may pass through if they also satisfy security, subscription, broker, and exposure checks.",
    };
  }, [config]);

  const riskLimitsHaveChanges = config
    ? hasRiskLimitChanges(config, riskForm)
    : false;

  async function applyUpdate(payload: Partial<RuntimeTradingConfig>) {
    try {
      await updateMutation.mutateAsync(payload);
      notifications.show({ message: "Settings saved.", color: "teal" });
    } catch (err) {
      notifications.show({
        message: err instanceof Error ? err.message : "Failed to save settings.",
        color: "red",
      });
    }
  }

  function handleTradingToggle(enabled: boolean) {
    if (enabled) {
      modals.openConfirmModal({
        title: "Enable trading",
        children: (
          <Stack gap="xs">
            <Text size="sm">
              This turns on the global trading master switch.
            </Text>
            <Text size="sm">
              Entry signals may be accepted if the kill switch is off and all
              risk checks pass.
            </Text>
            <Text size="sm" c="dimmed">
              Use this only after subscriptions, exit profiles, securities, and
              risk limits are configured correctly.
            </Text>
          </Stack>
        ),
        labels: { confirm: "Enable trading", cancel: "Cancel" },
        confirmProps: { color: "teal" },
        onConfirm: () => applyUpdate({ tradingEnabled: true }),
      });
    } else {
      modals.openConfirmModal({
        title: "Disable trading",
        children: (
          <Stack gap="xs">
            <Text size="sm">
              This turns off the global trading master switch.
            </Text>
            <Text size="sm">
              Use this when you want the backend to reject new order submission
              broadly, regardless of the kill switch setting.
            </Text>
            <Text size="sm" c="dimmed">
              For a softer entry-only pause, leave Trading Enabled on and turn
              on the Kill Switch instead.
            </Text>
          </Stack>
        ),
        labels: { confirm: "Disable trading", cancel: "Cancel" },
        confirmProps: { color: "red" },
        onConfirm: () => applyUpdate({ tradingEnabled: false }),
      });
    }
  }

  function handleKillSwitchToggle(enabled: boolean) {
    if (enabled) {
      modals.openConfirmModal({
        title: "Activate kill switch",
        children: (
          <Stack gap="xs">
            <Text size="sm">
              This blocks new entry orders while keeping the system online.
            </Text>
            <Text size="sm">
              This is the preferred production pause when you want to stop new
              buys but still allow monitoring and exit workflows to continue.
            </Text>
          </Stack>
        ),
        labels: { confirm: "Activate kill switch", cancel: "Cancel" },
        confirmProps: { color: "orange" },
        onConfirm: () => applyUpdate({ killSwitchEnabled: true }),
      });
    } else {
      modals.openConfirmModal({
        title: "Deactivate kill switch",
        children: (
          <Stack gap="xs">
            <Text size="sm">
              New entry signals may be accepted again if Trading Enabled is on
              and all risk checks pass.
            </Text>
            <Text size="sm" c="dimmed">
              Daily order limits, exposure limits, security status,
              subscription status, broker mode, and broker trading-blocked
              checks still apply.
            </Text>
          </Stack>
        ),
        labels: { confirm: "Deactivate kill switch", cancel: "Cancel" },
        confirmProps: { color: "teal" },
        onConfirm: () => applyUpdate({ killSwitchEnabled: false }),
      });
    }
  }

  function handlePaperModeToggle(paperMode: boolean) {
    if (!paperMode) {
      modals.openConfirmModal({
        title: "Switch to live trading",
        children: (
          <Stack gap="xs">
            <Text size="sm">
              Live trading uses real money. Orders will be executed against your
              live Alpaca account.
            </Text>
            <Text size="sm" c="red">
              Only switch this after the backend environment variables and
              Alpaca account mode are confirmed.
            </Text>
          </Stack>
        ),
        labels: { confirm: "Switch to live", cancel: "Cancel" },
        confirmProps: { color: "red" },
        onConfirm: () => applyUpdate({ paperMode: false }),
      });
    } else {
      applyUpdate({ paperMode: true });
    }
  }

  async function handleSaveRiskLimits() {
    if (!riskForm) return;

    await applyUpdate(riskForm);
  }

  function handleResetRiskForm() {
    if (config) {
      setRiskForm(configToRiskForm(config));
    }
  }

  return (
    <Stack gap="lg">
      <Group justify="space-between" align="flex-start">
        <div>
          <Title order={2}>Settings</Title>
          <Text c="dimmed">
            Runtime trading configuration, risk controls, and admin account
            management.
          </Text>
        </div>

        {entryStatus && (
          <Badge color={entryStatus.color} size="lg" variant="light">
            {entryStatus.label}
          </Badge>
        )}
      </Group>

      {isError && (
        <Alert color="red" title="Failed to load settings">
          Check the backend connection and admin session.
        </Alert>
      )}

      {isLoading && (
        <Group>
          <Loader size="sm" />
          <Text>Loading settings…</Text>
        </Group>
      )}

      {config && (
        <>
          {entryStatus && (
            <Alert color={entryStatus.color} variant="light">
              {entryStatus.message}
            </Alert>
          )}


          <Card withBorder radius="md" p="lg">
            <Stack gap="md">
              <Group justify="space-between" align="flex-start">
                <div>
                  <Title order={3}>System Status</Title>
                  <Text c="dimmed" size="sm">
                    Production readiness snapshot for the app, database, broker mode,
                    workers, and trading entry state.
                  </Text>
                </div>

                <Group>
                  {systemStatus && (
                    <Badge
                      color={systemStatus.health.ok ? "teal" : "red"}
                      size="lg"
                      variant="light"
                    >
                      {systemStatus.health.ok ? "Healthy" : "Health Issue"}
                    </Badge>
                  )}

                  {systemStatus && (
                    <Badge
                      color={systemStatus.trading.risk.canEnter ? "teal" : "orange"}
                      size="lg"
                      variant="light"
                    >
                      {systemStatus.trading.risk.canEnter
                        ? "Entries Allowed"
                        : "Entries Blocked"}
                    </Badge>
                  )}

                  <Button
                    variant="default"
                    onClick={() => systemStatusQuery.refetch()}
                    loading={systemStatusQuery.isFetching}
                  >
                    Refresh
                  </Button>
                </Group>
              </Group>

              <Divider />

              {systemStatusQuery.isLoading && (
                <Group>
                  <Loader size="sm" />
                  <Text>Loading system status…</Text>
                </Group>
              )}

              {systemStatusQuery.isError && (
                <Alert color="red" title="Failed to load system status">
                  Check the backend connection and admin session.
                </Alert>
              )}

              {systemStatus && (
                <Stack gap="md">
                  {!systemStatus.trading.risk.canEnter &&
                    systemStatus.trading.risk.reasons.length > 0 && (
                      <Alert color="orange" title="Entries are currently blocked">
                        {systemStatus.trading.risk.reasons[0]}
                      </Alert>
                    )}

                  <SimpleGrid cols={{ base: 1, md: 2, xl: 4 }}>
                    <Card withBorder radius="md" p="md">
                      <Group justify="space-between">
                        <Text fw={600}>App / DB</Text>
                        <StatusBadge ok={systemStatus.health.ok} />
                      </Group>
                      <Text size="sm" c="dimmed" mt="xs">
                        Env: {systemStatus.environment.nodeEnv}
                      </Text>
                      <Text size="sm" c="dimmed">
                        Uptime: {formatUptime(systemStatus.health.uptimeSeconds)}
                      </Text>
                      <Text size="sm" c="dimmed">
                        Database:{" "}
                        {systemStatus.health.database.ok ? "reachable" : "unreachable"}
                      </Text>
                    </Card>

                    <Card withBorder radius="md" p="md">
                      <Group justify="space-between">
                        <Text fw={600}>Broker Mode</Text>
                        <Badge
                          color={
                            systemStatus.trading.risk.broker.mode ===
                            systemStatus.trading.risk.broker.expectedMode
                              ? "teal"
                              : "red"
                          }
                          variant="light"
                        >
                          {systemStatus.trading.risk.broker.mode}
                        </Badge>
                      </Group>
                      <Text size="sm" c="dimmed" mt="xs">
                        Expected: {systemStatus.trading.risk.broker.expectedMode}
                      </Text>
                      <Text size="sm" c="dimmed">
                        Trading blocked:{" "}
                        {systemStatus.trading.risk.broker.tradingBlocked ? "yes" : "no"}
                      </Text>
                    </Card>

                    <Card withBorder radius="md" p="md">
                      <Group justify="space-between">
                        <Text fw={600}>Workers</Text>
                        <StatusBadge
                          ok={
                            systemStatus.workers.pendingOrderCount === 0 &&
                            systemStatus.workers.submittingOrderCount === 0
                          }
                          trueLabel="Clear"
                          falseLabel="Pending"
                        />
                      </Group>
                      <Text size="sm" c="dimmed" mt="xs">
                        Pending: {systemStatus.workers.pendingOrderCount}
                      </Text>
                      <Text size="sm" c="dimmed">
                        Submitting: {systemStatus.workers.submittingOrderCount}
                      </Text>
                      <Text size="sm" c="dimmed">
                        Submitted: {systemStatus.workers.submittedOrderCount}
                      </Text>
                    </Card>

                    <Card withBorder radius="md" p="md">
                      <Group justify="space-between">
                        <Text fw={600}>Positions</Text>
                        <Badge color="blue" variant="light">
                          {systemStatus.workers.openTrackedPositionCount} open
                        </Badge>
                      </Group>
                      <Text size="sm" c="dimmed" mt="xs">
                        Closing: {systemStatus.workers.closingTrackedPositionCount}
                      </Text>
                      <Text size="sm" c="dimmed">
                        Unprocessed events:{" "}
                        {systemStatus.workers.unprocessedSystemEventCount}
                      </Text>
                    </Card>
                  </SimpleGrid>

                  <Grid>
                    <Grid.Col span={{ base: 12, md: 6 }}>
                      <Card withBorder radius="md" p="md">
                        <Title order={4}>Environment</Title>

                        <SimpleGrid cols={{ base: 1, sm: 2 }} mt="sm">
                          <Group justify="space-between">
                            <Text size="sm">DATABASE_URL</Text>
                            <StatusBadge ok={systemStatus.environment.hasDatabaseUrl} />
                          </Group>

                          <Group justify="space-between">
                            <Text size="sm">ALPACA_API_KEY</Text>
                            <StatusBadge ok={systemStatus.environment.hasAlpacaApiKey} />
                          </Group>

                          <Group justify="space-between">
                            <Text size="sm">ALPACA_SECRET_KEY</Text>
                            <StatusBadge
                              ok={systemStatus.environment.hasAlpacaSecretKey}
                            />
                          </Group>

                          <Group justify="space-between">
                            <Text size="sm">ALPACA_BASE_URL</Text>
                            <StatusBadge ok={systemStatus.environment.hasAlpacaBaseUrl} />
                          </Group>

                          <Group justify="space-between" py="sm">
                            <div>
                              <Text size="sm" fw={500}>Admin session token</Text>
                              <Text size="xs" c="dimmed">BEARER TOKEN</Text>
                            </div>
                            <StatusBadge ok={systemStatusQuery.isSuccess} />
                          </Group>

                          <Group justify="space-between">
                            <Text size="sm">SIGNAL_API_KEY</Text>
                            <StatusBadge ok={systemStatus.environment.hasSignalApiKey} />
                          </Group>

                          <Group justify="space-between">
                            <Text size="sm">CORS allowed origins</Text>
                            <StatusBadge ok={systemStatus.environment.hasCorsAllowedOrigins} />
                          </Group>

                        </SimpleGrid>
                      </Card>
                    </Grid.Col>


                    <Text size="xs" c="dimmed" mt="sm">
                      CORS origins:{" "}
                      {systemStatus.environment.corsAllowedOrigins.length > 0
                        ? systemStatus.environment.corsAllowedOrigins.join(", ")
                        : "-"}
                    </Text>


                    <Grid.Col span={{ base: 12, md: 6 }}>
                      <Card withBorder radius="md" p="md">
                        <Title order={4}>Audit Freshness</Title>

                        <Stack gap="xs" mt="sm">
                          <Group justify="space-between">
                            <Text size="sm">Latest account snapshot</Text>
                            <Text size="sm" c="dimmed">
                              {formatDateTime(
                                systemStatus.audit.latestAccountSnapshot?.createdAt
                              )}
                            </Text>
                          </Group>

                          <Group justify="space-between">
                            <Text size="sm">Snapshot reason</Text>
                            <Badge variant="light">
                              {systemStatus.audit.latestAccountSnapshot?.reason ?? "-"}
                            </Badge>
                          </Group>

                          <Group justify="space-between">
                            <Text size="sm">Latest broker activity</Text>
                            <Text size="sm" c="dimmed">
                              {formatDateTime(
                                systemStatus.audit.latestBrokerActivity?.transactionTime
                              )}
                            </Text>
                          </Group>

                          <Group justify="space-between">
                            <Text size="sm">Last broker event</Text>
                            <Text size="sm" c="dimmed">
                              {[
                                systemStatus.audit.latestBrokerActivity?.activityType,
                                systemStatus.audit.latestBrokerActivity?.side,
                                systemStatus.audit.latestBrokerActivity?.symbol,
                              ]
                                .filter(Boolean)
                                .join(" ") || "-"}
                            </Text>
                          </Group>
                        </Stack>
                      </Card>
                    </Grid.Col>
                  </Grid>

                  <Text size="xs" c="dimmed">
                    Last checked: {formatDateTime(systemStatus.timestamp)}
                  </Text>
                </Stack>
              )}
            </Stack>
          </Card>

          <Card withBorder radius="md" p="lg">
            <Stack gap="md">
              <Group justify="space-between" align="flex-start">
                <div>
                  <Group gap="xs">
                    <Title order={3}>Trading Controls</Title>
                    <ThemeIcon color="blue" variant="light" size="sm">
                      i
                    </ThemeIcon>
                  </Group>
                  <Text c="dimmed" size="sm">
                    These are the highest-level runtime controls. They affect
                    whether the backend accepts trading activity before the
                    detailed risk limits are even considered.
                  </Text>
                </div>
              </Group>

              <Divider />

              <Group justify="space-between" align="flex-start" wrap="nowrap">
                <div>
                  <Group gap="xs">
                    <Text fw={600}>Automated Trading</Text>
                    <Badge color={config.tradingEnabled ? "teal" : "red"}>
                      {config.tradingEnabled ? "On" : "Off"}
                    </Badge>
                  </Group>
                  <Text size="sm" c="dimmed" maw={720}>
                    Master switch for automated order submission. When this is off, the
                     backend rejects automated trading requests even if subscriptions, 
                    securities, strategies, and exit profiles are enabled. 
                    Use this when the trading system should not place orders.
                  </Text>
                </div>

                <Switch
                  checked={config.tradingEnabled}
                  onChange={(e) => handleTradingToggle(e.currentTarget.checked)}
                  disabled={updateMutation.isPending}
                  color="teal"
                  size="md"
                />
              </Group>

              <Divider />

              <Group justify="space-between" align="flex-start" wrap="nowrap">
                <div>
                  <Group gap="xs">
                    <Text fw={600}>Kill Switch - Block new entries</Text>
                    <Badge color={config.killSwitchEnabled ? "orange" : "teal"}>
                      {config.killSwitchEnabled ? "Entries Blocked" : "Off"}
                    </Badge>
                  </Group>
                  <Text size="sm" c="dimmed" maw={720}>
                    Entry-only safety pause. When this is on, the backend blocks new buy-side entries while allowing the system to stay online for monitoring, syncing, and position management. 
                    Use this when you want to stop opening new positions without shutting down the whole trading system.
                  </Text>
                </div>

                <Switch
                  checked={config.killSwitchEnabled}
                  onChange={(e) =>
                    handleKillSwitchToggle(e.currentTarget.checked)
                  }
                  disabled={updateMutation.isPending}
                  color="orange"
                  size="md"
                />
              </Group>

              <Divider />

              <Group justify="space-between" align="flex-start" wrap="nowrap">
                <div>
                  <Group gap="xs">
                    <Text fw={600}>Paper Trading Mode</Text>
                    <Badge color={config.paperMode ? "blue" : "red"}>
                      {config.paperMode ? "Paper" : "Live"}
                    </Badge>
                  </Group>
                  <Text size="sm" c="dimmed" maw={720}>
                    When enabled, runtime config expects the Alpaca paper
                    trading environment. Disable only when connected to a live
                    Alpaca account and ready to trade real funds.
                  </Text>
                  {!config.paperMode && (
                    <Text size="sm" c="red" fw={600} mt="xs">
                      Live trading is active — real money at risk.
                    </Text>
                  )}
                </div>

                <Switch
                  checked={config.paperMode}
                  onChange={(e) =>
                    handlePaperModeToggle(e.currentTarget.checked)
                  }
                  disabled={updateMutation.isPending}
                  color="yellow"
                  size="md"
                />
              </Group>
            </Stack>
          </Card>

          <Card withBorder radius="md" p="lg">
            <Stack gap="md">
              <Group justify="space-between" align="flex-start">
                <div>
                  <Title order={3}>Entry Risk Limits</Title>
                  <Text c="dimmed" size="sm">
                    These limits are checked only after trading is enabled and
                    the kill switch is off. Clearing a value removes that
                    specific limit.
                  </Text>
                </div>

                <Group>
                  <Button
                    variant="default"
                    onClick={handleResetRiskForm}
                    disabled={updateMutation.isPending || !riskLimitsHaveChanges}
                  >
                    Reset
                  </Button>
                  <Button
                    onClick={handleSaveRiskLimits}
                    loading={updateMutation.isPending}
                    disabled={!riskForm || !riskLimitsHaveChanges}
                  >
                    Save Risk Limits
                  </Button>
                </Group>
              </Group>

              <Divider />

              {riskForm && (
                <SimpleGrid cols={{ base: 1, md: 2 }}>
                  {riskLimitDefinitions.map((definition) => {
                    const changed = riskLimitChanged(config, riskForm, definition.key);

                    return (
                      <Card
                        key={definition.key}
                        withBorder
                        radius="md"
                        p="md"
                        style={{
                          borderColor: changed ? theme.colors.blue[6] : undefined,
                          boxShadow: changed
                            ? `0 0 0 1px ${theme.colors.blue[6]}`
                            : undefined,
                        }}
                      >
                        <Stack gap="xs">
                          <Group justify="space-between" align="flex-start">
                            <div>
                              <Group gap="xs">
                                <Text fw={600}>{definition.label}</Text>
                              </Group>

                              <Badge variant="light" color="gray">
                                {definition.badge}
                              </Badge>
                            </div>

                            <Stack gap={2} align="flex-end">
                              <Text size="sm" c="dimmed">
                                Current: {formatLimit(config[definition.key])}
                              </Text>

                              {changed && (
                                <Text size="sm" c="blue" fw={600}>
                                  New: {formatLimit(riskForm[definition.key])}
                                </Text>
                              )}
                            </Stack>
                          </Group>

                          <Text size="sm" c="dimmed">
                            {definition.description}
                          </Text>

                          <NumberInput
                            value={riskForm[definition.key] ?? ""}
                            onChange={(value) =>
                              setRiskForm((current) =>
                                current
                                  ? {
                                      ...current,
                                      [definition.key]: normalizeNumberInput(value),
                                    }
                                  : current
                              )
                            }
                            min={0}
                            placeholder={definition.placeholder}
                            disabled={updateMutation.isPending}
                            thousandSeparator=","
                          />
                        </Stack>
                      </Card>
                    );
                  })}
                </SimpleGrid>
              )}
            </Stack>
          </Card>
        </>
      )}

      <Card withBorder radius="md" p="lg">
        <Stack gap="md">
          <Title order={3}>Security</Title>

          <Group justify="space-between" align="flex-start">
            <div>
              <Text fw={600}>Admin Password</Text>
              <Text size="sm" c="dimmed">
                Change the password used to log in to this admin panel.
              </Text>
            </div>

            <Button variant="default" onClick={() => setChangePasswordOpen(true)}>
              Change Password
            </Button>
          </Group>
        </Stack>
      </Card>

      {token && (
        <ChangePasswordModal
          opened={changePasswordOpen}
          onClose={() => setChangePasswordOpen(false)}
          token={token}
        />
      )}
    </Stack>
  );
}