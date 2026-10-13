import { Alert, Title } from "@mantine/core";
import { OrderOperationalEvidence } from "../orderOperationalEvidence/OrderOperationalEvidence";
import type { EntryDecisionSummary } from "./types";

type Props = {
  decision: Pick<EntryDecisionSummary, "orderIntentId" | "tradingAccountId">;
  token: string | null;
  requestedOrderIntentId: number | null;
  authorizationContext: string;
  className?: string;
  headingClassName?: string;
  headingSize?: "h4" | "h5";
};

export function EntryDecisionOrderEvidence({
  decision,
  token,
  requestedOrderIntentId,
  authorizationContext,
  className,
  headingClassName,
  headingSize = "h4",
}: Props) {
  return (
    <section className={className}>
      <Title order={3} size={headingSize} className={headingClassName}>
        Market Policy order evidence
      </Title>
      {decision.orderIntentId === null ? (
        <Alert color="gray" title="No OrderIntent">
          This Entry Decision did not create an OrderIntent. No order-level Market Policy evidence is applicable.
        </Alert>
      ) : requestedOrderIntentId !== null && requestedOrderIntentId !== decision.orderIntentId ? (
        <Alert color="red" title="OrderIntent link mismatch">
          The URL does not match this Entry Decision&apos;s exact OrderIntent. Evidence was not requested.
        </Alert>
      ) : (
        <OrderOperationalEvidence
          orderIntentId={decision.orderIntentId}
          token={token}
          authorizationContext={authorizationContext}
          expectedTradingAccountId={decision.tradingAccountId}
        />
      )}
    </section>
  );
}
