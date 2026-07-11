import { useMemo, useState } from "react";
import { Button, Checkbox, Code, CopyButton, Group, Modal, Select, Stack, Switch, Text, TextInput } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { getAdminToken } from "../../lib/api";
import { useTradingAccounts } from "../tradingAccounts/hooks";
import type { PlatformRole } from "../auth/types";
import { useCreateUserInvitation } from "./hooks";
import { platformRoleLabels } from "./roleLabels";
import type { UserSetupLink } from "./types";

const roleOptions = (Object.entries(platformRoleLabels) as [PlatformRole, string][]).map(([value, label]) => ({ value, label }));

export function CreateUserInviteModal({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  const accountsQuery = useTradingAccounts(getAdminToken());
  const createInvitation = useCreateUserInvitation();
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [platformRole, setPlatformRole] = useState<PlatformRole>("ACCOUNT_USER");
  const [enabled, setEnabled] = useState(true);
  const [tradingAccountIds, setTradingAccountIds] = useState<number[]>([]);
  const [setupLink, setSetupLink] = useState<UserSetupLink | null>(null);
  const setupUrl = useMemo(() => setupLink ? new URL(setupLink.setupPath, window.location.origin).toString() : "", [setupLink]);

  function close() {
    setEmail(""); setName(""); setPlatformRole("ACCOUNT_USER"); setEnabled(true); setTradingAccountIds([]); setSetupLink(null); onClose();
  }

  function toggleAccount(id: number, checked: boolean) {
    setTradingAccountIds((current) => checked ? [...new Set([...current, id])] : current.filter((value) => value !== id));
  }

  async function submit() {
    try {
      const result = await createInvitation.mutateAsync({ email: email.trim(), name: name.trim() || null, platformRole, enabled, tradingAccountIds });
      setSetupLink(result.setupLink);
      notifications.show({ title: "Invite created", message: "Setup link is ready to copy", color: "green" });
    } catch (error) {
      notifications.show({ title: "Invite failed", message: error instanceof Error ? error.message : "Failed to create invite", color: "red" });
    }
  }

  return <Modal opened={opened} onClose={close} title="Create User Invite" size="lg" centered><Stack>
    <TextInput label="Email" value={email} onChange={(event) => setEmail(event.currentTarget.value)} disabled={Boolean(setupLink)} required />
    <TextInput label="Name" value={name} onChange={(event) => setName(event.currentTarget.value)} disabled={Boolean(setupLink)} />
    <Select label="Platform Role" data={roleOptions} value={platformRole} onChange={(value) => setPlatformRole((value as PlatformRole) || "ACCOUNT_USER")} disabled={Boolean(setupLink)} />
    <Switch label="Enabled" checked={enabled} onChange={(event) => setEnabled(event.currentTarget.checked)} disabled={Boolean(setupLink)} />
    <Stack gap="xs"><Text fw={600} size="sm">Trading Account memberships</Text><Text c="dimmed" size="xs">Memberships determine explicit account scope. System Owners retain unrestricted scope.</Text>
      {accountsQuery.data?.accounts.map((account) => <Checkbox key={account.id} label={account.displayName} checked={tradingAccountIds.includes(account.id)} onChange={(event) => toggleAccount(account.id, event.currentTarget.checked)} disabled={Boolean(setupLink)} />)}
    </Stack>
    {setupLink ? <><Code block>{setupUrl}</Code><CopyButton value={setupUrl}>{({ copied, copy }) => <Button onClick={copy}>{copied ? "Copied" : "Copy Setup Link"}</Button>}</CopyButton></> : <Group justify="flex-end"><Button variant="default" onClick={close}>Cancel</Button><Button onClick={submit} loading={createInvitation.isPending} disabled={!email.trim()}>Create Invite</Button></Group>}
  </Stack></Modal>;
}
