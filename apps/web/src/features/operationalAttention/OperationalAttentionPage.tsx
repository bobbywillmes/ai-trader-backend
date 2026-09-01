import {
  Alert,
  Badge,
  Button,
  Card,
  Code,
  Group,
  Modal,
  Pagination,
  Select,
  Stack,
  Text,
  Textarea,
  Title,
} from "@mantine/core";
import { Link, useSearchParams } from "react-router-dom";
import { useEffect, useState } from "react";
import { DataState } from "../../components/data-display";
import { getAdminToken } from "../../lib/api";
import { TradingAccountScopeSelector } from "../tradingAccountScope/TradingAccountScopeSelector";
import {
  useAcknowledgeAttention,
  useAttentionDetail,
  useAttentionList,
  useManualResolveAttention,
  useRemainingExposureClosePreview,
  useExecuteRemainingExposureClose,
} from "./hooks";
import { RemainingExposureClosePanel } from "./RemainingExposureClosePanel";
import type { AttentionSeverity, OperationalAttention } from "./types";
import {
  applyAttentionStatusFilter,
  ATTENTION_STATUS_OPTIONS,
  readAttentionStatusFilter,
  statusApiValue,
  type AttentionStatusFilter,
} from "./statusFilter";
const colors: Record<AttentionSeverity, string> = {
  CRITICAL: "red",
  ERROR: "orange",
  WARNING: "yellow",
  INFO: "blue",
};
const stamp = (value: string | null) =>
  value ? new Date(value).toLocaleString() : "Not recorded";
