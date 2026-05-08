import React, { useState, Fragment } from "react";
import {
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  Group,
  Loader,
  ScrollArea,
  Select,
  SimpleGrid,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { getAdminToken } from "../../lib/api";
import { useSecurities, useCreateSecurity, useUpdateSecurity } from "./hooks";
import { ASSET_TYPES } from "./types";
import type { Security, SecurityForm } from "./types";

const EMPTY_FORM: SecurityForm = {
  symbol: "",
  name: "",
  assetType: "STOCK",
  sector: "",
  industry: "",
  enabled: true,
};

function securityToForm(security: Security): SecurityForm {
  return {
    symbol: security.symbol,
    name: security.name,
    assetType: security.assetType,
    sector: security.sector ?? "",
    industry: security.industry ?? "",
    enabled: security.enabled,
  };
}

type SecurityEditorProps = {
  form: SecurityForm;
  setForm: React.Dispatch<React.SetStateAction<SecurityForm>>;
  onSave: () => void;
  onCancel: () => void;
  isCreating: boolean;
  isSaving: boolean;
};

function SecurityEditor({ form, setForm, onSave, onCancel, isCreating, isSaving }: SecurityEditorProps) {
  function field<K extends keyof SecurityForm>(key: K) {
    return (value: SecurityForm[K]) => setForm((f) => ({ ...f, [key]: value }));
  }

  return (
    <Stack gap="md" p="sm" style={{ background: "var(--mantine-color-dark-7)", borderRadius: "var(--mantine-radius-md)" }}>
      <SimpleGrid cols={{ base: 1, sm: 2, md: 3 }} spacing="sm">
        <TextInput
          label="Symbol"
          value={form.symbol}
          disabled={!isCreating}
          onChange={(e) => field("symbol")(e.currentTarget.value.toUpperCase())}
          size="sm"
        />
        <TextInput
          label="Name"
          value={form.name}
          onChange={(e) => field("name")(e.currentTarget.value)}
          size="sm"
        />
        <Select
          label="Asset Type"
          data={ASSET_TYPES}
          value={form.assetType}
          onChange={(v) => field("assetType")(v ?? form.assetType)}
          size="sm"
        />
        <TextInput
          label="Sector"
          value={form.sector}
          onChange={(e) => field("sector")(e.currentTarget.value)}
          size="sm"
        />
        <TextInput
          label="Industry"
          value={form.industry}
          onChange={(e) => field("industry")(e.currentTarget.value)}
          size="sm"
        />
      </SimpleGrid>

      <Group gap="sm" align="center">
        <Checkbox
          label="Enabled"
          checked={form.enabled}
          onChange={(e) => field("enabled")(e.currentTarget.checked)}
          size="sm"
        />
      </Group>

      <Group gap="sm">
        <Button size="sm" color="cyan" loading={isSaving} onClick={onSave}>
          Save
        </Button>
        <Button size="sm" variant="subtle" onClick={onCancel}>
          Cancel
        </Button>
      </Group>
    </Stack>
  );
}

export function SecuritiesPage() {
  const [token] = useState<string | null>(() => getAdminToken());
  const [creatingSecurity, setCreatingSecurity] = useState(false);
  const [editingSymbol, setEditingSymbol] = useState<string | null>(null);
  const [form, setForm] = useState<SecurityForm>(EMPTY_FORM);

  const { data: securities = [], isLoading, isError, error } = useSecurities(token);
  const createMutation = useCreateSecurity(token);
  const updateMutation = useUpdateSecurity(token);

  function startCreating() {
    setCreatingSecurity(true);
    setEditingSymbol(null);
    setForm(EMPTY_FORM);
  }

  function startEditing(security: Security) {
    setCreatingSecurity(false);
    setEditingSymbol(security.symbol);
    setForm(securityToForm(security));
  }

  function cancelForm() {
    setCreatingSecurity(false);
    setEditingSymbol(null);
  }

  async function handleSave() {
    const symbol = form.symbol.trim().toUpperCase();
    const name = form.name.trim();

    if (!symbol) { notifications.show({ message: "Symbol is required.", color: "red" }); return; }
    if (!name) { notifications.show({ message: "Name is required.", color: "red" }); return; }

    const commonFields = {
      name,
      assetType: form.assetType as Security["assetType"],
      sector: form.sector.trim() || undefined,
      industry: form.industry.trim() || undefined,
      enabled: form.enabled,
    };

    try {
      if (editingSymbol !== null) {
        await updateMutation.mutateAsync({ symbol: editingSymbol, payload: commonFields });
        notifications.show({ message: `Security updated: ${editingSymbol}`, color: "teal" });
      } else {
        await createMutation.mutateAsync({ symbol, ...commonFields });
        notifications.show({ message: `Security added: ${symbol}`, color: "teal" });
      }
      cancelForm();
    } catch (err) {
      notifications.show({
        message: err instanceof Error ? err.message : "Failed to save security.",
        color: "red",
      });
    }
  }

  const isSaving = createMutation.isPending || updateMutation.isPending;

  return (
    <Stack gap="lg">
      <Group justify="space-between" align="flex-end">
        <div>
          <Title order={2} size="h3">Securities</Title>
          <Text size="sm" c="dimmed">Manage the symbol registry for trading.</Text>
        </div>
        <Button size="sm" color="cyan" onClick={startCreating} disabled={creatingSecurity}>
          Add Security
        </Button>
      </Group>

      {creatingSecurity && (
        <SecurityEditor
          form={form}
          setForm={setForm}
          onSave={handleSave}
          onCancel={cancelForm}
          isCreating
          isSaving={isSaving}
        />
      )}

      <Card withBorder radius="md" p="md">
        {isError && (
          <Alert color="red" mb="md">
            {error instanceof Error ? error.message : "Failed to load securities."}
          </Alert>
        )}

        {isLoading && (
          <Group gap="sm">
            <Loader size="sm" color="cyan" />
            <Text size="sm" c="dimmed">Loading securities…</Text>
          </Group>
        )}

        {!isLoading && securities.length === 0 && (
          <Text size="sm" c="dimmed">No securities.</Text>
        )}

        {securities.length > 0 && (
          <ScrollArea>
            <Table striped highlightOnHover style={{ minWidth: 600 }}>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Symbol</Table.Th>
                  <Table.Th>Name</Table.Th>
                  <Table.Th>Type</Table.Th>
                  <Table.Th>Sector</Table.Th>
                  <Table.Th>Status</Table.Th>
                  <Table.Th />
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {securities.map((security) => (
                  <Fragment key={security.symbol}>
                    <Table.Tr>
                      <Table.Td fw={600}>{security.symbol}</Table.Td>
                      <Table.Td>{security.name}</Table.Td>
                      <Table.Td>
                        <Badge size="sm" color="blue" variant="light">{security.assetType}</Badge>
                      </Table.Td>
                      <Table.Td>
                        <Text size="sm" c="dimmed">{security.sector ?? "—"}</Text>
                      </Table.Td>
                      <Table.Td>
                        <Badge size="sm" color={security.enabled ? "teal" : "gray"} variant="light">
                          {security.enabled ? "Enabled" : "Disabled"}
                        </Badge>
                      </Table.Td>
                      <Table.Td>
                        <Button
                          size="xs"
                          variant="subtle"
                          onClick={() => editingSymbol === security.symbol ? cancelForm() : startEditing(security)}
                        >
                          {editingSymbol === security.symbol ? "Cancel" : "Edit"}
                        </Button>
                      </Table.Td>
                    </Table.Tr>

                    {editingSymbol === security.symbol && (
                      <Table.Tr>
                        <Table.Td colSpan={6} style={{ padding: "8px 0" }}>
                          <SecurityEditor
                            form={form}
                            setForm={setForm}
                            onSave={handleSave}
                            onCancel={cancelForm}
                            isCreating={false}
                            isSaving={isSaving}
                          />
                        </Table.Td>
                      </Table.Tr>
                    )}
                  </Fragment>
                ))}
              </Table.Tbody>
            </Table>
          </ScrollArea>
        )}
      </Card>
    </Stack>
  );
}
