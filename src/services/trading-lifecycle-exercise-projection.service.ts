import { isTerminalBrokerOrderStatus, normalizeBrokerOrderStatus } from './broker-order-lifecycle-status.service.js';

type TimelineEvent = {
  key: string;
  type: string;
  at: Date;
  label: string;
  entityType: string;
  entityId: number;
};

export type LifecycleExerciseStage =
  | 'PREVIEW_READY' | 'PREVIEW_BLOCKED' | 'DISPATCHING' | 'INTENT_CREATED'
  | 'ORDER_PENDING' | 'ORDER_SUBMITTING' | 'ORDER_ACCEPTED' | 'PARTIALLY_FILLED'
  | 'ENTRY_FILLED' | 'POSITION_OPEN' | 'EXIT_MONITORING' | 'PROTECTIVE_ORDER_ACTIVE'
  | 'CLOSE_SUBMITTING' | 'POSITION_CLOSING' | 'POSITION_CLOSED'
  | 'RECONCILIATION_PENDING' | 'RECONCILED' | 'FAILED'
  | 'ATTENTION_REQUIRED' | 'CANCELLED';

type ProjectionTarget = {
  id: number;
  status: string;
  previewedAt?: never;
  createdAt: Date;
  dispatchStartedAt: Date | null;
  dispatchCompletedAt: Date | null;
  intentCreatedAt: Date | null;
  reconciledAt: Date | null;
  cancelledAt: Date | null;
  reconciliationSummaryJson: unknown;
  orderIntent: null | {
    id: number;
    status: string;
    createdAt: Date;
    updatedAt: Date;
    brokerActivities: Array<{ id: number; activityType: string; createdAt: Date }>;
    brokerOrders: Array<{
      id: number; status: string; createdAt: Date; updatedAt: Date;
      trackedPosition: null | Position;
    }>;
    trackedPosition: null | Position;
  };
};

type Position = {
  id: number;
  status: string;
  openedAt: Date;
  closedAt: Date | null;
  updatedAt: Date;
  exitState: null | {
    id: number;
    status: string;
    attentionRequired: boolean;
    trailBrokerOrderId: string | null;
    trailClientOrderId: string | null;
    trailOrderStatus: string | null;
    createdAt: Date;
    updatedAt: Date;
  };
};

function positionFor(target: ProjectionTarget) {
  return target.orderIntent?.trackedPosition
    ?? target.orderIntent?.brokerOrders.find((order) => order.trackedPosition)?.trackedPosition
    ?? null;
}

function cleanReconciliation(summary: unknown) {
  return Boolean(summary && typeof summary === 'object' && 'clean' in summary && summary.clean === true);
}

