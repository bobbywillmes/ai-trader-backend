import { useEffect, useMemo, useState } from "react";
import { Button, Checkbox, Code, CopyButton, Drawer, Group, Select, Stack, Switch, Text, TextInput } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { getAdminToken } from "../../lib/api";
import { useTradingAccounts } from "../tradingAccounts/hooks";
import type { PlatformRole } from "../auth/types";
import { useRegenerateUserSetupLink, useReplaceUserTradingAccountMemberships, useUpdateUser, useUser, useUserTradingAccountMemberships } from "./hooks";
import { platformRoleLabels } from "./roleLabels";
import type { UserSetupLink } from "./types";

const roleOptions = (Object.entries(platformRoleLabels) as [PlatformRole, string][]).map(([value, label]) => ({ value, label }));

export function UserDetailDrawer({ userId, onClose }: { userId: number | null; onClose: () => void }) {
  const userQuery = useUser(userId);
  const membershipsQuery = useUserTradingAccountMemberships(userId);
  const accountsQuery = useTradingAccounts(getAdminToken());
  const updateUser = useUpdateUser();
  const replaceMemberships = useReplaceUserTradingAccountMemberships();
  const regenerateLink = useRegenerateUserSetupLink();
  const [name, setName] = useState("");
  const [platformRole, setPlatformRole] = useState<PlatformRole>("ACCOUNT_USER");
  const [enabled, setEnabled] = useState(true);
  const [tradingAccountIds, setTradingAccountIds] = useState<number[]>([]);
  const [setupLink, setSetupLink] = useState<UserSetupLink | null>(null);
  const setupUrl = useMemo(() => setupLink ? new URL(setupLink.setupPath, window.location.origin).toString() : "", [setupLink]);

  useEffect(() => { if (userQuery.data) {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setName(userQuery.data.name ?? ""); setPlatformRole(userQuery.data.platformRole); setEnabled(userQuery.data.enabled);
  } }, [userQuery.data]);
  useEffect(() => { if (membershipsQuery.data) {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTradingAccountIds(membershipsQuery.data.map((membership) => membership.tradingAccountId));
  } }, [membershipsQuery.data]);

  function toggleAccount(id: number, checked: boolean) {
    setTradingAccountIds((current) => checked ? [...new Set([...current, id])] : current.filter((value) => value !== id));
  }

  async function save() {
    if (!userId) return;
    try {
      await updateUser.mutateAsync({ id: userId, data: { name: name.trim() || null, platformRole, enabled } });
      await replaceMemberships.mutateAsync({ userId, data: { tradingAccountIds } });
      notifications.show({ title: "User updated", message: "Platform access and memberships were saved", color: "green" });
    } catch (error) {
      notifications.show({ title: "Update failed", message: error instanceof Error ? error.message : "Failed to update user", color: "red" });
    }
  }

  async function regenerate() { if (!userId) return; try { const result = await regenerateLink.mutateAsync(userId); setSetupLink(result.setupLink); } catch (error) { notifications.show({ title: "Setup link failed", message: error instanceof Error ? error.message : "Failed to regenerate setup link", color: "red" }); } }

  return <Drawer opened={userId !== null} onClose={() => { setSetupLink(null); onClose(); }} title="User Details" position="right" size="lg"><Stack>
    {userQuery.data && <><Text fw={600}>{userQuery.data.email}</Text><TextInput label="Name" value={name} onChange={(event) => setName(event.currentTarget.value)} /><Select label="Platform Role" data={roleOptions} value={platformRole} onChange={(value) => setPlatformRole((value as PlatformRole) || "ACCOUNT_USER")} /><Switch label="Enabled" checked={enabled} onChange={(event) => setEnabled(event.currentTarget.checked)} />
    <Stack gap="xs"><Text fw={600} size="sm">Trading Account memberships</Text><Text c="dimmed" size="xs">System Owners have unrestricted scope. Other users are scoped to these explicit memberships.</Text>{accountsQuery.data?.accounts.map((account) => <Checkbox key={account.id} label={account.displayName} checked={tradingAccountIds.includes(account.id)} onChange={(event) => toggleAccount(account.id, event.currentTarget.checked)} />)}</Stack>
    <Group justify="flex-end"><Button onClick={save} loading={updateUser.isPending || replaceMemberships.isPending}>Save Changes</Button></Group>
    {userQuery.data.pendingSetup && <Button variant="light" onClick={regenerate} loading={regenerateLink.isPending}>Regenerate Setup Link</Button>}
    {setupLink && <><Code block>{setupUrl}</Code><CopyButton value={setupUrl}>{({ copied, copy }) => <Button onClick={copy}>{copied ? "Copied" : "Copy Setup Link"}</Button>}</CopyButton></>}
    </>}
  </Stack></Drawer>;
}
