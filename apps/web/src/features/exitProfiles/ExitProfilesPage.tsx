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
import { useExitProfiles, useCreateExitProfile, useUpdateExitProfile } from "./hooks";
import { useSubscriptions } from "../subscriptions/hooks";
import type { ExitProfile, ExitProfileForm } from "./types";

const EMPTY_FORM: ExitProfileForm = {
  key: "",
  name: "",
  description: "",
  targetPct: "",
  stopLossPct: "",
  trailingStopPct: "",
  maxHoldDays: "",
  exitMode: "fixed_bracket",
  takeProfitBehavior: "immediate",
  enabled: true,
};

function exitProfileToForm(profile: ExitProfile): ExitProfileForm {
  return {
    key: profile.key,
    name: profile.name,
    description: profile.description ?? "",
    targetPct: profile.targetPct === null ? "" : String(profile.targetPct),
    stopLossPct: profile.stopLossPct === null ? "" : String(profile.stopLossPct),
    trailingStopPct: profile.trailingStopPct === null ? "" : String(profile.trailingStopPct),
    maxHoldDays: profile.maxHoldDays === null ? "" : String(profile.maxHoldDays),
    exitMode: profile.exitMode,
    takeProfitBehavior: profile.takeProfitBehavior,
    enabled: profile.enabled,
  };
}

function emptyToNumberOrNull(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  if (Number.isNaN(parsed)) throw new Error(`Invalid number: ${value}`);
  return parsed;
}

function emptyToIntOrNull(value: string): number | null {
  const parsed = emptyToNumberOrNull(value);
  if (parsed === null) return null;
  if (!Number.isInteger(parsed)) throw new Error(`Expected whole number: ${value}`);
  return parsed;
}

type ExitProfileEditorProps = {
  form: ExitProfileForm;
  setForm: React.Dispatch<React.SetStateAction<ExitProfileForm>>;
  onSave: () => void;
  onCancel: () => void;
  isCreating: boolean;
  isSaving: boolean;
};

