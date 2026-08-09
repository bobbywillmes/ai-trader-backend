import { createContext } from "react";
import type { TradingAccountScopeContextValue } from "./types";

export const TradingAccountScopeContext = createContext<TradingAccountScopeContextValue | null>(null);
