import { useState } from "react";
import {
  Alert,
  Badge,
  Button,
  Card,
  Group,
  PasswordInput,
  SimpleGrid,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import { modals } from "@mantine/modals";
import { notifications } from "@mantine/notifications";
import {
  useRevokeTradingAccountCredential,
  useUpsertTradingAccountCredential,
  useVerifyTradingAccountCredential,
} from "../../../hooks";
import type { TradingAccount } from "../../../types";
import { formatStatus } from "../../utils/formatters";
import type { CredentialDraft } from "./types";
import { credentialStatusColor } from "./utils";

export function CredentialManagementCard({
  account,
  token,
}: {
  account: TradingAccount;
  token: string | null;
}) {
  const [draft, setDraft] = useState<CredentialDraft>({
    apiKey: "",
    apiSecret: "",
  });
  const upsertMutation = useUpsertTradingAccountCredential(token);
  const verifyMutation = useVerifyTradingAccountCredential(token);
  const revokeMutation = useRevokeTradingAccountCredential(token);
  const hasCredentialDraft =
    draft.apiKey.trim().length > 0 || draft.apiSecret.trim().length > 0;
  const canSaveCredential =
    draft.apiKey.trim().length > 0 && draft.apiSecret.trim().length > 0;
  const credentialBusy =
    upsertMutation.isPending ||
    verifyMutation.isPending ||
    revokeMutation.isPending;

  async function saveCredentials() {
    if (!canSaveCredential) {
      notifications.show({
        message: "API key and API secret are both required.",
        color: "red",
      });
      return;
    }

    try {
      await upsertMutation.mutateAsync({
        id: account.id,
        payload: {
          authType: "API_KEY",
          apiKey: draft.apiKey.trim(),
          apiSecret: draft.apiSecret.trim(),
        },
      });

      setDraft({ apiKey: "", apiSecret: "" });
      notifications.show({
        message:
          "Credentials saved. Verify them before account-scoped broker access can use them.",
        color: "teal",
      });
    } catch (error) {
      notifications.show({
        message:
          error instanceof Error ? error.message : "Failed to save credentials.",
        color: "red",
      });
    }
  }

  async function verifyCredentials() {
    try {
      await verifyMutation.mutateAsync(account.id);
      notifications.show({
        message:
          "Credentials verified. Trading remains controlled by the account safety settings.",
        color: "teal",
      });
    } catch (error) {
      notifications.show({
        message:
          error instanceof Error
            ? error.message
            : "Failed to verify credentials.",
        color: "red",
      });
    }
  }

  function confirmRevokeCredentials() {
    modals.openConfirmModal({
      title: "Revoke broker credentials",
      children: (
        <Stack gap="sm">
          <Text size="sm">
            Revoke broker credentials for <strong>{account.displayName}</strong>?
          </Text>
          <Text size="sm" c="dimmed">
            This marks the credential revoked, disables trading, enables the kill
            switch, and requires new credentials before account-scoped broker
            access can work.
          </Text>
        </Stack>
      ),
      labels: { confirm: "Revoke credentials", cancel: "Keep credentials" },
      confirmProps: { color: "red" },
      onConfirm: async () => {
        try {
          await revokeMutation.mutateAsync(account.id);
          setDraft({ apiKey: "", apiSecret: "" });
          notifications.show({
            message:
              "Credentials revoked. Trading was disabled and the kill switch was enabled.",
            color: "teal",
          });
        } catch (error) {
          notifications.show({
            message:
              error instanceof Error
                ? error.message
                : "Failed to revoke credentials.",
            color: "red",
          });
        }
      },
    });
  }

  return (
    <Card withBorder radius="md" p="lg">
      <Stack gap="md">
        <Group justify="space-between" align="flex-start">
          <div>
            <Title order={3}>Credential Management</Title>
            <Text size="sm" c="dimmed">
              Existing credentials cannot be viewed after saving. Enter new
              values only when replacing credentials.
            </Text>
          </div>
          <Badge
            color={credentialStatusColor(account.credential.status)}
            variant="light"
          >
            {account.credential.exists
              ? formatStatus(account.credential.status)
              : "No credentials"}
          </Badge>
        </Group>

        <Alert color="blue" title="Credential safety">
          API key and secret values are submitted only to the backend credential
          endpoint. They are cleared from this form after a successful save and
          are never prefilled.
        </Alert>

        {account.environment === "LIVE" && (
          <Alert color="red" title="Live credential risk">
            Live account credentials can access real funds. Verification does
            not enable trading automatically.
          </Alert>
        )}

        <SimpleGrid cols={{ base: 1, md: 2 }}>
          <PasswordInput
            label="API key"
            value={draft.apiKey}
            onChange={(event) => {
              const value = event.currentTarget.value;

              setDraft((current) => ({
                ...current,
                apiKey: value,
              }));
            }}
            disabled={credentialBusy}
            autoComplete="off"
          />

          <PasswordInput
            label="API secret"
            value={draft.apiSecret}
            onChange={(event) => {
              const value = event.currentTarget.value;

              setDraft((current) => ({
                ...current,
                apiSecret: value,
              }));
            }}
            disabled={credentialBusy}
            autoComplete="off"
          />
        </SimpleGrid>

        <Group justify="space-between" align="flex-start">
          <Text size="sm" c="dimmed">
            Verification refreshes broker metadata and credential status, but it
            does not turn on trading or turn off the kill switch.
          </Text>
          <Group>
            <Button
              variant="default"
              onClick={() => setDraft({ apiKey: "", apiSecret: "" })}
              disabled={!hasCredentialDraft || credentialBusy}
            >
              Clear
            </Button>
            <Button
              onClick={saveCredentials}
              loading={upsertMutation.isPending}
              disabled={!canSaveCredential || credentialBusy}
            >
              Save Credentials
            </Button>
            <Button
              variant="light"
              onClick={verifyCredentials}
              loading={verifyMutation.isPending}
              disabled={!account.credential.exists || credentialBusy}
            >
              Verify
            </Button>
            <Button
              color="red"
              variant="light"
              onClick={confirmRevokeCredentials}
              loading={revokeMutation.isPending}
              disabled={!account.credential.exists || credentialBusy}
            >
              Revoke
            </Button>
          </Group>
        </Group>
      </Stack>
    </Card>
  );
}
