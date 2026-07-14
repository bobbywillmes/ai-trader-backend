import { useState } from "react";
import {
  Alert,
  Badge,
  Button,
  Card,
  Grid,
  Group,
  Loader,
  NumberInput,
  PasswordInput,
  Select,
  SimpleGrid,
  Stack,
  Switch,
  Tabs,
  Text,
  Textarea,
  TextInput,
  Title,
} from "@mantine/core";
import { modals } from "@mantine/modals";
import { notifications } from "@mantine/notifications";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { getAdminToken } from "../../../lib/api";
import {
  useRevokeTradingAccountCredential,
  useTradingAccount,
  useUpdateTradingAccount,
  useUpsertTradingAccountCredential,
  useVerifyTradingAccountCredential,
} from "../hooks";
import type {
  BrokerCredentialStatus,
  TradingAccount,
  TradingAccountEnvironment,
  TradingAccountStatus,
} from "../types";
import { AccountDetailHeader } from "./components/AccountDetailHeader";
import { DetailItem } from "./components/DetailItem";
import { ActivityTab } from "./tabs/activity/ActivityTab";
import { OrdersTab } from "./tabs/orders/OrdersTab";
import { PositionsTab } from "./tabs/positions/PositionsTab";
import { RiskHealthTab } from "./tabs/riskHealth/RiskHealthTab";
import { AllocationManagementCard } from "./tabs/subscriptions/AllocationManagementCard";
import { SubscriptionsTab } from "./tabs/subscriptions/SubscriptionsTab";
import type { TradingAccountDetailTab } from "./types";
import {
  isTradingAccountDetailTab,
  tradingAccountDetailTabs,
} from "./utils/tabRouting";
import {
  formatDateTime,
  formatMoney,
  formatStatus,
} from "./utils/formatters";
import { actionableErrorMessage } from "./utils/errors";

type AccountSettingsDraft = {
  displayName: string;
  estimatedTradingCapital: number | null;
  maxDeployableNotional: number | null;
  status: TradingAccountStatus;
  tradingEnabled: boolean;
  killSwitchEnabled: boolean;
  pausedReason: string;
  notes: string;
};

type CredentialDraft = {
  apiKey: string;
  apiSecret: string;
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
    maxDeployableNotional: account.maxDeployableNotional,
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
    account.maxDeployableNotional !== draft.maxDeployableNotional ||
    account.status !== draft.status ||
    account.tradingEnabled !== draft.tradingEnabled ||
    account.killSwitchEnabled !== draft.killSwitchEnabled ||
    (account.pausedReason ?? "") !== draft.pausedReason ||
    (account.notes ?? "") !== draft.notes
  );
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
          <DetailItem
            label="Open position notional"
            value={formatMoney(
              account.totalOpenPositionNotional,
              account.baseCurrency
            )}
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



