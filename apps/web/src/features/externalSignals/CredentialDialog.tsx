import { Alert, Button, Modal, Stack, Text } from "@mantine/core";
import type { Credential } from "./types";
import { CopyValue } from "./components";
import { webhookUrl } from "./api";

export function CredentialDialog({ credential, onClose }: { credential: Credential; onClose: () => void }) {
  return <Modal opened onClose={onClose} title="Save your webhook credential" centered size="lg" closeOnClickOutside={false}>
    <Stack>
      <Text fw={600} style={{ overflowWrap: "anywhere" }}>{credential.source.name}</Text>
      <Alert color="blue">This token is shown only now and cannot be retrieved later. Save it securely before closing. If it is lost, rotate the token to create a replacement.</Alert>
      {credential.rotated && <Text size="sm">The previous token is now invalid. Update the sender with this new credential.</Text>}
      <section><Text size="sm" fw={600} mb="xs">Webhook token</Text><CopyValue value={credential.token} name="Token" secret /></section>
      <section><Text size="sm" fw={600} mb="xs">Webhook URL</Text><CopyValue value={webhookUrl(credential.token)} name="Webhook URL" secret /></section>
      <Text size="xs" c="dimmed">Use POST with the canonical JSON envelope. Never include this credential in the payload or share it in diagnostics.</Text>
      <Button onClick={onClose}>Done — clear credential</Button>
    </Stack>
  </Modal>;
}
