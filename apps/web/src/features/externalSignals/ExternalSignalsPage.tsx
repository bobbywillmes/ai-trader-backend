import { Alert, Stack, Tabs, Text, Title } from "@mantine/core";
import { IconInfoCircle } from "@tabler/icons-react";
import { useSearchParams } from "react-router-dom";
import { changeExternalParams, readExternalParams, sections } from "./url";

export function ExternalSignalsPage() {
  const [params, setParams] = useSearchParams();
  const { section } = readExternalParams(params);
  return <main><Stack gap="lg">
    <div><Title order={2}>External Signals</Title><Text c="dimmed" size="sm">Configure external origins and inspect recognized strategy events.</Text></div>
    <Alert color="blue" variant="light" icon={<IconInfoCircle size={18} />}>External signals are evidence-only in this phase. They cannot create orders or modify positions.</Alert>
    <Tabs value={section} onChange={value => value && setParams(current => changeExternalParams(current, { section: value }))}>
      <Tabs.List>{Object.entries(sections).map(([value, label]) => <Tabs.Tab key={value} value={value}>{label}</Tabs.Tab>)}</Tabs.List>
    </Tabs>
    <Text size="sm" c="dimmed">{section === "sources" || section === "bindings" ? "Mutable configuration · Changes affect future acceptance." : "Immutable historical evidence · Read-only."}</Text>
  </Stack></main>;
}
