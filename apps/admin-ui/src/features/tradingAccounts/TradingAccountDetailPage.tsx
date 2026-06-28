import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import {
  Alert,
  Badge,
  Button,
  Card,
  Grid,
  Group,
  Loader,
  NumberInput,
  Select,
  SimpleGrid,
  Stack,
  Switch,
  Text,
  Textarea,
  TextInput,
  Title,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { Link, useNavigate, useParams } from "react-router-dom";
import { getAdminToken } from "../../lib/api";
import { useTradingAccount, useUpdateTradingAccount } from "./hooks";
import type {
  BrokerCredentialStatus,
  TradingAccount,
  TradingAccountEnvironment,
  TradingAccountStatus,
} from "./types";

type DetailItemProps = {
  label: string;
  value: ReactNode;
};

type AccountSettingsDraft = {
  displayName: string;
  estimatedTradingCapital: number | null;
  status: TradingAccountStatus;
  tradingEnabled: boolean;
  killSwitchEnabled: boolean;
  pausedReason: string;
  notes: string;
};

const tradingAccountStatusOptions: {
  value: TradingAccountStatus;
  label: string;
}[] = [
  { value: "ACTIVE", label: "Active" },
  { value: "PAUSED", label: "Paused" },
  { value: "NEEDS_CREDENTIALS", label: "Needs credentials" },
  { value: "ERROR", label: "Error" },
  { value: "ARCHIVED", label: "Archived" },
];

function accountToSettingsDraft(account: TradingAccount): AccountSettingsDraft {
  return {
    displayName: account.displayName,
    estimatedTradingCapital: account.estimatedTradingCapital,
    status: account.status,
    tradingEnabled: account.tradingEnabled,
    killSwitchEnabled: account.killSwitchEnabled,
    pausedReason: account.pausedReason ?? "",
    notes: account.notes ?? "",
  };
}

function normalizeOptionalText(value: string) {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeNumberInput(value: string | number) {
  if (value === "") return null;

  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function settingsDraftChanged(
  account: TradingAccount,
  draft: AccountSettingsDraft
) {
  return (
    account.displayName !== draft.displayName ||
    account.estimatedTradingCapital !== draft.estimatedTradingCapital ||
    account.status !== draft.status ||
    account.tradingEnabled !== draft.tradingEnabled ||
    account.killSwitchEnabled !== draft.killSwitchEnabled ||
    (account.pausedReason ?? "") !== draft.pausedReason ||
    (account.notes ?? "") !== draft.notes
  );
}

function formatDateTime(value: string | null | undefined) {
  if (!value) return "-";

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function formatMoney(value: number | null | undefined, currency = "USD") {
  if (value === null || value === undefined) return "-";

  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency,
    maximumFractionDigits: 2,
  }).format(value);
}

function formatStatus(value: string | null | undefined) {
  if (!value) return "-";
  return value.replace(/_/g, " ");
}

function accountStatusColor(status: TradingAccountStatus) {
  switch (status) {
    case "ACTIVE":
      return "teal";
    case "PAUSED":
      return "yellow";
    case "NEEDS_CREDENTIALS":
      return "orange";
    case "ERROR":
      return "red";
    case "ARCHIVED":
      return "gray";
    default:
      return "gray";
  }
}

function credentialStatusColor(status: BrokerCredentialStatus | null) {
  switch (status) {
    case "ACTIVE":
      return "teal";
    case "NEEDS_VERIFICATION":
      return "yellow";
    case "INVALID":
      return "red";
    case "REVOKED":
      return "gray";
    default:
      return "orange";
  }
}

function environmentColor(environment: TradingAccountEnvironment) {
  return environment === "LIVE" ? "red" : "blue";
}

function DetailItem({ label, value }: DetailItemProps) {
  return (
    <Stack gap={2}>
      <Text size="xs" c="dimmed" tt="uppercase">
        {label}
      </Text>
      <Text size="sm" fw={600}>
        {value ?? "-"}
      </Text>
    </Stack>
  );
}

function AccountSummaryCard({ account }: { account: TradingAccount }) {
  return (
    <Card withBorder radius="md" p="lg">
      <Stack gap="md">
        <Group justify="space-between" align="flex-start">
          <div>
            <Title order={3}>Account Summary</Title>
            <Text size="sm" c="dimmed">
              Broker identity and account-level safety posture.
            </Text>
          </div>
          <Group gap="xs">
            <Badge color={environmentColor(account.environment)} variant="light">
              {account.environment}
            </Badge>
            <Badge color={accountStatusColor(account.status)} variant="light">
              {formatStatus(account.status)}
            </Badge>
          </Group>
        </Group>

        {account.environment === "LIVE" && (
          <Alert color="red" title="Live account">
            Treat every credential and trading-control change for this account as
            broker-facing real-money risk.
          </Alert>
        )}

        <SimpleGrid cols={{ base: 1, sm: 2, lg: 4 }}>
          <DetailItem label="Display name" value={account.displayName} />
          <DetailItem label="Broker" value={account.broker} />
          <DetailItem label="Environment" value={account.environment} />
          <DetailItem label="Status" value={formatStatus(account.status)} />
          <DetailItem
            label="Trading enabled"
            value={
              <Badge color={account.tradingEnabled ? "teal" : "gray"}>
                {account.tradingEnabled ? "Enabled" : "Disabled"}
              </Badge>
            }
          />
          <DetailItem
            label="Kill switch"
            value={
              <Badge color={account.killSwitchEnabled ? "orange" : "teal"}>
                {account.killSwitchEnabled ? "Enabled" : "Off"}
              </Badge>
            }
          />
          <DetailItem
            label="Estimated capital"
            value={formatMoney(
              account.estimatedTradingCapital,
              account.baseCurrency
            )}
          />
          <DetailItem label="Base currency" value={account.baseCurrency} />
        </SimpleGrid>
      </Stack>
    </Card>
  );
}

function BrokerSnapshotCard({ account }: { account: TradingAccount }) {
  return (
    <Card withBorder radius="md" p="lg">
      <Stack gap="md">
        <div>
          <Title order={3}>Broker Account Snapshot</Title>
          <Text size="sm" c="dimmed">
            Latest metadata and balances synced from the broker.
          </Text>
        </div>

        <SimpleGrid cols={{ base: 1, sm: 2, lg: 4 }}>
          <DetailItem label="Broker account id" value={account.brokerAccountId} />
          <DetailItem
            label="Account number"
            value={account.brokerAccountNumberMasked}
          />
          <DetailItem
            label="Broker status"
            value={account.brokerAccountStatus}
          />
          <DetailItem
            label="Last broker sync"
            value={formatDateTime(account.lastBrokerSyncAt)}
          />
          <DetailItem
            label="Cash"
            value={formatMoney(account.lastCash, account.baseCurrency)}
          />
          <DetailItem
            label="Buying power"
            value={formatMoney(account.lastBuyingPower, account.baseCurrency)}
          />
          <DetailItem
            label="Equity"
            value={formatMoney(account.lastEquity, account.baseCurrency)}
          />
          <DetailItem
            label="Portfolio value"
            value={formatMoney(account.lastPortfolioValue, account.baseCurrency)}
          />
        </SimpleGrid>
      </Stack>
    </Card>
  );
}

function CredentialStatusCard({ account }: { account: TradingAccount }) {
  const credential = account.credential;

  return (
    <Card withBorder radius="md" p="lg">
      <Stack gap="md">
        <Group justify="space-between" align="flex-start">
          <div>
            <Title order={3}>Credential Status</Title>
            <Text size="sm" c="dimmed">
              Safe credential summary only. Secrets and ciphertext are never
              displayed.
            </Text>
          </div>
          <Badge color={credentialStatusColor(credential.status)} variant="light">
            {credential.exists ? formatStatus(credential.status) : "No credentials"}
          </Badge>
        </Group>

        <SimpleGrid cols={{ base: 1, sm: 2, lg: 4 }}>
          <DetailItem label="Exists" value={credential.exists ? "Yes" : "No"} />
          <DetailItem label="Status" value={formatStatus(credential.status)} />
          <DetailItem label="Auth type" value={credential.authType ?? "-"} />
          <DetailItem
            label="Key fingerprint"
            value={credential.keyFingerprint ?? "-"}
          />
          <DetailItem
            label="Verified at"
            value={formatDateTime(credential.verifiedAt)}
          />
          <DetailItem
            label="Last used"
            value={formatDateTime(credential.lastUsedAt)}
          />
          <DetailItem
            label="Last failed"
            value={formatDateTime(credential.lastFailedAt)}
          />
          <DetailItem
            label="Revoked at"
            value={formatDateTime(credential.revokedAt)}
          />
        </SimpleGrid>
      </Stack>
    </Card>
  );
}

function NotesCard({ account }: { account: TradingAccount }) {
  return (
    <Card withBorder radius="md" p="lg">
      <Stack gap="md">
        <div>
          <Title order={3}>Safety Notes</Title>
          <Text size="sm" c="dimmed">
            Current paused reason and admin notes.
          </Text>
        </div>
        <Grid>
          <Grid.Col span={{ base: 12, md: 6 }}>
            <DetailItem
              label="Paused reason"
              value={account.pausedReason || "-"}
            />
          </Grid.Col>
          <Grid.Col span={{ base: 12, md: 6 }}>
            <DetailItem label="Notes" value={account.notes || "-"} />
          </Grid.Col>
        </Grid>
      </Stack>
    </Card>
  );
}

function SafetySettingsCard({
  account,
  token,
}: {
  account: TradingAccount;
  token: string | null;
}) {
  const [draft, setDraft] = useState<AccountSettingsDraft>(() =>
    accountToSettingsDraft(account)
  );
  const updateMutation = useUpdateTradingAccount(token);
  const hasChanges = settingsDraftChanged(account, draft);
  const displayNameValid = draft.displayName.trim().length > 0;
  const capitalValid =
    draft.estimatedTradingCapital === null || draft.estimatedTradingCapital >= 0;

  useEffect(() => {
    setDraft(accountToSettingsDraft(account));
  }, [account]);

  function resetDraft() {
    setDraft(accountToSettingsDraft(account));
  }

  async function saveSettings() {
    if (!displayNameValid) {
      notifications.show({
        message: "Display name is required.",
        color: "red",
      });
      return;
    }

    if (!capitalValid) {
      notifications.show({
        message: "Estimated trading capital must be zero or greater.",
        color: "red",
      });
      return;
    }

    try {
      await updateMutation.mutateAsync({
        id: account.id,
        payload: {
          displayName: draft.displayName.trim(),
          estimatedTradingCapital: draft.estimatedTradingCapital,
          status: draft.status,
          tradingEnabled: draft.tradingEnabled,
          killSwitchEnabled: draft.killSwitchEnabled,
          pausedReason: normalizeOptionalText(draft.pausedReason),
          notes: normalizeOptionalText(draft.notes),
        },
      });

      notifications.show({
        message: "Trading account settings saved.",
        color: "teal",
      });
    } catch (error) {
      notifications.show({
        message:
          error instanceof Error
            ? error.message
            : "Failed to save trading account settings.",
        color: "red",
      });
    }
  }

  return (
    <Card withBorder radius="md" p="lg">
      <Stack gap="md">
        <Group justify="space-between" align="flex-start">
          <div>
            <Group gap="xs">
              <Title order={3}>Safety / Status Controls</Title>
              {hasChanges && (
                <Badge color="blue" variant="light">
                  Unsaved changes
                </Badge>
              )}
            </Group>
            <Text size="sm" c="dimmed">
              Save-gated account settings. Broker identity and broker metadata
              are read-only.
            </Text>
          </div>
          <Group>
            <Button
              variant="default"
              onClick={resetDraft}
              disabled={!hasChanges || updateMutation.isPending}
            >
              Reset
            </Button>
            <Button
              onClick={saveSettings}
              loading={updateMutation.isPending}
              disabled={!hasChanges || !displayNameValid || !capitalValid}
            >
              Save Settings
            </Button>
          </Group>
        </Group>

        {account.environment === "LIVE" && draft.tradingEnabled && (
          <Alert color="red" title="Live trading enablement">
            This would mark a live account as trading-enabled. Credential
            verification does not turn this on automatically.
          </Alert>
        )}

        <SimpleGrid cols={{ base: 1, md: 2 }}>
          <TextInput
            label="Display name"
            value={draft.displayName}
            onChange={(event) => {
              const value = event.currentTarget.value;

              setDraft((current) => ({
                ...current,
                displayName: value,
              }));
            }}
            error={displayNameValid ? undefined : "Display name is required."}
            disabled={updateMutation.isPending}
          />

          <NumberInput
            label="Estimated trading capital"
            value={draft.estimatedTradingCapital ?? ""}
            onChange={(value) =>
              setDraft((current) => ({
                ...current,
                estimatedTradingCapital: normalizeNumberInput(value),
              }))
            }
            min={0}
            thousandSeparator=","
            prefix="$"
            error={capitalValid ? undefined : "Must be zero or greater."}
            disabled={updateMutation.isPending}
          />

          <Select
            label="Status"
            data={tradingAccountStatusOptions}
            value={draft.status}
            onChange={(value) => {
              if (!value) return;

              setDraft((current) => ({
                ...current,
                status: value as TradingAccountStatus,
              }));
            }}
            disabled={updateMutation.isPending}
          />

          <Stack gap="sm">
            <Group justify="space-between" align="flex-start" wrap="nowrap">
              <div>
                <Text fw={600} size="sm">
                  Automated trading
                </Text>
                <Text size="sm" c="dimmed">
                  Account-level master switch for broker-facing automation.
                </Text>
              </div>
              <Switch
                checked={draft.tradingEnabled}
                onChange={(event) => {
                  const checked = event.currentTarget.checked;

                  setDraft((current) => ({
                    ...current,
                    tradingEnabled: checked,
                  }));
                }}
                disabled={updateMutation.isPending}
                color="teal"
              />
            </Group>

            <Group justify="space-between" align="flex-start" wrap="nowrap">
              <div>
                <Text fw={600} size="sm">
                  Kill switch
                </Text>
                <Text size="sm" c="dimmed">
                  Blocks new account-scoped broker access when enabled.
                </Text>
              </div>
              <Switch
                checked={draft.killSwitchEnabled}
                onChange={(event) => {
                  const checked = event.currentTarget.checked;

                  setDraft((current) => ({
                    ...current,
                    killSwitchEnabled: checked,
                  }));
                }}
                disabled={updateMutation.isPending}
                color="orange"
              />
            </Group>
          </Stack>

          <Textarea
            label="Paused reason"
            value={draft.pausedReason}
            onChange={(event) => {
              const value = event.currentTarget.value;

              setDraft((current) => ({
                ...current,
                pausedReason: value,
              }));
            }}
            autosize
            minRows={3}
            disabled={updateMutation.isPending}
          />

          <Textarea
            label="Notes"
            value={draft.notes}
            onChange={(event) => {
              const value = event.currentTarget.value;

              setDraft((current) => ({
                ...current,
                notes: value,
              }));
            }}
            autosize
            minRows={3}
            disabled={updateMutation.isPending}
          />
        </SimpleGrid>
      </Stack>
    </Card>
  );
}

export function TradingAccountDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [token] = useState<string | null>(() => getAdminToken());
  const accountId = id ? Number(id) : undefined;
  const validAccountId =
    accountId !== undefined && Number.isInteger(accountId) && accountId > 0
      ? accountId
      : undefined;
  const { data, isLoading, isError, error } = useTradingAccount(
    validAccountId,
    token
  );
  const account = data?.account;

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
      <Group justify="space-between" align="flex-start">
        <div>
          <Button
            component={Link}
            to="/trading-accounts"
            variant="subtle"
            size="xs"
            mb="xs"
          >
            Back to Trading Accounts
          </Button>
          <Title order={2} size="h3">
            {account?.displayName ?? "Trading Account"}
          </Title>
          <Text size="sm" c="dimmed">
            Account-scoped broker metadata, credential status, and safety
            controls.
          </Text>
        </div>
      </Group>

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
        <>
          <AccountSummaryCard account={account} />
          <BrokerSnapshotCard account={account} />
          <CredentialStatusCard account={account} />
          <SafetySettingsCard account={account} token={token} />
          <NotesCard account={account} />
        </>
      )}
    </Stack>
  );
}
