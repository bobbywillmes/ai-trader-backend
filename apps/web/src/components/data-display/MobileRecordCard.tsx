import { Button } from "@mantine/core";
import type { ReactNode } from "react";
import type { SummaryField } from "./CompactRecordList";
import classes from "./RecordPresentations.module.css";

type Props<T> = {
  records: readonly T[];
  getRecordId: (record: T) => string | number;
  renderIdentity: (record: T) => ReactNode;
  renderStatus?: (record: T) => ReactNode;
  renderFields: (record: T) => readonly SummaryField[];
  onDetails: (record: T, opener: HTMLElement) => void;
  renderActions?: (record: T) => ReactNode;
};

export function MobileRecordCard<T>({ records, getRecordId, renderIdentity, renderStatus, renderFields, onDetails, renderActions }: Props<T>) {
  return <div className={classes.cards}>{records.map((record) => <article className={classes.card} key={getRecordId(record)} data-record-id={getRecordId(record)}>
    <header className={classes.cardHeader}><div className={classes.cardIdentity}>{renderIdentity(record)}</div>{renderStatus?.(record)}</header>
    <div className={classes.cardMeta}>{renderFields(record).map((field) => <div className={classes.field} key={field.label}><span className={classes.fieldLabel}>{field.label}</span><div className={classes.fieldValue}>{field.value}</div></div>)}</div>
    <div className={classes.cardActions}><Button className={classes.detailButton} variant="default" onClick={(event) => onDetails(record, event.currentTarget)} aria-haspopup="dialog">View details</Button>{renderActions?.(record)}</div>
  </article>)}</div>;
}
