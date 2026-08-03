import { useEffect, useRef, useState, type ReactNode } from "react";
import { getDataPresentation, type DataPresentation } from "./presentation";
import classes from "./ResponsiveDataView.module.css";
import "./responsiveDataTokens.css";

type Props<T> = {
  records: readonly T[];
  getRecordId: (record: T) => string | number;
  wide: (records: readonly T[]) => ReactNode;
  compact: (records: readonly T[]) => ReactNode;
  narrow: (records: readonly T[]) => ReactNode;
  className?: string;
  "aria-label"?: string;
};

export function ResponsiveDataView<T>({ records, getRecordId, wide, compact, narrow, className, "aria-label": ariaLabel }: Props<T>) {
  const ref = useRef<HTMLDivElement>(null);
  const [presentation, setPresentation] = useState<DataPresentation | null>(null);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const update = (width: number) => setPresentation(getDataPresentation(width));
    update(element.getBoundingClientRect().width || window.innerWidth);
    const observerConstructor = globalThis.ResizeObserver as typeof ResizeObserver | undefined;
    if (!observerConstructor) {
      const browserWindow = globalThis as unknown as Window;
      const onResize = () => update(element.getBoundingClientRect().width || browserWindow.innerWidth);
      browserWindow.addEventListener("resize", onResize);
      return () => browserWindow.removeEventListener("resize", onResize);
    }
    const observer = new observerConstructor(([entry]) => update(entry.contentRect.width));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const identity = records.map(getRecordId).join(" ");
  const content = presentation === "narrow" ? narrow(records) : presentation === "compact" ? compact(records) : wide(records);

  return <div ref={ref} className={`${classes.container} ${className ?? ""}`} aria-label={ariaLabel} data-presentation={presentation ?? "wide"} data-record-ids={identity}>{content}</div>;
}
