import { mkdir, writeFile } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { Client } from 'pg';
import { assertAcceptanceEnvironment, assertDatabaseIdentity, loadAcceptanceDatabaseUrl } from './guard.js';
import { ACCEPTANCE_MARKER } from './constants.js';

assertAcceptanceEnvironment();
process.env.DATABASE_URL = loadAcceptanceDatabaseUrl();
const { prisma } = await import('../../src/db/prisma.js');
const identity = new Client({ connectionString: process.env.DATABASE_URL });
await identity.connect(); await assertDatabaseIdentity(identity); await identity.end();
const { hashPassword } = await import('../../src/services/auth.service.js');
const policy = await import('../../src/services/strategy-market-policy.service.js');
const enrollment = await import('../../src/services/assignment-market-policy-enrollment.service.js');
const broker = await import('../../src/services/order-intent-broker-opportunity.service.js');
const brokerComparison = await import('../../src/services/order-intent-broker-comparison.service.js');
const intentComparison = await import('../../src/services/order-intent-market-policy-comparison.service.js');

const password = `UiAcceptance-${randomBytes(18).toString('base64url')}!`;
const now = new Date();
const users = Object.fromEntries(await Promise.all((['SYSTEM_OWNER','OPERATOR','ACCOUNT_USER'] as const).map(async role => {
  const email = `phase3b4-${role.toLowerCase().replace('_','-')}@example.invalid`;
  const user = await prisma.user.create({ data: { email, name: `Phase 3B.4 ${role}`, platformRole: role, enabled: true, passwordHash: await hashPassword(password), emailVerifiedAt: now, setupCompletedAt: now } });
  return [role, user];
}))) as Record<'SYSTEM_OWNER'|'OPERATOR'|'ACCOUNT_USER', {id:number;email:string}>;

const accounts = [];
for (const [name, holder] of [['Acceptance Alpha', users.ACCOUNT_USER], ['Acceptance Restricted', users.SYSTEM_OWNER]] as const) {
  accounts.push(await prisma.tradingAccount.create({ data: { accountHolderUserId: holder.id, displayName: name, environment: 'PAPER', status: 'ACTIVE', tradingEnabled: false, killSwitchEnabled: true, brokerAccountId: `phase3b4-${name.toLowerCase().replaceAll(' ','-')}` } }));
}
await prisma.tradingAccountMembership.createMany({ data: [
  { tradingAccountId: accounts[0]!.id, userId: users.ACCOUNT_USER.id },
  { tradingAccountId: accounts[0]!.id, userId: users.OPERATOR.id },
  { tradingAccountId: accounts[1]!.id, userId: users.OPERATOR.id },
] });

const security = await prisma.security.create({ data: { symbol: 'AAPL', name: 'Apple Acceptance Fixture', assetType: 'STOCK' } });
const amd = await prisma.security.create({ data: { symbol: 'AMD', name: 'AMD Acceptance Fixture', assetType: 'STOCK' } });
const strategy = await prisma.strategy.create({ data: { key: 'momentum_stock', name: 'Momentum Stock' } });
const exit = await prisma.exitProfile.create({ data: { key: 'phase3b4_exit', name: 'Phase 3B.4 Exit', exitMode: 'market', takeProfitBehavior: 'close' } });
async function assignment(accountId:number, sec:{id:number;symbol:string}, key:string) {
  const sub = await prisma.subscription.create({ data: { key, name: key, symbol: sec.symbol, securityId: sec.id, strategyId: strategy.id, exitProfileId: exit.id } });
  const row = await prisma.tradingAccountSubscription.create({ data: { tradingAccountId: accountId, subscriptionId: sub.id, fixedQty: 1, enabled: true, entriesEnabled: true, exitsEnabled: true } });
  return { sub, row };
}
const alpha = await assignment(accounts[0]!.id, security, 'phase3b4_aapl_alpha');
const alphaAmd = await assignment(accounts[0]!.id, amd, 'phase3b4_amd_alpha');
const restricted = await assignment(accounts[1]!.id, security, 'phase3b4_aapl_restricted');

