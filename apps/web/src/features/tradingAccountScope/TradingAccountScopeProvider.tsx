import { notifications } from "@mantine/notifications";
import { useCallback, useEffect, useMemo, useRef, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../auth/useAuth";
import { useTradingAccounts } from "../tradingAccounts/hooks";
import { getAdminToken } from "../../lib/api";
import { TradingAccountScopeContext } from "./context";
import type { TradingAccountScope } from "./types";
import { parseAccountScope, resolveTradingAccountScope, withAccountScope, withUserSelectedAccountScope } from "./url";

const UNAVAILABLE_MESSAGE = "That Trading Account is unavailable or you no longer have access.";

export function TradingAccountScopeProvider({ children }: { children: ReactNode }) {
  const { access } = useAuth();
  const query = useTradingAccounts(getAdminToken());
  const location = useLocation();
  const navigate = useNavigate();
  const lastNotificationKey = useRef<string | null>(null);
  const accessibleAccounts = useMemo(() => query.data?.accounts ?? [], [query.data]);
  const parsed = useMemo(() => parseAccountScope(new URLSearchParams(location.search)), [location.search]);
  const resolution = useMemo(() => query.isSuccess
    ? resolveTradingAccountScope(parsed, accessibleAccounts, access?.platformRole)
    : { scope: { type: "ALL" } as const, shouldCanonicalize: false, shouldNotify: false },
  [access?.platformRole, accessibleAccounts, parsed, query.isSuccess]);

  useEffect(() => {
    if (!query.isSuccess || !resolution.shouldCanonicalize) return;
    const params = withAccountScope(location.search, resolution.scope);
    navigate({ pathname: location.pathname, search: `?${params.toString()}`, hash: location.hash }, { replace: true });
    if (resolution.shouldNotify) {
      const key = `${location.pathname}|${location.search}`;
      if (lastNotificationKey.current !== key) {
        lastNotificationKey.current = key;
        notifications.show({ color: "yellow", message: UNAVAILABLE_MESSAGE });
      }
    }
  }, [location.hash, location.pathname, location.search, navigate, query.isSuccess, resolution]);

  const setScope = useCallback((scope: TradingAccountScope) => {
    if (scope.type === "ACCOUNT" && !accessibleAccounts.some((account) => account.id === scope.tradingAccountId)) return;
    const currentScope = resolution.scope;
    if (scope.type === currentScope.type && (scope.type === "ALL" || (currentScope.type === "ACCOUNT" && scope.tradingAccountId === currentScope.tradingAccountId))) return;
    const params = withUserSelectedAccountScope(location.search, scope);
    navigate({ pathname: location.pathname, search: `?${params.toString()}`, hash: location.hash });
  }, [accessibleAccounts, location.hash, location.pathname, location.search, navigate, resolution.scope]);

  const scope = resolution.scope;
  const selectedAccount = scope.type === "ACCOUNT"
    ? accessibleAccounts.find((account) => account.id === scope.tradingAccountId) ?? null
    : null;
  const value = useMemo(() => ({
    scope,
    selectedAccount,
    accessibleAccounts,
    isAll: scope.type === "ALL",
    isLoading: query.isLoading,
    isError: query.isError,
    error: query.error instanceof Error ? query.error : null,
    setScope,
    isAccountAccessible: (tradingAccountId: number) => accessibleAccounts.some((account) => account.id === tradingAccountId),
  }), [accessibleAccounts, query.error, query.isError, query.isLoading, scope, selectedAccount, setScope]);

  return <TradingAccountScopeContext.Provider value={value}>{children}</TradingAccountScopeContext.Provider>;
}
