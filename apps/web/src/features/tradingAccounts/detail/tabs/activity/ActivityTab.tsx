import { AccountTabPlaceholder } from "../../components/AccountTabPlaceholder";

export function ActivityTab() {
  return (
    <AccountTabPlaceholder
      title="Activity"
      description="There is not currently an account-scoped activity feed wired for this page. Use the global System Events and Trade History pages for lifecycle and audit review."
      actionLabel="Open System Events"
      actionTo="/system/events"
      secondaryActionLabel="Open Trade History"
      secondaryActionTo="/trade-history"
    />
  );
}
