import { createHash, randomUUID } from 'node:crypto';
import { Prisma, type ExternalSignalCorrelationDecisionType } from '@prisma/client';
import { prisma } from '../db/prisma.js';
import { routeSignalInTransaction } from './signal-routing.service.js';
import { evaluateNewSignalRoute } from './signal-evaluation.service.js';
import { processSignalMarketEligibilityRoutes, SIGNAL_ROUTE_MARKET_ELIGIBILITY_MAX_ATTEMPTS } from './signal-route-market-eligibility.service.js';

export const EXTERNAL_SIGNAL_CORRELATION_MAX_ATTEMPTS = 8;
export const EXTERNAL_SIGNAL_UNMATCHED_EXIT_RETENTION_MS = 24 * 60 * 60 * 1000;
type Db = typeof prisma; type Claim = { id:number; signalId:number; attemptCount:number };
const reservationKey=(cycleId:number,accountId:number,routeId:number)=>`external-shadow:${createHash('sha256').update(`${cycleId}:${accountId}:${routeId}`).digest('hex')}`;

async function claimWork(db:Db,workerId:string){const rows=await db.$queryRaw<Claim[]>`WITH candidate AS (SELECT id FROM "ExternalSignalCorrelationWork" WHERE ((status IN ('PENDING','RETRY_WAIT') AND "nextAttemptAt"<=statement_timestamp()) OR (status='CLAIMED' AND "leaseExpiresAt"<=statement_timestamp())) ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1) UPDATE "ExternalSignalCorrelationWork" w SET status='CLAIMED',"attemptCount"=w."attemptCount"+1,"leaseOwner"=${workerId},"leaseExpiresAt"=statement_timestamp()+interval '60 seconds',"updatedAt"=statement_timestamp() FROM candidate WHERE w.id=candidate.id RETURNING w.id,w."signalId",w."attemptCount"`;return rows[0]??null;}
async function fence(tx:Prisma.TransactionClient,claim:Claim,workerId:string){const rows=await tx.$queryRaw<Array<{id:number}>>`SELECT id FROM "ExternalSignalCorrelationWork" WHERE id=${claim.id} AND "signalId"=${claim.signalId} AND status='CLAIMED' AND "leaseOwner"=${workerId} AND "leaseExpiresAt">statement_timestamp() FOR UPDATE`;if(rows.length!==1)throw new Error('CORRELATION_LEASE_FENCE_FAILED');}
async function decision(tx:Prisma.TransactionClient,data:Prisma.ExternalSignalCorrelationDecisionCreateManyInput){await tx.externalSignalCorrelationDecision.createMany({data:[data],skipDuplicates:true});}
async function currentRollout(tx:Prisma.TransactionClient){const rows=await tx.$queryRaw<Array<{id:number;enabled:boolean}>>`SELECT id,enabled FROM "ExternalSignalExecutionRolloutGeneration" WHERE direction='ENTRY' AND "authorityMode"='SHADOW' AND "effectiveAt"<=statement_timestamp() ORDER BY generation DESC,id DESC LIMIT 1`;return rows[0]??null;}
async function prospectiveExecution(tx:Prisma.TransactionClient, signalId:number, route:{tradingAccountId:number;tradingAccountSubscriptionId:number;subscriptionId:number}){const [available]=await tx.$queryRaw<Array<{present:boolean}>>`SELECT to_regclass('"ExternalSignalExecutionRolloutState"') IS NOT NULL AS present`;if(!available?.present)return null;const rows=await tx.$queryRaw<Array<{rolloutGenerationId:number;authorizationId:number}>>`
 SELECT gen.id AS "rolloutGenerationId",auth.id AS "authorizationId"
 FROM "Signal" sig
 JOIN "ExternalSignalExecutionRolloutState" state ON state.id=1
 JOIN "ExternalSignalExecutionRolloutGeneration" gen ON gen.id=state."activeRolloutGenerationId"
 JOIN "ExternalSignalEntryExecutionAuthorization" auth ON auth."rolloutGenerationId"=gen.id
 WHERE sig.id=${signalId} AND sig.event='ENTRY_LONG' AND gen.direction='ENTRY' AND gen."authorityMode"='EXECUTE' AND gen.enabled=true
   AND state."activatedAt" IS NOT NULL AND sig."createdAt">=state."activatedAt" AND sig."createdAt">=auth."authorizedAt"
   AND auth.status='AUTHORIZED' AND auth."tradingAccountId"=${route.tradingAccountId}
   AND auth."tradingAccountSubscriptionId"=${route.tradingAccountSubscriptionId} AND auth."subscriptionId"=${route.subscriptionId}
   AND auth."securityId"=sig."securityId" AND auth."signalSourceId"=sig."signalSourceId"
   AND auth."strategySignalBindingId"=sig."strategySignalBindingId" AND auth."strategySignalRevisionId"=sig."strategySignalRevisionId"
 LIMIT 1`;return rows[0]??null;}

