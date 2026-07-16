import { ActionIcon, Checkbox, Group, Menu, SegmentedControl, Switch, Tooltip } from "@mantine/core";
import { IconAdjustmentsHorizontal, IconArrowsMaximize, IconArrowsMinimize } from "@tabler/icons-react";
import type { MomentumMarketChartInterval } from "../types";
import type { MomentumChartLayer, MomentumChartLayers, MomentumChartRange } from "../momentumChartHelpers";

const layerGroups: Array<[string, Array<[MomentumChartLayer, string]>]> = [
  ["Markers", [["decisionMarkers", "Decision markers"], ["catalystMarkers", "Catalyst markers"], ["allPriceChecks", "All price checks"]]],
  ["Overlays", [["aggregateVwap", "Aggregate VWAP"], ["sessionVwap", "Session VWAP"], ["previousClose", "Previous close"], ["premarketHigh", "Premarket high"], ["regularSessionHigh", "Regular-session high"]]],
  ["Panels", [["volume", "Volume"]]],
];

export function MomentumChartControls({ interval, onIntervalChange, layers, onLayerChange, extendedHours, onExtendedHoursChange, range, onRangeChange, hasCandidate, expanded, onExpandedChange }: {
  interval: MomentumMarketChartInterval; onIntervalChange: (value: MomentumMarketChartInterval) => void;
  layers: MomentumChartLayers; onLayerChange: (key: MomentumChartLayer, value: boolean) => void;
  extendedHours: boolean; onExtendedHoursChange: (value: boolean) => void;
  range: MomentumChartRange; onRangeChange: (value: MomentumChartRange) => void;
  hasCandidate: boolean; expanded: boolean; onExpandedChange: () => void;
}) {
  return <Group gap="xs" wrap="wrap" justify="flex-end">
    <SegmentedControl aria-label="Chart interval" size="xs" data={["1m", "5m", "15m", { label: "1D", value: "1d" }]} value={interval} onChange={(value) => onIntervalChange(value as MomentumMarketChartInterval)} />
    <SegmentedControl aria-label="Visible chart range" size="xs" data={[...(hasCandidate ? [{ label: "Decision window", value: "decision" }] : []), { label: "Latest session", value: "session" }, { label: "Fit all", value: "all" }]} value={range} onChange={(value) => onRangeChange(value as MomentumChartRange)} />
    <Switch size="xs" label="Extended hours" checked={extendedHours} onChange={(event) => onExtendedHoursChange(event.currentTarget.checked)} />
    <Menu shadow="md" width={230} closeOnItemClick={false} position="bottom-end">
      <Menu.Target><Tooltip label="Choose visible chart layers"><ActionIcon variant="default" aria-label="Choose visible chart layers"><IconAdjustmentsHorizontal size={17} /></ActionIcon></Tooltip></Menu.Target>
      <Menu.Dropdown>{layerGroups.map(([group, entries]) => <div key={group}><Menu.Label>{group}</Menu.Label>{entries.map(([key, label]) => <Menu.Item key={key} closeMenuOnClick={false}><Checkbox label={label} checked={layers[key]} onChange={(event) => onLayerChange(key, event.currentTarget.checked)} /></Menu.Item>)}</div>)}</Menu.Dropdown>
    </Menu>
    <Tooltip label={expanded ? "Collapse chart" : "Expand chart"}><ActionIcon variant="subtle" aria-label={expanded ? "Collapse chart" : "Expand chart"} onClick={onExpandedChange}>{expanded ? <IconArrowsMinimize size={17} /> : <IconArrowsMaximize size={17} />}</ActionIcon></Tooltip>
  </Group>;
}
