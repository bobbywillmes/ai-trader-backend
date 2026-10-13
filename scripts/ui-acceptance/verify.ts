import { readFile } from 'node:fs/promises';
type Manifest={login:{password:string;users:Record<string,{email:string}>};scenarios:Record<string,{id:number;accountId:number;url:string}>};
const manifest=JSON.parse(await readFile('.acceptance/ui/manifest.json','utf8')) as Manifest;
const base='http://127.0.0.1:3304';
async function login(role:string){const r=await fetch(`${base}/api/auth/login`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:manifest.login.users[role]!.email,password:manifest.login.password})});if(!r.ok)throw new Error(`${role} login failed: ${r.status}`);return (await r.json()).token as string;}
async function request(path:string,token:string,init:RequestInit={}){return fetch(`${base}${path}`,{...init,headers:{authorization:`Bearer ${token}`,'content-type':'application/json',...(init.headers??{})}});}
const owner=await login('SYSTEM_OWNER'),operator=await login('OPERATOR'),account=await login('ACCOUNT_USER');
const evidence:Record<string,any>={};
for(const [name,s] of Object.entries(manifest.scenarios)){const r=await request(`/api/order-intents/${s.id}/operational-evidence?rawEvidence=true`,owner);if(!r.ok)throw new Error(`${name} owner evidence failed: ${r.status}`);const body=await r.json();if(body.orderIntent?.id!==s.id)throw new Error(`${name} serializer identity mismatch`);evidence[name]=body;}
const none=evidence.aapl_none_visible_zero_gates;if(none.intentStage.state!=='NONE_VISIBLE'||none.brokerStage?.opportunities?.[0]?.comparison?.attempts?.[0]?.gates?.length!==0)throw new Error('NONE_VISIBLE must preserve a zero-gate result.');
const multiple=evidence.aapl_multiple_opportunities;if(multiple.brokerStage.state!=='MULTIPLE_POST_OPPORTUNITIES'||multiple.brokerStage.opportunities.length!==2)throw new Error('Multiple opportunities were not preserved separately.');
const split=evidence.aapl_intent_blocked_broker_allowed;if(split.intentStage.comparison.attempts[0]?.outcome!=='BLOCKED'||split.brokerStage.opportunities[0]?.comparison.attempts[0]?.outcome!=='ALLOWED')throw new Error('Split intent-blocked/broker-allowed outcome is incorrect.');
const both=evidence.aapl_both_blocked;if(both.intentStage.comparison.attempts[0]?.outcome!=='BLOCKED'||both.brokerStage.opportunities[0]?.comparison.attempts[0]?.outcome!=='BLOCKED')throw new Error('Both-blocked outcome is incorrect.');
if(evidence.aapl_pre_rollout.intentStage.state!=='PRE_ROLLOUT')throw new Error('Pre-rollout state is incorrect.');
if(evidence.amd_unenrolled.intentStage.state!=='UNENROLLED')throw new Error('Unenrolled state is incorrect.');
const eventTypes=evidence.aapl_delivery_uncertain_recovered.brokerStage.opportunities[0].events.map((event:any)=>event.eventType);if(!eventTypes.includes('DELIVERY_UNCERTAIN')||!eventTypes.includes('RECOVERY_FOUND'))throw new Error('Delivery uncertainty/recovery chronology is incomplete.');
if(evidence.aapl_technical_failure.brokerStage.opportunities[0].comparison.state!=='TECHNICAL_FAILURE')throw new Error('Technical failure state is incorrect.');
if(evidence.aapl_terminal_retry_exhausted.brokerStage.opportunities[0].comparison.state!=='TERMINAL_RETRY_EXHAUSTED')throw new Error('Terminal retry exhaustion state is incorrect.');
const restrictedId=manifest.scenarios.restricted_account_evidence!.id;
if((await request(`/api/order-intents/${restrictedId}/operational-evidence`,account)).status!==404)throw new Error('Restricted intent must be 404 to ACCOUNT_USER.');
if((await request(`/api/order-intents/${manifest.scenarios.aapl_both_blocked!.id}/operational-evidence?rawEvidence=true`,operator)).status!==403)throw new Error('OPERATOR raw evidence must be forbidden.');
const accountVisible=await (await request(`/api/order-intents/${manifest.scenarios.aapl_both_blocked!.id}/operational-evidence`,account)).json();if(accountVisible.intentStage.coverage.marketComposition.sourceSetFingerprint!==undefined||accountVisible.intentStage.comparison.attempts[0].gates.some((gate:any)=>gate.allowedStates!==undefined))throw new Error('ACCOUNT_USER evidence was not redacted.');
const operatorVisible=await (await request(`/api/order-intents/${manifest.scenarios.aapl_both_blocked!.id}/operational-evidence`,operator)).json();if(operatorVisible.intentStage.comparison.attempts[0].gates.some((gate:any)=>gate.allowedStates===undefined))throw new Error('OPERATOR technical evidence was unexpectedly redacted.');
const restrictedDecisionId=evidence.restricted_account_evidence.relatedRecords.entryDecisionId;if((await request(`/api/entry-decisions/${restrictedDecisionId}`,account)).status!==403)throw new Error('ACCOUNT_USER must remain prohibited from Entry Decisions.');
for(const [method,path] of [['POST','/api/orders'],['PUT','/api/subscriptions/1'],['PATCH','/api/config'],['DELETE','/api/users/1']] as const){const r=await request(path,owner,{method,body:'{}'});if(r.status!==405)throw new Error(`${method} ${path} was not denied by acceptance guard.`);}
console.log(JSON.stringify({ok:true,scenarioCount:Object.keys(manifest.scenarios).length,rolesVerified:3,writesDenied:4,credentialsRedacted:true}));