async function correlate(tx:Prisma.TransactionClient,signalId:number){
 const signal=await tx.signal.findUnique({where:{id:signalId},include:{strategySignalRevision:true}});if(!signal||signal.schemaVersion!==2||!signal.externalSignalTradeCycleId)throw new Error('INVALID_CORRELATION_SIGNAL');
 await tx.$queryRaw`SELECT id FROM "ExternalSignalSource" WHERE id=${signal.signalSourceId} FOR UPDATE`;await tx.$queryRaw`SELECT id FROM "StrategySignalBinding" WHERE id=${signal.strategySignalBindingId} FOR UPDATE`;await tx.$queryRaw`SELECT id FROM "ExternalSignalTradeCycle" WHERE id=${signal.externalSignalTradeCycleId} FOR UPDATE`;
 const cycle=await tx.externalSignalTradeCycle.findUniqueOrThrow({where:{id:signal.externalSignalTradeCycleId}});
 if(signal.event==='EXIT_LONG'){
  const accounts=await tx.externalSignalTradeCycleAccount.findMany({where:{externalSignalTradeCycleId:cycle.id},orderBy:{id:'asc'}});
  if(!accounts.length){await decision(tx,{externalSignalTradeCycleId:cycle.id,signalId,decisionType:'EXIT_PENDING',authorityMode:'SHADOW',reasonCode:'EXIT_ACCEPTED_AWAITING_ENTRY',evidenceJson:{schemaVersion:1,accountRoutesDeferred:true,unresolved:true}});return;}
  for(const account of accounts){await tx.$queryRaw`SELECT id FROM "ExternalSignalTradeCycleAccount" WHERE id=${account.id} FOR UPDATE`;const terminal=['TERMINAL_NO_EXPOSURE','TERMINAL_CLOSED'].includes(account.status);if(!terminal&&account.status!=='EXIT_PENDING')await tx.externalSignalTradeCycleAccount.update({where:{id:account.id},data:{status:'EXIT_PENDING',pendingExitAcceptedAt:signal.createdAt}});await decision(tx,{externalSignalTradeCycleId:cycle.id,accountCycleId:account.id,signalId,decisionType:'EXIT_PENDING',authorityMode:'SHADOW',reservationKey:account.entryReservationKey,reasonCode:terminal?'EXIT_ACCEPTED_ALREADY_APPLIED':account.entryReservationKey?'EXIT_HELD_BEHIND_ADMISSION_RESERVATION':'EXIT_ACCEPTED_SHADOW_ONLY',evidenceJson:{schemaVersion:1,orderIntentAbsenceIsNotProof:true,terminalAccount:terminal}});}return;
 }
 if(['TERMINAL_NO_EXPOSURE','TERMINAL_CLOSED','CONFLICT'].includes(cycle.status))return;
 const routing=await routeSignalInTransaction(signal.id,tx);
 const pendingExit=await tx.signal.findFirst({where:{externalSignalTradeCycleId:cycle.id,event:'EXIT_LONG'},orderBy:{id:'asc'}});
 if(routing.routes.length===0){
  const stopped=routing.status==='STOPPED';const terminalReason=stopped?'ROUTING_STOPPED_EVIDENCE_ONLY':pendingExit?'ENTRY_PREEMPTED_WITH_ZERO_ROUTES':'ROUTING_COMPLETED_ZERO_ELIGIBLE_TARGETS';
  await tx.externalSignalTradeCycle.update({where:{id:cycle.id},data:{status:'TERMINAL_NO_EXPOSURE',terminalAt:new Date(),terminalReasonCode:terminalReason}});
  await decision(tx,{externalSignalTradeCycleId:cycle.id,signalId,decisionType:'CYCLE_BLOCKED',authorityMode:'SHADOW',reasonCode:terminalReason,evidenceJson:{schemaVersion:1,routingStatus:routing.status,routeCount:0,noPhase4AAdmissionPossible:true,brokerExposureInferred:false}});
  return;
 }
 let rollout: {id:number;enabled:boolean}|null|undefined;
 let processedNewRoute=false;
 let processedNewPaperRoute=false;
 for(const route of routing.routes){
  const accountIdentity=await tx.tradingAccount.findUniqueOrThrow({where:{id:route.tradingAccountId},select:{environment:true}});
  const existingAccount=await tx.externalSignalTradeCycleAccount.findUnique({where:{externalSignalTradeCycleId_tradingAccountId:{externalSignalTradeCycleId:cycle.id,tradingAccountId:route.tradingAccountId}}});
  if(accountIdentity.environment!=='PAPER'){
   if(existingAccount)throw new Error('INCONSISTENT_LIVE_ACCOUNT_CORRELATION');
   const existingLiveDecision=await tx.externalSignalCorrelationDecision.findFirst({where:{signalId,signalRouteId:route.id,decisionType:'LIVE_ROUTE_BLOCKED'}});
   if(existingLiveDecision)continue;
   rollout??=await currentRollout(tx);processedNewRoute=true;
   await decision(tx,{externalSignalTradeCycleId:cycle.id,signalRouteId:route.id,signalId,decisionType:'LIVE_ROUTE_BLOCKED',authorityMode:'SHADOW',rolloutGenerationId:rollout?.id??null,reasonCode:'LIVE_ACCOUNT_EXCLUDED',evidenceJson:{schemaVersion:1,environment:accountIdentity.environment,executable:false}});continue;
  }
  if(existingAccount){
   if(existingAccount.entrySignalRouteId!==route.id||existingAccount.tradingAccountSubscriptionId!==route.tradingAccountSubscriptionId||existingAccount.subscriptionId!==route.subscriptionId||existingAccount.securityId!==signal.securityId)throw new Error('INCONSISTENT_ENTRY_CORRELATION_EVIDENCE');
   let outcomes=await tx.externalSignalCorrelationDecision.count({where:{signalId,accountCycleId:existingAccount.id,signalRouteId:route.id,decisionType:{in:['ENTRY_SHADOW_AUTHORITY','ENTRY_SUPPRESSED','CYCLE_BLOCKED','ROUTE_EVALUATION_BLOCKED']}}});
   if(outcomes===0){const rows=await tx.$queryRaw<Array<{count:bigint}>>`SELECT count(*) AS count FROM "ExternalSignalCorrelationDecision" WHERE "signalId"=${signalId} AND "accountCycleId"=${existingAccount.id} AND "signalRouteId"=${route.id} AND "decisionType"::text='ENTRY_EXECUTION_PROSPECTIVE'`;outcomes=Number(rows[0]?.count??0);}
   if(outcomes!==1)throw new Error(outcomes===0?'INCOMPLETE_ENTRY_CORRELATION_EVIDENCE':'CONFLICTING_ENTRY_CORRELATION_EVIDENCE');
   const reservations=await tx.externalSignalCorrelationDecision.count({where:{signalId,accountCycleId:existingAccount.id,signalRouteId:route.id,decisionType:'ENTRY_RESERVATION',reservationKey:existingAccount.entryReservationKey}});
   if((existingAccount.entryReservationKey&&reservations!==1)||(!existingAccount.entryReservationKey&&reservations!==0))throw new Error(reservations===0?'INCOMPLETE_ENTRY_RESERVATION_EVIDENCE':'CONFLICTING_ENTRY_RESERVATION_EVIDENCE');
   continue;
  }
  rollout??=await currentRollout(tx);processedNewRoute=true;processedNewPaperRoute=true;
  const evaluation=await evaluateNewSignalRoute(route.id,tx);const eligible=evaluation?.status==='COMPLETED'&&evaluation.outcome==='ELIGIBLE';const tradeEligible=signal.strategySignalRevision?.authorityMode==='TRADE_ELIGIBLE';const execution=!pendingExit&&eligible&&tradeEligible?await prospectiveExecution(tx,signalId,route):null;const reserved=!execution&&!pendingExit&&eligible&&tradeEligible&&rollout?.enabled===true;const key=reserved?reservationKey(cycle.id,route.tradingAccountId,route.id):null;const status=pendingExit?'TERMINAL_NO_EXPOSURE':execution?'ENTRY_EXECUTION_PROSPECTIVE':reserved?'ENTRY_ADMISSION_PENDING':'BLOCKED';
  const account=await tx.externalSignalTradeCycleAccount.upsert({where:{externalSignalTradeCycleId_tradingAccountId:{externalSignalTradeCycleId:cycle.id,tradingAccountId:route.tradingAccountId}},create:{externalSignalTradeCycleId:cycle.id,entrySignalRouteId:route.id,tradingAccountId:route.tradingAccountId,tradingAccountSubscriptionId:route.tradingAccountSubscriptionId,subscriptionId:route.subscriptionId,securityId:signal.securityId,entryRolloutGenerationId:execution?.rolloutGenerationId??rollout?.id??null,status,entryReservationKey:key,entryReservationCreatedAt:key?new Date():null,...(pendingExit?{pendingExitAcceptedAt:pendingExit.createdAt,terminalAt:new Date(),terminalReasonCode:'ENTRY_PREEMPTED_BY_ACCEPTED_EXIT',noExposureProof:'ENTRY_SUPPRESSED_BEFORE_ADMISSION' as const}:{})},update:{}});await tx.$queryRaw`SELECT id FROM "ExternalSignalTradeCycleAccount" WHERE id=${account.id} FOR UPDATE`;
  if(reserved)await decision(tx,{externalSignalTradeCycleId:cycle.id,accountCycleId:account.id,signalRouteId:route.id,signalId,decisionType:'ENTRY_RESERVATION',authorityMode:'SHADOW',rolloutGenerationId:rollout!.id,reservationKey:key,reasonCode:'DETERMINISTIC_SHADOW_RESERVATION',evidenceJson:{schemaVersion:1,callsEntryAdmission:false}});
  const type:ExternalSignalCorrelationDecisionType=pendingExit?'ENTRY_SUPPRESSED':execution?'ENTRY_EXECUTION_PROSPECTIVE':reserved?'ENTRY_SHADOW_AUTHORITY':eligible?'CYCLE_BLOCKED':'ROUTE_EVALUATION_BLOCKED';const reasonCode=pendingExit?'PENDING_EXIT_PREEMPTED_ENTRY':execution?'PROSPECTIVE_EXECUTION_AUTHORIZED':reserved?'SHADOW_ROLLOUT_ONLY':!eligible?evaluation?.reasonCode??'ROUTE_EVALUATION_NOT_ELIGIBLE':!tradeEligible?'REVISION_NOT_TRADE_ELIGIBLE':rollout?'CURRENT_ENTRY_ROLLOUT_DISABLED':'NO_APPLICABLE_ENTRY_ROLLOUT';await decision(tx,{externalSignalTradeCycleId:cycle.id,accountCycleId:account.id,signalRouteId:route.id,signalId,decisionType:type,authorityMode:execution?'EXECUTE':'SHADOW',rolloutGenerationId:execution?.rolloutGenerationId??rollout?.id??null,reservationKey:key,reasonCode,evidenceJson:{schemaVersion:1,executable:!!execution,authorizationId:execution?.authorizationId??null,routeEligible:eligible,revisionAuthority:signal.strategySignalRevision?.authorityMode??null}});
 }
 if(pendingExit&&processedNewPaperRoute)await tx.externalSignalTradeCycle.update({where:{id:cycle.id},data:{status:'TERMINAL_NO_EXPOSURE',terminalAt:new Date(),terminalReasonCode:'ENTRY_PREEMPTED_BY_ACCEPTED_EXIT'}});else if(processedNewRoute&&!processedNewPaperRoute&&cycle.status==='ENTRY_RECEIVED')await tx.externalSignalTradeCycle.update({where:{id:cycle.id},data:{status:'TERMINAL_NO_EXPOSURE',terminalAt:new Date(),terminalReasonCode:'LIVE_ROUTES_EXCLUDED'}});else if(processedNewRoute&&cycle.status==='ENTRY_RECEIVED')await tx.externalSignalTradeCycle.update({where:{id:cycle.id},data:{status:'ROUTED'}});
}

