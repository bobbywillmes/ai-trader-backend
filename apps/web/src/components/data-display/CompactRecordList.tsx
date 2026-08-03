import { Button } from "@mantine/core";
import { IconChevronDown, IconChevronUp } from "@tabler/icons-react";
import type { ReactNode } from "react";
import classes from "./RecordPresentations.module.css";

export type SummaryField = { label: string; value: ReactNode };

type Props<T> = {
  records: readonly T[];
  getRecordId: (record: T) => string | number;
  renderIdentity: (record: T) => ReactNode;
  renderFields: (record: T) => readonly SummaryField[];
  renderDetails: (record: T) => ReactNode;
  renderActions?: (record: T) => ReactNode;
  expandedId: string | number | null;
  onExpandedChange: (id: string | number | null) => void;
};

export function CompactRecordList<T>({ records, getRecordId, renderIdentity, renderFields, renderDetails, renderActions, expandedId, onExpandedChange }: Props<T>) {
  return <div className={classes.list}>{records.map((record) => {
    const id = getRecordId(record); const expanded = expandedId === id; const panelId = `record-${id}-details`;
    return <article className={classes.record} key={id} data-record-id={id}>
      <div className={classes.summary}>
        <div className={classes.identity}>{renderIdentity(record)}</div>
        {renderFields(record).slice(0, 2).map((field) => <div className={classes.field} key={field.label}><span className={classes.fieldLabel}>{field.label}</span><div className={classes.fieldValue}>{field.value}</div></div>)}
        <div className={classes.summaryActions}><Button className={classes.detailButton} size="compact-sm" variant="subtle" aria-expanded={expanded} aria-controls={panelId} onClick={() => onExpandedChange(expanded ? null : id)} rightSection={expanded ? <IconChevronUp size={15} aria-hidden="true" /> : <IconChevronDown size={15} aria-hidden="true" />}>Details</Button>{renderActions?.(record)}</div>
      </div>
      {expanded && <div className={classes.details} id={panelId}>{renderDetails(record)}</div>}
    </article>;
  })}</div>;
}
