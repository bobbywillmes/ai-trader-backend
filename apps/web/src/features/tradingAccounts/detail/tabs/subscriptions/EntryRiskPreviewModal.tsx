import { Alert, Button, Group, Modal, SimpleGrid, Stack, Text } from "@mantine/core";
import type { EntryRiskPreview } from "../../../types";
import {
  formatDateTime,
  formatMoney,
  formatQuantity,
  formatStatus,
} from "../../utils/formatters";
import { PreviewMetric } from "./MarketContextCell";
import { previewLayerLabel, previewSessionLabel, sizingTypeLabel } from "./utils";

export function EntryRiskPreviewModal({
  currency,
  onClose,
  preview,
}: {
  currency: string;
  onClose: () => void;
  preview: EntryRiskPreview | null;
}) {
  const allowed = preview?.ok ?? false;
  const blockingLayer =
    preview?.blockingLayer ??
    preview?.risk.layer ??
    (preview && !preview.allocationRisk.ok ? preview.allocationRisk.layer : null);
  const blockingCode =
    preview?.blockingCode ??
    preview?.risk.code ??
    (preview && !preview.allocationRisk.ok ? preview.allocationRisk.code : null);
  const blockingMessage =
    preview?.risk.message ??
    (preview && !preview.allocationRisk.ok
      ? preview.allocationRisk.message
      : null) ??
    preview?.sizing.message;

  return (
    <Modal
      opened={preview !== null}
      onClose={onClose}
      title={
        preview
          ? `Entry risk preview: ${preview.subscription.symbol} / ${preview.subscription.key}`
          : "Entry risk preview"
      }
      size="lg"
      centered
    >
      {preview && (
        <Stack gap="md">
          <Alert
            color={allowed ? "teal" : "red"}
            title={allowed ? "Allowed" : "Blocked"}
          >
            {allowed
              ? "Sizing and risk checks allow this entry when session timing is ignored."
              : blockingMessage ??
                "A sizing, risk, or allocation layer blocked this preview."}
          </Alert>

          <Alert color="blue" title="Dry run only">
            No order intent will be created and no broker order will be
            submitted.
          </Alert>

          <SimpleGrid cols={{ base: 1, sm: 2 }}>
            <PreviewMetric
              label="Blocking layer"
              value={previewLayerLabel(blockingLayer)}
            />
            <PreviewMetric label="Block code" value={blockingCode ?? "-"} />
            <PreviewMetric
              label="Calculated quantity"
              value={formatQuantity(preview.sizing.calculatedQty)}
            />
            <PreviewMetric
              label="Estimated notional"
              value={formatMoney(preview.sizing.estimatedNotional, currency)}
            />
            <PreviewMetric
              label="Latest price"
              value={formatMoney(preview.sizing.latestPrice, currency)}
            />
            <PreviewMetric
              label="Latest price source"
              value={preview.sizing.latestPriceSource ?? "-"}
            />
            <PreviewMetric
              label="Latest price time"
              value={formatDateTime(preview.sizing.latestPriceAt)}
            />
            <PreviewMetric
              label="Sizing type"
              value={
                preview.sizing.sizingType
                  ? sizingTypeLabel(preview.sizing.sizingType)
                  : "-"
              }
            />
          </SimpleGrid>

          {preview.accountUsage && (
            <>
              <Text fw={600}>Account exposure</Text>
              <SimpleGrid cols={{ base: 1, sm: 2, lg: 4 }}>
                <PreviewMetric
                  label="Open exposure"
                  value={formatMoney(
                    preview.accountUsage.openPositionNotional,
                    currency
                  )}
                />
                <PreviewMetric
                  label="Pending entry exposure"
                  value={formatMoney(
                    preview.accountUsage.pendingEntryNotional,
                    currency
                  )}
                />
                <PreviewMetric
                  label="Current account exposure"
                  value={formatMoney(
                    preview.accountUsage.currentAccountExposure,
                    currency
                  )}
                />
                <PreviewMetric
                  label="Projected account exposure"
                  value={formatMoney(
                    preview.accountUsage.projectedAccountExposure,
                    currency
                  )}
                />
              </SimpleGrid>
            </>
          )}

          {preview.effectiveEntryLimits && (
            <>
              <Text fw={600}>Effective account limits</Text>
              <SimpleGrid cols={{ base: 1, sm: 2 }}>
                {Object.entries(preview.effectiveEntryLimits.limits).map(
                  ([field, limit]) => (
                    <PreviewMetric
                      key={field}
                      label={`${formatStatus(field)} (${limit.source === "ACCOUNT" ? "Account" : "Legacy fallback"})`}
                      value={
                        field === "maxDailyEntryOrders" || field === "maxOpenPositions"
                          ? formatQuantity(limit.value)
                          : formatMoney(limit.value, currency)
                      }
                    />
                  )
                )}
                <PreviewMetric
                  label="Max deployable notional (Trading Account)"
                  value={formatMoney(
                    preview.effectiveEntryLimits.authoritativeTotalExposure.value,
                    currency
                  )}
                />
              </SimpleGrid>
            </>
          )}

          <SimpleGrid cols={{ base: 1, sm: 2 }}>
            <PreviewMetric
              label="Account subscription"
              value={
                preview.accountSubscription
                  ? preview.accountSubscription.enabled
                    ? "Active"
                    : "Disabled"
                  : "Missing"
              }
            />
            <PreviewMetric
              label="Entries"
              value={
                preview.accountSubscription
                  ? preview.accountSubscription.entriesEnabled
                    ? "Enabled"
                    : "Disabled"
                  : "-"
              }
            />
            <PreviewMetric
              label="Allocation"
              value={preview.allocation ? preview.allocation.name : "Unassigned"}
            />
            <PreviewMetric
              label="Allocation status"
              value={
                preview.allocation
                  ? preview.allocation.enabled
                    ? "Enabled"
                    : "Disabled"
                  : "-"
              }
            />
            <PreviewMetric
              label="Allocation risk"
              value={
                preview.allocationRisk.checked
                  ? preview.allocationRisk.ok
                    ? "Pass"
                    : "Blocked"
                  : "Not assigned"
              }
            />
            <PreviewMetric
              label="Allocation block code"
              value={preview.allocationRisk.code ?? "-"}
            />
            <PreviewMetric
              label="Max allocated notional"
              value={formatMoney(
                preview.allocation?.maxAllocatedNotional,
                currency
              )}
            />
            <PreviewMetric
              label="Max position notional"
              value={formatMoney(
                preview.allocation?.maxPositionNotional,
                currency
              )}
            />
            <PreviewMetric
              label="Max open positions"
              value={formatQuantity(preview.allocation?.maxOpenPositions)}
            />
          </SimpleGrid>

          {preview.allocationRisk.checked && !preview.allocationRisk.ok && (
            <Alert color="red" title="Parent allocation would block">
              {preview.allocationRisk.message ??
                "An allocation-level rule would block this entry."}
            </Alert>
          )}

          <Alert
            color={preview.session.wouldBlockRealEntryNow ? "yellow" : "gray"}
            title="Session context"
          >
            {previewSessionLabel(preview.session)}
          </Alert>

          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>
              Close
            </Button>
          </Group>
        </Stack>
      )}
    </Modal>
  );
}