function findSqlState(error: unknown) {
  const pending: unknown[] = [error];
  const seen = new Set<unknown>();
  for (let visited = 0; pending.length > 0 && visited < 32; visited += 1) {
    const value = pending.shift();
    if (!value || typeof value !== 'object' || seen.has(value)) continue;
    seen.add(value);
    const row = value as Record<string, unknown>;
    for (const candidate of [row.sqlState, row.sqlstate, row.database_error, row.originalCode, row.code]) {
      if (candidate === '40001' || candidate === '40P01' || candidate === '55P03') return candidate;
    }
    for (const child of [row.meta, row.driverAdapterError, row.cause, row.error]) {
      if (child && typeof child === 'object') pending.push(child);
    }
  }
  return null;
}
const permanentCorrelationCodes=new Set(['INVALID_CORRELATION_SIGNAL','INCONSISTENT_LIVE_ACCOUNT_CORRELATION','INCONSISTENT_ENTRY_CORRELATION_EVIDENCE','INCOMPLETE_ENTRY_CORRELATION_EVIDENCE','CONFLICTING_ENTRY_CORRELATION_EVIDENCE','INCOMPLETE_ENTRY_RESERVATION_EVIDENCE','CONFLICTING_ENTRY_RESERVATION_EVIDENCE']);
export function classifyExternalSignalCorrelationError(error:unknown){const state=findSqlState(error);if(state)return{retryable:true,code:`SQLSTATE_${state}`};const code=error&&typeof error==='object'&&'code'in error&&typeof error.code==='string'?error.code:null;if(code&&['P2024','P1001','P1017','P2034','P2028','ECONNRESET'].includes(code))return{retryable:true,code};if(error instanceof Error&&['ELIGIBILITY_CONTINUATION_RETRY','CORRELATION_LEASE_FENCE_FAILED'].includes(error.message))return{retryable:true,code:error.message};if(error instanceof Error&&permanentCorrelationCodes.has(error.message))return{retryable:false,code:error.message};const name=error&&typeof error==='object'&&'name'in error&&typeof error.name==='string'?error.name:null;if(name==='PrismaClientInitializationError')return{retryable:true,code:'PRISMA_CLIENT_INITIALIZATION'};return{retryable:true,code:'UNCLASSIFIED_CORRELATION_FAILURE'};}
async function complete(db:Db,claim:Claim,workerId:string){await db.$transaction(async tx=>{await fence(tx,claim,workerId);const result=await tx.externalSignalCorrelationWork.updateMany({where:{id:claim.id,status:'CLAIMED',leaseOwner:workerId},data:{status:'COMPLETED',leaseOwner:null,leaseExpiresAt:null,completedAt:new Date(),lastErrorCode:null}});if(result.count!==1)throw new Error('CORRELATION_LEASE_FENCE_FAILED');});}

