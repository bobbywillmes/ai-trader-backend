import { Badge, Group, Loader, Menu, Stack, Text, Tooltip, UnstyledButton } from "@mantine/core";
import { IconBuildingBank, IconChevronDown } from "@tabler/icons-react";
import type { ReactNode } from "react";
import type { TradingAccount } from "../tradingAccounts/types";
import { useTradingAccountScope } from "./useTradingAccountScope";
import type { PageScopeMode, TradingAccountScope } from "./types";
import classes from "./TradingAccountScopeSelector.module.css";

type Props = { mode: PageScopeMode; expanded: boolean; mobile?: boolean; variant?: "sidebar" | "dashboard"; onMenuChange?: (open: boolean) => void };

function accountLabel(account: TradingAccount) {
  return `${account.displayName} — ${account.environment}`;
}

export function TradingAccountScopeSelector({ mode, expanded, mobile = false, variant = "sidebar", onMenuChange }: Props) {
  const context = useTradingAccountScope();
  if (mode !== "ACCOUNT_FILTERABLE") return null;

  if (context.isLoading) return <SelectorState expanded={expanded} label="Loading Trading Accounts" icon={<Loader size={18} />} />;
  if (context.isError) return <SelectorState expanded={expanded} label="Trading Accounts unavailable" />;
  if (context.accessibleAccounts.length === 0) return <SelectorState expanded={expanded} label="No accessible Trading Accounts" />;

  const selectedLabel = context.isAll ? "All Trading Accounts" : context.selectedAccount ? accountLabel(context.selectedAccount) : "Trading Account";
  const accountGroups = context.accessibleAccounts.reduce((groups, account) => {
    const holder = account.accountHolderName?.trim() || "Account holder unavailable";
    groups.set(holder, [...(groups.get(holder) ?? []), account]);
    return groups;
  }, new Map<string, TradingAccount[]>());
  const opensBelow = mobile || variant === "dashboard";
  return <Menu position={opensBelow ? "bottom-start" : "right-start"} offset={8} width={300} shadow="lg" withinPortal onChange={onMenuChange} classNames={opensBelow ? { dropdown: classes.mobileDropdown } : undefined}>
    <Menu.Target>
      <UnstyledButton className={`${classes.trigger} ${variant === "dashboard" ? classes.dashboardTrigger : ""}`} aria-label={`Trading Account scope: ${selectedLabel}`}>
        <IconBuildingBank size={20} aria-hidden="true" />
        {expanded && <><div className={classes.triggerText}><Text size="xs" c="dimmed">TRADING ACCOUNT SCOPE</Text><Text size="sm" fw={650} truncate>{selectedLabel}</Text></div><IconChevronDown size={16} aria-hidden="true" /></>}
      </UnstyledButton>
    </Menu.Target>
    <Menu.Dropdown aria-label="Choose Trading Account scope">
      <Menu.Label>Trading Account scope</Menu.Label>
      <ScopeItem label="All Trading Accounts" scope={{ type: "ALL" }} current={context.scope} onSelect={context.setScope} />
      <Menu.Divider />
      {[...accountGroups.entries()].map(([holder, accounts]) => <div key={holder}>
        <Menu.Label>{holder}</Menu.Label>
        {accounts.map((account) => <ScopeItem key={account.id} account={account} label={account.displayName} scope={{ type: "ACCOUNT", tradingAccountId: account.id }} current={context.scope} onSelect={context.setScope} />)}
      </div>)}
    </Menu.Dropdown>
  </Menu>;
}

function SelectorState({ expanded, label, icon }: { expanded: boolean; label: string; icon?: ReactNode }) {
  const content = <div className={classes.state} aria-label={label}>{icon ?? <IconBuildingBank size={20} aria-hidden="true" />}{expanded && <Text size="xs" c="dimmed">{label}</Text>}</div>;
  return expanded ? content : <Tooltip label={label} position="right">{content}</Tooltip>;
}

function ScopeItem({ account, label, scope, current, onSelect }: { account?: TradingAccount; label: string; scope: TradingAccountScope; current: TradingAccountScope; onSelect: (scope: TradingAccountScope) => void }) {
  const selected = scope.type === current.type && (scope.type === "ALL" || (current.type === "ACCOUNT" && scope.tradingAccountId === current.tradingAccountId));
  return <Menu.Item onClick={() => onSelect(scope)} data-selected={selected || undefined}>
    <Group justify="space-between" wrap="nowrap">
      <Stack gap={1} className={classes.itemIdentity}>
        <Text size="sm" fw={selected ? 700 : 500}>{label}</Text>
        {account && <Text size="xs" c="dimmed">{account.broker}</Text>}
      </Stack>
      {account && <Badge color={account.environment === "LIVE" ? "red" : "blue"} variant="light">{account.environment}</Badge>}
    </Group>
  </Menu.Item>;
}
