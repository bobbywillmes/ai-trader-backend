import type { PageScopeMode } from "../features/tradingAccountScope/types";

type RouteScopeDefinition = { pattern: RegExp; mode: PageScopeMode; routeAccountIdGroup?: number };

const routeScopes: RouteScopeDefinition[] = [
  { pattern: /^\/(dashboard|positions\/open|orders\/open|trade-history|entry-decisions|system\/events|reports(?:\/[^/]+)?)\/?$/, mode: "ACCOUNT_FILTERABLE" },
  { pattern: /^\/trading-accounts\/(\d+)\/?$/, mode: "ACCOUNT_SPECIFIC", routeAccountIdGroup: 1 },
  { pattern: /^\/trading-accounts\/(\d+)\/reconciliation\/?$/, mode: "ACCOUNT_SPECIFIC", routeAccountIdGroup: 1 },
];

export function getPageScope(pathname: string): { mode: PageScopeMode; routeTradingAccountId: number | null } {
  for (const definition of routeScopes) {
    const match = pathname.match(definition.pattern);
    if (!match) continue;
    const rawId = definition.routeAccountIdGroup ? match[definition.routeAccountIdGroup] : undefined;
    return { mode: definition.mode, routeTradingAccountId: rawId ? Number(rawId) : null };
  }
  return { mode: "SYSTEM", routeTradingAccountId: null };
}