const createdPolicy = await policy.createStrategyMarketPolicy(strategy.id, users.SYSTEM_OWNER.id, 'Phase 3B.4 fixture revision 1');
const revision = createdPolicy.revisions[0]!;
const saved = await policy.saveStrategyMarketPolicyRevision(strategy.id, revision.id, { expectedConfigurationFingerprint: revision.configurationFingerprint, rules: [
  { dimension:'TREND',algorithmVersion:'TREND_V1',requirement:'REQUIRED',allowedStates:['UP'] },
  { dimension:'VOLATILITY',algorithmVersion:'VOLATILITY_V1',requirement:'IGNORED',allowedStates:[] },
  { dimension:'BREADTH',algorithmVersion:'BREADTH_V1',requirement:'REQUIRED',allowedStates:['POSITIVE'] },
  { dimension:'PARTICIPATION',algorithmVersion:'PARTICIPATION_V1',requirement:'IGNORED',allowedStates:[] },
  { dimension:'INTRADAY_STRESS',algorithmVersion:'INTRADAY_STRESS_V1',requirement:'IGNORED',allowedStates:[] },
] }, users.SYSTEM_OWNER.id);
await policy.activateStrategyMarketPolicyRevision(strategy.id, revision.id, saved.configurationFingerprint, users.SYSTEM_OWNER.id);
for (const item of [alpha, restricted]) { const prepared = await enrollment.prepareAssignmentMarketPolicyEnrollment(item.row.tradingAccountId, item.row.id, users.SYSTEM_OWNER.id); await enrollment.activateAssignmentMarketPolicyEnrollment(item.row.tradingAccountId, item.row.id, prepared.id, users.SYSTEM_OWNER.id, prepared.configurationFingerprint); }

async function createIntent(name:string, item:typeof alpha, symbol:string, createdAt = new Date()) {
  return prisma.orderIntent.create({ data: { source:`ui_acceptance:${name}`,symbol,side:'buy',orderType:'market',timeInForce:'day',qty:1,clientOrderId:`phase3b4-${name}`,status:'accepted',rawRequestJson:{fixture:name},tradingAccountId:item.row.tradingAccountId,subscriptionId:item.sub.id,subscriptionKey:item.sub.key,tradingAccountSubscriptionId:item.row.id,createdAt } });
}
const scenarios: Record<string,{id:number;accountId:number}> = {};
const pre = await createIntent('aapl_pre_rollout', alpha, 'AAPL', new Date(Date.now()-60_000)); scenarios.aapl_pre_rollout={id:pre.id,accountId:accounts[0]!.id};
await prisma.orderIntentMarketPolicyCaptureRollout.update({ where:{id:1}, data:{enabled:true} });
await prisma.orderIntentBrokerOpportunityCaptureRollout.update({ where:{id:1}, data:{enabled:true} });
await prisma.orderIntentBrokerComparisonRollout.update({ where:{id:1}, data:{enabled:true} });
await prisma.orderIntentMarketPolicyComparisonRollout.update({ where:{id:1}, data:{enabled:true} });
const none = await createIntent('aapl_none_visible_zero_gates', alpha, 'AAPL'); scenarios.aapl_none_visible_zero_gates={id:none.id,accountId:accounts[0]!.id};
const noneOpp = await broker.captureOrderIntentBrokerPostOpportunity({orderIntentId:none.id,idempotencyKey:'phase3b4-none'},prisma)!;

