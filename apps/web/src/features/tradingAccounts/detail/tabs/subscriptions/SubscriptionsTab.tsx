import type { TradingAccount } from "../../../types";
import { SubscriptionManagementCard } from "./SubscriptionManagementCard";

export function SubscriptionsTab({
  account,
  token,
}: {
  account: TradingAccount;
  token: string | null;
}) {
  return <SubscriptionManagementCard account={account} token={token} />;
}
