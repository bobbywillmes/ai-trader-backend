import { Table, type TableProps } from "@mantine/core";
import type { ReactNode } from "react";
import classes from "./DataTable.module.css";

type Props = {
  children: ReactNode;
  caption?: string;
  captionHidden?: boolean;
  density?: "compact" | "normal";
  striped?: boolean;
  highlightOnHover?: boolean;
};

export function DataTable({ children, caption, captionHidden = false, density = "normal", striped = true, highlightOnHover = true }: Props) {
  const verticalSpacing: TableProps["verticalSpacing"] = density === "compact" ? "xs" : "sm";
  return <Table striped={striped} highlightOnHover={highlightOnHover} verticalSpacing={verticalSpacing} horizontalSpacing={density === "compact" ? "sm" : "md"} withRowBorders>
    {caption && <Table.Caption className={captionHidden ? classes.visuallyHidden : undefined}>{caption}</Table.Caption>}
    {children}
  </Table>;
}
