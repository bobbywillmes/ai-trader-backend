export const SETTINGS_SECTIONS = [
  { value: "status", label: "System Status" },
  { value: "trading", label: "Global Trading Controls" },
  { value: "integrity", label: "Reconciliation & Integrity" },
  { value: "user", label: "User Settings" },
] as const;

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number]["value"];

export function getSettingsSection(value: string | null): SettingsSection {
  return SETTINGS_SECTIONS.some((section) => section.value === value)
    ? value as SettingsSection
    : "status";
}

export function settingsSectionParams(current: URLSearchParams, section: SettingsSection) {
  const next = new URLSearchParams(current);
  if (section === "status") next.delete("section");
  else next.set("section", section);
  return next;
}
