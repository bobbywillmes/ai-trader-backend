import type { ReactNode } from "react";
import classes from "./RecordDetailsGrid.module.css";

export type DetailItem = { label: string; value?: ReactNode; technical?: boolean };
export type DetailSection = { title?: string; items: readonly DetailItem[] };

export function RecordDetailsGrid({ sections, missingValue = "Not available" }: { sections: readonly DetailSection[]; missingValue?: ReactNode }) {
  return <div className={classes.sections}>{sections.map((section, sectionIndex) => <section key={section.title ?? sectionIndex}>{section.title && <h3 className={classes.group}>{section.title}</h3>}<dl className={classes.grid}>{section.items.map((item, itemIndex) => <div className={classes.item} key={`${item.label}-${itemIndex}`}><dt className={classes.label}>{item.label}</dt><dd className={`${classes.value} ${item.technical ? classes.technical : ""}`}>{item.value === null || item.value === undefined || item.value === "" ? missingValue : item.value}</dd></div>)}</dl></section>)}</div>;
}
