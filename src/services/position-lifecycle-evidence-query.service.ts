import { createHash } from 'node:crypto';
import type { QueryResult } from 'pg';

import type { InventoryIntentEvidence, PositionLifecycleEvidenceSource } from './position-lifecycle-evidence-inventory.types.js';

export type ReadonlyInventoryDb = { query<T extends Record<string, unknown> = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<QueryResult<T>> };

const hashExternal = (value: string | null) => value === null ? null : `sha256:${createHash('sha256').update(value).digest('hex')}`;
const mask = (value: string | null) => value === null ? null : `***${value.slice(-4)}`;
const iso = (value: Date | string | null) => value === null ? null : new Date(value).toISOString();
const nums = (values: Array<number | null | undefined>) => [...new Set(values.filter((value): value is number => value != null))].sort((a,b) => a-b);

type PositionRow = { id:number; tradingAccountId:number|null; accountBroker:string|null; positionBroker:string; environment:string|null; brokerAccountId:string|null; securityId:number; securitySymbol:string; positionSymbol:string; side:string; status:string; openedAt:Date; closedAt:Date|null; qty:number; subscriptionId:number|null; tradingAccountSubscriptionId:number|null; configSnapshotCapturedAt:Date|null; lifecycleAuthorityAtCreation:'EXECUTOR'|'OBSERVER'|null; exitStateId:number|null; exitManagementModeSnapshot:string|null; exitOwnershipProvenance:unknown; exitStatus:string|null; trailBrokerOrderId:string|null; trailingStopOrderId:string|null };
type IntentRow = { id:number; positionId:number; source:string; createdAt:Date; tradingAccountId:number|null; trackedPositionId:number|null; side:string; status:string; symbol:string; qty:number|null; clientOrderId:string|null; subscriptionId:number|null; tradingAccountSubscriptionId:number|null };
type OrderRow = { id:number; orderIntentId:number; tradingAccountId:number|null; trackedPositionId:number|null; broker:string; securityId:number; symbol:string; status:string; brokerOrderId:string; clientOrderId:string; side:string };
type FillRow = { id:number; orderIntentId:number; activityId:string; duplicateCount:string|number; tradingAccountId:number|null; trackedPositionId:number|null; trackedPositionLinkSource:string|null; broker:string; mode:string; symbol:string|null; brokerOrderRecordId:number|null; orderId:string|null; side:string|null; qty:number|null; cumQty:number|null; leavesQty:number|null; transactionTime:Date|null };
type DispatchRow = { orderIntentId:number; consumptionId:number|null; consumptionClientOrderId:string|null; unenforcedId:number|null; unenforcedClientOrderId:string|null; opportunityId:number|null };
type MarkerRow = { orderIntentId:number; id:number; evidenceJson:unknown };
type AttributionRow = { positionId:number; subscriptionId:number; securityId:number; strategyId:number; exitProfileId:number; assignmentId:number|null; assignmentAccountId:number|null; assignmentSubscriptionId:number|null };
type ClaimRow = { positionId:number; id:number; tradingAccountId:number; securityId:number; orderIntentId:number|null; trackedPositionId:number|null; status:string; releasedAt:Date|null; events:Array<{id:number;eventType:string}>|null };
type ProvenanceRow = { positionId:number; id:number; origin:string; ownership:string; legacyExitContinuityAuthorized:boolean; classifierVersion:string; evidenceFingerprint:string; supersedesDecisionId:number|null };
type AttentionRow = { positionId:number; id:number; code:string; status:string; source:string };
type UnmatchedFillRow = { positionId:number; id:number; activityId:string; side:string|null; qty:number|null; trackedPositionLinkSource:string|null };

function markerIdentity(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {orderIntentId:null,clientOrderId:null};
  const record=value as Record<string,unknown>;
  return {orderIntentId:Number.isInteger(record.orderIntentId)?record.orderIntentId as number:null,clientOrderId:typeof record.clientOrderId==='string'&&record.clientOrderId.length>0?record.clientOrderId:null};
}

