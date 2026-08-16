import { Button, Group, Stack, Text, Title } from '@mantine/core';
import { Link } from 'react-router-dom';
import { IconArrowLeft } from '@tabler/icons-react';
import { StatusBadge } from '../../../../components/data-display';
import type { TradingAccount } from '../../types';
import classes from '../TradingAccountDetailPage.module.css';

export function AccountDetailHeader({
  account,
  backTo,
}: {
  account?: TradingAccount;
  backTo: string;
}) {
  return (
    <header className={classes.header}>
      <Stack gap="xs" className={classes.headerCopy}>
        <Button
          component={Link}
          to={backTo}
          variant="subtle"
          size="xs"
          leftSection={<IconArrowLeft size={16} aria-hidden="true" />}
          className={classes.backButton}
        >
          Trading Accounts
        </Button>
        <Group gap="sm" align="center" wrap="wrap">
          <Title order={2} size="h3" className={classes.accountTitle}>
            {account?.displayName ?? 'Trading Account'}
          </Title>
          {account && (
            <StatusBadge
              status={account.environment}
              tone={account.environment === 'LIVE' ? 'danger' : 'informational'}
              size="compact"
            />
          )}
          {account && (
            <StatusBadge
              status={account.status}
              label={
                account.status === 'ACTIVE' &&
                !account.tradingEnabled &&
                account.killSwitchEnabled
                  ? 'ACTIVE · ENTRY DISARMED'
                  : undefined
              }
              tone={
                account.status === 'ACTIVE' &&
                account.tradingEnabled &&
                !account.killSwitchEnabled
                  ? 'positive'
                  : account.status === 'ERROR'
                    ? 'danger'
                    : 'warning'
              }
              size="compact"
            />
          )}
        </Group>
        <Text size="sm" c="dimmed">
          {account
            ? `${account.accountHolderName || 'No account holder'} · ${account.broker} · Account ${account.id}`
            : 'Account-scoped broker metadata, credential status, and safety controls.'}
        </Text>
        {account &&
          (account.killSwitchEnabled ||
            !account.tradingEnabled ||
            !account.credential.exists) && (
            <Text
              size="sm"
              fw={600}
              c={account.environment === 'LIVE' ? 'red.4' : 'yellow.4'}
            >
              {account.killSwitchEnabled ? 'Kill switch enabled · ' : ''}
              {!account.tradingEnabled ? 'Trading disabled · ' : ''}
              {!account.credential.exists
                ? 'Credentials required'
                : 'Review account safety posture'}
            </Text>
          )}
      </Stack>
    </header>
  );
}
