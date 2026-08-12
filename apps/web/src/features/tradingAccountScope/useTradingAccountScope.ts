import { useContext } from "react";
import { TradingAccountScopeContext } from "./context";

export function useTradingAccountScope() {
  const value = useContext(TradingAccountScopeContext);
  if (!value) throw new Error("useTradingAccountScope must be used within TradingAccountScopeProvider.");
  return value;
}
