import { randomUUID } from 'node:crypto';
import { Prisma, type OrderIntentBrokerOpportunityApplicability, type OrderIntentBrokerOpportunityEventType, type PrismaClient } from '@prisma/client';
import { prisma } from '../db/prisma.js';
import { logger } from '../config/logger.js';

const BROKER_EVIDENCE_MAX_WAIT_MS = 250;
const BROKER_EVIDENCE_TRANSACTION_TIMEOUT_MS = 1_500;
const latencySamples = { disabled: [] as number[], enabled: [] as number[], failed: [] as number[] };
function observeLatency(bucket: keyof typeof latencySamples, started: number) { const values=latencySamples[bucket]; values.push(performance.now()-started); if(values.length>500)values.shift(); }
export function getBrokerOpportunityLatencySnapshot() { return Object.fromEntries(Object.entries(latencySamples).map(([key,values])=>{const sorted=[...values].sort((a,b)=>a-b);return [key,{count:values.length,p50Ms:sorted[Math.floor((sorted.length-1)*.5)]??null,p95Ms:sorted[Math.floor((sorted.length-1)*.95)]??null,maxMs:sorted.at(-1)??null}];})); }

type CoverageAnchor = { environment: string; provenance: string; captureSchemaVersion: number };

export function resolveBrokerOpportunityApplicability(anchor: CoverageAnchor): OrderIntentBrokerOpportunityApplicability {
  if (anchor.environment === 'LIVE') return 'NOT_APPLICABLE_LIVE';
  if (anchor.captureSchemaVersion < 2) return 'NOT_APPLICABLE_LEGACY';
  if (anchor.provenance === 'ACTIVE_EXACT') return 'APPLICABLE_ACTIVE';
  if (anchor.provenance === 'SUPERSEDED_COMPARE_ONLY') return 'APPLICABLE_SUPERSEDED';
  if (anchor.provenance === 'UNENROLLED') return 'NOT_APPLICABLE_UNENROLLED';
  return 'NOT_APPLICABLE_UNKNOWN';
}

