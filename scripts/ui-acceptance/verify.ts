import { readFile } from 'node:fs/promises';
type Manifest={baseUrl:string;login:{password:string;users:Record<string,{email:string}>};scenarios:Record<string,{id:number;accountId:number;url:string}>};
type Gate={allowedStates?:unknown};
type Comparison={state?:string;attempts:Array<{outcome?:string;gates:Gate[]}>};
type OperationalEvidence={orderIntent?:{id:number};intentStage:{state:string;coverage:{marketComposition:{sourceSetFingerprint?:unknown}};comparison:Comparison};brokerStage:{state:string;opportunities:Array<{comparison:Comparison;events:Array<{eventType:string}>}>};relatedRecords:{entryDecisionId:number}};
const manifest=JSON.parse(await readFile('.acceptance/ui/manifest.json','utf8')) as Manifest;
const base=manifest.baseUrl;
if(base!=='http://127.0.0.1:5174')throw new Error(`Acceptance browser base rejected: ${base}`);
async function login(role:string){const r=await fetch(`${base}/api/auth/login`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:manifest.login.users[role]!.email,password:manifest.login.password})});if(!r.ok)throw new Error(`${role} login failed: ${r.status}`);return ((await r.json()) as {token:string}).token;}
async function request(path:string,token:string,init:RequestInit={}){return fetch(`${base}${path}`,{...init,headers:{authorization:`Bearer ${token}`,'content-type':'application/json',...(init.headers??{})}});}
const owner=await login('SYSTEM_OWNER'),operator=await login('OPERATOR'),account=await login('ACCOUNT_USER');
for(const [role,token] of [['SYSTEM_OWNER',owner],['OPERATOR',operator],['ACCOUNT_USER',account]] as const){const r=await request('/api/auth/me',token);if(!r.ok)throw new Error(`${role} session refresh failed through browser proxy: ${r.status}`);}
const evidence:Record<string,OperationalEvidence>={};
for(const [name,s] of Object.entries(manifest.scenarios)){const r=await request(`/api/order-intents/${s.id}/operational-evidence?rawEvidence=true`,owner);if(!r.ok)throw new Error(`${name} owner evidence failed: ${r.status}`);const body=(await r.json()) as OperationalEvidence;if(body.orderIntent?.id!==s.id)throw new Error(`${name} serializer identity mismatch`);evidence[name]=body;}
function requiredEvidence(name:string){const value=evidence[name];if(!value)throw new Error(`Missing acceptance evidence: ${name}`);return value;}
const none=requiredEvidence('aapl_none_visible_zero_gates');if(none.intentStage.state!=='NONE_VISIBLE'||none.brokerStage?.opportunities?.[0]?.comparison?.attempts?.[0]?.gates?.length!==0)throw new Error('NONE_VISIBLE must preserve a zero-gate result.');
const multiple=requiredEvidence('aapl_multiple_opportunities');if(multiple.brokerStage.state!=='MULTIPLE_POST_OPPORTUNITIES'||multiple.brokerStage.opportunities.length!==2)throw new Error('Multiple opportunities were not preserved separately.');
const split=requiredEvidence('aapl_intent_blocked_broker_allowed');if(split.intentStage.comparison.attempts[0]?.outcome!=='BLOCKED'||split.brokerStage.opportunities[0]?.comparison.attempts[0]?.outcome!=='ALLOWED')throw new Error('Split intent-blocked/broker-allowed outcome is incorrect.');
const both=requiredEvidence('aapl_both_blocked');if(both.intentStage.comparison.attempts[0]?.outcome!=='BLOCKED'||both.brokerStage.opportunities[0]?.comparison.attempts[0]?.outcome!=='BLOCKED')throw new Error('Both-blocked outcome is incorrect.');
if(requiredEvidence('aapl_pre_rollout').intentStage.state!=='PRE_ROLLOUT')throw new Error('Pre-rollout state is incorrect.');
if(requiredEvidence('amd_unenrolled').intentStage.state!=='UNENROLLED')throw new Error('Unenrolled state is incorrect.');
const eventTypes=requiredEvidence('aapl_delivery_uncertain_recovered').brokerStage.opportunities[0]!.events.map(event=>event.eventType);if(!eventTypes.includes('DELIVERY_UNCERTAIN')||!eventTypes.includes('RECOVERY_FOUND'))throw new Error('Delivery uncertainty/recovery chronology is incomplete.');
if(requiredEvidence('aapl_technical_failure').brokerStage.opportunities[0]!.comparison.state!=='TECHNICAL_FAILURE')throw new Error('Technical failure state is incorrect.');
if(requiredEvidence('aapl_terminal_retry_exhausted').brokerStage.opportunities[0]!.comparison.state!=='TERMINAL_RETRY_EXHAUSTED')throw new Error('Terminal retry exhaustion state is incorrect.');
const restrictedId=manifest.scenarios.restricted_account_evidence!.id;
if((await request(`/api/order-intents/${restrictedId}/operational-evidence`,account)).status!==404)throw new Error('Restricted intent must be 404 to ACCOUNT_USER.');
if((await request(`/api/order-intents/${manifest.scenarios.aapl_both_blocked!.id}/operational-evidence?rawEvidence=true`,operator)).status!==403)throw new Error('OPERATOR raw evidence must be forbidden.');
const accountVisible=await (await request(`/api/order-intents/${manifest.scenarios.aapl_both_blocked!.id}/operational-evidence`,account)).json() as OperationalEvidence;if(accountVisible.intentStage.coverage.marketComposition.sourceSetFingerprint!==undefined||accountVisible.intentStage.comparison.attempts[0]!.gates.some(gate=>gate.allowedStates!==undefined))throw new Error('ACCOUNT_USER evidence was not redacted.');
const operatorVisible=await (await request(`/api/order-intents/${manifest.scenarios.aapl_both_blocked!.id}/operational-evidence`,operator)).json() as OperationalEvidence;if(operatorVisible.intentStage.comparison.attempts[0]!.gates.some(gate=>gate.allowedStates===undefined))throw new Error('OPERATOR technical evidence was unexpectedly redacted.');
const restrictedDecisionId=requiredEvidence('restricted_account_evidence').relatedRecords.entryDecisionId;if((await request(`/api/entry-decisions/${restrictedDecisionId}`,account)).status!==403)throw new Error('ACCOUNT_USER must remain prohibited from Entry Decisions.');
for(const [method,path] of [['POST','/api/orders'],['PUT','/api/subscriptions/1'],['PATCH','/api/config'],['DELETE','/api/users/1']] as const){const r=await request(path,owner,{method,body:'{}'});if(r.status!==405)throw new Error(`${method} ${path} was not denied by acceptance guard.`);}
const logoutResponse=await request('/api/auth/logout',owner,{method:'POST'});if(!logoutResponse.ok)throw new Error(`Logout failed through browser proxy: ${logoutResponse.status}`);
console.log(JSON.stringify({ok:true,browserProxyVerified:true,sessionRefreshVerified:true,logoutVerified:true,scenarioCount:Object.keys(manifest.scenarios).length,rolesVerified:3,writesDenied:4,credentialsRedacted:true}));