const detailErrorMessage = (error: unknown) => {
  const message = error instanceof Error ? error.message : "";
  return /active attention key|activeKey|fingerprint/i.test(message)
    ? "Operational attention details could not be refreshed. Retry shortly."
    : message || "Operational attention details could not be loaded.";
};
function Episode({
  item,
  review,
}: {
  item: OperationalAttention;
  review: () => void;
}) {
  return (
    <Card withBorder>
      <Group justify="space-between" align="flex-start">
        <div>
          <Group gap="xs">
            <Badge color={colors[item.severity]}>{item.severity}</Badge>
            <Badge variant="outline">{item.status}</Badge>
          </Group>
          <Text fw={700} mt="xs">
            {item.title}
          </Text>
          <Text size="sm">{item.message}</Text>
          <Text size="xs" c="dimmed">
            {item.tradingAccount.displayName} ·{" "}
            {item.tradingAccount.environment} · observed{" "}
            {stamp(item.lastObservedAt)} · {item.occurrenceCount} occurrence
            {item.occurrenceCount === 1 ? "" : "s"}
          </Text>
        </div>
        <Button variant="light" onClick={review}>
          Review
        </Button>
      </Group>
    </Card>
  );
}
export function OperationalAttentionPage() {
  const token = getAdminToken();
  const [params, setParams] = useSearchParams();
  const [detailId, setDetailId] = useState<number | null>(
    () => Number(params.get("attention")) || null,
  );
  const [reason, setReason] = useState("");
  const account = params.get("account") ?? "all";
  const statusState = readAttentionStatusFilter(params.get("status"));
  const status = statusState.value;
  const severity = params.get("severity") ?? "all";
  const page = Number(params.get("page") ?? 1);
  const query = useAttentionList(
    token,
    `?account=${account}&status=${statusApiValue(status)}&severity=${severity}&page=${page}&pageSize=20`,
  );
  const detail = useAttentionDetail(token, detailId);
  const acknowledge = useAcknowledgeAttention(token);
  const resolve = useManualResolveAttention(token);
  const correctivePreview = useRemainingExposureClosePreview(token, detailId);
  const correctiveClose = useExecuteRemainingExposureClose(token);
  useEffect(() => {
    if (!statusState.invalid) return;
    const next = new URLSearchParams(params);
    next.delete("status");
    next.set("page", "1");
    setParams(next, { replace: true });
  }, [params, setParams, statusState.invalid]);
  const update = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    next.set(key, value);
    if (key !== "page") next.set("page", "1");
    setParams(next);
  };
  const open = (id: number) => {
    setDetailId(id);
    const next = new URLSearchParams(params);
    next.set("attention", String(id));
    setParams(next);
  };
  const close = () => {
    setDetailId(null);
    const next = new URLSearchParams(params);
    next.delete("attention");
    setParams(next, { replace: true });
  };
  return (
    <main>
      <Stack gap="lg">
        <Group justify="space-between">
          <div>
            <Title order={2}>Operational Attention</Title>
            <Text c="dimmed" size="sm">
              Account-scoped operational conditions and their history.
            </Text>
          </div>
          <TradingAccountScopeSelector
            mode="ACCOUNT_FILTERABLE"
            expanded
            variant="dashboard"
          />
        </Group>
        <Card withBorder>
          <Group align="end">
            <Select
              label="Status"
              value={status}
              onChange={(v) =>
                setParams(
                  applyAttentionStatusFilter(
                    params,
                    v as AttentionStatusFilter,
                  ),
                )
              }
              data={ATTENTION_STATUS_OPTIONS}
            />
            <Select
              label="Severity"
              value={severity}
              onChange={(v) => update("severity", v!)}
              data={["all", "CRITICAL", "ERROR", "WARNING"].map((v) => ({
                value: v,
                label: v === "all" ? "All severities" : v,
              }))}
            />
          </Group>
        </Card>
        {query.isLoading ? (
          <DataState state="loading" message="Loading operational attention…" />
        ) : query.isError ? (
          <DataState
            state="error"
            title="Operational attention unavailable"
            message={query.error.message}
          />
        ) : !query.data?.items.length ? (
          <DataState
            state="empty"
            title={
              status === "RESOLVED"
                ? "No resolved history"
                : status === "unresolved"
                  ? "No unresolved operational attention."
                  : "No operational attention"
            }
            message="No episodes match the current account and filters."
          />
        ) : (
          <Stack>
            {query.data.items.map((item) => (
              <Episode key={item.id} item={item} review={() => open(item.id)} />
            ))}
            <Pagination
              value={page}
              total={query.data.pagination.totalPages}
              onChange={(v) => update("page", String(v))}
            />
          </Stack>
        )}
      </Stack>
      <Modal
        opened={Boolean(detailId)}
        onClose={close}
        title={detail.data?.title ?? "Operational attention"}
        size="lg"
      >
        <Stack>
          {detail.isLoading ? (
            <DataState state="loading" />
          ) : detail.isError ? (
            <Alert color="red">{detailErrorMessage(detail.error)}</Alert>
          ) : (
            detail.data && (
              <>
                <Group>
                  <Badge color={colors[detail.data.severity]}>
                    {detail.data.severity}
                  </Badge>
                  <Badge>{detail.data.status}</Badge>
                </Group>
                <Text>{detail.data.message}</Text>
                <Text size="sm">
                  <b>Condition code:</b>{" "}
                  <Code>{detail.data.code}</Code>
                </Text>
                <Text size="sm">
                  <b>Account:</b> {detail.data.tradingAccount.displayName} ·{" "}
                  {detail.data.tradingAccount.environment}
                </Text>
                {correctivePreview.data && (
                  <RemainingExposureClosePanel
                    preview={correctivePreview.data}
                    pending={correctiveClose.isPending}
                    error={
                      correctiveClose.error instanceof Error
                        ? correctiveClose.error.message
                        : null
                    }
                    onConfirm={() =>
                      correctiveClose.mutate({
                        id: correctivePreview.data!.attentionId,
                        revision: correctivePreview.data!.revision,
                        fingerprint: correctivePreview.data!.previewFingerprint,
                      })
                    }
                  />
                )}
                <Text size="sm">
                  <b>First observed:</b> {stamp(detail.data.firstObservedAt)}
                  <br />
                  <b>Last observed:</b> {stamp(detail.data.lastObservedAt)}
                  <br />
                  <b>Resolution policy:</b>{" "}
                  {detail.data.resolutionPolicy.replaceAll("_", " ")}
                </Text>
                <Group>
                  <Button
                    component={Link}
                    to={
                      detail.data.links.position ??
                      detail.data.links.reconciliation
                    }
                    variant="light"
                  >
                    {detail.data.links.position
                      ? "Review position"
                      : "Review reconciliation"}
                  </Button>
                  <Button
                    component={Link}
                    to={detail.data.links.systemEvents}
                    variant="default"
                  >
                    System Events
                  </Button>
                </Group>
                {detail.data.allowedActions.acknowledge && (
                  <Button
                    onClick={() =>
                      acknowledge.mutate({
                        id: detail.data!.id,
                        revision: detail.data!.revision,
                      })
                    }
                    loading={acknowledge.isPending}
                  >
                    Acknowledge
                  </Button>
                )}
                {detail.data.allowedActions.manualResolve && (
                  <>
                    <Textarea
                      label="Manual resolution reason"
                      value={reason}
                      onChange={(e) => setReason(e.currentTarget.value)}
                    />
                    <Button
                      disabled={!reason.trim()}
                      onClick={() =>
                        resolve.mutate({
                          id: detail.data!.id,
                          revision: detail.data!.revision,
                          reason,
                        })
                      }
                    >
                      Resolve with reason
                    </Button>
                  </>
                )}
                <Title order={4}>Evidence timeline</Title>
                {detail.data.evidenceEvents?.map((event) => (
                  <Card withBorder key={event.systemEvent.id}>
                    <Text size="xs">
                      {stamp(event.systemEvent.createdAt)} ·{" "}
                      {event.relationKind}
                    </Text>
                    <Text size="sm">{event.systemEvent.message}</Text>
                  </Card>
                ))}
                <Title order={4}>Current structured evidence</Title>
                <Code block>{JSON.stringify(detail.data.detailsJson, null, 2)}</Code>
              </>
            )
          )}
        </Stack>
      </Modal>
    </main>
  );
}
