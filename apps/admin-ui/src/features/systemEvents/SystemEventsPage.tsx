import { useState, useMemo, Fragment } from "react";
import {
  Badge,
  Box,
  Card,
  Code,
  Group,
  Loader,
  ScrollArea,
  Select,
  Stack,
  Table,
  Text,
  Title,
  ActionIcon,
  Tooltip,
} from "@mantine/core";
import { getAdminToken } from "../../lib/api";
import { useSystemEvents } from "../dashboard/hooks";
import { describeEvent, rawPayload } from "../dashboard/eventUtils";
import type { SystemEvent } from "../dashboard/types";

const LIMIT_OPTIONS = [
  { value: "50", label: "Last 50" },
  { value: "100", label: "Last 100" },
  { value: "200", label: "Last 200" },
  { value: "500", label: "Last 500" },
];

function ChevronIcon({ expanded }: { expanded: boolean }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 14 14"
      fill="none"
      style={{ transform: expanded ? "rotate(180deg)" : "rotate(0deg)", transition: "transform 150ms ease" }}
    >
      <path d="M3 5L7 9L11 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function EventRow({ ev }: { ev: SystemEvent }) {
  const [expanded, setExpanded] = useState(false);
  const { label, description, color } = describeEvent(ev);
  const payload = rawPayload(ev);
  const hasPayload = payload !== "{}";

  return (
    <Fragment>
      <Table.Tr
        style={{ cursor: hasPayload ? "pointer" : undefined }}
        onClick={() => hasPayload && setExpanded((v) => !v)}
      >
        <Table.Td>
          <Badge size="sm" color={color} variant="light" style={{ minWidth: 80, textAlign: "center" }}>
            {label}
          </Badge>
        </Table.Td>
        <Table.Td>
          <Text size="sm">{description}</Text>
        </Table.Td>
        <Table.Td>
          {ev.entityType && (
            <Text size="sm" c="dimmed">
              {ev.entityType}{ev.entityId ? ` · ${ev.entityId}` : ""}
            </Text>
          )}
        </Table.Td>
        <Table.Td>
          <Text size="xs" c="dimmed">
            {new Date(ev.createdAt).toLocaleString([], {
              month: "short", day: "numeric",
              hour: "2-digit", minute: "2-digit", second: "2-digit",
            })}
          </Text>
        </Table.Td>
        <Table.Td style={{ width: 32 }}>
          {hasPayload && (
            <Tooltip label={expanded ? "Hide payload" : "Show payload"} withArrow>
              <ActionIcon
                size="sm"
                variant="subtle"
                color="gray"
                onClick={(e) => { e.stopPropagation(); setExpanded((v) => !v); }}
              >
                <ChevronIcon expanded={expanded} />
              </ActionIcon>
            </Tooltip>
          )}
        </Table.Td>
      </Table.Tr>

      {hasPayload && expanded && (
        <Table.Tr>
          <Table.Td colSpan={5} style={{ padding: 0 }}>
            <Box p="sm" style={{ background: "var(--mantine-color-dark-8)", borderTop: "1px solid var(--mantine-color-dark-5)" }}>
              <Code block style={{ fontSize: "var(--mantine-font-size-xs)" }}>
                {payload}
              </Code>
            </Box>
          </Table.Td>
        </Table.Tr>
      )}
    </Fragment>
  );
}

export function SystemEventsPage() {
  const [token] = useState<string | null>(() => getAdminToken());
  const [limit, setLimit] = useState("100");
  const [typeFilter, setTypeFilter] = useState<string | null>(null);

  const { data: events = [], isLoading } = useSystemEvents(token, Number(limit));

  const typeOptions = useMemo(() => {
    const types = Array.from(new Set(events.map((e) => e.type))).sort();
    return [
      { value: "", label: "All types" },
      ...types.map((t) => ({ value: t, label: t })),
    ];
  }, [events]);

  const filtered = useMemo(
    () => (typeFilter ? events.filter((e) => e.type === typeFilter) : events),
    [events, typeFilter]
  );

  return (
    <Stack gap="lg">
      <Group justify="space-between" align="flex-end">
        <div>
          <Title order={2} size="h3">System Events</Title>
          <Text size="sm" c="dimmed">Audit log of all significant state transitions.</Text>
        </div>
        {isLoading && <Loader size="xs" color="cyan" />}
      </Group>

      <Group gap="sm">
        <Select
          data={LIMIT_OPTIONS}
          value={limit}
          onChange={(v) => setLimit(v ?? "100")}
          size="sm"
          style={{ width: 130 }}
        />
        <Select
          data={typeOptions}
          value={typeFilter ?? ""}
          onChange={(v) => setTypeFilter(v || null)}
          size="sm"
          style={{ width: 200 }}
          placeholder="All types"
        />
        <Text size="xs" c="dimmed">
          {filtered.length} event{filtered.length !== 1 ? "s" : ""}
          {typeFilter ? ` · filtered from ${events.length}` : ""}
        </Text>
      </Group>

      <Card withBorder radius="md" p={0}>
        <ScrollArea>
          <Table highlightOnHover style={{ minWidth: 640 }}>
            <Table.Thead>
              <Table.Tr>
                <Table.Th style={{ width: 100 }}>Event</Table.Th>
                <Table.Th>Description</Table.Th>
                <Table.Th>Entity</Table.Th>
                <Table.Th style={{ width: 180 }}>Time</Table.Th>
                <Table.Th style={{ width: 32 }} />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {filtered.length === 0 && !isLoading && (
                <Table.Tr>
                  <Table.Td colSpan={5}>
                    <Text size="sm" c="dimmed" p="md">No events found.</Text>
                  </Table.Td>
                </Table.Tr>
              )}
              {filtered.map((ev) => (
                <EventRow key={ev.id} ev={ev} />
              ))}
            </Table.Tbody>
          </Table>
        </ScrollArea>
      </Card>
    </Stack>
  );
}