export async function processExternalSignalCorrelationWork(options:{limit?:number;workerId?:string;db?:Db}={}){const db=options.db??prisma,workerId=options.workerId??randomUUID(),limit=Math.min(Math.max(options.limit??10,1),50);let claimed=0,completed=0,retrying=0,failed=0;for(let i=0;i<limit;i+=1){const claim=await claimWork(db,workerId);if(!claim)break;claimed+=1;try{await db.$transaction(async tx=>{await fence(tx,claim,workerId);await correlate(tx,claim.signalId);},{isolationLevel:Prisma.TransactionIsolationLevel.Serializable});const signal=await db.signal.findUnique({where:{id:claim.signalId},select:{event:true}});if(signal?.event==='ENTRY_LONG'){try{for(let attempt=0;attempt<SIGNAL_ROUTE_MARKET_ELIGIBILITY_MAX_ATTEMPTS;attempt+=1){const rows=await processSignalMarketEligibilityRoutes(claim.signalId,db);if(rows.every(row=>row?.status!=='FAILED'||row.attempt>=SIGNAL_ROUTE_MARKET_ELIGIBILITY_MAX_ATTEMPTS))break;}}catch{await db.systemEvent.create({data:{type:'external_signal_market_eligibility_continuation_failed',entityType:'signal',entityId:String(claim.signalId),severity:'WARNING',message:'Durable route correlation completed, but market-eligibility publication requires retry.',payloadJson:{signalId:claim.signalId,tradingEffect:'NONE'}}});}}await complete(db,claim,workerId);completed+=1;}catch(error){const classified=classifyExternalSignalCorrelationError(error),terminal=!classified.retryable||claim.attemptCount>=EXTERNAL_SIGNAL_CORRELATION_MAX_ATTEMPTS;const result=await db.externalSignalCorrelationWork.updateMany({where:{id:claim.id,status:'CLAIMED',leaseOwner:workerId},data:{status:terminal?'FAILED':'RETRY_WAIT',leaseOwner:null,leaseExpiresAt:null,nextAttemptAt:new Date(Date.now()+Math.min(claim.attemptCount*1000,30000)),lastErrorCode:classified.code}});if(terminal&&result.count===1){failed+=1;await db.systemEvent.create({data:{type:'external_signal_correlation_failed',entityType:'external_signal_correlation_work',entityId:String(claim.id),severity:'ERROR',message:'External signal correlation requires operator attention.',payloadJson:{workId:claim.id,signalId:claim.signalId,errorCode:classified.code,attemptCount:claim.attemptCount,retryable:classified.retryable,retryExhausted:classified.retryable,unresolved:true}}});}else retrying+=1;}}return{claimed,completed,retrying,failed};}

