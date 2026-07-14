import { Badge, Card, Group, SimpleGrid, Stack, Text, Title } from "@mantine/core";
import type { TradingAccount } from "../../../types";
import { DetailItem } from "../../components/DetailItem";
import { formatDateTime, formatStatus } from "../../utils/formatters";
import { credentialStatusColor } from "./utils";

export function CredentialStatusCard({ account }: { account: TradingAccount }) {
  const credential = account.credential;

  return (
    <Card withBorder radius="md" p="lg">
      <Stack gap="md">
        <Group justify="space-between" align="flex-start">
          <div>
            <Title order={3}>Credential Status</Title>
            <Text size="sm" c="dimmed">
              Safe credential summary only. Secrets and ciphertext are never
              displayed.
            </Text>
          </div>
          <Badge color={credentialStatusColor(credential.status)} variant="light">
            {credential.exists ? formatStatus(credential.status) : "No credentials"}
          </Badge>
        </Group>

        <SimpleGrid cols={{ base: 1, sm: 2, lg: 4 }}>
          <DetailItem label="Exists" value={credential.exists ? "Yes" : "No"} />
          <DetailItem label="Status" value={formatStatus(credential.status)} />
          <DetailItem label="Auth type" value={credential.authType ?? "-"} />
          <DetailItem
            label="Key fingerprint"
            value={credential.keyFingerprint ?? "-"}
          />
          <DetailItem
            label="Verified at"
            value={formatDateTime(credential.verifiedAt)}
          />
          <DetailItem
            label="Last used"
            value={formatDateTime(credential.lastUsedAt)}
          />
          <DetailItem
            label="Last failed"
            value={formatDateTime(credential.lastFailedAt)}
          />
          <DetailItem
            label="Revoked at"
            value={formatDateTime(credential.revokedAt)}
          />
        </SimpleGrid>
      </Stack>
    </Card>
  );
}
