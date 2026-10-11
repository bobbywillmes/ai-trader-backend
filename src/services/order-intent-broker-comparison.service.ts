import { randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import { prisma } from '../db/prisma.js';
import { evaluateStrategyMarketEligibility } from './strategy-market-eligibility.service.js';

export const ORDER_INTENT_BROKER_COMPARISON_VERSION = 'ORDER_INTENT_BROKER_COMPARISON_V1';
const MAX_ATTEMPTS = 3; const MAX_BATCH = 25;
const json = (value: unknown): Prisma.InputJsonValue => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;

export async function seedOrderIntentBrokerComparisonDeliveries(limit = 25, db: PrismaClient = prisma) {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_BATCH) throw new RangeError('Broker comparison seed limit must be between 1 and 25.');
  return db.$executeRaw`INSERT INTO "OrderIntentBrokerComparisonDelivery"("opportunityId",status,"attemptCount","nextAttemptAt","createdAt","updatedAt")
    SELECT o.id,'PENDING'::"OrderIntentMarketPolicyComparisonDeliveryStatus",0,statement_timestamp(),statement_timestamp(),statement_timestamp()
    FROM "OrderIntentBrokerPostOpportunity" o CROSS JOIN "OrderIntentBrokerComparisonRollout" r
    WHERE r.id=1 AND r.enabled AND r."effectiveEpoch" IS NOT NULL AND o."opportunityAt">=r."effectiveEpoch"
      AND o.applicability IN ('APPLICABLE_ACTIVE','APPLICABLE_SUPERSEDED')
      AND NOT EXISTS(SELECT 1 FROM "OrderIntentBrokerComparisonDelivery" d WHERE d."opportunityId"=o.id)
    ORDER BY o.id LIMIT ${limit} ON CONFLICT("opportunityId") DO NOTHING`;
}

async function claim(workerId: string, db: PrismaClient) {
  return db.$transaction(async tx => (await tx.$queryRaw<Array<{id:number; opportunityId:number; attemptCount:number}>>`
    WITH candidate AS (SELECT d.id FROM "OrderIntentBrokerComparisonDelivery" d CROSS JOIN "OrderIntentBrokerComparisonRollout" r
      WHERE r.id=1 AND r.enabled AND d."attemptCount"<${MAX_ATTEMPTS} AND ((d.status IN ('PENDING','RETRY_WAIT') AND d."nextAttemptAt"<=statement_timestamp()) OR (d.status='CLAIMED' AND d."leaseExpiresAt"<=statement_timestamp()))
      ORDER BY d.id FOR UPDATE OF d SKIP LOCKED LIMIT 1)
    UPDATE "OrderIntentBrokerComparisonDelivery" d SET status='CLAIMED',"attemptCount"=d."attemptCount"+1,"leaseOwner"=${workerId},"leaseExpiresAt"=statement_timestamp()+interval '60 seconds',"updatedAt"=statement_timestamp()
    FROM candidate WHERE d.id=candidate.id RETURNING d.id,d."opportunityId",d."attemptCount"`)[0] ?? null);
}

const opportunityInclude = { enrollmentGeneration: true, policyRevision: { include: { dimensionRules: { include: { allowedStates: true } } } }, marketRegimeAssessment: { include: { sources: true } } } satisfies Prisma.OrderIntentBrokerPostOpportunityInclude;

