import { useState } from "react";
import {
  Alert,
  Badge,
  Button,
  Card,
  Group,
  Loader,
  Modal,
  NumberInput,
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
import { notifications } from "@mantine/notifications";
import {
  usePreviewTradingAccountEntryRisk,
  useTradingAccountAllocations,
  useTradingAccountSubscriptionMarketContext,
  useTradingAccountSubscriptionPriceHistory,
  useTradingAccountSubscriptions,
  useUpdateTradingAccountSubscription,
} from "../../../hooks";
import type {
  AccountSubscriptionPriceHistoryRange,
  EntryRiskPreview,
  PositionSizingType,
  TradingAccount,
  TradingAccountSubscription,
} from "../../../types";
import {
  formatDateTime,
  formatMoney,
  formatQuantity,
} from "../../utils/formatters";
import { normalizeNumberInput } from "../../utils/formValues";
import { EntryRiskPreviewModal } from "./EntryRiskPreviewModal";
import {
  MarketContextCell,
  MarketContextPanel,
  PriceHistoryChart,
} from "./MarketContextCell";
import type {
  AccountSubscriptionDraft,
  AccountSubscriptionSizingFilter,
  AccountSubscriptionStatusFilter,
} from "./types";
import {
  accountSubscriptionDraftToPayload,
  accountSubscriptionHierarchyWarning,
  accountSubscriptionMatchesSearch,
  accountSubscriptionToDraft,
  actionableErrorMessage,
  formatLimits,
  formatSizing,
  sizingTypeLabel,
  validateAccountSubscriptionDraft,
} from "./utils";

export function SubscriptionManagementCard({
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
  const [preview, setPreview] = useState<EntryRiskPreview | null>(null);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] =
    useState<AccountSubscriptionStatusFilter>("active");
  const [sizingFilter, setSizingFilter] =
    useState<AccountSubscriptionSizingFilter>("all");
  const [allocationFilter, setAllocationFilter] = useState("all");
  const [priceHistoryRange, setPriceHistoryRange] =
    useState<AccountSubscriptionPriceHistoryRange>("1y");
  const { data, isLoading, isError, error } = useTradingAccountSubscriptions(
    account.id,
    token
  );
  const { data: allocationData } = useTradingAccountAllocations(
    account.id,
    token
  );
  const {
    data: marketContextData,
    isLoading: marketContextLoading,
    isError: marketContextIsError,
    error: marketContextError,
  } = useTradingAccountSubscriptionMarketContext(
    account.id,
    token,
    statusFilter
  );
  const {
    data: priceHistoryData,
    isLoading: priceHistoryLoading,
    isError: priceHistoryIsError,
  } = useTradingAccountSubscriptionPriceHistory(
    account.id,
    editing?.id,
    token,
    priceHistoryRange
  );
  const updateMutation = useUpdateTradingAccountSubscription(token);
  const previewMutation = usePreviewTradingAccountEntryRisk(token);
  const accountSubscriptions = data?.accountSubscriptions ?? [];
  const allocations = allocationData?.allocations ?? [];
  const marketContextByAccountSubscriptionId = new Map(
    (marketContextData?.items ?? []).map((item) => [
      item.accountSubscriptionId,
      item,
    ])
  );
  const draftError = draft
    ? validateAccountSubscriptionDraft(draft, allocations, editing)
    : null;
  const selectedDraftAllocation = allocations.find(
    (allocation) => allocation.id === draft?.allocationId
  );
  const invalidHierarchyCount = accountSubscriptions.filter(
    accountSubscriptionHierarchyWarning
  ).length;
  const filteredAccountSubscriptions = accountSubscriptions.filter(
    (accountSubscription) => {
      if (!accountSubscriptionMatchesSearch(accountSubscription, search)) {
        return false;
      }

      if (
        statusFilter === "active" &&
        !accountSubscription.enabled
      ) {
        return false;
      }

      if (
        statusFilter === "disabled" &&
        accountSubscription.enabled
      ) {
        return false;
      }

      if (
        sizingFilter !== "all" &&
        accountSubscription.sizingType !== sizingFilter
      ) {
        return false;
      }

      if (
        allocationFilter === "unassigned" &&
        accountSubscription.allocationId !== null
      ) {
        return false;
      }

      if (
        allocationFilter !== "all" &&
        allocationFilter !== "unassigned" &&
        accountSubscription.allocationId !== Number(allocationFilter)
      ) {
        return false;
      }

      return true;
    }
  );

  function startEdit(accountSubscription: TradingAccountSubscription) {
    setEditing(accountSubscription);
    setDraft(accountSubscriptionToDraft(accountSubscription));
    setPriceHistoryRange("1y");
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

    const validationError = validateAccountSubscriptionDraft(
      draft,
      allocations,
      editing
    );
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
        message: actionableErrorMessage(
          error,
          "Failed to save account subscription settings."
        ),
        color: "red",
      });
    }
  }

  async function previewEntryRisk(
    accountSubscription: TradingAccountSubscription
  ) {
    try {
      const result = await previewMutation.mutateAsync({
        id: account.id,
        payload: {
          subscriptionKey: accountSubscription.subscription.key,
        },
      });

      setPreview(result.preview);
    } catch (error) {
      notifications.show({
        message:
          error instanceof Error
            ? error.message
            : "Failed to preview entry risk.",
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
              {filteredAccountSubscriptions.length.toLocaleString()} of{" "}
              {accountSubscriptions.length.toLocaleString()} subscriptions
            </Badge>
          </Group>

          {accountSubscriptions.length > 0 && (
            <SimpleGrid cols={{ base: 1, md: 4 }}>
              <TextInput
                label="Search"
                placeholder="Symbol, subscription, strategy, exit profile"
                value={search}
                onChange={(event) => setSearch(event.currentTarget.value)}
              />

              <Select
                label="Status"
                value={statusFilter}
                onChange={(value) =>
                  setStatusFilter(
                    (value ?? "all") as AccountSubscriptionStatusFilter
                  )
                }
                data={[
                  { value: "all", label: "All statuses" },
                  { value: "active", label: "Active" },
                  { value: "disabled", label: "Disabled" },
                ]}
              />

              <Select
                label="Sizing"
                value={sizingFilter}
                onChange={(value) =>
                  setSizingFilter(
                    (value ?? "all") as AccountSubscriptionSizingFilter
                  )
                }
                data={[
                  { value: "all", label: "All sizing types" },
                  { value: "FIXED_QTY", label: "Fixed share quantity" },
                  { value: "MAX_NOTIONAL", label: "Max position dollars" },
                ]}
              />

              <Select
                label="Allocation"
                value={allocationFilter}
                onChange={(value) => setAllocationFilter(value ?? "all")}
                data={[
                  { value: "all", label: "All allocations" },
                  { value: "unassigned", label: "Unassigned" },
                  ...allocations.map((allocation) => ({
                    value: String(allocation.id),
                    label: `${allocation.name} (${allocation.key})${
                      allocation.enabled ? "" : " - disabled"
                    }`,
                  })),
                ]}
              />
            </SimpleGrid>
          )}

          {invalidHierarchyCount > 0 && (
            <Alert color="yellow" title="Legacy configuration needs attention">
              {invalidHierarchyCount} active account subscription
              {invalidHierarchyCount === 1 ? " has" : "s have"} incomplete or
              invalid capital hierarchy settings. These rows remain visible and
              editable, but new entries are blocked until corrected.
            </Alert>
          )}

          {isError && (
            <Alert color="red" title="Failed to load account subscriptions">
              {error instanceof Error ? error.message : "Unknown error."}
            </Alert>
          )}

          {marketContextIsError && (
            <Alert color="yellow" title="Failed to load market context">
              {marketContextError instanceof Error
                ? marketContextError.message
                : "Price context is unavailable."}
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

          {!isLoading &&
            !isError &&
            accountSubscriptions.length > 0 &&
            filteredAccountSubscriptions.length === 0 && (
              <Alert color="gray">
                No account subscriptions match the current filters.
              </Alert>
            )}

          {filteredAccountSubscriptions.length > 0 && (
            <ScrollArea>
              <Table striped highlightOnHover style={{ minWidth: 1460 }}>
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
                    <Table.Th>Reserved capital</Table.Th>
                    <Table.Th>Market context</Table.Th>
                    <Table.Th>Limits</Table.Th>
                    <Table.Th>Updated</Table.Th>
                    <Table.Th />
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {filteredAccountSubscriptions.map((accountSubscription) => (
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
                          {accountSubscriptionHierarchyWarning(accountSubscription) && (
                            <Badge color="yellow" variant="light" size="xs">
                              Needs correction
                            </Badge>
                          )}
                        </Stack>
                      </Table.Td>
                      <Table.Td>
                        <Text size="sm">
                          {formatMoney(
                            accountSubscription.reservedNotional,
                            account.baseCurrency
                          )}
                        </Text>
                        {accountSubscriptionHierarchyWarning(accountSubscription) && (
                          <Text size="xs" c="orange">
                            {accountSubscriptionHierarchyWarning(accountSubscription)}
                          </Text>
                        )}
                      </Table.Td>
                      <Table.Td style={{ minWidth: 230 }}>
                        <MarketContextCell
                          context={marketContextByAccountSubscriptionId.get(
                            accountSubscription.id
                          )}
                          currency={account.baseCurrency}
                          loading={marketContextLoading}
                        />
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
                        <Group gap="xs" wrap="nowrap">
                          <Button
                            size="xs"
                            variant="default"
                            loading={
                              previewMutation.isPending &&
                              previewMutation.variables?.payload
                                .subscriptionKey ===
                                accountSubscription.subscription.key
                            }
                            onClick={() => previewEntryRisk(accountSubscription)}
                          >
                            Preview risk
                          </Button>
                          <Button
                            size="xs"
                            variant="subtle"
                            onClick={() => startEdit(accountSubscription)}
                          >
                            Edit
                          </Button>
                        </Group>
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </ScrollArea>
          )}
        </Stack>
      </Card>

      <EntryRiskPreviewModal
        currency={account.baseCurrency}
        preview={preview}
        onClose={() => setPreview(null)}
      />

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
              required={draft.enabled && draft.entriesEnabled}
              error={
                draft.enabled && draft.entriesEnabled && draft.allocationId === null
                  ? "Allocation is required for new entries."
                  : undefined
              }
            />

            {selectedDraftAllocation && (
              <Alert
                color={selectedDraftAllocation.enabled ? "blue" : "yellow"}
                title="Selected allocation capacity"
              >
                Budget {formatMoney(
                  selectedDraftAllocation.maxAllocatedNotional,
                  account.baseCurrency
                )}; reserved {formatMoney(
                  selectedDraftAllocation.reservedNotional,
                  account.baseCurrency
                )}; remaining {formatMoney(
                  selectedDraftAllocation.remainingAllocatedNotional,
                  account.baseCurrency
                )}; per-position ceiling {formatMoney(
                  selectedDraftAllocation.maxPositionNotional,
                  account.baseCurrency
                )}; max open positions {formatQuantity(
                  selectedDraftAllocation.maxOpenPositions
                )}.
              </Alert>
            )}

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

            <MarketContextPanel
              context={marketContextByAccountSubscriptionId.get(editing.id)}
              currency={account.baseCurrency}
              draft={draft}
              loading={marketContextLoading}
            />

            <PriceHistoryChart
              currency={account.baseCurrency}
              data={priceHistoryData}
              isError={priceHistoryIsError}
              isLoading={priceHistoryLoading}
              range={priceHistoryRange}
              onRangeChange={setPriceHistoryRange}
            />

            <SimpleGrid cols={{ base: 1, sm: 2 }}>
              <NumberInput
                label="Reserved capital"
                description="Capital reserved inside the allocation; separate from MAX_NOTIONAL sizing."
                value={draft.reservedNotional ?? ""}
                onChange={(value) =>
                  updateDraft({ reservedNotional: normalizeNumberInput(value) })
                }
                min={0}
                thousandSeparator=","
                prefix="$"
                error={
                  draft.enabled && draft.entriesEnabled &&
                  (draft.reservedNotional === null || draft.reservedNotional <= 0)
                    ? "Reserved capital is required for new entries."
                    : undefined
                }
                disabled={updateMutation.isPending}
                required={draft.enabled && draft.entriesEnabled}
              />

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
