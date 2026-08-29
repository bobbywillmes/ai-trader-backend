import {
  Alert,
  Button,
  Card,
  Group,
  Modal,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import { Link } from "react-router-dom";
import { useState } from "react";
import type { RemainingExposureClosePreview } from "./types";

export function RemainingExposureClosePanel({
  preview,
  pending,
  error,
  onConfirm,
}: {
  preview: RemainingExposureClosePreview;
  pending: boolean;
  error: string | null;
  onConfirm: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const account = preview.tradingAccount.id;
  return (
    <Card withBorder aria-label="Remaining broker exposure">
      <Stack gap="xs">
        <Title order={4}>Remaining broker exposure</Title>
        <Text size="sm">
          Tracked quantity: <b>{preview.trackedQuantity ?? "Unavailable"}</b>
        </Text>
        <Text size="sm">
          Previously sold and attributed:{" "}
          <b>{preview.attributedExitFilledQuantity}</b>
        </Text>
        <Text size="sm">
          Expected remaining:{" "}
          <b>{preview.expectedRemainingQuantity ?? "Unavailable"}</b>
        </Text>
        <Text size="sm">
          Alpaca holds:{" "}
          <b>
            {preview.brokerPosition.heldQuantity ?? "Unavailable"}{" "}
            {preview.brokerPosition.side ?? ""}
          </b>
        </Text>
        <Text size="sm">
          Available to sell:{" "}
          <b>{preview.brokerPosition.availableQuantity ?? "Unavailable"}</b>
        </Text>
        <Text size="sm">
          Active orders:{" "}
          <b>
            {preview.activeOrders.length ? preview.activeOrders.length : "None"}
          </b>
        </Text>
        <Text size="xs" c="dimmed">
          Evidence observed: {new Date(preview.observedAt).toLocaleString()}
        </Text>
        {preview.blockingReasons.map((reason) => (
          <Alert key={reason.code} color="orange" title={reason.message}>
            {reason.nextAction}
          </Alert>
        ))}
        {error && (
          <Alert color="red" title="Corrective close was not submitted">
            {error} Refresh the preview and review the latest evidence.
          </Alert>
        )}
        <Group>
          <Button
            component={Link}
            to={`/orders?account=${account}`}
            variant="default"
          >
            Open Orders
          </Button>
          <Button
            component={Link}
            to={`/trading-accounts/${account}/reconciliation`}
            variant="default"
          >
            Reconciliation
          </Button>
          {preview.blockingReasons.some(
            (reason) => reason.code === "LIVE_AUTHORITY_REQUIRED",
          ) && (
            <Button
              component={Link}
              to={`/trading-accounts/${account}?tab=readiness`}
              variant="light"
            >
              Readiness
            </Button>
          )}
        </Group>
        {preview.eligible && preview.canExecute && (
          <Button onClick={() => setConfirming(true)}>
            Close remaining {preview.expectedRemainingQuantity} shares
          </Button>
        )}
        {preview.eligible && !preview.canExecute && (
          <Alert color="blue">
            You may inspect this verified action, but only a System Owner can
            execute it.
          </Alert>
        )}
      </Stack>
      <Modal
        opened={confirming}
        onClose={() => setConfirming(false)}
        title={`Close remaining ${preview.expectedRemainingQuantity} shares?`}
      >
        <Stack>
          <Text>
            This submits a market sell-to-close order for the entire remaining
            broker position. Broker quantity, attributed fills, active orders,
            market state and authorization will be verified again before
            submission. Existing orders will not be cancelled automatically.
          </Text>
          <Button loading={pending} onClick={onConfirm}>
            Confirm corrective close
          </Button>
        </Stack>
      </Modal>
    </Card>
  );
}
