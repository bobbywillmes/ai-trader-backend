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
  useCreateTradingAccountAllocation,
  useTradingAccountAllocations,
  useUpdateTradingAccountAllocation,
} from "../../../hooks";
import type { TradingAccount, TradingAccountAllocation } from "../../../types";
import { formatDateTime, formatMoney } from "../../utils/formatters";
import type { AllocationDraft, AllocationModalState } from "./types";
import {
  actionableErrorMessage,
  allocationDraftToPayload,
  allocationToDraft,
  emptyAllocationDraft,
  normalizeNumberInput,
  suggestAllocationKey,
  validateAllocationDraft,
} from "./utils";

export function AllocationManagementCard({
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
  const candidateEnabledAllocatedNotional = modalState
    ? allocations.reduce(
        (total, allocation) =>
          total +
          (modalState.mode === "edit" && allocation.id === modalState.allocation.id
            ? 0
            : allocation.enabled
              ? allocation.maxAllocatedNotional ?? 0
              : 0),
        modalState.draft.enabled
          ? modalState.draft.maxAllocatedNotional ?? 0
          : 0
      )
    : account.enabledAllocatedNotional;
  const draftError = modalState
    ? validateAllocationDraft(modalState.draft) ??
      (account.maxDeployableNotional !== null &&
      candidateEnabledAllocatedNotional > account.maxDeployableNotional
        ? "Enabled allocation budgets would exceed account deployable capital."
        : null)
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
        message: actionableErrorMessage(error, "Failed to save allocation."),
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
                      Reserved / remaining
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
                        <Text size="sm">
                          {formatMoney(allocation.reservedNotional, account.baseCurrency)}
                        </Text>
                        <Text size="xs" c="dimmed">
                          {formatMoney(
                            allocation.remainingAllocatedNotional,
                            account.baseCurrency
                          )} remaining
                        </Text>
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
                        {allocation.entryEnabledSubscriptionCount} entry-enabled
                        <Text size="xs" c="dimmed">
                          {allocation.accountSubscriptionCount ?? 0} assigned total
                        </Text>
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

            <Alert color={draftError ? "yellow" : "blue"} title="Resulting capacity">
              Account enabled allocation total: {formatMoney(
                candidateEnabledAllocatedNotional,
                account.baseCurrency
              )} of {formatMoney(account.maxDeployableNotional, account.baseCurrency)}.
              {modalState.mode === "edit" && (
                <> This allocation currently reserves {formatMoney(
                  modalState.allocation.reservedNotional,
                  account.baseCurrency
                )}; resulting remaining allocation capacity is {formatMoney(
                  modalState.draft.maxAllocatedNotional === null
                    ? null
                    : modalState.draft.maxAllocatedNotional -
                        modalState.allocation.reservedNotional,
                  account.baseCurrency
                )}.</>
              )}
            </Alert>

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
