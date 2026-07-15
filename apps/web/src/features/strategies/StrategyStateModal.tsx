import { Alert, Button, Group, Loader, Modal, Stack, Text } from "@mantine/core";

import type { StrategyChangeImpact } from "./types";

export function StrategyStateModal({
  opened,
  strategyName,
  nextEnabled,
  impact,
  loading,
  pending,
  error,
  onClose,
  onConfirm,
}: {
  opened: boolean;
  strategyName: string;
  nextEnabled: boolean;
  impact: StrategyChangeImpact | undefined;
  loading: boolean;
  pending: boolean;
  error: string | null;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={`${nextEnabled ? "Enable" : "Disable"} ${strategyName}?`}
      centered
      size="lg"
      closeOnClickOutside={!pending}
      closeOnEscape={!pending}
    >
      <Stack gap="md">
        {loading && <Group gap="sm"><Loader size="sm" /><Text size="sm">Loading current impact...</Text></Group>}
        {error && <Alert color="red">{error}</Alert>}
        {impact && (
          <>
            <Text size="sm">
              This strategy is linked to <strong>{impact.totalSubscriptions}</strong> subscriptions.
              {" "}<strong>{impact.enabledSubscriptions}</strong> are currently enabled and{" "}
              <strong>{impact.disabledSubscriptions}</strong> will remain disabled.
            </Text>
            {nextEnabled ? (
              <Text size="sm">
                Enabling may make individually enabled momentum subscriptions eligible for
                price confirmation and handoff processing when their account and allocation
                configuration also qualifies.
              </Text>
            ) : (
              <Text size="sm">
                Enabled momentum subscriptions using this strategy will immediately become
                ineligible for price confirmation and handoff processing.
              </Text>
            )}
            <Alert color="blue" variant="light">
              No subscriptions will be enabled, disabled, or otherwise changed. No signal or
              order will be created by this action.
            </Alert>
          </>
        )}
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose} disabled={pending}>Cancel</Button>
          <Button
            color={nextEnabled ? "teal" : "red"}
            onClick={onConfirm}
            loading={pending}
            disabled={!impact || loading}
          >
            Confirm {nextEnabled ? "enable" : "disable"}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