export async function captureOrderIntentBrokerPostOpportunity(input: {
  orderIntentId: number;
  opportunitySequence?: number;
  idempotencyKey?: string;
}, db: PrismaClient = prisma) {
  if (input.opportunitySequence !== undefined && (!Number.isInteger(input.opportunitySequence) || input.opportunitySequence < 1)) throw new RangeError('Opportunity sequence must be positive.');
  const idempotencyKey=input.idempotencyKey?.trim()||`broker-post:${input.orderIntentId}:${randomUUID()}`;

  return db.$transaction(async tx => {
    await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '250ms'`);
    await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = '1000ms'`);
    const rollout=await tx.orderIntentBrokerOpportunityCaptureRollout.findUnique({where:{id:1},select:{enabled:true,effectiveEpoch:true}});
    if(!rollout?.enabled||!rollout.effectiveEpoch)return null;
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${idempotencyKey},0))::text`;
    await tx.$queryRaw`SELECT id FROM "OrderIntent" WHERE id=${input.orderIntentId} FOR UPDATE`;
    const existing = await tx.orderIntentBrokerPostOpportunity.findUnique({ where: { idempotencyKey } });
    if (existing) {
      if (existing.orderIntentId !== input.orderIntentId || (input.opportunitySequence!==undefined&&existing.opportunitySequence !== input.opportunitySequence)) throw new Error('BROKER_OPPORTUNITY_IDEMPOTENCY_CONFLICT');
      return existing;
    }
    const opportunitySequence=input.opportunitySequence??((await tx.orderIntentBrokerPostOpportunity.aggregate({where:{orderIntentId:input.orderIntentId},_max:{opportunitySequence:true}}))._max.opportunitySequence??0)+1;
    const anchors = await tx.$queryRaw<Array<{
      orderIntentId: number; coverageId: number; tradingAccountId: number; accountSubscriptionId: number;
      clientOrderId: string; environment: string; provenance: string; captureSchemaVersion: number;
      enrollmentGenerationId: number | null; boundPolicyRevisionId: number | null;
      marketRegimeAssessmentId: number | null; sourceSetFingerprint: string | null; opportunityAt: Date;
    }>>(Prisma.sql`
      SELECT i.id AS "orderIntentId",c.id AS "coverageId",c."tradingAccountId",c."accountSubscriptionId",
        i."clientOrderId",a.environment::text,c.provenance::text,c."captureSchemaVersion",
        c."enrollmentGenerationId",c."boundPolicyRevisionId",m.id AS "marketRegimeAssessmentId",
        m."sourceSetFingerprint",statement_timestamp() AS "opportunityAt"
      FROM "OrderIntent" i
      JOIN "OrderIntentMarketPolicyCoverage" c ON c."orderIntentId"=i.id
      JOIN "TradingAccount" a ON a.id=c."tradingAccountId"
      JOIN "OrderIntentBrokerOpportunityCaptureRollout" r ON r.id=1 AND r.enabled
        AND r."effectiveEpoch" IS NOT NULL AND statement_timestamp()>=r."effectiveEpoch"
      LEFT JOIN LATERAL (
        SELECT x.id,x."sourceSetFingerprint" FROM "MarketRegimeAssessment" x
        WHERE x."compositionVersion"='MARKET_REGIME_COMPOSITION_V1' AND x."publicationStatus"='SUCCEEDED'
          AND x."observedAt"<=statement_timestamp()
        ORDER BY x."targetAt" DESC,x."observedAt" DESC,x.id DESC LIMIT 1
      ) m ON true
      WHERE i.id=${input.orderIntentId} AND i.side='buy' AND i."clientOrderId" IS NOT NULL
      FOR SHARE OF i,c,a`);
    const anchor = anchors[0];
    if (!anchor) throw new Error('BROKER_OPPORTUNITY_ANCHOR_UNAVAILABLE');
    const applicability = resolveBrokerOpportunityApplicability({ environment: anchor.environment, provenance: anchor.provenance, captureSchemaVersion: anchor.captureSchemaVersion });
    const applicable = applicability === 'APPLICABLE_ACTIVE' || applicability === 'APPLICABLE_SUPERSEDED';
    const inserted = await tx.orderIntentBrokerPostOpportunity.create({ data: {
      orderIntentId: anchor.orderIntentId, intentCoverageId: anchor.coverageId, tradingAccountId: anchor.tradingAccountId,
      accountSubscriptionId: anchor.accountSubscriptionId, clientOrderId: anchor.clientOrderId,
      opportunitySequence, idempotencyKey,
      enrollmentGenerationId: applicable ? anchor.enrollmentGenerationId : null,
      policyRevisionId: applicable ? anchor.boundPolicyRevisionId : null,
      marketRegimeAssessmentId: anchor.marketRegimeAssessmentId, sourceSetFingerprint: anchor.sourceSetFingerprint,
      compositionCapture: anchor.marketRegimeAssessmentId ? 'EXACT' : 'NONE_VISIBLE', applicability,
      comparisonMode: 'COMPARE_ONLY', tradingEffect: 'NONE', opportunityAt: anchor.opportunityAt,
      events: { create: { orderIntentId:anchor.orderIntentId,sequence: 1, eventType: 'OPPORTUNITY_CAPTURED', evidenceJson: { captureVersion: 1 } } },
    } });
    return inserted;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, maxWait: BROKER_EVIDENCE_MAX_WAIT_MS, timeout: BROKER_EVIDENCE_TRANSACTION_TIMEOUT_MS });
}

export async function bestEffortCaptureOrderIntentBrokerPostOpportunity(orderIntentId:number,db:PrismaClient=prisma){const started=performance.now();try{const row=await captureOrderIntentBrokerPostOpportunity({orderIntentId},db);observeLatency(row?'enabled':'disabled',started);return row;}catch(error){observeLatency('failed',started);if(error instanceof Error&&error.message==='BROKER_OPPORTUNITY_ANCHOR_UNAVAILABLE'){try{await appendMissingBrokerObservation(orderIntentId,{reasonCode:'BROKER_OPPORTUNITY_ANCHOR_UNAVAILABLE'},db);}catch(missingError){logger.warn({orderIntentId,error:missingError},'Missing broker observation event also failed without changing broker submission.');}}logger.warn({orderIntentId,error},'Broker opportunity observation failed without changing broker submission.');return null;}}

export async function appendOrderIntentBrokerOpportunityEvent(opportunityId:number,eventType:OrderIntentBrokerOpportunityEventType,evidence:Prisma.InputJsonValue,db:PrismaClient=prisma){return db.$transaction(async tx=>{await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '250ms'`);await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = '1000ms'`);const rows=await tx.$queryRaw<Array<{orderIntentId:number}>>`SELECT "orderIntentId" FROM "OrderIntentBrokerPostOpportunity" WHERE id=${opportunityId} FOR UPDATE`;const anchor=rows[0];if(!anchor)throw new Error('BROKER_OPPORTUNITY_NOT_FOUND');const last=await tx.orderIntentBrokerOpportunityEvent.aggregate({where:{opportunityId},_max:{sequence:true}});return tx.orderIntentBrokerOpportunityEvent.create({data:{orderIntentId:anchor.orderIntentId,opportunityId,sequence:(last._max.sequence??0)+1,eventType,evidenceJson:evidence}});},{maxWait:BROKER_EVIDENCE_MAX_WAIT_MS,timeout:BROKER_EVIDENCE_TRANSACTION_TIMEOUT_MS});}

export async function appendMissingBrokerObservation(orderIntentId:number,evidence:Prisma.InputJsonValue,db:PrismaClient=prisma){return db.$transaction(async tx=>{await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '250ms'`);await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = '1000ms'`);await tx.$queryRaw`SELECT id FROM "OrderIntent" WHERE id=${orderIntentId} FOR UPDATE`;const last=await tx.orderIntentBrokerOpportunityEvent.aggregate({where:{orderIntentId,opportunityId:null},_max:{sequence:true}});return tx.orderIntentBrokerOpportunityEvent.create({data:{orderIntentId,opportunityId:null,sequence:(last._max.sequence??0)+1,eventType:'MISSING_OBSERVATION',evidenceJson:evidence}});},{maxWait:BROKER_EVIDENCE_MAX_WAIT_MS,timeout:BROKER_EVIDENCE_TRANSACTION_TIMEOUT_MS});}

async function appendLatestOrderIntentBrokerOpportunityEvent(orderIntentId:number,eventType:OrderIntentBrokerOpportunityEventType,evidence:Prisma.InputJsonValue,db:PrismaClient){return db.$transaction(async tx=>{await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '250ms'`);await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = '1000ms'`);await tx.$queryRaw`SELECT id FROM "OrderIntent" WHERE id=${orderIntentId} FOR UPDATE`;const opportunity=await tx.orderIntentBrokerPostOpportunity.findFirst({where:{orderIntentId},orderBy:{opportunitySequence:'desc'},select:{id:true}});if(!opportunity)return null;await tx.$queryRaw`SELECT id FROM "OrderIntentBrokerPostOpportunity" WHERE id=${opportunity.id} FOR UPDATE`;const last=await tx.orderIntentBrokerOpportunityEvent.aggregate({where:{opportunityId:opportunity.id},_max:{sequence:true}});return tx.orderIntentBrokerOpportunityEvent.create({data:{orderIntentId,opportunityId:opportunity.id,sequence:(last._max.sequence??0)+1,eventType,evidenceJson:evidence}});},{maxWait:BROKER_EVIDENCE_MAX_WAIT_MS,timeout:BROKER_EVIDENCE_TRANSACTION_TIMEOUT_MS});}

export async function bestEffortAppendBrokerOpportunityEvent(args:{opportunityId?:number|null;orderIntentId?:number;eventType:OrderIntentBrokerOpportunityEventType;evidence?:Prisma.InputJsonValue},db:PrismaClient=prisma){try{const row=args.opportunityId?await appendOrderIntentBrokerOpportunityEvent(args.opportunityId,args.eventType,args.evidence??{},db):args.orderIntentId===undefined?null:await appendLatestOrderIntentBrokerOpportunityEvent(args.orderIntentId,args.eventType,args.evidence??{},db);return row!==null;}catch(error){logger.warn({opportunityId:args.opportunityId,orderIntentId:args.orderIntentId,eventType:args.eventType,error},'Broker opportunity event persistence failed without changing broker behavior.');return false;}}
