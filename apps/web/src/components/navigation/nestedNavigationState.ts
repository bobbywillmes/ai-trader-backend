export function isNestedGroupOpen(active: boolean, manuallyExpanded: boolean) {
  return active || manuallyExpanded;
}
