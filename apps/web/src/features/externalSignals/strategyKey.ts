// Match backend creation validation; never apply this to an existing identity.
export function normalizeNewStrategyKey(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, "-").replace(/-+/g, "-");
}
export function isValidNewStrategyKey(value: string) {
  return value.length <= 200 && /^[a-z0-9_-]+$/.test(value);
}
