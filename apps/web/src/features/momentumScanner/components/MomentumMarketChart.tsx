import {
  ActionIcon,
  Alert,
  Badge,
  Card,
  Group,
  Loader,
  SegmentedControl,
  Stack,
  Text,
  Title,
  useMantineColorScheme,
  useMantineTheme,
} from "@mantine/core";
import { IconArrowsMaximize, IconArrowsMinimize } from "@tabler/icons-react";
import {
  CandlestickSeries,
  ColorType,
  createChart,
  createSeriesMarkers,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  LineStyle,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import { useEffect, useMemo, useRef, useState } from "react";

import type {
  MomentumMarketChartInterval,
  MomentumMarketChartMarkerType,
  MomentumMarketChartResponse,
} from "../types";

type Props = {
  data: MomentumMarketChartResponse | undefined;
  interval: MomentumMarketChartInterval;
  onIntervalChange: (interval: MomentumMarketChartInterval) => void;
  isLoading?: boolean;
  isFetching?: boolean;
  error?: Error | null;
  title?: string;
};

type TooltipData = {
  bar: MomentumMarketChartResponse["bars"][number];
  markers: MomentumMarketChartResponse["markers"];
} | null;

const intervals: Array<{ label: string; value: MomentumMarketChartInterval }> = [
  { label: "1m", value: "1m" },
  { label: "5m", value: "5m" },
  { label: "15m", value: "15m" },
  { label: "1D", value: "1d" },
];

function chartTime(timestamp: string) {
  return Math.floor(new Date(timestamp).getTime() / 1000) as UTCTimestamp;
}

function nearestChartTime(timestamp: string, barTimes: UTCTimestamp[]) {
  const target = chartTime(timestamp);
  return barTimes.reduce(
    (nearest, time) => Math.abs(time - target) < Math.abs(nearest - target) ? time : nearest,
    barTimes[0] ?? target
  );
}

function markerAppearance(type: MomentumMarketChartMarkerType) {
  if (type === "ENTRY_READY") return { color: "#20c997", shape: "arrowUp" as const, position: "belowBar" as const };
  if (type === "ENTRY_BLOCKED" || type === "HANDOFF_CANCELLED") return { color: "#fa5252", shape: "arrowDown" as const, position: "aboveBar" as const };
  if (type.startsWith("CATALYST")) return { color: "#4dabf7", shape: "circle" as const, position: "aboveBar" as const };
  if (type.startsWith("HANDOFF")) return { color: "#cc5de8", shape: "square" as const, position: "aboveBar" as const };
  if (type === "CANDIDATE_DISCOVERED") return { color: "#ffd43b", shape: "circle" as const, position: "belowBar" as const };
  return { color: "#adb5bd", shape: "circle" as const, position: "aboveBar" as const };
}

function markerText(type: MomentumMarketChartMarkerType) {
  if (type === "PRICE_CHECK") return undefined;
  if (type === "CATALYST_PUBLISHED") return "Catalyst";
  if (type === "CATALYST_RECEIVED") return undefined;
  if (type === "CANDIDATE_DISCOVERED") return "Discovered";
  if (type === "ENTRY_READY") return "Ready";
  if (type === "ENTRY_BLOCKED") return "Blocked";
  if (type === "HANDOFF_PREPARED") return "Prepared";
  if (type === "HANDOFF_SENT") return "Sent";
  return "Cancelled";
}

function formatPrice(value: number | null | undefined) {
  return value === null || value === undefined
    ? "-"
    : value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 });
}