export async function terminalizeAbandonedExternalSignalCycles(options:{limit?:number;now?:Date;db?:Db}={}){
 const db=options.db??prisma,now=options.now??new Date(),cutoff=new Date(now.getTime()-EXTERNAL_SIGNAL_UNMATCHED_EXIT_RETENTION_MS),limit=Math.min(Math.max(options.limit??10,1),50);
 const candidates=await db.externalSignalTradeCycle.findMany({where:{status:'AWAITING_ENTRY',accountCycles:{none:{}},signals:{some:{event:'EXIT_LONG'},every:{event:'EXIT_LONG',createdAt:{lte:cutoff},correlationWork:{is:{status:'COMPLETED'}}}}},orderBy:[{createdAt:'asc'},{id:'asc'}],take:limit,select:{id:true}});
 let terminalized=0,serializationConflicts=0;
 for(const candidate of candidates){
  try{const changed=await db.$transaction(async tx=>{
   await tx.$queryRaw`SELECT id FROM "ExternalSignalTradeCycle" WHERE id=${candidate.id} FOR UPDATE`;
   const cycle=await tx.externalSignalTradeCycle.findUniqueOrThrow({where:{id:candidate.id},include:{signals:{include:{correlationWork:true}},accountCycles:true}});
   if(cycle.status!=='AWAITING_ENTRY'||cycle.accountCycles.length>0||cycle.signals.length===0||cycle.signals.some(signal=>signal.event!=='EXIT_LONG'||signal.createdAt>cutoff||signal.correlationWork?.status!=='COMPLETED'))return false;
   const pendingDecisions=await tx.externalSignalCorrelationDecision.count({where:{externalSignalTradeCycleId:cycle.id,decisionType:'EXIT_PENDING'}});
   if(pendingDecisions!==cycle.signals.length)return false;
   await tx.externalSignalTradeCycle.update({where:{id:cycle.id},data:{status:'TERMINAL_NO_EXPOSURE',terminalAt:now,terminalReasonCode:'UNMATCHED_EXIT_RETENTION_EXPIRED'}});
   await tx.systemEvent.create({data:{type:'external_signal_unmatched_exit_terminalized',entityType:'external_signal_trade_cycle',entityId:String(cycle.id),severity:'INFO',message:'An unmatched EXIT source cycle reached its retention boundary and was terminalized.',payloadJson:{cycleId:cycle.id,retentionHours:24,acceptedExitCount:cycle.signals.length,tradingEffect:'NONE'}}});
   return true;
  },{isolationLevel:Prisma.TransactionIsolationLevel.ReadCommitted});
  if(changed)terminalized+=1;}catch(error){const classified=classifyExternalSignalCorrelationError(error);if(classified.retryable&&['SQLSTATE_40001','SQLSTATE_40P01'].includes(classified.code)){serializationConflicts+=1;continue;}throw error;}
 }
 return{examined:candidates.length,terminalized,serializationConflicts};
}

