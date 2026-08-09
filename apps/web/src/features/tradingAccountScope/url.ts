import type { PlatformRole } from "../auth/types";
import type { TradingAccount } from "../tradingAccounts/types";
import type { TradingAccountScope } from "./types";

export type ParsedAccountScope =
  | { kind: "MISSING" }
  | { kind: "VALID"; scope: TradingAccountScope }
  | { kind: "INVALID" };

export function parseAccountScope(searchParams: URLSearchParams): ParsedAccountScope {
  if (!searchParams.has("account")) return { kind: "MISSING" };
  const value = searchParams.get("account");
  if (value === "all") return { kind: "VALID", scope: { type: "ALL" } };
  if (!value || !/^[1-9]\d*$/.test(value)) return { kind: "INVALID" };
  const tradingAccountId = Number(value);
  if (!Number.isSafeInteger(tradingAccountId)) return { kind: "INVALID" };
  return { kind: "VALID", scope: { type: "ACCOUNT", tradingAccountId } };
}

export function serializeAccountScope(scope: TradingAccountScope) {
  return scope.type === "ALL" ? "all" : String(scope.tradingAccountId);
}

export function defaultTradingAccountScope(accounts: readonly TradingAccount[], role: PlatformRole | undefined): TradingAccountScope {
  if (role !== "SYSTEM_OWNER" && accounts.length === 1) {
    return { type: "ACCOUNT", tradingAccountId: accounts[0].id };
  }
  return { type: "ALL" };
}

export function withAccountScope(search: string | URLSearchParams, scope: TradingAccountScope) {
  const params = typeof search === "string" ? new URLSearchParams(search) : new URLSearchParams(search);
  params.set("account", serializeAccountScope(scope));
  return params;
}

export function resolveTradingAccountScope(parsed: ParsedAccountScope, accounts: readonly TradingAccount[], role: PlatformRole | undefined) {
  const fallback = defaultTradingAccountScope(accounts, role);
  if (parsed.kind !== "VALID") return { scope: fallback, shouldCanonicalize: true, shouldNotify: parsed.kind === "INVALID" };
  if (parsed.scope.type === "ALL") return { scope: parsed.scope, shouldCanonicalize: false, shouldNotify: false };
  const requestedAccountId = parsed.scope.tradingAccountId;
  if (accounts.some((account) => account.id === requestedAccountId)) {
    return { scope: parsed.scope, shouldCanonicalize: false, shouldNotify: false };
  }
  return { scope: fallback, shouldCanonicalize: true, shouldNotify: true };
}