const dimensions = [
  ['TREND','TREND_V1','UP'],['VOLATILITY','VOLATILITY_V1','NORMAL'],['BREADTH','BREADTH_V1','POSITIVE'],['PARTICIPATION','PARTICIPATION_V1','NORMAL'],['INTRADAY_STRESS','INTRADAY_STRESS_V1','NORMAL'],
] as const;
let assessmentAttempt = 0;
async function composition(tag:string, overrides:Record<string,string>={}) {
  const target = new Date(Date.now()-10_000); const validUntil = new Date(Date.now()+86_400_000);
  const assessments: Awaited<ReturnType<typeof prisma.marketRegimeDimensionAssessment.create>>[]=[];
  for (const [dimension,algorithmVersion,state] of dimensions) assessments.push(await prisma.marketRegimeDimensionAssessment.create({data:{dimension,algorithmVersion,evidenceSchemaVersion:1,targetAt:target,sessionDate:new Date('2026-10-09'),attempt:++assessmentAttempt,status:'VALID',rawState:overrides[dimension]??state,effectiveState:overrides[dimension]??state,dataThroughAt:target,validUntil,startedAt:target,completedAt:target,evidenceJson:{fixture:tag}}}));
  const fingerprint=createHash('sha256').update(`phase3b4-${tag}`).digest('hex');
  return prisma.$transaction(async tx => tx.marketRegimeAssessment.create({data:{compositionVersion:'MARKET_REGIME_COMPOSITION_V1',evidenceSchemaVersion:1,targetAt:target,observedAt:new Date(),dataThroughAt:target,validUntil,publicationStatus:'SUCCEEDED',evidenceHealth:'COMPLETE',sourceSetFingerprint:fingerprint,startedAt:target,completedAt:new Date(),evidenceJson:{fixture:tag},sources:{create:assessments.map((a,i)=>({dimension:a.dimension,requiredAlgorithmVersion:a.algorithmVersion,expectedTargetAt:target,sourceAssessmentId:a.id,sourceEvidenceSchemaVersion:a.evidenceSchemaVersion,sourceAttempt:a.attempt,sourceStatus:a.status,sourceTargetAt:a.targetAt,sourceCompletedAt:a.completedAt,sourceDataThroughAt:a.dataThroughAt,sourceValidUntil:a.validUntil,sourceRawState:a.rawState,sourceEffectiveState:a.effectiveState,health:'AVAILABLE',ordinal:i+1,evidenceJson:{fixture:tag}}))}},include:{sources:true}}));
}
async function scenario(name:string,item=alpha,symbol='AAPL',opportunities=1) { const intent=await createIntent(name,item,symbol); scenarios[name]={id:intent.id,accountId:item.row.tradingAccountId}; for(let i=1;i<=opportunities;i++) await broker.captureOrderIntentBrokerPostOpportunity({orderIntentId:intent.id,opportunitySequence:i,idempotencyKey:`phase3b4-${name}-${i}`},prisma); return intent; }
await composition('blocked',{TREND:'DOWN',BREADTH:'NEGATIVE'});
const splitOutcome=await createIntent('aapl_intent_blocked_broker_allowed',alpha,'AAPL'); scenarios.aapl_intent_blocked_broker_allowed={id:splitOutcome.id,accountId:accounts[0]!.id};
await composition('allowed');
await broker.captureOrderIntentBrokerPostOpportunity({orderIntentId:splitOutcome.id,idempotencyKey:'phase3b4-split-outcome'},prisma);
await composition('blocked-2',{TREND:'DOWN',BREADTH:'NEGATIVE'});
await scenario('aapl_both_blocked');
await scenario('aapl_multiple_opportunities',alpha,'AAPL',2);
const uncertain=await scenario('aapl_delivery_uncertain_recovered'); const uo=await prisma.orderIntentBrokerPostOpportunity.findFirstOrThrow({where:{orderIntentId:uncertain.id}}); await broker.appendOrderIntentBrokerOpportunityEvent(uo.id,'ADAPTER_DISPATCH_REACHED',{adapter:'throwing-acceptance'} as any,prisma); await broker.appendOrderIntentBrokerOpportunityEvent(uo.id,'DELIVERY_UNCERTAIN',{classification:'unknown'} as any,prisma); await broker.appendOrderIntentBrokerOpportunityEvent(uo.id,'RECOVERY_FOUND',{status:'accepted'} as any,prisma);
const amdIntent=await createIntent('amd_unenrolled',alphaAmd,'AMD'); scenarios.amd_unenrolled={id:amdIntent.id,accountId:accounts[0]!.id}; await broker.captureOrderIntentBrokerPostOpportunity({orderIntentId:amdIntent.id,idempotencyKey:'phase3b4-amd'},prisma);
await scenario('restricted_account_evidence',restricted);