export function projectTradingLifecycleExerciseTarget(target: ProjectionTarget) {
  const intent = target.orderIntent;
  const orders = intent?.brokerOrders ?? [];
  const position = positionFor(target);
  const exitState = position?.exitState ?? null;
  const statuses = orders.map((order) => normalizeBrokerOrderStatus(order.status));
  let stage: LifecycleExerciseStage;

  if (target.cancelledAt || target.status === 'CANCELLED') stage = 'CANCELLED';
  else if (target.status === 'ATTENTION_REQUIRED' || exitState?.attentionRequired) stage = 'ATTENTION_REQUIRED';
  else if (target.status === 'FAILED') stage = 'FAILED';
  else if (target.reconciledAt && position?.status === 'closed' && cleanReconciliation(target.reconciliationSummaryJson)) stage = 'RECONCILED';
  else if (position?.status === 'closed') stage = target.reconciledAt ? 'ATTENTION_REQUIRED' : 'RECONCILIATION_PENDING';
  else if (position?.status === 'closing') stage = 'POSITION_CLOSING';
  else if (exitState?.trailBrokerOrderId || exitState?.trailClientOrderId) stage = 'PROTECTIVE_ORDER_ACTIVE';
  else if (position?.status === 'open' && exitState) stage = 'EXIT_MONITORING';
  else if (position?.status === 'open') stage = 'POSITION_OPEN';
  else if (statuses.includes('partially_filled')) stage = 'PARTIALLY_FILLED';
  else if (statuses.includes('filled')) stage = 'ENTRY_FILLED';
  else if (statuses.some((status) => ['accepted', 'new', 'pending_new'].includes(status))) stage = 'ORDER_ACCEPTED';
  else if (orders.some((order) => !isTerminalBrokerOrderStatus(order.status))) stage = 'ORDER_SUBMITTING';
  else if (intent?.status === 'submitting') stage = 'ORDER_SUBMITTING';
  else if (intent?.status === 'pending') stage = 'ORDER_PENDING';
  else if (intent) stage = 'INTENT_CREATED';
  else if (target.dispatchStartedAt && !target.dispatchCompletedAt) stage = 'DISPATCHING';
  else if (target.status === 'BLOCKED') stage = 'PREVIEW_BLOCKED';
  else stage = 'PREVIEW_READY';

  const timeline: TimelineEvent[] = [{
    key: `preview:${target.id}`,
    type: 'PREVIEW_COMPLETED',
    at: target.createdAt,
    label: 'Target preview completed',
    entityType: 'tradingLifecycleExerciseTarget',
    entityId: target.id,
  }];
  const add = (event: TimelineEvent | null) => { if (event) timeline.push(event); };
  add(target.dispatchStartedAt ? { key: `dispatch:${target.id}`, type: 'DISPATCH_CLAIMED', at: target.dispatchStartedAt, label: 'Dispatch claimed', entityType: 'tradingLifecycleExerciseTarget', entityId: target.id } : null);
  add(intent ? { key: `intent:${intent.id}`, type: 'ENTRY_INTENT_CREATED', at: intent.createdAt, label: 'Entry intent created', entityType: 'orderIntent', entityId: intent.id } : null);
  for (const order of orders) {
    add({ key: `order:${order.id}:created`, type: 'BROKER_ORDER_MATERIALIZED', at: order.createdAt, label: 'Broker order materialized', entityType: 'brokerOrder', entityId: order.id });
    if (['accepted', 'new', 'pending_new'].includes(normalizeBrokerOrderStatus(order.status))) {
      add({ key: `order:${order.id}:accepted`, type: 'BROKER_ORDER_ACCEPTED', at: order.updatedAt, label: 'Broker order accepted', entityType: 'brokerOrder', entityId: order.id });
    }
  }
  for (const activity of intent?.brokerActivities ?? []) {
    add({ key: `activity:${activity.id}`, type: activity.activityType.toUpperCase(), at: activity.createdAt, label: `Broker activity: ${activity.activityType}`, entityType: 'brokerActivity', entityId: activity.id });
  }
  add(position ? { key: `position:${position.id}:open`, type: 'POSITION_OPENED', at: position.openedAt, label: 'Tracked position opened', entityType: 'trackedPosition', entityId: position.id } : null);
  add(exitState ? { key: `exit:${exitState.id}:created`, type: 'EXIT_STATE_INITIALIZED', at: exitState.createdAt, label: 'Exit monitoring initialized', entityType: 'positionExitState', entityId: exitState.id } : null);
  add(position?.closedAt ? { key: `position:${position.id}:closed`, type: 'POSITION_CLOSED', at: position.closedAt, label: 'Position closed', entityType: 'trackedPosition', entityId: position.id } : null);
  add(target.reconciledAt ? { key: `reconcile:${target.id}`, type: 'RECONCILIATION_COMPLETED', at: target.reconciledAt, label: 'Final reconciliation completed', entityType: 'tradingLifecycleExerciseTarget', entityId: target.id } : null);
  add(target.cancelledAt ? { key: `cancel:${target.id}`, type: 'CANCELLATION_REQUESTED', at: target.cancelledAt, label: 'Undispatched target cancelled', entityType: 'tradingLifecycleExerciseTarget', entityId: target.id } : null);

  return {
    stage,
    timeline: [...new Map(timeline.map((event) => [event.key, event])).values()]
      .sort((left, right) => left.at.getTime() - right.at.getTime()),
    links: {
      orderIntentId: intent?.id ?? null,
      brokerOrderIds: orders.map((order) => order.id),
      trackedPositionId: position?.id ?? null,
      positionExitStateId: exitState?.id ?? null,
    },
    lifecycleContinuesAfterCancellation: Boolean(target.cancelledAt && intent),
  };
}
