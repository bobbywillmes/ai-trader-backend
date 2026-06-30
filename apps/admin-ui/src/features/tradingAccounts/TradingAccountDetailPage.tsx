import { useState } from "react";
import type { ReactNode } from "react";
import {
  Alert,
  Badge,
  Button,
  Card,
  Grid,
  Group,
  Loader,
  Modal,
  NumberInput,
  PasswordInput,
  ScrollArea,
  Select,
  SimpleGrid,
  Stack,
  Switch,
  Table,
  Text,
  Textarea,
  TextInput,
  Title,
} from "@mantine/core";
import { modals } from "@mantine/modals";
import { notifications } from "@mantine/notifications";
import { Link, useNavigate, useParams } from "react-router-dom";
import { getAdminToken } from "../../lib/api";
import {
  useCreateTradingAccountAllocation,
  useRevokeTradingAccountCredential,
  useTradingAccount,
  useTradingAccountAllocations,
  useTradingAccountSubscriptions,
  useUpdateTradingAccount,
  useUpdateTradingAccountAllocation,
  useUpdateTradingAccountSubscription,
  useUpsertTradingAccountCredential,
  useVerifyTradingAccountCredential,
} from "./hooks";
import type {
  BrokerCredentialStatus,
  PositionSizingType,
  TradingAccount,
  TradingAccountAllocation,
  TradingAccountAllocationInput,
  TradingAccountEnvironment,
  TradingAccountSubscription,
  TradingAccountSubscriptionInput,
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

type CredentialDraft = {
  apiKey: string;
  apiSecret: string;
};

type AllocationDraft = {
  key: string;
  name: string;
  description: string;
  enabled: boolean;
  maxAllocatedNotional: number | null;
  maxOpenPositions: number | null;
  maxPositionNotional: number | null;
  notes: string;
};

type AllocationModalState =
  | {
      mode: "create";
      allocation: null;
      keyManuallyEdited: boolean;
      draft: AllocationDraft;
    }
  | {
      mode: "edit";
      allocation: TradingAccountAllocation;
      keyManuallyEdited: boolean;
      draft: AllocationDraft;
    };

type AccountSubscriptionDraft = {
  allocationId: number | null;
  enabled: boolean;
  entriesEnabled: boolean;
  exitsEnabled: boolean;
  sizingType: PositionSizingType;
  fixedQty: number | null;
  maxPositionNotional: number | null;
  minPositionNotional: number | null;
  maxQty: number | null;
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

const emptyAllocationDraft: AllocationDraft = {
  key: "",
  name: "",
  description: "",
  enabled: true,
  maxAllocatedNotional: null,
  maxOpenPositions: null,
  maxPositionNotional: null,
  notes: "",
};

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

function suggestAllocationKey(name: string) {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .slice(0, 80);
}

function allocationToDraft(
  allocation: TradingAccountAllocation
): AllocationDraft {
  return {
    key: allocation.key,
    name: allocation.name,
    description: allocation.description ?? "",
    enabled: allocation.enabled,
    maxAllocatedNotional: allocation.maxAllocatedNotional,
    maxOpenPositions: allocation.maxOpenPositions,
    maxPositionNotional: allocation.maxPositionNotional,
    notes: allocation.notes ?? "",
  };
}

function allocationDraftToPayload(
  draft: AllocationDraft
): TradingAccountAllocationInput {
  return {
    key: draft.key.trim().toLowerCase(),
    name: draft.name.trim(),
    description: normalizeOptionalText(draft.description),
    enabled: draft.enabled,
    maxAllocatedNotional: draft.maxAllocatedNotional,
    maxOpenPositions: draft.maxOpenPositions,
    maxPositionNotional: draft.maxPositionNotional,
    notes: normalizeOptionalText(draft.notes),
  };
}

function validateAllocationDraft(draft: AllocationDraft) {
  const key = draft.key.trim();
  const name = draft.name.trim();

  if (!name) return "Name is required.";
  if (!key) return "Key is required.";
  if (!/^[a-z0-9_-]+$/.test(key)) {
    return "Key may only contain lowercase letters, numbers, hyphens, and underscores.";
  }
  if (
    draft.maxAllocatedNotional !== null &&
    draft.maxAllocatedNotional <= 0
  ) {
    return "Max allocated dollars must be empty or greater than zero.";
  }
  if (
    draft.maxPositionNotional !== null &&
    draft.maxPositionNotional <= 0
  ) {
    return "Default max position dollars must be empty or greater than zero.";
  }
  if (
    draft.maxOpenPositions !== null &&
    (!Number.isInteger(draft.maxOpenPositions) || draft.maxOpenPositions <= 0)
  ) {
    return "Max open positions must be empty or a positive whole number.";
  }

  return null;
}

function accountSubscriptionToDraft(
  accountSubscription: TradingAccountSubscription
): AccountSubscriptionDraft {
  return {
    allocationId: accountSubscription.allocationId,
    enabled: accountSubscription.enabled,
    entriesEnabled: accountSubscription.entriesEnabled,
    exitsEnabled: accountSubscription.exitsEnabled,
    sizingType: accountSubscription.sizingType,
    fixedQty: accountSubscription.fixedQty,
    maxPositionNotional: accountSubscription.maxPositionNotional,
    minPositionNotional: accountSubscription.minPositionNotional,
    maxQty: accountSubscription.maxQty,
    notes: accountSubscription.notes ?? "",
  };
}

function accountSubscriptionDraftToPayload(
  draft: AccountSubscriptionDraft
): TradingAccountSubscriptionInput {
  return {
    allocationId: draft.allocationId,
    enabled: draft.enabled,
    entriesEnabled: draft.entriesEnabled,
    exitsEnabled: draft.exitsEnabled,
    sizingType: draft.sizingType,
    fixedQty: draft.sizingType === "FIXED_QTY" ? draft.fixedQty : null,
    maxPositionNotional:
      draft.sizingType === "MAX_NOTIONAL" ? draft.maxPositionNotional : null,
    minPositionNotional: draft.minPositionNotional,
    maxQty: draft.maxQty,
    notes: normalizeOptionalText(draft.notes),
  };
}

function validateAccountSubscriptionDraft(draft: AccountSubscriptionDraft) {
  if (draft.sizingType === "FIXED_QTY") {
    if (draft.fixedQty === null || draft.fixedQty <= 0) {
      return "Fixed quantity is required and must be greater than zero.";
    }
  }

  if (draft.sizingType === "MAX_NOTIONAL") {
    if (
      draft.maxPositionNotional === null ||
      draft.maxPositionNotional <= 0
    ) {
      return "Max position dollars is required and must be greater than zero.";
    }
  }

  if (
    draft.minPositionNotional !== null &&
    draft.minPositionNotional < 0
  ) {
    return "Min position dollars must be empty or zero or greater.";
  }

  if (draft.maxQty !== null && draft.maxQty <= 0) {
    return "Max quantity must be empty or greater than zero.";
  }

  return null;
}

function formatQuantity(value: number | null | undefined) {
  if (value === null || value === undefined) return "-";
  return value.toLocaleString();
}

function formatSizing(
  accountSubscription: TradingAccountSubscription,
  currency: string
) {
  if (accountSubscription.sizingType === "FIXED_QTY") {
    return `Fixed qty: ${formatQuantity(accountSubscription.fixedQty)}`;
  }

  return `Max position dollars: ${formatMoney(
    accountSubscription.maxPositionNotional,
    currency
  )}`;
}

function formatLimits(
  accountSubscription: TradingAccountSubscription,
  currency: string
) {
  const limits = [];

  if (accountSubscription.minPositionNotional !== null) {
    limits.push(
      `Min dollars: ${formatMoney(
        accountSubscription.minPositionNotional,
        currency
      )}`
    );
  }

  if (accountSubscription.maxQty !== null) {
    limits.push(`Max qty: ${formatQuantity(accountSubscription.maxQty)}`);
  }

  return limits.length > 0 ? limits.join(" | ") : "-";
}

function sizingTypeLabel(value: PositionSizingType) {
  return value === "FIXED_QTY"
    ? "Fixed share quantity"
    : "Max position dollars";
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
          Account-specific capital buckets and subscription sizing settings.
        </Text>
      </div>

      <Alert color="blue" title="Runtime sizing note">
        These settings configure account-specific sizing and allocation budgets.
        Runtime order sizing still uses the legacy subscription sizing path
        until the next runtime sizing phase is implemented.
      </Alert>

      <AllocationManagementCard account={account} token={token} />
      <AccountSubscriptionsManagementCard account={account} token={token} />
    </Stack>
  );
}

function AllocationManagementCard({
  account,
  token,
}: {
  account: TradingAccount;
  token: string | null;
}) {
  const [modalState, setModalState] = useState<AllocationModalState | null>(
    null
  );
  const { data, isLoading, isError, error } = useTradingAccountAllocations(
    account.id,
    token
  );
  const createMutation = useCreateTradingAccountAllocation(token);
  const updateMutation = useUpdateTradingAccountAllocation(token);
  const allocations = data?.allocations ?? [];
  const saving = createMutation.isPending || updateMutation.isPending;
  const draftError = modalState
    ? validateAllocationDraft(modalState.draft)
    : null;

  function startCreate() {
    setModalState({
      mode: "create",
      allocation: null,
      keyManuallyEdited: false,
      draft: emptyAllocationDraft,
    });
  }

  function startEdit(allocation: TradingAccountAllocation) {
    setModalState({
      mode: "edit",
      allocation,
      keyManuallyEdited: true,
      draft: allocationToDraft(allocation),
    });
  }

  function closeModal() {
    if (!saving) {
      setModalState(null);
    }
  }

  function updateDraft(next: Partial<AllocationDraft>) {
    setModalState((current) =>
      current
        ? {
            ...current,
            draft: {
              ...current.draft,
              ...next,
            },
          }
        : current
    );
  }

  function updateName(name: string) {
    setModalState((current) => {
      if (!current) return current;

      return {
        ...current,
        draft: {
          ...current.draft,
          name,
          key:
            current.mode === "create" && !current.keyManuallyEdited
              ? suggestAllocationKey(name)
              : current.draft.key,
        },
      };
    });
  }

  function updateKey(key: string) {
    setModalState((current) =>
      current
        ? {
            ...current,
            keyManuallyEdited: true,
            draft: {
              ...current.draft,
              key: key.toLowerCase(),
            },
          }
        : current
    );
  }

  async function saveAllocation() {
    if (!modalState) return;

    const validationError = validateAllocationDraft(modalState.draft);
    if (validationError) {
      notifications.show({
        message: validationError,
        color: "red",
      });
      return;
    }

    try {
      const payload = allocationDraftToPayload(modalState.draft);

      if (modalState.mode === "create") {
        await createMutation.mutateAsync({
          id: account.id,
          payload,
        });
        notifications.show({
          message: "Allocation created.",
          color: "teal",
        });
      } else {
        await updateMutation.mutateAsync({
          id: account.id,
          allocationId: modalState.allocation.id,
          payload,
        });
        notifications.show({
          message: "Allocation updated.",
          color: "teal",
        });
      }

      setModalState(null);
    } catch (error) {
      notifications.show({
        message:
          error instanceof Error ? error.message : "Failed to save allocation.",
        color: "red",
      });
    }
  }

  return (
    <>
      <Card withBorder radius="md" p="lg">
        <Stack gap="md">
          <Group justify="space-between" align="flex-start">
            <div>
              <Title order={4}>Allocation Buckets</Title>
              <Text size="sm" c="dimmed">
                Optional budgets and default limits for groups of account
                subscriptions.
              </Text>
            </div>
            <Button onClick={startCreate}>Create allocation</Button>
          </Group>

          {isError && (
            <Alert color="red" title="Failed to load allocations">
              {error instanceof Error ? error.message : "Unknown error."}
            </Alert>
          )}

          {isLoading && (
            <Group gap="sm">
              <Loader size="sm" color="cyan" />
              <Text size="sm" c="dimmed">
                Loading allocations...
              </Text>
            </Group>
          )}

          {!isLoading && !isError && allocations.length === 0 && (
            <Alert color="gray">
              No allocation buckets exist for this trading account yet.
            </Alert>
          )}

          {allocations.length > 0 && (
            <ScrollArea>
              <Table striped highlightOnHover style={{ minWidth: 980 }}>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Name</Table.Th>
                    <Table.Th>Key</Table.Th>
                    <Table.Th>Status</Table.Th>
                    <Table.Th style={{ textAlign: "right" }}>
                      Max allocated dollars
                    </Table.Th>
                    <Table.Th style={{ textAlign: "right" }}>
                      Max open positions
                    </Table.Th>
                    <Table.Th style={{ textAlign: "right" }}>
                      Default max position dollars
                    </Table.Th>
                    <Table.Th style={{ textAlign: "right" }}>
                      Assigned subscriptions
                    </Table.Th>
                    <Table.Th>Updated</Table.Th>
                    <Table.Th />
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {allocations.map((allocation) => (
                    <Table.Tr
                      key={allocation.id}
                      style={{ opacity: allocation.enabled ? 1 : 0.68 }}
                    >
                      <Table.Td>
                        <div>
                          <Text fw={600} size="sm">
                            {allocation.name}
                          </Text>
                          {allocation.description && (
                            <Text size="xs" c="dimmed" lineClamp={1}>
                              {allocation.description}
                            </Text>
                          )}
                        </div>
                      </Table.Td>
                      <Table.Td>
                        <Text size="sm" ff="monospace">
                          {allocation.key}
                        </Text>
                      </Table.Td>
                      <Table.Td>
                        <Badge
                          color={allocation.enabled ? "teal" : "gray"}
                          variant="light"
                        >
                          {allocation.enabled ? "Active" : "Disabled"}
                        </Badge>
                      </Table.Td>
                      <Table.Td style={{ textAlign: "right" }}>
                        {formatMoney(
                          allocation.maxAllocatedNotional,
                          account.baseCurrency
                        )}
                      </Table.Td>
                      <Table.Td style={{ textAlign: "right" }}>
                        {allocation.maxOpenPositions ?? "-"}
                      </Table.Td>
                      <Table.Td style={{ textAlign: "right" }}>
                        {formatMoney(
                          allocation.maxPositionNotional,
                          account.baseCurrency
                        )}
                      </Table.Td>
                      <Table.Td style={{ textAlign: "right" }}>
                        {allocation.accountSubscriptionCount ?? 0}
                      </Table.Td>
                      <Table.Td>{formatDateTime(allocation.updatedAt)}</Table.Td>
                      <Table.Td>
                        <Button
                          size="xs"
                          variant="subtle"
                          onClick={() => startEdit(allocation)}
                        >
                          Edit
                        </Button>
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </ScrollArea>
          )}
        </Stack>
      </Card>

      <Modal
        opened={modalState !== null}
        onClose={closeModal}
        title={
          modalState?.mode === "edit"
            ? `Edit allocation: ${modalState.allocation.name}`
            : "Create allocation"
        }
        size="lg"
        centered
      >
        {modalState && (
          <Stack gap="md">
            <SimpleGrid cols={{ base: 1, sm: 2 }}>
              <TextInput
                label="Name"
                value={modalState.draft.name}
                onChange={(event) => updateName(event.currentTarget.value)}
                error={
                  modalState.draft.name.trim()
                    ? undefined
                    : "Name is required."
                }
                disabled={saving}
                required
              />

              <TextInput
                label="Key"
                description="Lowercase letters, numbers, hyphens, and underscores."
                value={modalState.draft.key}
                onChange={(event) => updateKey(event.currentTarget.value)}
                error={
                  modalState.draft.key.trim() &&
                  /^[a-z0-9_-]+$/.test(modalState.draft.key.trim())
                    ? undefined
                    : "Use lowercase letters, numbers, hyphens, or underscores."
                }
                disabled={saving}
                required
              />
            </SimpleGrid>

            <Textarea
              label="Description"
              value={modalState.draft.description}
              onChange={(event) =>
                updateDraft({ description: event.currentTarget.value })
              }
              autosize
              minRows={2}
              disabled={saving}
            />

            <Group justify="space-between" align="flex-start" wrap="nowrap">
              <div>
                <Text fw={600} size="sm">
                  Enabled
                </Text>
                <Text size="sm" c="dimmed">
                  Disabled allocations remain visible and can stay assigned, but
                  should not be used for new planning.
                </Text>
              </div>
              <Switch
                checked={modalState.draft.enabled}
                onChange={(event) =>
                  updateDraft({ enabled: event.currentTarget.checked })
                }
                color="teal"
                disabled={saving}
              />
            </Group>

            <SimpleGrid cols={{ base: 1, sm: 3 }}>
              <NumberInput
                label="Max allocated dollars"
                value={modalState.draft.maxAllocatedNotional ?? ""}
                onChange={(value) =>
                  updateDraft({
                    maxAllocatedNotional: normalizeNumberInput(value),
                  })
                }
                min={0}
                thousandSeparator=","
                prefix="$"
                error={
                  modalState.draft.maxAllocatedNotional === null ||
                  modalState.draft.maxAllocatedNotional > 0
                    ? undefined
                    : "Must be greater than zero."
                }
                disabled={saving}
              />

              <NumberInput
                label="Max open positions"
                value={modalState.draft.maxOpenPositions ?? ""}
                onChange={(value) =>
                  updateDraft({
                    maxOpenPositions: normalizeNumberInput(value),
                  })
                }
                min={1}
                allowDecimal={false}
                error={
                  modalState.draft.maxOpenPositions === null ||
                  (Number.isInteger(modalState.draft.maxOpenPositions) &&
                    modalState.draft.maxOpenPositions > 0)
                    ? undefined
                    : "Must be a positive whole number."
                }
                disabled={saving}
              />

              <NumberInput
                label="Default max position dollars"
                value={modalState.draft.maxPositionNotional ?? ""}
                onChange={(value) =>
                  updateDraft({
                    maxPositionNotional: normalizeNumberInput(value),
                  })
                }
                min={0}
                thousandSeparator=","
                prefix="$"
                error={
                  modalState.draft.maxPositionNotional === null ||
                  modalState.draft.maxPositionNotional > 0
                    ? undefined
                    : "Must be greater than zero."
                }
                disabled={saving}
              />
            </SimpleGrid>

            <Textarea
              label="Notes"
              value={modalState.draft.notes}
              onChange={(event) =>
                updateDraft({ notes: event.currentTarget.value })
              }
              autosize
              minRows={3}
              disabled={saving}
            />

            <Group justify="flex-end">
              <Button variant="default" onClick={closeModal} disabled={saving}>
                Cancel
              </Button>
              <Button
                onClick={saveAllocation}
                loading={saving}
                disabled={draftError !== null}
              >
                Save allocation
              </Button>
            </Group>
          </Stack>
        )}
      </Modal>
    </>
  );
}

function AccountSubscriptionsManagementCard({
  account,
  token,
}: {
  account: TradingAccount;
  token: string | null;
}) {
  const [editing, setEditing] = useState<TradingAccountSubscription | null>(
    null
  );
  const [draft, setDraft] = useState<AccountSubscriptionDraft | null>(null);
  const { data, isLoading, isError, error } = useTradingAccountSubscriptions(
    account.id,
    token
  );
  const { data: allocationData } = useTradingAccountAllocations(
    account.id,
    token
  );
  const updateMutation = useUpdateTradingAccountSubscription(token);
  const accountSubscriptions = data?.accountSubscriptions ?? [];
  const allocations = allocationData?.allocations ?? [];
  const draftError = draft ? validateAccountSubscriptionDraft(draft) : null;

  function startEdit(accountSubscription: TradingAccountSubscription) {
    setEditing(accountSubscription);
    setDraft(accountSubscriptionToDraft(accountSubscription));
  }

  function closeModal() {
    if (!updateMutation.isPending) {
      setEditing(null);
      setDraft(null);
    }
  }

  function updateDraft(next: Partial<AccountSubscriptionDraft>) {
    setDraft((current) =>
      current
        ? {
            ...current,
            ...next,
          }
        : current
    );
  }

  function updateSizingType(sizingType: PositionSizingType) {
    setDraft((current) => {
      if (!current) return current;

      return {
        ...current,
        sizingType,
        fixedQty: sizingType === "FIXED_QTY" ? (current.fixedQty ?? 1) : null,
        maxPositionNotional:
          sizingType === "MAX_NOTIONAL"
            ? current.maxPositionNotional
            : null,
      };
    });
  }

  async function saveAccountSubscription() {
    if (!editing || !draft) return;

    const validationError = validateAccountSubscriptionDraft(draft);
    if (validationError) {
      notifications.show({
        message: validationError,
        color: "red",
      });
      return;
    }

    try {
      await updateMutation.mutateAsync({
        id: account.id,
        accountSubscriptionId: editing.id,
        payload: accountSubscriptionDraftToPayload(draft),
      });

      notifications.show({
        message: "Account subscription settings saved.",
        color: "teal",
      });
      closeModal();
    } catch (error) {
      notifications.show({
        message:
          error instanceof Error
            ? error.message
            : "Failed to save account subscription settings.",
        color: "red",
      });
    }
  }

  return (
    <>
      <Card withBorder radius="md" p="lg">
        <Stack gap="md">
          <Group justify="space-between" align="flex-start">
            <div>
              <Title order={4}>Account Subscriptions</Title>
              <Text size="sm" c="dimmed">
                Account-specific subscription activation, allocation assignment,
                and sizing configuration.
              </Text>
            </div>
            <Badge color="blue" variant="light">
              {accountSubscriptions.length.toLocaleString()} subscriptions
            </Badge>
          </Group>

          {isError && (
            <Alert color="red" title="Failed to load account subscriptions">
              {error instanceof Error ? error.message : "Unknown error."}
            </Alert>
          )}

          {isLoading && (
            <Group gap="sm">
              <Loader size="sm" color="cyan" />
              <Text size="sm" c="dimmed">
                Loading account subscriptions...
              </Text>
            </Group>
          )}

          {!isLoading && !isError && accountSubscriptions.length === 0 && (
            <Alert color="gray">
              No account subscriptions exist for this trading account yet.
            </Alert>
          )}

          {accountSubscriptions.length > 0 && (
            <ScrollArea>
              <Table striped highlightOnHover style={{ minWidth: 1240 }}>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Symbol</Table.Th>
                    <Table.Th>Subscription</Table.Th>
                    <Table.Th>Strategy</Table.Th>
                    <Table.Th>Exit profile</Table.Th>
                    <Table.Th>Allocation</Table.Th>
                    <Table.Th>Status</Table.Th>
                    <Table.Th>Entries</Table.Th>
                    <Table.Th>Exits</Table.Th>
                    <Table.Th>Sizing</Table.Th>
                    <Table.Th>Limits</Table.Th>
                    <Table.Th>Updated</Table.Th>
                    <Table.Th />
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {accountSubscriptions.map((accountSubscription) => (
                    <Table.Tr
                      key={accountSubscription.id}
                      style={{
                        opacity: accountSubscription.enabled ? 1 : 0.68,
                      }}
                    >
                      <Table.Td>
                        <Text fw={700} size="sm">
                          {accountSubscription.subscription.symbol}
                        </Text>
                      </Table.Td>
                      <Table.Td>
                        <div>
                          <Text size="sm" ff="monospace">
                            {accountSubscription.subscription.key}
                          </Text>
                          {!accountSubscription.subscription.enabled && (
                            <Badge color="gray" variant="light" size="xs">
                              Legacy disabled
                            </Badge>
                          )}
                        </div>
                      </Table.Td>
                      <Table.Td>
                        {accountSubscription.subscription.strategy ? (
                          <div>
                            <Text size="sm">
                              {accountSubscription.subscription.strategy.name}
                            </Text>
                            <Text size="xs" c="dimmed" ff="monospace">
                              {accountSubscription.subscription.strategy.key}
                            </Text>
                          </div>
                        ) : (
                          "-"
                        )}
                      </Table.Td>
                      <Table.Td>
                        {accountSubscription.subscription.exitProfile ? (
                          <div>
                            <Text size="sm">
                              {accountSubscription.subscription.exitProfile.name}
                            </Text>
                            <Text size="xs" c="dimmed" ff="monospace">
                              {accountSubscription.subscription.exitProfile.key}
                            </Text>
                          </div>
                        ) : (
                          "-"
                        )}
                      </Table.Td>
                      <Table.Td>
                        {accountSubscription.allocation ? (
                          <Stack gap={2}>
                            <Group gap="xs">
                              <Text size="sm">
                                {accountSubscription.allocation.name}
                              </Text>
                              {!accountSubscription.allocation.enabled && (
                                <Badge color="gray" variant="light" size="xs">
                                  Disabled
                                </Badge>
                              )}
                            </Group>
                            <Text size="xs" c="dimmed" ff="monospace">
                              {accountSubscription.allocation.key}
                            </Text>
                          </Stack>
                        ) : (
                          <Text size="sm" c="dimmed">
                            Unassigned
                          </Text>
                        )}
                      </Table.Td>
                      <Table.Td>
                        <Badge
                          color={accountSubscription.enabled ? "teal" : "gray"}
                          variant="light"
                        >
                          {accountSubscription.enabled ? "Active" : "Disabled"}
                        </Badge>
                      </Table.Td>
                      <Table.Td>
                        <Badge
                          color={
                            accountSubscription.entriesEnabled ? "teal" : "gray"
                          }
                          variant="light"
                        >
                          {accountSubscription.entriesEnabled
                            ? "Entries on"
                            : "Entries off"}
                        </Badge>
                      </Table.Td>
                      <Table.Td>
                        <Badge
                          color={
                            accountSubscription.exitsEnabled ? "teal" : "gray"
                          }
                          variant="light"
                        >
                          {accountSubscription.exitsEnabled
                            ? "Exits on"
                            : "Exits off"}
                        </Badge>
                      </Table.Td>
                      <Table.Td>
                        <Stack gap={2}>
                          <Badge color="blue" variant="light" size="xs">
                            {sizingTypeLabel(accountSubscription.sizingType)}
                          </Badge>
                          <Text size="sm">
                            {formatSizing(
                              accountSubscription,
                              account.baseCurrency
                            )}
                          </Text>
                        </Stack>
                      </Table.Td>
                      <Table.Td>
                        <Text size="sm">
                          {formatLimits(
                            accountSubscription,
                            account.baseCurrency
                          )}
                        </Text>
                      </Table.Td>
                      <Table.Td>
                        {formatDateTime(accountSubscription.updatedAt)}
                      </Table.Td>
                      <Table.Td>
                        <Button
                          size="xs"
                          variant="subtle"
                          onClick={() => startEdit(accountSubscription)}
                        >
                          Edit
                        </Button>
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </ScrollArea>
          )}
        </Stack>
      </Card>

      <Modal
        opened={editing !== null && draft !== null}
        onClose={closeModal}
        title={
          editing
            ? `Edit settings: ${editing.subscription.symbol} / ${editing.subscription.key}`
            : "Edit account subscription"
        }
        size="lg"
        centered
      >
        {editing && draft && (
          <Stack gap="md">
            <Select
              label="Allocation"
              value={draft.allocationId === null ? "none" : String(draft.allocationId)}
              onChange={(value) =>
                updateDraft({
                  allocationId:
                    !value || value === "none" ? null : Number(value),
                })
              }
              data={[
                { value: "none", label: "Unassigned" },
                ...allocations.map((allocation) => ({
                  value: String(allocation.id),
                  label: `${allocation.name} (${allocation.key})${
                    allocation.enabled ? "" : " - disabled"
                  }`,
                })),
              ]}
              disabled={updateMutation.isPending}
            />

            <SimpleGrid cols={{ base: 1, md: 3 }}>
              <Group justify="space-between" align="flex-start" wrap="nowrap">
                <div>
                  <Text fw={600} size="sm">
                    Active
                  </Text>
                  <Text size="sm" c="dimmed">
                    Controls whether this account uses this subscription at all.
                  </Text>
                </div>
                <Switch
                  checked={draft.enabled}
                  onChange={(event) =>
                    updateDraft({ enabled: event.currentTarget.checked })
                  }
                  color="teal"
                  disabled={updateMutation.isPending}
                />
              </Group>

              <Group justify="space-between" align="flex-start" wrap="nowrap">
                <div>
                  <Text fw={600} size="sm">
                    Allow new entries
                  </Text>
                  <Text size="sm" c="dimmed">
                    Allows this subscription to open new positions.
                  </Text>
                </div>
                <Switch
                  checked={draft.entriesEnabled}
                  onChange={(event) =>
                    updateDraft({ entriesEnabled: event.currentTarget.checked })
                  }
                  color="teal"
                  disabled={updateMutation.isPending}
                />
              </Group>

              <Group justify="space-between" align="flex-start" wrap="nowrap">
                <div>
                  <Text fw={600} size="sm">
                    Allow exit management
                  </Text>
                  <Text size="sm" c="dimmed">
                    Allows this subscription to manage or close positions that
                    already exist.
                  </Text>
                </div>
                <Switch
                  checked={draft.exitsEnabled}
                  onChange={(event) =>
                    updateDraft({ exitsEnabled: event.currentTarget.checked })
                  }
                  color="teal"
                  disabled={updateMutation.isPending}
                />
              </Group>
            </SimpleGrid>

            <Select
              label="Sizing type"
              value={draft.sizingType}
              onChange={(value) => {
                if (value === "FIXED_QTY" || value === "MAX_NOTIONAL") {
                  updateSizingType(value);
                }
              }}
              data={[
                { value: "FIXED_QTY", label: "Fixed share quantity" },
                { value: "MAX_NOTIONAL", label: "Max position dollars" },
              ]}
              disabled={updateMutation.isPending}
            />

            {draft.sizingType === "FIXED_QTY" ? (
              <Alert color="blue">
                Fixed quantity is required. Max position dollars will be cleared
                when this sizing type is saved.
              </Alert>
            ) : (
              <Alert color="blue">
                Max position dollars is required. Fixed quantity will be cleared
                when this sizing type is saved.
              </Alert>
            )}

            <SimpleGrid cols={{ base: 1, sm: 2 }}>
              {draft.sizingType === "FIXED_QTY" ? (
                <NumberInput
                  label="Fixed quantity"
                  value={draft.fixedQty ?? ""}
                  onChange={(value) =>
                    updateDraft({ fixedQty: normalizeNumberInput(value) })
                  }
                  min={0}
                  thousandSeparator=","
                  error={
                    draft.fixedQty !== null && draft.fixedQty > 0
                      ? undefined
                      : "Fixed quantity is required."
                  }
                  disabled={updateMutation.isPending}
                  required
                />
              ) : (
                <NumberInput
                  label="Max position dollars"
                  value={draft.maxPositionNotional ?? ""}
                  onChange={(value) =>
                    updateDraft({
                      maxPositionNotional: normalizeNumberInput(value),
                    })
                  }
                  min={0}
                  thousandSeparator=","
                  prefix="$"
                  error={
                    draft.maxPositionNotional !== null &&
                    draft.maxPositionNotional > 0
                      ? undefined
                      : "Max position dollars is required."
                  }
                  disabled={updateMutation.isPending}
                  required
                />
              )}

              <NumberInput
                label="Min position dollars"
                value={draft.minPositionNotional ?? ""}
                onChange={(value) =>
                  updateDraft({
                    minPositionNotional: normalizeNumberInput(value),
                  })
                }
                min={0}
                thousandSeparator=","
                prefix="$"
                error={
                  draft.minPositionNotional === null ||
                  draft.minPositionNotional >= 0
                    ? undefined
                    : "Must be zero or greater."
                }
                disabled={updateMutation.isPending}
              />

              <NumberInput
                label="Max quantity"
                value={draft.maxQty ?? ""}
                onChange={(value) =>
                  updateDraft({ maxQty: normalizeNumberInput(value) })
                }
                min={0}
                thousandSeparator=","
                error={
                  draft.maxQty === null || draft.maxQty > 0
                    ? undefined
                    : "Must be greater than zero."
                }
                disabled={updateMutation.isPending}
              />
            </SimpleGrid>

            <Textarea
              label="Notes"
              value={draft.notes}
              onChange={(event) =>
                updateDraft({ notes: event.currentTarget.value })
              }
              autosize
              minRows={3}
              disabled={updateMutation.isPending}
            />

            <Group justify="flex-end">
              <Button
                variant="default"
                onClick={closeModal}
                disabled={updateMutation.isPending}
              >
                Cancel
              </Button>
              <Button
                onClick={saveAccountSubscription}
                loading={updateMutation.isPending}
                disabled={draftError !== null}
              >
                Save settings
              </Button>
            </Group>
          </Stack>
        )}
      </Modal>
    </>
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
          <SafetySettingsCard
            key={`settings-${account.id}-${account.updatedAt}`}
            account={account}
            token={token}
          />
          <SizingAndAllocationsSection account={account} token={token} />
          <CredentialManagementCard account={account} token={token} />
          <NotesCard account={account} />
        </>
      )}
    </Stack>
  );
}
