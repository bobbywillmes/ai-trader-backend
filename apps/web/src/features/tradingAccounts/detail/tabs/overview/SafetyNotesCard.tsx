import { Card, Grid, Stack, Text, Title } from "@mantine/core";
import type { TradingAccount } from "../../../types";
import { DetailItem } from "../../components/DetailItem";

export function SafetyNotesCard({ account }: { account: TradingAccount }) {
  return (
    <Card withBorder radius="md" p="lg">
      <Stack gap="md">
        <div>
          <Title order={3}>Safety Notes</Title>
          <Text size="sm" c="dimmed">
            Current paused reason and admin notes.
          </Text>
        </div>
        <Grid>
          <Grid.Col span={{ base: 12, md: 6 }}>
            <DetailItem
              label="Paused reason"
              value={account.pausedReason || "-"}
            />
          </Grid.Col>
          <Grid.Col span={{ base: 12, md: 6 }}>
            <DetailItem label="Notes" value={account.notes || "-"} />
          </Grid.Col>
        </Grid>
      </Stack>
    </Card>
  );
}