await intentComparison.processOrderIntentMarketPolicyComparisons({limit:25,db:prisma});
await brokerComparison.processOrderIntentBrokerComparisons({limit:25,db:prisma});
const technical=await scenario('aapl_technical_failure');
const terminal=await scenario('aapl_terminal_retry_exhausted');
for (const [intent,terminalMode] of [[technical,false],[terminal,true]] as const) {
  const opp=await prisma.orderIntentBrokerPostOpportunity.findFirstOrThrow({where:{orderIntentId:intent.id}});
  await prisma.orderIntentBrokerComparisonDelivery.deleteMany({where:{opportunityId:opp.id}});
  await prisma.orderIntentBrokerComparisonDelivery.create({data:{opportunityId:opp.id,status:terminalMode?'TERMINAL_FAILURE':'COMPLETED',attemptCount:terminalMode?3:1,nextAttemptAt:new Date(),completedAt:new Date(),lastErrorCode:'ACCEPTANCE_SYNTHETIC_TECHNICAL_FAILURE'}});
  await prisma.orderIntentBrokerComparisonAttempt.create({data:{opportunityId:opp.id,attempt:1,enrollmentGenerationId:opp.enrollmentGenerationId!,policyRevisionId:opp.policyRevisionId!,marketRegimeAssessmentId:opp.marketRegimeAssessmentId,evidenceAsOf:opp.opportunityAt,evaluationVersion:'ORDER_INTENT_BROKER_COMPARISON_V1',enrollmentDisposition:'ACTIVE',outcome:'TECHNICAL_FAILURE',reasonCode:'EVALUATION_TECHNICAL_FAILURE',evidenceJson:{fixture:true}}});
}
await prisma.brokerOrder.create({data:{orderIntentId:uncertain.id,tradingAccountId:accounts[0]!.id,broker:'alpaca',brokerOrderId:'phase3b4-recovered',clientOrderId:uncertain.clientOrderId!,securityId:security.id,symbol:'AAPL',side:'buy',status:'accepted',rawBrokerJson:{fixture:true}}});

for (const [name, scenario] of Object.entries(scenarios)) {
  const intent=await prisma.orderIntent.findUniqueOrThrow({where:{id:scenario.id}});
  await prisma.entryDecision.create({data:{decisionKey:`phase3b4:${name}`,evaluatedAt:intent.createdAt,source:'ui_acceptance',symbol:intent.symbol,decisionState:'RECORDED',decisionReason:name,persistenceReason:'PHASE_3B4_ACCEPTANCE',decisionFingerprint:createHash('sha256').update(name).digest('hex'),rawDecisionJson:{fixture:name},securityId:intent.symbol==='AMD'?amd.id:security.id,subscriptionId:intent.subscriptionId,subscriptionKey:intent.subscriptionKey,strategyId:strategy.id,strategyKey:strategy.key,exitProfileId:exit.id,exitProfileKey:exit.key,orderIntentId:intent.id,tradingAccountId:intent.tradingAccountId,tradingAccountSubscriptionId:intent.tradingAccountSubscriptionId}});
}

const manifest={marker:ACCEPTANCE_MARKER,generatedAt:new Date().toISOString(),baseUrl:'http://127.0.0.1:5174',apiUrl:'http://127.0.0.1:3304',login:{password,users:Object.fromEntries(Object.entries(users).map(([r,u])=>[r,{email:u.email}]))},accounts:accounts.map(a=>({id:a.id,name:a.displayName})),scenarios:Object.fromEntries(Object.entries(scenarios).map(([name,s])=>[name,{...s,url:`http://127.0.0.1:5174/entry-decisions?account=${s.accountId}&intent=${s.id}`}]))};
await mkdir('.acceptance/ui',{recursive:true}); await writeFile('.acceptance/ui/manifest.json',JSON.stringify(manifest,null,2),{mode:0o600});
await prisma.$disconnect();
