import { ActionIcon, Badge, Button, Drawer, Group, Stack, Text } from "@mantine/core";
import { IconAdjustments, IconX } from "@tabler/icons-react";
import { useRef, useState, type ReactNode } from "react";
import classes from "./ResponsiveFilterToolbar.module.css";

export type ActiveFilter = { key: string; label: string; onRemove?: () => void };

type Props = { primary?: ReactNode; secondary?: ReactNode; activeFilters?: readonly ActiveFilter[]; onClearAll?: () => void; title?: string };

export function ResponsiveFilterToolbar({ primary, secondary, activeFilters = [], onClearAll, title = "Filters" }: Props) {
  const [opened, setOpened] = useState(false); const opener = useRef<HTMLButtonElement>(null);
  const close = () => { setOpened(false); window.setTimeout(() => opener.current?.focus(), 0); };
  return <div className={classes.root}>
    <div className={classes.toolbar} aria-label="Data filters"><div className={classes.controls} data-filter-controls>{primary && <div className={classes.primary} data-filter-primary>{primary}</div>}<div className={classes.secondary}>{secondary}</div><Button ref={opener} className={classes.mobileButton} variant="default" leftSection={<IconAdjustments size={17} />} onClick={() => setOpened(true)} aria-expanded={opened} aria-haspopup="dialog">Filters{activeFilters.length ? ` (${activeFilters.length})` : ""}</Button></div></div>
    {activeFilters.length > 0 && <div className={classes.summary} aria-label="Active filters"><Text size="xs" c="dimmed">Active:</Text>{activeFilters.map((filter) => <Badge key={filter.key} variant="light" rightSection={filter.onRemove ? <ActionIcon variant="transparent" size="xs" aria-label={`Remove ${filter.label} filter`} onClick={filter.onRemove}><IconX size={12} aria-hidden="true" /></ActionIcon> : undefined}>{filter.label}</Badge>)}{onClearAll && <Button size="compact-xs" variant="subtle" onClick={onClearAll}>Clear all</Button>}</div>}
    <Drawer opened={opened} onClose={close} title={title} position="bottom" size="auto" closeOnEscape trapFocus lockScroll><Stack gap="md">{secondary}{activeFilters.length > 0 && <Group justify="space-between"><Text size="sm">{activeFilters.length} active</Text>{onClearAll && <Button variant="subtle" onClick={() => { onClearAll(); close(); }}>Clear all</Button>}</Group>}<Button onClick={close}>Apply filters</Button></Stack></Drawer>
  </div>;
}
