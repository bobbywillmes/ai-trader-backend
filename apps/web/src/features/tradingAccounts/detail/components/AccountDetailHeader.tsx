import { Button, Group, Stack, Text, Title } from "@mantine/core";
import { Link } from "react-router-dom";
import { StatusBadge } from "../../../../components/data-display";
import type { TradingAccount } from "../../types";
import classes from "../TradingAccountDetailPage.module.css";

export function AccountDetailHeader({ account }: { account?: TradingAccount }) {
  return (
    <header className={classes.header}>
      <Stack gap="xs" className={classes.headerCopy}>
        <Button
          component={Link}
          to="/trading-accounts"
          variant="subtle"
          size="xs"
          className={classes.backButton}
        >
          Back to Trading Accounts
        </Button>
        <Group gap="sm" align="center" wrap="wrap">
          <Title order={2} size="h3" className={classes.accountTitle}>{account?.displayName ?? "Trading Account"}</Title>
          {account && <StatusBadge status={account.environment} tone={account.environment === "LIVE" ? "danger" : "informational"} size="compact" />}
          {account && <StatusBadge status={account.status} tone={account.status === "ACTIVE" ? "positive" : account.status === "ERROR" ? "danger" : "warning"} size="compact" />}
        </Group>
        <Text size="sm" c="dimmed">
          {account ? `${account.accountHolderName || "No account holder"} · ${account.broker} · Account ${account.id}` : "Account-scoped broker metadata, credential status, and safety controls."}
        </Text>
        {account && (account.killSwitchEnabled || !account.tradingEnabled || !account.credential.exists) && <Text size="sm" fw={600} c={account.environment === "LIVE" ? "red.4" : "yellow.4"}>{account.killSwitchEnabled ? "Kill switch enabled · " : ""}{!account.tradingEnabled ? "Trading disabled · " : ""}{!account.credential.exists ? "Credentials required" : "Review account safety posture"}</Text>}
      </Stack>
    </header>
  );
}