function ExitProfileEditor({ form, setForm, onSave, onCancel, isCreating, isSaving }: ExitProfileEditorProps) {
  function field<K extends keyof ExitProfileForm>(key: K) {
    return (value: ExitProfileForm[K]) => setForm((f) => ({ ...f, [key]: value }));
  }

  return (
    <Stack gap="md" p="sm" style={{ background: "var(--mantine-color-dark-7)", borderRadius: "var(--mantine-radius-md)" }}>
      <SimpleGrid cols={{ base: 1, sm: 2, md: 3 }} spacing="sm">
        <TextInput
          label="Key"
          value={form.key}
          disabled={!isCreating}
          onChange={(e) => field("key")(e.currentTarget.value)}
          size="sm"
        />
        <TextInput
          label="Name"
          value={form.name}
          onChange={(e) => field("name")(e.currentTarget.value)}
          size="sm"
        />
        <TextInput
          label="Description"
          value={form.description}
          onChange={(e) => field("description")(e.currentTarget.value)}
          size="sm"
        />
        <TextInput
          label="Target %"
          placeholder="e.g. 5"
          value={form.targetPct}
          onChange={(e) => field("targetPct")(e.currentTarget.value)}
          size="sm"
        />
        <TextInput
          label="Stop Loss %"
          placeholder="e.g. 3"
          value={form.stopLossPct}
          onChange={(e) => field("stopLossPct")(e.currentTarget.value)}
          size="sm"
        />
        <TextInput
          label="Trailing Stop %"
          placeholder="e.g. 2"
          value={form.trailingStopPct}
          onChange={(e) => field("trailingStopPct")(e.currentTarget.value)}
          size="sm"
        />
        <TextInput
          label="Max Hold Days"
          placeholder="e.g. 10"
          value={form.maxHoldDays}
          onChange={(e) => field("maxHoldDays")(e.currentTarget.value)}
          size="sm"
        />
        <Select
          label="Exit Mode"
          data={[
            { value: "fixed_target", label: "Fixed Target" },
            { value: "fixed_bracket", label: "Fixed Bracket" },
            { value: "hybrid", label: "Hybrid" },
            { value: "ai_assisted", label: "AI Assisted" },
          ]}
          value={form.exitMode}
          onChange={(v) => field("exitMode")(v ?? form.exitMode)}
          size="sm"
        />
        <Select
          label="Take Profit Behavior"
          data={[
            { value: "immediate", label: "Immediate" },
            { value: "trail_after_target", label: "Trail After Target" },
            { value: "ai_confirm", label: "AI Confirm" },
          ]}
          value={form.takeProfitBehavior}
          onChange={(v) => field("takeProfitBehavior")(v ?? form.takeProfitBehavior)}
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

export function ExitProfilesPage() {
  const [token] = useState<string | null>(() => getAdminToken());
  const [creatingProfile, setCreatingProfile] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState<ExitProfileForm>(EMPTY_FORM);

  const { data: exitProfiles = [], isLoading, isError, error } = useExitProfiles(token);
  const { data: subscriptions = [] } = useSubscriptions(token);
  const createMutation = useCreateExitProfile(token);
  const updateMutation = useUpdateExitProfile(token);

  function startCreating() {
    setCreatingProfile(true);
    setEditingId(null);
    setForm(EMPTY_FORM);
  }

  function startEditing(profile: ExitProfile) {
    setCreatingProfile(false);
    setEditingId(profile.id);
    setForm(exitProfileToForm(profile));
  }

  function cancelForm() {
    setCreatingProfile(false);
    setEditingId(null);
  }

  async function handleSave() {
    const key = form.key.trim();
    const name = form.name.trim();

    if (!key) { notifications.show({ message: "Key is required.", color: "red" }); return; }
    if (!name) { notifications.show({ message: "Name is required.", color: "red" }); return; }

    let targetPct, stopLossPct, trailingStopPct, maxHoldDays;
    try {
      targetPct = emptyToNumberOrNull(form.targetPct);
      stopLossPct = emptyToNumberOrNull(form.stopLossPct);
      trailingStopPct = emptyToNumberOrNull(form.trailingStopPct);
      maxHoldDays = emptyToIntOrNull(form.maxHoldDays);
    } catch (err) {
      notifications.show({ message: err instanceof Error ? err.message : "Invalid value.", color: "red" });
      return;
    }

    const commonFields = {
      name,
      description: form.description.trim() || null,
      targetPct,
      stopLossPct,
      trailingStopPct,
      maxHoldDays,
      exitMode: form.exitMode,
      takeProfitBehavior: form.takeProfitBehavior,
      enabled: form.enabled,
    };

    try {
      if (editingId !== null) {
        const matchingProfile = exitProfiles.find((p) => p.id === editingId);
        const usedByEnabled = matchingProfile
          ? subscriptions.filter((s) => s.enabled && s.exitProfile?.key === matchingProfile.key)
          : [];

        if (usedByEnabled.length > 0) {
          const ok = window.confirm(
            `This exit profile is used by ${usedByEnabled.length} enabled subscription(s). Saving will affect live exit behavior. Continue?`
          );
          if (!ok) return;
        }

        await updateMutation.mutateAsync({ id: editingId, payload: commonFields });
        notifications.show({ message: `Exit profile updated: ${key}`, color: "teal" });
      } else {
        await createMutation.mutateAsync({ key, ...commonFields });
        notifications.show({ message: `Exit profile created: ${key}`, color: "teal" });
      }
      cancelForm();
    } catch (err) {
      notifications.show({
        message: err instanceof Error ? err.message : "Failed to save exit profile.",
        color: "red",
      });
    }
  }

  const isSaving = createMutation.isPending || updateMutation.isPending;

  return (
    <Stack gap="lg">
      <Group justify="space-between" align="flex-end">
        <div>
          <Title order={2} size="h3">Exit Profiles</Title>
          <Text size="sm" c="dimmed">View and edit exit profiles.</Text>
        </div>
        <Button size="sm" color="cyan" onClick={startCreating} disabled={creatingProfile}>
          New Profile
        </Button>
      </Group>

      {creatingProfile && (
        <ExitProfileEditor
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
            {error instanceof Error ? error.message : "Failed to load exit profiles."}
          </Alert>
        )}

        {isLoading && (
          <Group gap="sm">
            <Loader size="sm" color="cyan" />
            <Text size="sm" c="dimmed">Loading exit profiles…</Text>
          </Group>
        )}

        {!isLoading && exitProfiles.length === 0 && (
          <Text size="sm" c="dimmed">No exit profiles.</Text>
        )}

        {exitProfiles.length > 0 && (
          <ScrollArea>
            <Table striped highlightOnHover style={{ minWidth: 700 }}>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Key</Table.Th>
                  <Table.Th style={{ textAlign: "right" }}>Target %</Table.Th>
                  <Table.Th style={{ textAlign: "right" }}>Stop %</Table.Th>
                  <Table.Th style={{ textAlign: "right" }}>Trail %</Table.Th>
                  <Table.Th style={{ textAlign: "right" }}>Max Days</Table.Th>
                  <Table.Th>Mode</Table.Th>
                  <Table.Th>Status</Table.Th>
                  <Table.Th />
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {exitProfiles.map((profile) => (
                  <Fragment key={profile.id}>
                    <Table.Tr>
                      <Table.Td>
                        <div>
                          <Text fw={600} size="sm">{profile.key}</Text>
                          {profile.name !== profile.key && (
                            <Text size="xs" c="dimmed">{profile.name}</Text>
                          )}
                        </div>
                      </Table.Td>
                      <Table.Td style={{ textAlign: "right" }}>{profile.targetPct ?? "—"}</Table.Td>
                      <Table.Td style={{ textAlign: "right" }}>{profile.stopLossPct ?? "—"}</Table.Td>
                      <Table.Td style={{ textAlign: "right" }}>{profile.trailingStopPct ?? "—"}</Table.Td>
                      <Table.Td style={{ textAlign: "right" }}>{profile.maxHoldDays ?? "—"}</Table.Td>
                      <Table.Td>
                        <Text size="sm" c="dimmed" tt="capitalize">{profile.exitMode.replace(/_/g, " ")}</Text>
                      </Table.Td>
                      <Table.Td>
                        <Badge size="sm" color={profile.enabled ? "teal" : "gray"} variant="light">
                          {profile.enabled ? "Enabled" : "Disabled"}
                        </Badge>
                      </Table.Td>
                      <Table.Td>
                        <Button
                          size="xs"
                          variant="subtle"
                          onClick={() => editingId === profile.id ? cancelForm() : startEditing(profile)}
                        >
                          {editingId === profile.id ? "Cancel" : "Edit"}
                        </Button>
                      </Table.Td>
                    </Table.Tr>

                    {editingId === profile.id && (
                      <Table.Tr>
                        <Table.Td colSpan={8} style={{ padding: "8px 0" }}>
                          <ExitProfileEditor
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
