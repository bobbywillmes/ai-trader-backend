export const DATA_NARROW_MAX = 639;
export const DATA_WIDE_MIN = 1100;

export type DataPresentation = "narrow" | "compact" | "wide";

export function getDataPresentation(width: number): DataPresentation {
  if (width < DATA_NARROW_MAX + 1) return "narrow";
  if (width < DATA_WIDE_MIN) return "compact";
  return "wide";
}
