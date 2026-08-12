import { Button, Card, Group, Stack, Text, Title } from "@mantine/core";
import { Link, useLocation } from "react-router-dom";
import { createScopedNavigationTarget } from "../../../../../app/navigationUtils";
import { DataState } from "../../../../../components/data-display";
import { useTradingAccountOpenPositions } from "../../../../positions/hooks";
import { PositionsDataView } from "../../../../positions/PositionsPage";
import type { TradingAccount } from "../../../types";

export function PositionsTab({ account, token }: { account: TradingAccount; token: string | null }) {
  const location = useLocation();
  const query = useTradingAccountOpenPositions(account.id, token);
  const positions = query.data?.positions ?? [];
  return <Card withBorder radius="md" p="md"><Stack gap="md">
    <Group justify="space-between" align="flex-start"><div><Title order={3}>Open Positions</Title><Text size="sm" c="dimmed">Open tracked positions for this trading account.</Text></div><Button component={Link} to={createScopedNavigationTarget("/positions/open", location.search)} variant="light" size="xs">Open operational positions</Button></Group>
    {query.isLoading ? <DataState state="loading" message="Loading open positions…" /> : query.isError ? <DataState state="error" title="Unable to load open positions" message={query.error instanceof Error ? query.error.message : "Open positions could not be loaded."} onRetry={() => void query.refetch()} /> : positions.length === 0 ? <DataState state="empty" title="No open positions" message="No open positions are currently attributed to this trading account." /> : <PositionsDataView positions={positions} token={token} ariaLabel={`${account.displayName} open positions`} />}
  </Stack></Card>;
}