function formatNewYork(timestamp: string) {
  return new Intl.DateTimeFormat(undefined, {
    timeZone: "America/New_York",
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(timestamp));
}

export function MomentumMarketChart({
  data,
  interval,
  onIntervalChange,
  isLoading = false,
  isFetching = false,
  error = null,
  title = "Market context",
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const theme = useMantineTheme();
  const { colorScheme } = useMantineColorScheme();
  const [expanded, setExpanded] = useState(false);
  const [tooltip, setTooltip] = useState<TooltipData>(null);
  const isDark = colorScheme === "dark";
  const barByTime = useMemo(
    () => new Map(data?.bars.map((bar) => [chartTime(bar.timestamp), bar]) ?? []),
    [data]
  );
  const barTimes = useMemo(() => [...barByTime.keys()], [barByTime]);
  const markersByTime = useMemo(() => {
    const result = new Map<number, MomentumMarketChartResponse["markers"]>();
    for (const marker of data?.markers ?? []) {
      const time = nearestChartTime(marker.timestamp, barTimes);
      result.set(time, [...(result.get(time) ?? []), marker]);
    }
    return result;
  }, [barTimes, data]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !data || data.bars.length === 0) return;

    const chart = createChart(container, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: isDark ? theme.colors.dark[1] : theme.colors.gray[7],
        panes: { separatorColor: isDark ? theme.colors.dark[4] : theme.colors.gray[3] },
      },
      grid: {
        vertLines: { color: isDark ? theme.colors.dark[6] : theme.colors.gray[2] },
        horzLines: { color: isDark ? theme.colors.dark[6] : theme.colors.gray[2] },
      },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: isDark ? theme.colors.dark[4] : theme.colors.gray[3] },
      timeScale: {
        borderColor: isDark ? theme.colors.dark[4] : theme.colors.gray[3],
        timeVisible: interval !== "1d",
        secondsVisible: false,
      },
    });
    const candles = chart.addSeries(CandlestickSeries, {
      upColor: theme.colors.teal[6], downColor: theme.colors.red[6],
      borderUpColor: theme.colors.teal[6], borderDownColor: theme.colors.red[6],
      wickUpColor: theme.colors.teal[5], wickDownColor: theme.colors.red[5],
    });
    candles.setData(data.bars.map((bar) => ({
      time: chartTime(bar.timestamp), open: bar.open, high: bar.high,
      low: bar.low, close: bar.close,
    })));

    const volume = chart.addSeries(HistogramSeries, {
      priceFormat: { type: "volume" }, priceScaleId: "volume",
    }, 1);
    volume.setData(data.bars.flatMap((bar) => bar.volume === null ? [] : [{
      time: chartTime(bar.timestamp), value: Number(bar.volume),
      color: bar.close >= bar.open ? `${theme.colors.teal[6]}80` : `${theme.colors.red[6]}80`,
    }]));

    const aggregateVwap = chart.addSeries(LineSeries, {
      color: theme.colors.blue[4], lineWidth: 2,
      title: "Aggregate VWAP", priceLineVisible: false, lastValueVisible: false,
    });
    aggregateVwap.setData(data.bars.flatMap((bar) =>
      bar.vwap === null ? [] : [{ time: chartTime(bar.timestamp), value: bar.vwap }]
    ));

    const levels = [
      [data.referenceLevels.previousClose, "Previous close", theme.colors.gray[5], LineStyle.Dashed],
      [data.referenceLevels.sessionVwap, "Session VWAP (extended)", theme.colors.blue[6], LineStyle.Dotted],
      [data.referenceLevels.premarketHigh, "Premarket high", theme.colors.yellow[6], LineStyle.Dashed],
      [data.referenceLevels.regularSessionHigh, "Regular-session high", theme.colors.violet[5], LineStyle.Dashed],
    ] as const;
    for (const [price, lineTitle, color, lineStyle] of levels) {
      if (price !== null) candles.createPriceLine({ price, title: lineTitle, color, lineStyle, axisLabelVisible: true });
    }

    const chartMarkers: SeriesMarker<Time>[] = data.markers.map((marker) => ({
      time: nearestChartTime(marker.timestamp, barTimes),
      ...markerAppearance(marker.type),
      text: markerText(marker.type),
    }));
    createSeriesMarkers(candles, chartMarkers);
    chart.timeScale().fitContent();
    chart.subscribeCrosshairMove((param) => {
      if (typeof param.time !== "number") {
        setTooltip(null);
        return;
      }
      const bar = barByTime.get(param.time);
      setTooltip(bar ? { bar, markers: markersByTime.get(param.time) ?? [] } : null);
    });

    return () => chart.remove();
  }, [barByTime, barTimes, data, interval, isDark, markersByTime, theme.colors]);

  const height = expanded ? 640 : 430;

  return (
    <Card withBorder radius="md" p="lg">
      <Stack gap="md">
        <Group justify="space-between" align="center">
          <div>
            <Title order={2}>{title}</Title>
            <Text size="xs" c="dimmed">Adjusted Massive bars · New York market time · stored decisions remain authoritative</Text>
          </div>
          <Group gap="xs">
            {isFetching && !isLoading && <Loader size="xs" />}
            <SegmentedControl
              size="xs"
              data={intervals}
              value={interval}
              onChange={(value) => onIntervalChange(value as MomentumMarketChartInterval)}
            />
            <ActionIcon variant="subtle" aria-label={expanded ? "Collapse chart" : "Expand chart"} onClick={() => setExpanded((value) => !value)}>
              {expanded ? <IconArrowsMinimize size={17} /> : <IconArrowsMaximize size={17} />}
            </ActionIcon>
          </Group>
        </Group>

        {isLoading && <Group justify="center" h={height}><Loader /><Text c="dimmed">Loading market data…</Text></Group>}
        {!isLoading && error && <Alert color="red" title="Market chart unavailable">{error.message}</Alert>}
        {!isLoading && !error && data?.bars.length === 0 && <Alert color="blue" title="No market bars">No eligible trades were returned for this range. The market may be closed or the provider may have no data.</Alert>}
        {!isLoading && !error && data && data.bars.length > 0 && (
          <div style={{ position: "relative" }}>
            <div ref={containerRef} style={{ height }} />
            {tooltip && (
              <Card withBorder p="xs" radius="sm" style={{ position: "absolute", top: 8, left: 8, zIndex: 2, pointerEvents: "none", background: "var(--mantine-color-body)" }}>
                <Text size="xs" fw={700}>{formatNewYork(tooltip.bar.timestamp)} ET</Text>
                <Text size="xs">O {formatPrice(tooltip.bar.open)} · H {formatPrice(tooltip.bar.high)} · L {formatPrice(tooltip.bar.low)} · C {formatPrice(tooltip.bar.close)}</Text>
                <Text size="xs">Volume {tooltip.bar.volume === null ? "-" : Number(tooltip.bar.volume).toLocaleString()} · Aggregate VWAP {formatPrice(tooltip.bar.vwap)}</Text>
                {tooltip.markers.map((marker) => (
                  <Stack key={marker.id} gap={1} mt={4}>
                    <Group gap={4}><Badge size="xs" variant="light">{marker.label}</Badge><Text size="xs" c="dimmed">{formatNewYork(marker.timestamp)} ET</Text></Group>
                    {marker.metadata?.decision !== undefined && <Text size="xs">Decision: {String(marker.metadata.decision ?? "Not recorded")} · score {String(marker.metadata.totalConfirmationScore ?? "-")}</Text>}
                    {marker.metadata?.aboveVwap !== undefined && <Text size="xs">Above stored check VWAP: {marker.metadata.aboveVwap === null ? "-" : marker.metadata.aboveVwap ? "Yes" : "No"}</Text>}
                    {Boolean(marker.metadata?.blockedReason || marker.metadata?.reason) && <Text size="xs" c="red">{String(marker.metadata?.blockedReason ?? marker.metadata?.reason)}</Text>}
                  </Stack>
                ))}
              </Card>
            )}
          </div>
        )}
        {data && <Text size="xs" c="dimmed">{data.source.cached ? "Cached" : "Fresh"} provider data fetched {formatNewYork(data.source.fetchedAt)} ET</Text>}
      </Stack>
    </Card>
  );
}
