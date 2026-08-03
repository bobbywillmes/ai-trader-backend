import { Table, type TableProps } from "@mantine/core";
import type { ReactNode } from "react";

type Props = {
  children: ReactNode;
  caption?: string;
  density?: "compact" | "normal";
  striped?: boolean;
  highlightOnHover?: boolean;
};

export function DataTable({ children, caption, density = "normal", striped = true, highlightOnHover = true }: Props) {
  const verticalSpacing: TableProps["verticalSpacing"] = density === "compact" ? "xs" : "sm";
  return <Table striped={striped} highlightOnHover={highlightOnHover} verticalSpacing={verticalSpacing} horizontalSpacing={density === "compact" ? "sm" : "md"} withRowBorders>
    {caption && <Table.Caption>{caption}</Table.Caption>}
    {children}
  </Table>;
}
