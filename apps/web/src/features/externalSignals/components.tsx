import { useState, type ReactNode } from "react";
import { Anchor, Badge, Button, Group, Pagination, Select, Stack, Table, Text } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconCheck, IconCopy } from "@tabler/icons-react";
import { Link } from "react-router-dom";
import { DataTable, MobileRecordCard, ResponsiveDataView } from "../../components/data-display";
import type { Pagination as PageInfo } from "./types";
import { label } from "./presentation";
import classes from "./ExternalSignals.module.css";

export function EnabledBadge({ enabled }: { enabled: boolean }) { return <Badge color={enabled ? "teal" : "gray"} variant="light">{enabled ? "Enabled" : "Disabled"}</Badge>; }
export function EvidenceBadge({ value }: { value: string }) { return <Badge variant="light" color={value === "REJECTED" ? "orange" : value === "DUPLICATE" ? "gray" : value === "EXIT_LONG" ? "violet" : "cyan"}>{label(value)}</Badge>; }
export function ShortValue({ value }: { value: string }) { return <Text size="sm" className={classes.truncate} title={value}>{value}</Text>; }
export function CopyValue({ value, name, secret = false }: { value: string; name: string; secret?: boolean }) {
  const [copied, setCopied] = useState(false);
  return <Stack gap={6} className={classes.copyValue}>
    <Text component="div" className={classes.copyText}>{value}</Text>
    <Button size="compact-xs" variant="subtle" w="fit-content" leftSection={copied ? <IconCheck size={14} /> : <IconCopy size={14} />} onClick={async () => {
      try { await navigator.clipboard.writeText(value); setCopied(true); }
      catch { notifications.show({ color: "red", message: secret ? "Copy unavailable. Select and copy the credential manually." : "Copy unavailable. Select and copy the value manually." }); }
    }}>{copied ? `${name} copied` : `Copy ${name}`}</Button>
  </Stack>;
}
export function JsonEvidence({ title, value }: { title: string; value: unknown }) {
  return <section><Text fw={600} size="sm" mb="xs">{title}</Text>{value === null || value === undefined ? <Text size="sm" c="dimmed">Not provided</Text> : <pre className={classes.json} aria-label={title}>{JSON.stringify(value, null, 2)}</pre>}</section>;
}
export function StrategyLink({ id, name }: { id: number; name: string }) { return <Anchor component={Link} to={`/strategies/${id}`} size="sm">{name}</Anchor>; }
export type Column<T> = { label: string; value: (item: T) => ReactNode };
export function Records<T extends { id: number }>({ records, title, columns, identity, status, open }: {
  records: readonly T[]; title: string; columns: Column<T>[]; identity: (item: T) => ReactNode;
  status?: (item: T) => ReactNode; open: (id: number, opener: HTMLElement) => void;
}) {
  const cards = (items: readonly T[]) => <MobileRecordCard records={items} getRecordId={item => item.id} renderIdentity={identity} renderStatus={status}
    renderFields={item => columns.slice(0, 4).map(column => ({ label: column.label, value: column.value(item) }))}
    onDetails={(item, opener) => open(item.id, opener)} />;
  return <ResponsiveDataView records={records} getRecordId={item => item.id} aria-label={title} compact={cards} narrow={cards}
    wide={items => <DataTable caption={title} captionHidden density="compact"><Table.Thead><Table.Tr>{columns.map(column => <Table.Th key={column.label}>{column.label}</Table.Th>)}<Table.Th>Details</Table.Th></Table.Tr></Table.Thead>
      <Table.Tbody>{items.map(item => <Table.Tr key={item.id}>{columns.map(column => <Table.Td key={column.label} className={classes.cell}>{column.value(item)}</Table.Td>)}<Table.Td><Button variant="subtle" size="compact-sm" aria-label={`View ${title.toLowerCase()} #${item.id}`} onClick={event => open(item.id, event.currentTarget)}>View details</Button></Table.Td></Table.Tr>)}</Table.Tbody></DataTable>} />;
}
export function ListFooter({ pagination, page, pageSize, change }: { pagination?: PageInfo; page: number; pageSize: number; change: (values: Record<string, string>, reset?: boolean) => void }) {
  return <Group justify="space-between" className={classes.footer}>
    <Text size="xs" c="dimmed">{pagination?.total ?? 0} records · Page {page} of {pagination?.totalPages ?? 1}</Text>
    <Pagination value={page} total={pagination?.totalPages ?? 1} onChange={value => change({ page: String(value) }, false)} size="sm" siblings={0} />
    <Select aria-label="Records per page" w={100} value={String(pageSize)} data={["25", "50", "100"]} onChange={value => change({ pageSize: value ?? "25" })} />
  </Group>;
}