export async function requeueFailedExternalSignalCorrelationWork(args:{workId:number;actorUserId:number;db?:Db}){const db=args.db??prisma;return db.$transaction(async tx=>{const actor=await tx.user.findUnique({where:{id:args.actorUserId},select:{platformRole:true}});if(actor?.platformRole!=='SYSTEM_OWNER')throw new Error('SYSTEM_OWNER_REQUIRED');await tx.$queryRaw`SELECT id FROM "ExternalSignalCorrelationWork" WHERE id=${args.workId} FOR UPDATE`;const work=await tx.externalSignalCorrelationWork.findUniqueOrThrow({where:{id:args.workId}});if(work.status==='PENDING'||work.status==='RETRY_WAIT')return work;if(work.status!=='FAILED')throw new Error('CORRELATION_WORK_NOT_REQUEUEABLE');const updated=await tx.externalSignalCorrelationWork.update({where:{id:work.id},data:{status:'PENDING',attemptCount:0,nextAttemptAt:new Date(),lastErrorCode:null,completedAt:null}});await tx.systemEvent.create({data:{type:'external_signal_correlation_requeued',entityType:'external_signal_correlation_work',entityId:String(work.id),actorUserId:args.actorUserId,severity:'WARNING',message:'Failed external signal correlation work was explicitly requeued.',payloadJson:{workId:work.id,signalId:work.signalId,previousAttemptCount:work.attemptCount}}});return updated;});}
