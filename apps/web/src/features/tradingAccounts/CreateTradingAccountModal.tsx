import { useMemo, useState } from "react";
import { Alert, Badge, Box, Button, Checkbox, Group, Modal, NumberInput, Paper, Radio, Select, Stack, Text, TextInput, Textarea } from "@mantine/core";
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
        <Stack mt="xs" gap="sm">
          {(["PAPER", "LIVE"] as const).map((value) => {
            const existing = occupied(value);
            const disabled = !holderId || Boolean(existing);
            const selected = environment === value;
            const isLive = value === "LIVE";

            return (
              <Paper
                key={value}
                component="label"
                withBorder
                radius="md"
                p="md"
                style={{
                  cursor: disabled ? "not-allowed" : "pointer",
                  borderColor: selected ? (isLive ? "var(--mantine-color-red-6)" : "var(--mantine-color-cyan-6)") : undefined,
                  backgroundColor: selected ? (isLive ? "var(--mantine-color-red-light)" : "var(--mantine-color-cyan-light)") : undefined,
                  opacity: disabled ? 0.55 : 1,
                  transition: "border-color 120ms ease, background-color 120ms ease",
                }}
              >
                <Group align="flex-start" wrap="nowrap">
                  <Radio
                    value={value}
                    disabled={disabled}
                    aria-label={`${isLive ? "Live" : "Paper"} environment`}
                    styles={{ root: { position: "absolute", opacity: 0, pointerEvents: "none" } }}
                  />
                  <Box
                    mt={2}
                    mr="xs"
                    aria-hidden="true"
                    style={{
                      width: 22,
                      height: 22,
                      flex: "0 0 22px",
                      borderRadius: "50%",
                      border: `2px solid ${selected ? (isLive ? "var(--mantine-color-red-6)" : "var(--mantine-color-cyan-6)") : "var(--mantine-color-dark-3)"}`,
                      backgroundColor: selected ? (isLive ? "var(--mantine-color-red-6)" : "var(--mantine-color-cyan-6)") : "transparent",
                      display: "grid",
                      placeItems: "center",
                    }}
                  >
                    {selected && (
                      <Box
                        style={{
                          width: 8,
                          height: 8,
                          borderRadius: "50%",
                          backgroundColor: "var(--mantine-color-white)",
                        }}
                      />
                    )}
                  </Box>
                  <Stack gap={4} style={{ flex: 1 }}>
                    <Group justify="space-between" gap="xs">
                      <Text fw={600}>{isLive ? "Live" : "Paper"}</Text>
                      <Badge color={existing ? "gray" : isLive ? "red" : "cyan"} variant={selected ? "filled" : "light"}>
                        {existing ? "Already created" : holderId ? "Available" : "Select a holder"}
                      </Badge>
                    </Group>
                    <Text size="sm" c="dimmed">
                      {existing
                        ? `${existing.displayName} already uses this environment.`
                        : isLive
                          ? "Funded brokerage environment for real-money trading after configuration and deliberate enablement."
                          : "Simulated Alpaca environment for paper trading without real funds."}
                    </Text>
                  </Stack>
                </Group>
              </Paper>
            );
          })}
        </Stack>
      </Radio.Group>
      <Alert color="blue" title="Permanent selection">A Trading Account cannot be changed between Paper and Live after it is created. To use the other environment, create a separate Trading Account.</Alert>
      {bothOccupied && <Alert color="orange">This User already has both available Alpaca TradingAccounts.</Alert>}
      {environment === "LIVE" && <Checkbox checked={liveAcknowledged} onChange={(event) => setLiveAcknowledged(event.currentTarget.checked)} label="I understand that this account uses live brokerage credentials, the environment cannot be changed, and live orders can use real funds." />}
      <NumberInput label="Estimated trading capital" min={0} decimalScale={2} value={capital} onChange={setCapital} />
      <NumberInput label="Maximum deployable notional" min={0.01} decimalScale={2} value={notional} onChange={setNotional} />
      <Textarea label="Notes" value={notes} onChange={(event) => setNotes(event.currentTarget.value)} autosize minRows={3} />
      <Group justify="flex-end"><Button variant="default" onClick={resetAndClose}>Cancel</Button><Button onClick={submit} loading={createAccount.isPending} disabled={bothOccupied || (environment === "LIVE" && !liveAcknowledged)}>Create Trading Account</Button></Group>
    </Stack>
  </Modal>;
}
