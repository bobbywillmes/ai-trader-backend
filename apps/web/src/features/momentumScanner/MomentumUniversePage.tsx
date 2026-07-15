import { useMemo, useState } from "react";
import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Card,
  Group,
  Loader,
  Modal,
  NumberInput,
  Pagination,
  ScrollArea,
  Select,
  Stack,
  Switch,
  Table,
  Text,
  Textarea,
  TextInput,
  Title,
  Tooltip,
} from "@mantine/core";
import { useDebouncedValue } from "@mantine/hooks";
import { modals } from "@mantine/modals";
import { notifications } from "@mantine/notifications";
import { IconEdit, IconPlus, IconRefresh, IconTrash } from "@tabler/icons-react";

import { getAdminToken } from "../../lib/api";
import { useSecurities } from "../securities/hooks";
import {
  useCreateMomentumUniverseMember,
  useDeleteMomentumUniverseMember,
  useMomentumUniverse,
  useUpdateMomentumUniverseMember,
} from "./hooks";
import { MomentumScannerNavigation } from "./MomentumScannerNavigation";
import type {
  MomentumUniverseMember,
  UpdateMomentumUniverseMemberRequest,
} from "./types";

function formatDate(value: string | null | undefined) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "2-digit",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Unknown error.";
}

export function MomentumUniversePage() {
  const [token] = useState(() => getAdminToken());
  const [search, setSearch] = useState("");
  const [debouncedSearch] = useDebouncedValue(search, 250);
  const [enabledFilter, setEnabledFilter] = useState<string | null>("all");
  const [page, setPage] = useState(1);
  const [addOpened, setAddOpened] = useState(false);
  const [securitySearch, setSecuritySearch] = useState("");
  const [debouncedSecuritySearch] = useDebouncedValue(securitySearch, 250);
  const [selectedSecurityId, setSelectedSecurityId] = useState<string | null>(null);
  const [editing, setEditing] = useState<MomentumUniverseMember | null>(null);
  const [editPriority, setEditPriority] = useState<number | string>(0);
  const [editInterval, setEditInterval] = useState<number | string>(15);
  const [editNotes, setEditNotes] = useState("");

  const query = useMemo(
    () => ({
      page,
      pageSize: 50,
      ...(debouncedSearch ? { search: debouncedSearch } : {}),
      ...(enabledFilter === "enabled"
        ? { enabled: true }
        : enabledFilter === "disabled"
          ? { enabled: false }
          : {}),
    }),
    [debouncedSearch, enabledFilter, page]
  );
  const universeQuery = useMomentumUniverse(token, query);
  const allUniverseQuery = useMomentumUniverse(token, { page: 1, pageSize: 250 });
  const securitiesQuery = useSecurities(
    {
      page: 1,
      pageSize: 250,
      ...(debouncedSecuritySearch ? { search: debouncedSecuritySearch } : {}),
    },
    token
  );
  const createMember = useCreateMomentumUniverseMember(token);
  const updateMember = useUpdateMomentumUniverseMember(token);
  const deleteMember = useDeleteMomentumUniverseMember(token);

  const members = useMemo(
    () => universeQuery.data?.data ?? [],
    [universeQuery.data?.data]
  );
  const existingSecurityIds = useMemo(
    () =>
      new Set(
        (allUniverseQuery.data?.data ?? []).map((member) => member.securityId)
      ),
    [allUniverseQuery.data?.data]
  );
  const securityOptions = useMemo(
    () =>
      (securitiesQuery.data?.data ?? [])
        .filter((security) => !existingSecurityIds.has(security.id))
        .map((security) => ({
          value: String(security.id),
          label: `${security.symbol} — ${security.name}`,
        })),
    [existingSecurityIds, securitiesQuery.data?.data]
  );

  async function update(id: string, request: UpdateMomentumUniverseMemberRequest) {
    try {
      await updateMember.mutateAsync({ id, request });
      notifications.show({ message: "Universe member updated.", color: "teal" });
    } catch (error) {
      notifications.show({ title: "Update failed", message: errorMessage(error), color: "red" });
    }
  }

  function openEdit(member: MomentumUniverseMember) {
    setEditing(member);
    setEditPriority(member.priority);
    setEditInterval(member.pullIntervalMin);
    setEditNotes(member.notes ?? "");
  }

  async function saveEdit() {
    if (!editing || typeof editPriority !== "number" || typeof editInterval !== "number") {
      return;
    }

    try {
      await updateMember.mutateAsync({
        id: editing.id,
        request: {
          priority: editPriority,
          pullIntervalMin: editInterval,
          notes: editNotes.trim() || null,
        },
      });
      setEditing(null);
      notifications.show({ message: `${editing.security.symbol} settings saved.`, color: "teal" });
    } catch (error) {
      notifications.show({ title: "Save failed", message: errorMessage(error), color: "red" });
    }
  }

  async function addSecurity() {
    if (!selectedSecurityId) return;

    try {
      await createMember.mutateAsync({ securityId: Number(selectedSecurityId) });
      setSelectedSecurityId(null);
      setSecuritySearch("");
      setAddOpened(false);
      notifications.show({ message: "Security added to the research universe.", color: "teal" });
    } catch (error) {
      notifications.show({ title: "Add failed", message: errorMessage(error), color: "red" });
    }
  }

  function confirmRemove(member: MomentumUniverseMember) {
    modals.openConfirmModal({
      title: `Remove ${member.security.symbol} from the universe?`,
      children: (
        <Text size="sm">
          Disabling is safer for routine operations. Removal deletes only the universe membership;
          subscription or open-position coverage may still keep news polling active.
        </Text>
      ),
      labels: { confirm: "Remove membership", cancel: "Cancel" },
      confirmProps: { color: "red" },
      onConfirm: async () => {
        try {
          await deleteMember.mutateAsync(member.id);
          notifications.show({ message: `${member.security.symbol} removed.`, color: "teal" });
        } catch (error) {
          notifications.show({ title: "Removal failed", message: errorMessage(error), color: "red" });
        }
      },
    });
  }

  return (
    <Stack gap="lg">
      <MomentumScannerNavigation />

      <Group justify="space-between" align="flex-start">
        <div>
          <Title order={2}>Momentum Research Universe</Title>
          <Text c="dimmed" size="sm">
            Manage which securities the scanner researches. This does not create subscriptions or enable trading.
          </Text>
        </div>
        <Group>
          <Button
            variant="default"
            leftSection={<IconRefresh size={16} />}
            onClick={() => void universeQuery.refetch()}
          >
            Refresh
          </Button>
          <Button leftSection={<IconPlus size={16} />} onClick={() => setAddOpened(true)}>
            Add security
          </Button>
        </Group>
      </Group>

      <Card withBorder>
        <Group align="flex-end">
          <TextInput
            label="Search"
            placeholder="Symbol or company name"
            value={search}
            onChange={(event) => {
              setSearch(event.currentTarget.value);
              setPage(1);
            }}
            style={{ flex: 1 }}
          />
          <Select
            label="Universe status"
            value={enabledFilter}
            onChange={(value) => {
              setEnabledFilter(value);
              setPage(1);
            }}
            data={[
              { value: "all", label: "All" },
              { value: "enabled", label: "Enabled" },
              { value: "disabled", label: "Disabled" },
            ]}
            w={180}
          />
        </Group>
      </Card>

      {universeQuery.isError && (
        <Alert color="red" title="Unable to load the universe">
          {errorMessage(universeQuery.error)}
        </Alert>
      )}

      <Card withBorder p={0}>
        {universeQuery.isLoading ? (
          <Group justify="center" p="xl"><Loader /></Group>
        ) : (
          <ScrollArea>
            <Table striped highlightOnHover withColumnBorders miw={1500}>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Security</Table.Th>
                  <Table.Th>Type</Table.Th>
                  <Table.Th>Universe</Table.Th>
                  <Table.Th>News</Table.Th>
                  <Table.Th>Price scan</Table.Th>
                  <Table.Th>Priority</Table.Th>
                  <Table.Th>Interval</Table.Th>
                  <Table.Th>Reason</Table.Th>
                  <Table.Th>Momentum eligibility</Table.Th>
                  <Table.Th>Cursor health</Table.Th>
                  <Table.Th>Updated</Table.Th>
                  <Table.Th>Actions</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {members.map((member) => (
                  <Table.Tr key={member.id}>
                    <Table.Td>
                      <Text fw={700}>{member.security.symbol}</Text>
                      <Text size="xs" c="dimmed">{member.security.name}</Text>
                    </Table.Td>
                    <Table.Td><Badge variant="light">{member.security.assetType}</Badge></Table.Td>
                    <Table.Td>
                      <Switch
                        checked={member.enabled}
                        disabled={updateMember.isPending}
                        onChange={(event) => void update(member.id, { enabled: event.currentTarget.checked })}
                        aria-label={`Toggle ${member.security.symbol} universe membership`}
                      />
                    </Table.Td>
                    <Table.Td>
                      <Switch
                        checked={member.newsEnabled}
                        disabled={updateMember.isPending}
                        onChange={(event) => void update(member.id, { newsEnabled: event.currentTarget.checked })}
                        aria-label={`Toggle ${member.security.symbol} news coverage`}
                      />
                    </Table.Td>
                    <Table.Td>
                      <Switch
                        checked={member.priceScanningEnabled}
                        disabled={updateMember.isPending}
                        onChange={(event) =>
                          void update(member.id, { priceScanningEnabled: event.currentTarget.checked })
                        }
                        aria-label={`Toggle ${member.security.symbol} price scanning`}
                      />
                    </Table.Td>
                    <Table.Td>{member.priority}</Table.Td>
                    <Table.Td>{member.pullIntervalMin} min</Table.Td>
                    <Table.Td>{member.addedReason}</Table.Td>
                    <Table.Td><Stack gap={3}><Badge color={member.momentumSubscriptionEligibility.eligible ? "teal" : "yellow"} variant="light">{member.momentumSubscriptionEligibility.eligible ? "Momentum enabled" : "Research only"}</Badge><Text size="xs" c="dimmed">{member.momentumSubscriptionEligibility.qualifyingSubscriptionIds.length} qualifying of {member.subscriptionCount}</Text></Stack></Table.Td>
                    <Table.Td>
                      {member.cursor ? (
                        <Stack gap={2}>
                          <Badge
                            size="sm"
                            color={member.cursor.consecutiveErrors > 0 ? "red" : member.cursor.enabled ? "teal" : "gray"}
                          >
                            {member.cursor.consecutiveErrors > 0
                              ? `${member.cursor.consecutiveErrors} errors`
                              : member.cursor.enabled ? "Healthy" : "Disabled"}
                          </Badge>
                          <Text size="xs" c="dimmed">Last pull {formatDate(member.cursor.lastPulledAt)}</Text>
                        </Stack>
                      ) : (
                        <Badge color="gray" variant="light">Not initialized</Badge>
                      )}
                    </Table.Td>
                    <Table.Td>{formatDate(member.updatedAt)}</Table.Td>
                    <Table.Td>
                      <Group gap="xs" wrap="nowrap">
                        <Tooltip label="Edit settings and notes">
                          <ActionIcon variant="default" onClick={() => openEdit(member)}>
                            <IconEdit size={16} />
                          </ActionIcon>
                        </Tooltip>
                        <Tooltip label="Remove membership">
                          <ActionIcon color="red" variant="subtle" onClick={() => confirmRemove(member)}>
                            <IconTrash size={16} />
                          </ActionIcon>
                        </Tooltip>
                      </Group>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
            {members.length === 0 && <Text c="dimmed" ta="center" p="xl">No universe members found.</Text>}
          </ScrollArea>
        )}
      </Card>

      {(universeQuery.data?.pagination.totalPages ?? 1) > 1 && (
        <Group justify="space-between">
          <Text size="sm" c="dimmed">{universeQuery.data?.pagination.total ?? 0} members</Text>
          <Pagination
            value={page}
            onChange={setPage}
            total={universeQuery.data?.pagination.totalPages ?? 1}
          />
        </Group>
      )}

      <Modal opened={addOpened} onClose={() => setAddOpened(false)} title="Add existing security">
        <Stack>
          <Select
            searchable
            clearable
            label="Security"
            placeholder="Search by symbol or company"
            searchValue={securitySearch}
            onSearchChange={setSecuritySearch}
            value={selectedSecurityId}
            onChange={setSelectedSecurityId}
            data={securityOptions}
            nothingFoundMessage="No eligible securities found"
          />
          <Text size="xs" c="dimmed">
            Securities must already exist. Adding one here does not create a trading subscription.
          </Text>
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setAddOpened(false)}>Cancel</Button>
            <Button
              onClick={() => void addSecurity()}
              disabled={!selectedSecurityId}
              loading={createMember.isPending}
            >
              Add to universe
            </Button>
          </Group>
        </Stack>
      </Modal>

      <Modal
        opened={editing !== null}
        onClose={() => setEditing(null)}
        title={editing ? `Edit ${editing.security.symbol}` : "Edit universe member"}
      >
        <Stack>
          <NumberInput
            label="Priority"
            description="Higher values are polled first."
            min={-1000}
            max={1000}
            value={editPriority}
            onChange={setEditPriority}
          />
          <NumberInput
            label="Pull interval (minutes)"
            min={1}
            max={1440}
            value={editInterval}
            onChange={setEditInterval}
          />
          <Textarea
            label="Notes"
            maxLength={2000}
            minRows={4}
            value={editNotes}
            onChange={(event) => setEditNotes(event.currentTarget.value)}
          />
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setEditing(null)}>Cancel</Button>
            <Button loading={updateMember.isPending} onClick={() => void saveEdit()}>
              Save changes
            </Button>
          </Group>
        </Stack>
      </Modal>
    </Stack>
  );
}
