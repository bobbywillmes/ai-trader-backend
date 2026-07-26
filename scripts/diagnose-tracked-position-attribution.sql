-- Read-only diagnostic. Run against production with psql and ON_ERROR_STOP.
-- Change only the target CTE if a different position must be reviewed.
WITH target AS (
  SELECT 51::integer AS tracked_position_id
)
SELECT
  tp.id AS tracked_position_id,
  tp.status,
  tp.broker,
  tp.symbol,
  tp."securityId" AS actual_security_id,
  sec.symbol AS security_symbol,
  tp."tradingAccountId" AS actual_account_id,
  ta."displayName" AS actual_account_name,
  ta.environment AS actual_account_environment,
  tp."subscriptionId" AS actual_subscription_id,
  sub.key AS actual_subscription_key,
  sub.symbol AS actual_subscription_symbol,
  tp."tradingAccountSubscriptionId" AS actual_assignment_id,
  tas."tradingAccountId" AS assignment_account_id,
  tas."subscriptionId" AS assignment_subscription_id,
  assigned_sub.key AS assignment_subscription_key,
  assigned_sub.symbol AS assignment_subscription_symbol,
  (tp."tradingAccountId" = tas."tradingAccountId") AS account_ids_agree,
  (tp."subscriptionId" = tas."subscriptionId") AS subscription_ids_agree,
  pes.id AS position_exit_state_id,
  pes.status AS position_exit_status,
  pes."exitProfileKey" AS position_exit_profile_key,
  sub."exitProfileId" AS actual_exit_profile_id,
  assigned_sub."exitProfileId" AS assignment_exit_profile_id,
  tp."configSnapshotJson",
  opening.order_intents,
  opening.broker_orders,
  opening.entry_decision,
  opening.broker_activities
FROM target
JOIN "TrackedPosition" tp ON tp.id = target.tracked_position_id
LEFT JOIN "TradingAccount" ta ON ta.id = tp."tradingAccountId"
LEFT JOIN "TradingAccountSubscription" tas
  ON tas.id = tp."tradingAccountSubscriptionId"
LEFT JOIN "Subscription" sub ON sub.id = tp."subscriptionId"
LEFT JOIN "Subscription" assigned_sub ON assigned_sub.id = tas."subscriptionId"
LEFT JOIN "Security" sec ON sec.id = tp."securityId"
LEFT JOIN "PositionExitState" pes ON pes."trackedPositionId" = tp.id
LEFT JOIN LATERAL (
  SELECT
    COALESCE(jsonb_agg(DISTINCT jsonb_build_object(
      'id', oi.id,
      'accountId', oi."tradingAccountId",
      'subscriptionId', oi."subscriptionId",
      'assignmentId', oi."tradingAccountSubscriptionId",
      'clientOrderId', oi."clientOrderId",
      'createdAt', oi."createdAt"
    )) FILTER (WHERE oi.id IS NOT NULL), '[]'::jsonb) AS order_intents,
    COALESCE(jsonb_agg(DISTINCT jsonb_build_object(
      'id', bo.id,
      'orderIntentId', bo."orderIntentId",
      'accountId', bo."tradingAccountId",
      'brokerOrderId', bo."brokerOrderId",
      'clientOrderId', bo."clientOrderId",
      'status', bo.status
    )) FILTER (WHERE bo.id IS NOT NULL), '[]'::jsonb) AS broker_orders,
    COALESCE(jsonb_agg(DISTINCT jsonb_build_object(
      'id', ed.id,
      'accountId', ed."tradingAccountId",
      'subscriptionId', ed."subscriptionId",
      'assignmentId', ed."tradingAccountSubscriptionId",
      'subscriptionKey', ed."subscriptionKey"
    )) FILTER (WHERE ed.id IS NOT NULL), '[]'::jsonb) AS entry_decision,
    COALESCE(jsonb_agg(DISTINCT jsonb_build_object(
      'id', ba.id,
      'accountId', ba."tradingAccountId",
      'activityType', ba."activityType",
      'orderId', ba."orderId",
      'transactionTime', ba."transactionTime"
    )) FILTER (WHERE ba.id IS NOT NULL), '[]'::jsonb) AS broker_activities
  FROM "OrderIntent" oi
  FULL JOIN "BrokerOrder" bo
    ON bo."trackedPositionId" = tp.id
   AND (oi.id IS NULL OR bo."orderIntentId" = oi.id)
  FULL JOIN "EntryDecision" ed ON ed."trackedPositionId" = tp.id
  FULL JOIN "BrokerActivity" ba ON ba."trackedPositionId" = tp.id
  WHERE oi."trackedPositionId" = tp.id
     OR bo."trackedPositionId" = tp.id
     OR ed."trackedPositionId" = tp.id
     OR ba."trackedPositionId" = tp.id
) opening ON true;