async function complete(c: {id:number; opportunityId:number; attemptCount:number}, workerId: string, db: PrismaClient, evaluator: typeof evaluateStrategyMarketEligibility) {
  const o = await db.orderIntentBrokerPostOpportunity.findUnique({ where: { id: c.opportunityId }, include: opportunityInclude });
  if (!o?.enrollmentGeneration || !o.policyRevision) throw new Error('BROKER_COMPARISON_IDENTITY_MISSING');
  const disposition = o.applicability === 'APPLICABLE_ACTIVE' ? 'ACTIVE' : 'SUPERSEDED_DIAGNOSTIC';
  try {
    const result = o.compositionCapture === 'NONE_VISIBLE' ? null : evaluator(o.policyRevision.dimensionRules, o.marketRegimeAssessment!.sources, o.opportunityAt);
    await db.$transaction(async tx => {
      const d = await tx.orderIntentBrokerComparisonDelivery.findUnique({ where: { id: c.id } });
      if (!d || d.status !== 'CLAIMED' || d.leaseOwner !== workerId) return;
      const existing = await tx.orderIntentBrokerComparisonAttempt.findFirst({ where: { opportunityId: o.id, outcome: { not: 'TECHNICAL_FAILURE' } } });
      if (!existing) await tx.orderIntentBrokerComparisonAttempt.create({ data: {
        opportunityId:o.id,attempt:c.attemptCount,enrollmentGenerationId:o.enrollmentGenerationId!,policyRevisionId:o.policyRevisionId!,marketRegimeAssessmentId:o.marketRegimeAssessmentId,evidenceAsOf:o.opportunityAt,evaluationVersion:ORDER_INTENT_BROKER_COMPARISON_VERSION,enrollmentDisposition:disposition,
        outcome: (result?.outcome ?? 'INSUFFICIENT_EVIDENCE') as 'ALLOWED'|'BLOCKED'|'INSUFFICIENT_EVIDENCE', reasonCode: result?.reasonCode ?? 'NO_COMPOSITION_VISIBLE',authority:'COMPARE_ONLY',tradingEffect:'NONE',evidenceJson:json({opportunityId:o.id,sourceSetFingerprint:o.sourceSetFingerprint}),
        ...(result ? { gates: { create: result.gates.map(g => ({dimension:g.dimension,algorithmVersion:g.algorithmVersion,requirement:g.requirement,outcome:g.outcome,observedState:g.observedState,sourceHealth:g.sourceHealth,sourceAssessmentId:g.sourceAssessmentId,allowedStatesJson:g.allowedStates,reasonCode:g.reasonCode,evidenceJson:json(g),ordinal:g.ordinal})) } } : {}),
      } });
      await tx.orderIntentBrokerComparisonDelivery.update({where:{id:c.id},data:{status:'COMPLETED',leaseOwner:null,leaseExpiresAt:null,lastErrorCode:null,completedAt:new Date()}});
    }); return 'COMPLETED' as const;
  } catch (error) {
    const code=error instanceof Error?error.message.slice(0,120):'UNKNOWN_BROKER_COMPARISON_FAILURE';
    await db.$transaction(async tx => { const d=await tx.orderIntentBrokerComparisonDelivery.findUnique({where:{id:c.id}}); if(!d||d.status!=='CLAIMED'||d.leaseOwner!==workerId)return;
      await tx.orderIntentBrokerComparisonAttempt.create({data:{opportunityId:o.id,attempt:c.attemptCount,enrollmentGenerationId:o.enrollmentGenerationId!,policyRevisionId:o.policyRevisionId!,marketRegimeAssessmentId:o.marketRegimeAssessmentId,evidenceAsOf:o.opportunityAt,evaluationVersion:ORDER_INTENT_BROKER_COMPARISON_VERSION,enrollmentDisposition:disposition,outcome:'TECHNICAL_FAILURE',reasonCode:'EVALUATION_TECHNICAL_FAILURE',authority:'COMPARE_ONLY',tradingEffect:'NONE',evidenceJson:json({errorCode:code})}});
      const terminal=c.attemptCount>=MAX_ATTEMPTS; await tx.orderIntentBrokerComparisonDelivery.update({where:{id:c.id},data:{status:terminal?'TERMINAL_FAILURE':'RETRY_WAIT',leaseOwner:null,leaseExpiresAt:null,lastErrorCode:code,nextAttemptAt:new Date(Date.now()+c.attemptCount*30000),completedAt:terminal?new Date():null}}); });
    return c.attemptCount>=MAX_ATTEMPTS?'TERMINAL_FAILURE' as const:'RETRY_WAIT' as const;
  }
}

export async function processOrderIntentBrokerComparisons(options:{limit?:number;workerId?:string;db?:PrismaClient;evaluator?:typeof evaluateStrategyMarketEligibility}={}) {
  const limit=options.limit??10;if(!Number.isInteger(limit)||limit<1||limit>MAX_BATCH)throw new RangeError('Broker comparison limit must be between 1 and 25.'); const db=options.db??prisma;
  const rollout=await db.orderIntentBrokerComparisonRollout.findUnique({where:{id:1}});if(!rollout?.enabled)return{enabled:false,seeded:0,claimed:0,completed:0,retrying:0,terminalFailures:0};
  const seeded=await seedOrderIntentBrokerComparisonDeliveries(limit,db);let claimed=0,completed=0,retrying=0,terminalFailures=0;const workerId=options.workerId??randomUUID();
  for(let i=0;i<limit;i++){const c=await claim(workerId,db);if(!c)break;claimed++;const out=await complete(c,workerId,db,options.evaluator??evaluateStrategyMarketEligibility);if(out==='COMPLETED')completed++;else if(out==='RETRY_WAIT')retrying++;else terminalFailures++;}
  return{enabled:true,seeded,claimed,completed,retrying,terminalFailures};
}
