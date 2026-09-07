import { Alert, Badge, Group, Stack, Tabs, Text, Title } from "@mantine/core";
import { IconInfoCircle } from "@tabler/icons-react";
import { useSearchParams } from "react-router-dom";
import { changeExternalParams, readExternalParams, sections } from "./url";
import { getAdminToken } from "../../lib/api";
import { SourcesTab } from "./SourcesTab";
import { BindingsTab } from "./BindingsTab";
import { EvidenceTab } from "./EvidenceTab";
import classes from "./ExternalSignals.module.css";

export function ExternalSignalsPage() {
  const [params, setParams] = useSearchParams();
  const { section } = readExternalParams(params);
  const token = getAdminToken();
  return <main className={classes.page}><Stack gap="lg">
    <div><Title order={2}>External Signals</Title><Text c="dimmed" size="sm">Configure external origins and inspect recognized strategy events.</Text></div>
    <Alert color="blue" variant="light" icon={<IconInfoCircle size={18} />}>External signals are evidence-only in this phase. They cannot create orders or modify positions.</Alert>
    <Tabs value={section} onChange={value => value && setParams(current => changeExternalParams(current, { section: value }))}>
      <div className={classes.tabs}><Tabs.List className={classes.tabList}>{Object.entries(sections).map(([value, label]) => <Tabs.Tab key={value} value={value}>{label}</Tabs.Tab>)}</Tabs.List></div>
      <Group gap="sm" my="md"><Badge variant="light" color={section === "sources" || section === "bindings" ? "gray" : "cyan"}>{section === "sources" || section === "bindings" ? "Configuration" : "Historical evidence"}</Badge><Text size="sm" c="dimmed">{section === "sources" || section === "bindings" ? "Mutable configuration · Changes affect future acceptance." : "Immutable historical evidence · Read-only."}</Text></Group>
      <Tabs.Panel value="sources">{section === "sources" && <SourcesTab token={token} />}</Tabs.Panel>
      <Tabs.Panel value="bindings">{section === "bindings" && <BindingsTab token={token} />}</Tabs.Panel>
      <Tabs.Panel value="signals">{section === "signals" && <EvidenceTab key="signals" section="signals" token={token} />}</Tabs.Panel>
      <Tabs.Panel value="deliveries">{section === "deliveries" && <EvidenceTab key="deliveries" section="deliveries" token={token} />}</Tabs.Panel>
    </Tabs>
  </Stack></main>;
}
