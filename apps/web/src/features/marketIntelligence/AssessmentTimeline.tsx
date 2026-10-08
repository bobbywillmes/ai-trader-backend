import { Alert, Button, Card, Group, Stack, Text, Title } from "@mantine/core";
import { DataState } from "../../components/data-display";
import React from "react";
import { useAssessmentTimeline } from "./hooks";
import { label } from "./presentation";
import type { Assessment, DimensionKey } from "./types";
import classes from "./MarketIntelligencePage.module.css";
const names: Record<DimensionKey, string> = { trend: "Trend", volatility: "Volatility", breadth: "Breadth V1", participation: "Participation", intradayStress: "Intraday Stress" };
function cellClass(row: Assessment) { return row.status === "FAILED" ? classes.failed : row.status === "UNAVAILABLE" ? classes.unavailable : classes.valid; }
export function AssessmentTimeline() {
  const [enabled, setEnabled] = React.useState(false); const query = useAssessmentTimeline(enabled);
  return <Card withBorder p="md"><Group justify="space-between" align="flex-start"><div><Title order={2} size="h3">Recent state timeline</Title><Text size="sm" c="dimmed">Up to 20 persisted attempts per V1 dimension. Each row keeps its own target time; gaps and failures are not interpolated.</Text></div>{!enabled && <Button variant="light" onClick={() => setEnabled(true)}>Load timeline</Button>}</Group>
    {enabled && query.isLoading && <DataState state="loading" message="Loading recent assessment history…" />}{enabled && query.isError && <Alert mt="md" color="red" title="Timeline unavailable">{query.error.message}</Alert>}{query.data && <Stack mt="md" gap="xs"><div className={classes.timeline} aria-label="Authoritative assessment state timeline"><div className={classes.timelineGrid}>{(Object.keys(names) as DimensionKey[]).map(key => { const rows = [...query.data[key]].sort((a, b) => new Date(a.targetAt).getTime() - new Date(b.targetAt).getTime()); return <React.Fragment key={key}><div className={classes.timelineLabel}><Text fw={700}>{names[key]}</Text><Text size="xs" c="dimmed">{rows.at(-1)?.algorithmVersion ?? "No publications"}</Text></div>{Array.from({ length: 20 }, (_, index) => { const row = rows[index - (20 - rows.length)]; return row ? <div key={row.id} className={`${classes.timelineCell} ${cellClass(row)}`} title={`${row.algorithmVersion} · ${row.targetAt} · ${row.status} · ${row.effectiveState ?? "no state"}`} aria-label={`${names[key]} ${row.targetAt}: ${row.status}, ${row.effectiveState ? label(row.effectiveState) : "no effective state"}`}>{row.status === "VALID" ? label(row.effectiveState ?? "—").slice(0, 3) : row.status === "FAILED" ? "ERR" : "N/A"}</div> : <div key={`empty-${index}`} className={classes.timelineCell} aria-hidden="true" />; })}</React.Fragment>; })}</div></div><Group gap="md"><Text size="xs"><b>Blue</b> valid publication</Text><Text size="xs"><b>Dashed</b> unavailable evidence</Text><Text size="xs"><b>Red</b> failed attempt</Text></Group></Stack>}
  </Card>;
}