function SizingAndAllocationsSection({
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
  const deployableCapitalValid =
    draft.maxDeployableNotional !== null
      ? draft.maxDeployableNotional > 0
      : account.enabledAllocatedNotional === 0;

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
    if (!deployableCapitalValid) {
      notifications.show({
        message: "Max deployable notional must be empty or greater than zero.",
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
          maxDeployableNotional: draft.maxDeployableNotional,
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
        message: actionableErrorMessage(
          error,
          "Failed to save trading account settings."
        ),
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
              disabled={
                !hasChanges ||
                !displayNameValid ||
                !capitalValid ||
                !deployableCapitalValid
              }
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

          <NumberInput
            label="Max deployable notional"
            description="Authoritative ceiling for enabled allocation budgets."
            value={draft.maxDeployableNotional ?? ""}
            onChange={(value) =>
              setDraft((current) => ({
                ...current,
                maxDeployableNotional: normalizeNumberInput(value),
              }))
            }
            min={0}
            thousandSeparator=","
            prefix="$"
            error={deployableCapitalValid ? undefined : "Must be greater than zero."}
            disabled={updateMutation.isPending}
          />

          <Alert
            color={
              account.remainingDeployableNotional !== null &&
              account.remainingDeployableNotional < 0
                ? "red"
                : "blue"
            }
            title="Allocation capacity"
          >
            Enabled allocation budgets: {formatMoney(
              account.enabledAllocatedNotional,
              account.baseCurrency
            )}. Remaining deployable capacity: {formatMoney(
              account.remainingDeployableNotional,
              account.baseCurrency
            )}.
          </Alert>

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

function CredentialManagementCard({
  account,
  token,
}: {
  account: TradingAccount;
  token: string | null;
}) {
  const [draft, setDraft] = useState<CredentialDraft>({
    apiKey: "",
    apiSecret: "",
  });
  const upsertMutation = useUpsertTradingAccountCredential(token);
  const verifyMutation = useVerifyTradingAccountCredential(token);
  const revokeMutation = useRevokeTradingAccountCredential(token);
  const hasCredentialDraft =
    draft.apiKey.trim().length > 0 || draft.apiSecret.trim().length > 0;
  const canSaveCredential =
    draft.apiKey.trim().length > 0 && draft.apiSecret.trim().length > 0;
  const credentialBusy =
    upsertMutation.isPending ||
    verifyMutation.isPending ||
    revokeMutation.isPending;

  async function saveCredentials() {
    if (!canSaveCredential) {
      notifications.show({
        message: "API key and API secret are both required.",
        color: "red",
      });
      return;
    }

    try {
      await upsertMutation.mutateAsync({
        id: account.id,
        payload: {
          authType: "API_KEY",
          apiKey: draft.apiKey.trim(),
          apiSecret: draft.apiSecret.trim(),
        },
      });

      setDraft({ apiKey: "", apiSecret: "" });
      notifications.show({
        message:
          "Credentials saved. Verify them before account-scoped broker access can use them.",
        color: "teal",
      });
    } catch (error) {
      notifications.show({
        message:
          error instanceof Error ? error.message : "Failed to save credentials.",
        color: "red",
      });
    }
  }

  async function verifyCredentials() {
    try {
      await verifyMutation.mutateAsync(account.id);
      notifications.show({
        message:
          "Credentials verified. Trading remains controlled by the account safety settings.",
        color: "teal",
      });
    } catch (error) {
      notifications.show({
        message:
          error instanceof Error
            ? error.message
            : "Failed to verify credentials.",
        color: "red",
      });
    }
  }

  function confirmRevokeCredentials() {
    modals.openConfirmModal({
      title: "Revoke broker credentials",
      children: (
        <Stack gap="sm">
          <Text size="sm">
            Revoke broker credentials for <strong>{account.displayName}</strong>?
          </Text>
          <Text size="sm" c="dimmed">
            This marks the credential revoked, disables trading, enables the kill
            switch, and requires new credentials before account-scoped broker
            access can work.
          </Text>
        </Stack>
      ),
      labels: { confirm: "Revoke credentials", cancel: "Keep credentials" },
      confirmProps: { color: "red" },
      onConfirm: async () => {
        try {
          await revokeMutation.mutateAsync(account.id);
          setDraft({ apiKey: "", apiSecret: "" });
          notifications.show({
            message:
              "Credentials revoked. Trading was disabled and the kill switch was enabled.",
            color: "teal",
          });
        } catch (error) {
          notifications.show({
            message:
              error instanceof Error
                ? error.message
                : "Failed to revoke credentials.",
            color: "red",
          });
        }
      },
    });
  }

  return (
    <Card withBorder radius="md" p="lg">
      <Stack gap="md">
        <Group justify="space-between" align="flex-start">
          <div>
            <Title order={3}>Credential Management</Title>
            <Text size="sm" c="dimmed">
              Existing credentials cannot be viewed after saving. Enter new
              values only when replacing credentials.
            </Text>
          </div>
          <Badge
            color={credentialStatusColor(account.credential.status)}
            variant="light"
          >
            {account.credential.exists
              ? formatStatus(account.credential.status)
              : "No credentials"}
          </Badge>
        </Group>

        <Alert color="blue" title="Credential safety">
          API key and secret values are submitted only to the backend credential
          endpoint. They are cleared from this form after a successful save and
          are never prefilled.
        </Alert>

        {account.environment === "LIVE" && (
          <Alert color="red" title="Live credential risk">
            Live account credentials can access real funds. Verification does
            not enable trading automatically.
          </Alert>
        )}

        <SimpleGrid cols={{ base: 1, md: 2 }}>
          <PasswordInput
            label="API key"
            value={draft.apiKey}
            onChange={(event) => {
              const value = event.currentTarget.value;

              setDraft((current) => ({
                ...current,
                apiKey: value,
              }));
            }}
            disabled={credentialBusy}
            autoComplete="off"
          />

          <PasswordInput
            label="API secret"
            value={draft.apiSecret}
            onChange={(event) => {
              const value = event.currentTarget.value;

              setDraft((current) => ({
                ...current,
                apiSecret: value,
              }));
            }}
            disabled={credentialBusy}
            autoComplete="off"
          />
        </SimpleGrid>

        <Group justify="space-between" align="flex-start">
          <Text size="sm" c="dimmed">
            Verification refreshes broker metadata and credential status, but it
            does not turn on trading or turn off the kill switch.
          </Text>
          <Group>
            <Button
              variant="default"
              onClick={() => setDraft({ apiKey: "", apiSecret: "" })}
              disabled={!hasCredentialDraft || credentialBusy}
            >
              Clear
            </Button>
            <Button
              onClick={saveCredentials}
              loading={upsertMutation.isPending}
              disabled={!canSaveCredential || credentialBusy}
            >
              Save Credentials
            </Button>
            <Button
              variant="light"
              onClick={verifyCredentials}
              loading={verifyMutation.isPending}
              disabled={!account.credential.exists || credentialBusy}
            >
              Verify
            </Button>
            <Button
              color="red"
              variant="light"
              onClick={confirmRevokeCredentials}
              loading={revokeMutation.isPending}
              disabled={!account.credential.exists || credentialBusy}
            >
              Revoke
            </Button>
          </Group>
        </Group>
      </Stack>
    </Card>
  );
}

export function TradingAccountDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [token] = useState<string | null>(() => getAdminToken());
  const accountId = id ? Number(id) : undefined;
  const requestedTab = searchParams.get("tab");
  const activeTab: TradingAccountDetailTab =
    isTradingAccountDetailTab(requestedTab) ? requestedTab : "overview";
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

    setSearchParams((current) => {
      const next = new URLSearchParams(current);

      if (value === "overview") {
        next.delete("tab");
      } else {
        next.set("tab", value);
      }

      return next;
    });
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
            <Stack gap="lg">
              <AccountSummaryCard account={account} />
              <BrokerSnapshotCard account={account} />
              <CredentialStatusCard account={account} />
              <SafetySettingsCard
                key={`settings-${account.id}-${account.updatedAt}`}
                account={account}
                token={token}
              />
              <SizingAndAllocationsSection account={account} token={token} />
              <CredentialManagementCard account={account} token={token} />
              <NotesCard account={account} />
            </Stack>
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
