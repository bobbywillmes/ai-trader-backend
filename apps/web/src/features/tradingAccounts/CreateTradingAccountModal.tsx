import { useMemo, useState } from "react";
import { Alert, Button, Checkbox, Group, Modal, NumberInput, Radio, Select, Stack, Text, TextInput, Textarea } from "@mantine/core";
import { useNavigate } from "react-router-dom";
import { useUsers } from "../users/hooks";
import type { TradingAccount, TradingAccountEnvironment } from "./types";
import { useCreateTradingAccount } from "./hooks";
import { getOccupiedAlpacaAccount } from "./availability";

type Props = { opened: boolean; onClose: () => void; token: string | null; accounts: TradingAccount[] };

export function CreateTradingAccountModal({ opened, onClose, token, accounts }: Props) {
  const navigate = useNavigate();
  const users = useUsers();
  const createAccount = useCreateTradingAccount(token);
  const [holderId, setHolderId] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [environment, setEnvironment] = useState<TradingAccountEnvironment | null>(null);
  const [capital, setCapital] = useState<string | number>("");
  const [notional, setNotional] = useState<string | number>("");
  const [notes, setNotes] = useState("");
  const [liveAcknowledged, setLiveAcknowledged] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const held = useMemo(() => accounts.filter((account) => String(account.accountHolderUserId) === holderId), [accounts, holderId]);
  const occupied = (value: TradingAccountEnvironment) => holderId ? getOccupiedAlpacaAccount(held, Number(holderId), value) : undefined;
  const bothOccupied = Boolean(occupied("PAPER") && occupied("LIVE"));

  function resetAndClose() {
    setHolderId(null); setDisplayName(""); setEnvironment(null); setCapital(""); setNotional(""); setNotes(""); setLiveAcknowledged(false); setError(null); onClose();
  }

  async function submit() {
    setError(null);
    if (!holderId) return setError("Account holder is required.");
    if (!displayName.trim()) return setError("Display name is required.");
    if (!environment) return setError("Environment selection is required.");
    if (occupied(environment)) return setError(`This User already has an Alpaca ${environment === "PAPER" ? "Paper" : "Live"} Trading Account.`);
    if (environment === "LIVE" && !liveAcknowledged) return setError("Acknowledge the live-account warning before creating this account.");
    try {
      const result = await createAccount.mutateAsync({
        accountHolderUserId: Number(holderId), displayName: displayName.trim(), environment,
        estimatedTradingCapital: capital === "" ? null : Number(capital),
        maxDeployableNotional: notional === "" ? null : Number(notional), notes: notes.trim() || null,
      });
      resetAndClose();
      navigate(`/trading-accounts/${result.account.id}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to create Trading Account.");
    }
  }

  return <Modal opened={opened} onClose={resetAndClose} title="New Trading Account" size="lg" closeOnClickOutside={!createAccount.isPending}>
    <Stack>
      {error && <Alert color="red">{error}</Alert>}
      <Select label="Account holder" required searchable value={holderId} onChange={(value) => { setHolderId(value); setEnvironment(null); }} data={(users.data ?? []).filter((user) => user.enabled).map((user) => ({ value: String(user.id), label: user.name ? `${user.name} (${user.email})` : user.email }))} />
      <TextInput label="Display name" required value={displayName} onChange={(event) => setDisplayName(event.currentTarget.value)} />
      <TextInput label="Broker" value="Alpaca" readOnly />
      <Radio.Group label="Environment" required value={environment ?? ""} onChange={(value) => { setEnvironment(value as TradingAccountEnvironment); if (value !== "LIVE") setLiveAcknowledged(false); }}>
        <Stack mt="xs">
          {(["PAPER", "LIVE"] as const).map((value) => { const existing = occupied(value); return <Radio key={value} value={value} disabled={!holderId || Boolean(existing)} label={`${value === "PAPER" ? "Paper" : "Live"} — ${existing ? `Already created: ${existing.displayName}` : "Available"}`} />; })}
        </Stack>
      </Radio.Group>
      <Alert color="blue" title="Permanent selection">A Trading Account cannot be changed between Paper and Live after it is created. To use the other environment, create a separate Trading Account.</Alert>
      <Text size="sm" c="dimmed">Paper uses Alpaca’s simulated paper-trading environment. Live uses a funded Alpaca brokerage account and can submit real-money orders after the account is fully configured and trading is deliberately enabled.</Text>
      {bothOccupied && <Alert color="orange">This User already has both available Alpaca TradingAccounts.</Alert>}
      {environment === "LIVE" && <Checkbox checked={liveAcknowledged} onChange={(event) => setLiveAcknowledged(event.currentTarget.checked)} label="I understand that this account uses live brokerage credentials, the environment cannot be changed, and live orders can use real funds." />}
      <NumberInput label="Estimated trading capital" min={0} decimalScale={2} value={capital} onChange={setCapital} />
      <NumberInput label="Maximum deployable notional" min={0.01} decimalScale={2} value={notional} onChange={setNotional} />
      <Textarea label="Notes" value={notes} onChange={(event) => setNotes(event.currentTarget.value)} autosize minRows={3} />
      <Group justify="flex-end"><Button variant="default" onClick={resetAndClose}>Cancel</Button><Button onClick={submit} loading={createAccount.isPending} disabled={bothOccupied || (environment === "LIVE" && !liveAcknowledged)}>Create Trading Account</Button></Group>
    </Stack>
  </Modal>;
}
