export function updateOwnedSearchParams(
  current: URLSearchParams,
  ownedKeys: readonly string[],
  ownedValues: URLSearchParams,
) {
  const next = new URLSearchParams(current);
  for (const key of ownedKeys) next.delete(key);
  for (const [key, value] of ownedValues) next.append(key, value);
  return next;
}
