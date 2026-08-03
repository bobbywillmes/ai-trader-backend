import { Button, Group, Menu } from "@mantine/core";
import { IconDotsVertical } from "@tabler/icons-react";
import type { ReactNode } from "react";

export type ResponsiveAction = { label: string; onClick: () => void; icon?: ReactNode; color?: string; disabled?: boolean };

export function ResponsiveActions({ primary, secondary = [], compact = false }: { primary?: ResponsiveAction; secondary?: readonly ResponsiveAction[]; compact?: boolean }) {
  return <Group gap="xs" wrap="nowrap">{primary && <Button size={compact ? "compact-sm" : "sm"} onClick={primary.onClick} leftSection={primary.icon} color={primary.color} disabled={primary.disabled}>{primary.label}</Button>}{secondary.length > 0 && <Menu position="bottom-end" withinPortal><Menu.Target><Button size={compact ? "compact-sm" : "sm"} variant="default" aria-label="More actions" px="xs"><IconDotsVertical size={18} aria-hidden="true" /></Button></Menu.Target><Menu.Dropdown>{secondary.map((action) => <Menu.Item key={action.label} onClick={action.onClick} leftSection={action.icon} color={action.color} disabled={action.disabled}>{action.label}</Menu.Item>)}</Menu.Dropdown></Menu>}</Group>;
}
