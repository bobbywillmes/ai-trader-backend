import { TradingAccountBadge } from "../../components/TradingAccountBadge";
import type { EntryDecisionSummary } from "./types";

export function EntryDecisionAccountBadge({
  decision,
}: {
  decision: Pick<EntryDecisionSummary, "tradingAccount" | "tradingAccountId">;
}) {
  return (
    <TradingAccountBadge
      account={decision.tradingAccount}
      tradingAccountId={decision.tradingAccountId}
      emptyLabel="Global"
    />
  );
}