export async function loadPositionLifecycleEvidenceBatch(db: ReadonlyInventoryDb, args: { afterPositionId: number; limit: number }): Promise<PositionLifecycleEvidenceSource[]> {
  const positions = (await db.query<PositionRow>(`
    SELECT p.id, p."tradingAccountId", a.broker::text AS "accountBroker", p.broker AS "positionBroker",
      a.environment::text, a."brokerAccountId", p."securityId", s.symbol AS "securitySymbol", p.symbol AS "positionSymbol",
      p.side, p.status, p."openedAt", p."closedAt", p.qty, p."subscriptionId", p."tradingAccountSubscriptionId",
      p."configSnapshotCapturedAt", p."lifecycleAuthorityAtCreation"::text, e.id AS "exitStateId",
      e."exitManagementModeSnapshot"::text, e."exitOwnershipProvenance", e.status AS "exitStatus",
      e."trailBrokerOrderId", p."trailingStopOrderId"
    FROM "TrackedPosition" p
    JOIN "Security" s ON s.id=p."securityId"
    LEFT JOIN "TradingAccount" a ON a.id=p."tradingAccountId"
    LEFT JOIN "PositionExitState" e ON e."trackedPositionId"=p.id
    WHERE p.id > $1 ORDER BY p.id ASC LIMIT $2`, [args.afterPositionId, args.limit])).rows;
  if (!positions.length) return [];
  const positionIds = positions.map((row) => row.id);
  const intents = (await db.query<IntentRow>(`
    SELECT i.id, p.id AS "positionId", i.source, i."createdAt", i."tradingAccountId", i."trackedPositionId", i.side, i.status, i.symbol, i.qty,
      i."clientOrderId", i."subscriptionId", i."tradingAccountSubscriptionId"
    FROM "TrackedPosition" p JOIN "OrderIntent" i ON
      i."trackedPositionId"=p.id OR
      EXISTS (SELECT 1 FROM "BrokerOrder" bo WHERE bo."orderIntentId"=i.id AND bo."trackedPositionId"=p.id) OR
      EXISTS (SELECT 1 FROM "BrokerActivity" ba WHERE ba."orderIntentId"=i.id AND ba."trackedPositionId"=p.id) OR
      EXISTS (SELECT 1 FROM "EntryExposureClaim" ec WHERE ec."orderIntentId"=i.id AND ec."trackedPositionId"=p.id)
    WHERE p.id=ANY($1::int[]) ORDER BY p.id,i.id`, [positionIds])).rows;
  const intentIds = intents.map((row) => row.id);
  const orders=intentIds.length?await db.query<OrderRow>(`SELECT id,"orderIntentId","tradingAccountId","trackedPositionId",broker,"securityId",symbol,status,"brokerOrderId","clientOrderId",side FROM "BrokerOrder" WHERE "orderIntentId"=ANY($1::int[]) ORDER BY "orderIntentId",id`,[intentIds]):{rows:[]} as unknown as QueryResult<OrderRow>;
  const fills=intentIds.length?await db.query<FillRow>(`SELECT ba.id,ba."orderIntentId",ba."activityId",(SELECT count(*) FROM "BrokerActivity" duplicate WHERE duplicate.broker=ba.broker AND duplicate.mode=ba.mode AND duplicate."tradingAccountId" IS NOT DISTINCT FROM ba."tradingAccountId" AND duplicate."activityId"=ba."activityId") AS "duplicateCount",ba."tradingAccountId",ba."trackedPositionId",ba."trackedPositionLinkSource",ba.broker,ba.mode,ba.symbol,ba."brokerOrderRecordId",ba."orderId",ba.side,ba.qty,ba."cumQty",ba."leavesQty",ba."transactionTime" FROM "BrokerActivity" ba WHERE ba."activityType"='FILL' AND ba."orderIntentId"=ANY($1::int[]) ORDER BY ba."orderIntentId",ba."transactionTime" NULLS LAST,ba.id`,[intentIds]):{rows:[]} as unknown as QueryResult<FillRow>;
  const dispatches=intentIds.length?await db.query<DispatchRow>(`SELECT i.id AS "orderIntentId",c.id AS "consumptionId",c."clientOrderId" AS "consumptionClientOrderId",u.id AS "unenforcedId",u."clientOrderId" AS "unenforcedClientOrderId",o.id AS "opportunityId" FROM "OrderIntent" i LEFT JOIN "MarketPolicyBrokerDispatchConsumption" c ON c."orderIntentId"=i.id LEFT JOIN "MarketPolicyBrokerUnenforcedDispatch" u ON u."orderIntentId"=i.id LEFT JOIN "OrderIntentBrokerPostOpportunity" o ON o."orderIntentId"=i.id WHERE i.id=ANY($1::int[]) ORDER BY i.id,o.id`,[intentIds]):{rows:[]} as unknown as QueryResult<DispatchRow>;
  const markers=intentIds.length?await db.query<MarkerRow>(`SELECT i.id AS "orderIntentId",ev.id,ev."evidenceJson" FROM "OrderIntent" i JOIN "EntryExposureClaim" c ON c."orderIntentId"=i.id JOIN "EntryExposureClaimEvent" ev ON ev."claimId"=c.id AND ev."eventType"='ADAPTER_INVOCATION_STARTED' WHERE i.id=ANY($1::int[]) ORDER BY i.id,ev.id`,[intentIds]):{rows:[]} as unknown as QueryResult<MarkerRow>;
  const attrs=await db.query<AttributionRow>(`WITH related AS (
    SELECT DISTINCT p.id AS "positionId",i."subscriptionId",i."tradingAccountSubscriptionId"
    FROM "TrackedPosition" p JOIN "OrderIntent" i ON i."trackedPositionId"=p.id
      OR EXISTS (SELECT 1 FROM "BrokerOrder" bo WHERE bo."orderIntentId"=i.id AND bo."trackedPositionId"=p.id)
      OR EXISTS (SELECT 1 FROM "BrokerActivity" ba WHERE ba."orderIntentId"=i.id AND ba."trackedPositionId"=p.id)
      OR EXISTS (SELECT 1 FROM "EntryExposureClaim" ec WHERE ec."orderIntentId"=i.id AND ec."trackedPositionId"=p.id)
    WHERE p.id=ANY($1::int[])
  ) SELECT p.id AS "positionId",s.id AS "subscriptionId",s."securityId",s."strategyId",s."exitProfileId",tas.id AS "assignmentId",tas."tradingAccountId" AS "assignmentAccountId",tas."subscriptionId" AS "assignmentSubscriptionId"
    FROM "TrackedPosition" p JOIN "Subscription" s ON s.id=p."subscriptionId" OR s.id IN (SELECT r."subscriptionId" FROM related r WHERE r."positionId"=p.id)
    LEFT JOIN "TradingAccountSubscription" tas ON tas."subscriptionId"=s.id AND (tas.id=p."tradingAccountSubscriptionId" OR tas.id IN (SELECT r."tradingAccountSubscriptionId" FROM related r WHERE r."positionId"=p.id))
    WHERE p.id=ANY($1::int[]) ORDER BY p.id,s.id,tas.id`,[positionIds]);
  const claims=await db.query<ClaimRow>(`SELECT p.id AS "positionId",c.id,c."tradingAccountId",c."securityId",c."orderIntentId",c."trackedPositionId",c.status,c."releasedAt",coalesce(json_agg(json_build_object('id',ev.id,'eventType',ev."eventType") ORDER BY ev.id) FILTER (WHERE ev.id IS NOT NULL),'[]') AS events FROM "TrackedPosition" p JOIN "EntryExposureClaim" c ON c."trackedPositionId"=p.id OR c."orderIntentId" IN (SELECT i.id FROM "OrderIntent" i WHERE i."trackedPositionId"=p.id OR EXISTS (SELECT 1 FROM "BrokerOrder" bo WHERE bo."orderIntentId"=i.id AND bo."trackedPositionId"=p.id) OR EXISTS (SELECT 1 FROM "BrokerActivity" ba WHERE ba."orderIntentId"=i.id AND ba."trackedPositionId"=p.id)) LEFT JOIN "EntryExposureClaimEvent" ev ON ev."claimId"=c.id WHERE p.id=ANY($1::int[]) GROUP BY p.id,c.id ORDER BY p.id,c.id`,[positionIds]);
  const provenance=await db.query<ProvenanceRow>(`SELECT "trackedPositionId" AS "positionId",id,origin::text,ownership::text,"legacyExitContinuityAuthorized","classifierVersion","evidenceFingerprint","supersedesDecisionId" FROM "PositionLifecycleProvenanceDecision" WHERE "trackedPositionId"=ANY($1::int[]) ORDER BY "trackedPositionId",id`,[positionIds]);
  const unmatchedFills=await db.query<UnmatchedFillRow>(`SELECT "trackedPositionId" AS "positionId",id,"activityId",side,qty,"trackedPositionLinkSource" FROM "BrokerActivity" WHERE "trackedPositionId"=ANY($1::int[]) AND "activityType"='FILL' AND "orderIntentId" IS NULL ORDER BY "trackedPositionId",id`,[positionIds]);
  const attention=await db.query<AttentionRow>(`SELECT DISTINCT p.id AS "positionId",oa.id,oa.code,oa.status::text,oa.source FROM "TrackedPosition" p JOIN "OperationalAttention" oa ON oa."trackedPositionId"=p.id OR oa."orderIntentId" IN (SELECT i.id FROM "OrderIntent" i WHERE i."trackedPositionId"=p.id OR EXISTS (SELECT 1 FROM "BrokerOrder" bo WHERE bo."orderIntentId"=i.id AND bo."trackedPositionId"=p.id) OR EXISTS (SELECT 1 FROM "BrokerActivity" ba WHERE ba."orderIntentId"=i.id AND ba."trackedPositionId"=p.id)) OR oa."brokerOrderId" IN (SELECT bo.id FROM "BrokerOrder" bo WHERE bo."trackedPositionId"=p.id) WHERE p.id=ANY($1::int[]) ORDER BY p.id,oa.id`,[positionIds]);
  const rowsBy = <T extends {positionId:number}>(rows:T[]) => { const out=new Map<number,T[]>(); for(const row of rows){const list=out.get(row.positionId)??[];list.push(row);out.set(row.positionId,list);} return out; };
  const intentByPosition=rowsBy(intents); const attrsByPosition=rowsBy(attrs.rows); const claimsByPosition=rowsBy(claims.rows); const provenanceByPosition=rowsBy(provenance.rows); const attentionByPosition=rowsBy(attention.rows);const unmatchedByPosition=rowsBy(unmatchedFills.rows);

  return positions.map((position) => {
    const positionIntents: InventoryIntentEvidence[] = (intentByPosition.get(position.id) ?? []).map((intent) => {
      const intentOrders=orders.rows.filter((row)=>row.orderIntentId===intent.id); const intentFills=fills.rows.filter((row)=>row.orderIntentId===intent.id);
      const ds=dispatches.rows.filter((row)=>row.orderIntentId===intent.id); const ms=markers.rows.filter((row)=>row.orderIntentId===intent.id);
      const orderById=new Map(intentOrders.map((row)=>[row.id,row]));
      const durableClientIds=[...ds.map((row)=>row.consumptionClientOrderId),...ds.map((row)=>row.unenforcedClientOrderId)].filter((value):value is string=>value!==null);
      const markerIdentities=ms.map(row=>({row,identity:markerIdentity(row.evidenceJson)}));
      return { id:intent.id,source:intent.source,createdAt:iso(intent.createdAt)!,tradingAccountId:intent.tradingAccountId,trackedPositionId:intent.trackedPositionId,side:intent.side,status:intent.status,symbol:intent.symbol,qty:intent.qty,clientOrderIdHash:hashExternal(intent.clientOrderId),subscriptionId:intent.subscriptionId,tradingAccountSubscriptionId:intent.tradingAccountSubscriptionId,
        brokerOrders:intentOrders.map((row)=>({id:row.id,tradingAccountId:row.tradingAccountId,trackedPositionId:row.trackedPositionId,broker:row.broker,securityId:row.securityId,symbol:row.symbol,status:row.status,brokerOrderIdHash:hashExternal(row.brokerOrderId)!,clientOrderIdHash:hashExternal(row.clientOrderId)!,clientOrderIdMatchesIntent:intent.clientOrderId!==null&&row.clientOrderId===intent.clientOrderId,side:row.side})),
        fills:intentFills.map((row)=>({id:row.id,activityIdHash:hashExternal(row.activityId)!,activityIdDuplicateCount:Number(row.duplicateCount),tradingAccountId:row.tradingAccountId,trackedPositionId:row.trackedPositionId,trackedPositionLinkSource:row.trackedPositionLinkSource,broker:row.broker,mode:row.mode,symbol:row.symbol,brokerOrderRecordId:row.brokerOrderRecordId,orderIdHash:hashExternal(row.orderId),orderIdMatchesBrokerOrder:row.brokerOrderRecordId!==null&&orderById.get(row.brokerOrderRecordId)?.brokerOrderId===row.orderId,side:row.side,qty:row.qty,cumQty:row.cumQty,leavesQty:row.leavesQty,transactionTime:iso(row.transactionTime)})),
        dispatch:{consumptionIds:nums(ds.map((row)=>row.consumptionId)),unenforcedDispatchIds:nums(ds.map((row)=>row.unenforcedId)),brokerOpportunityIds:nums(ds.map((row)=>row.opportunityId)),adapterMarkers:markerIdentities.map(({row,identity})=>({eventId:row.id,orderIntentId:identity.orderIntentId,clientOrderIdHash:hashExternal(identity.clientOrderId),identityComplete:identity.orderIntentId!==null&&identity.clientOrderId!==null,matchesIntent:identity.orderIntentId===intent.id&&identity.clientOrderId!==null&&identity.clientOrderId===intent.clientOrderId,matchesDurableDispatch:identity.clientOrderId!==null&&durableClientIds.length===1&&durableClientIds[0]===identity.clientOrderId,matchesBrokerOrder:identity.clientOrderId!==null&&intentOrders.length===1&&intentOrders[0]!.clientOrderId===identity.clientOrderId})),durableClientIdentityConsistent:intent.clientOrderId!==null&&durableClientIds.length===1&&durableClientIds[0]===intent.clientOrderId},evidenceRole:'UNCLASSIFIED' };
    });
    const decisions=provenanceByPosition.get(position.id)??[];const byId=new Map(decisions.map(x=>[x.id,x]));const children=new Map<number,number>();for(const row of decisions)if(row.supersedesDecisionId!==null)children.set(row.supersedesDecisionId,(children.get(row.supersedesDecisionId)??0)+1);const roots=decisions.filter(x=>x.supersedesDecisionId===null);const heads=decisions.filter(x=>!children.has(x.id));let visited=0;let cursor=roots.length===1?roots[0]:undefined;const seen=new Set<number>();while(cursor&&!seen.has(cursor.id)){seen.add(cursor.id);visited++;const next=decisions.filter(x=>x.supersedesDecisionId===cursor!.id);cursor=next.length===1?next[0]:undefined;}const chainValid=decisions.length===0||(roots.length===1&&heads.length===1&&visited===decisions.length&&decisions.every(x=>x.supersedesDecisionId===null||byId.has(x.supersedesDecisionId))&&[...children.values()].every(x=>x===1));const head=chainValid&&heads.length===1?heads[0]:null;
    const claimRows=claimsByPosition.get(position.id)??[];
    return { identity:{trackedPositionId:position.id,tradingAccountId:position.tradingAccountId,accountBroker:position.accountBroker,positionBroker:position.positionBroker,environment:position.environment,brokerAccountIdMasked:mask(position.brokerAccountId),securityId:position.securityId,securitySymbol:position.securitySymbol,positionSymbol:position.positionSymbol,side:position.side}, currentState:{status:position.status,openedAt:iso(position.openedAt)!,closedAt:iso(position.closedAt),qty:position.qty,subscriptionId:position.subscriptionId,tradingAccountSubscriptionId:position.tradingAccountSubscriptionId,configSnapshotCapturedAt:iso(position.configSnapshotCapturedAt)}, creationAuthority:position.lifecycleAuthorityAtCreation, intents:positionIntents, unmatchedFills:(unmatchedByPosition.get(position.id)??[]).map(fill=>({id:fill.id,activityIdHash:hashExternal(fill.activityId)!,side:fill.side,qty:fill.qty,trackedPositionLinkSource:fill.trackedPositionLinkSource})),attribution:attrsByPosition.get(position.id)??[], exitState:position.exitStateId===null?null:{id:position.exitStateId,exitManagementModeSnapshot:position.exitManagementModeSnapshot!,hasOwnershipProvenance:position.exitOwnershipProvenance!==null,status:position.exitStatus!,hasProtectiveOrderState:position.trailBrokerOrderId!==null||position.trailingStopOrderId!==null}, claims:claimRows.map(claim=>({id:claim.id,tradingAccountId:claim.tradingAccountId,securityId:claim.securityId,orderIntentId:claim.orderIntentId,trackedPositionId:claim.trackedPositionId,status:claim.status,releasedAt:iso(claim.releasedAt),events:claim.events??[]})), provenance:{chainValid,decisionIds:decisions.map((row)=>row.id),effectiveDecisionId:head?.id??null,origin:head?.origin??null,ownership:head?.ownership??null,legacyExitContinuityAuthorized:head?.legacyExitContinuityAuthorized??false,classifierVersion:head?.classifierVersion??null,evidenceFingerprint:head?.evidenceFingerprint??null,trust:'UNVERIFIED'}, operationalAttention:attentionByPosition.get(position.id)??[] };
  });
}
