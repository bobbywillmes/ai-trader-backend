import { useState } from "react";
import { Alert, Button, Group, Select, Stack, TextInput } from "@mantine/core";
import { events, rejectionCodes, statuses, timeframes, type Section } from "./types";
import { useCatalogs } from "./hooks";
import { label } from "./presentation";
import classes from "./ExternalSignals.module.css";

function localTime(value: string | null) {
  if (!value) return "";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 23);
}
export function Filters({ section, query, token, apply, clear }: {
  section: Section; query: URLSearchParams; token: string | null;
  apply: (values: Record<string, string | null>) => void; clear: () => void;
}) {
  const catalogs = useCatalogs(token);
  const [error, setError] = useState<string | null>(null);
  const choices = (values: readonly string[]) => values.map(value => ({ value, label: label(value) }));
  const hasHistory = section === "signals" || section === "deliveries";
  return <form onSubmit={event => {
    event.preventDefault(); const data = new FormData(event.currentTarget); const values: Record<string, string | null> = {};
    for (const [key, raw] of data) {
      const value = String(raw).trim();
      values[key] = value && (key === "from" || key === "to") ? new Date(value).toISOString() : value || null;
    }
    if (values.from && values.to && values.from > values.to) { setError("From must be before or equal to To."); return; }
    setError(null); apply(values);
  }}><Stack gap="sm">
    <div className={classes.toolbar}>
      <Select label="Source" name="signalSourceId" placeholder="All sources" searchable clearable defaultValue={query.get("signalSourceId")} disabled={catalogs.sources.isPending} data={(catalogs.sources.data ?? []).map(source => ({ value: String(source.id), label: `${source.name} (#${source.id})` }))} />
      {(section === "bindings" || section === "signals") && <Select label="Strategy" name="strategyId" placeholder="All strategies" searchable clearable defaultValue={query.get("strategyId")} data={(catalogs.strategies.data ?? []).map(strategy => ({ value: String(strategy.id), label: `${strategy.name} (#${strategy.id})` }))} />}
      {section === "signals" && <>
        <TextInput label="Symbol" name="symbol" placeholder="e.g. QQQ" defaultValue={query.get("symbol") ?? ""} maxLength={32} />
        <Select label="Event" name="event" placeholder="All events" clearable defaultValue={query.get("event")} data={choices(events)} />
        <Select label="Timeframe" name="timeframe" placeholder="All timeframes" clearable defaultValue={query.get("timeframe")} data={[...timeframes]} />
      </>}
      {section === "deliveries" && <>
        <Select label="Status" name="status" placeholder="All statuses" clearable defaultValue={query.get("status")} data={choices(statuses)} />
        <Select label="Rejection code" name="rejectionCode" placeholder="All rejection codes" searchable clearable defaultValue={query.get("rejectionCode")} data={choices(rejectionCodes)} />
        <TextInput label="Signal ID" name="signalId" type="number" min={1} max={2147483647} step={1} defaultValue={query.get("signalId") ?? ""} placeholder="Any linked signal" />
      </>}
      {hasHistory && <><TextInput label="From (local time)" type="datetime-local" step="0.001" name="from" defaultValue={localTime(query.get("from"))} min="1970-01-01T00:00" /><TextInput label="To (local time)" type="datetime-local" step="0.001" name="to" defaultValue={localTime(query.get("to"))} min="1970-01-01T00:00" /></>}
    </div>
    {(catalogs.sources.isError || catalogs.strategies.isError) && <Alert color="orange">Some catalog labels could not be loaded. <Button variant="subtle" size="compact-xs" onClick={() => { void catalogs.sources.refetch(); void catalogs.strategies.refetch(); }}>Retry catalogs</Button></Alert>}
    {error && <Alert color="red" role="alert">{error}</Alert>}
    <Group gap="xs"><Button size="xs" type="submit" variant="light">Apply filters</Button><Button size="xs" variant="subtle" onClick={clear}>Clear filters</Button></Group>
  </Stack></form>;
}
