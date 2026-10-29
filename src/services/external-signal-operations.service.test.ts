import { describe,expect,it } from 'vitest';
import { classifyExitObligation } from './external-signal-operations.service.js';

const work=(status='COMPLETED')=>({id:1,status,leaseExpiresAt:null});
const signal=(status='COMPLETED')=>({id:10,externalEventId:'exit-10',createdAt:new Date(),correlationWork:work(status)});
const cycle=(changes:Record<string,unknown>={})=>({status:'ROUTED',terminalReasonCode:null,accountCycles:[{id:20}],correlationDecisions:[{signalId:10,decisionType:'EXIT_PENDING',accountCycleId:20,reasonCode:'EXIT_ACCEPTED_SHADOW_ONLY'}],...changes});

describe('external signal EXIT obligation projection',()=>{
 it('never claims a broker EXIT for fully recorded shadow evidence',()=>expect(classifyExitObligation(cycle(),signal())).toMatchObject({resolutionState:'RECORDED_SHADOW',unresolved:false,brokerExitApplied:false}));
 it('keeps reservation-held EXIT evidence unresolved',()=>expect(classifyExitObligation(cycle({correlationDecisions:[{signalId:10,decisionType:'EXIT_PENDING',accountCycleId:20,reasonCode:'EXIT_HELD_BEHIND_ADMISSION_RESERVATION'}]}),signal())).toMatchObject({resolutionState:'RECORDED_HELD_BEHIND_RESERVATION',unresolved:true}));
 it('distinguishes pending and failed work before inspecting terminal state',()=>{
  expect(classifyExitObligation(cycle({status:'TERMINAL_NO_EXPOSURE'}),signal('PENDING'))).toMatchObject({resolutionState:'CORRELATION_PENDING',unresolved:true});
  expect(classifyExitObligation(cycle({status:'TERMINAL_NO_EXPOSURE'}),signal('FAILED'))).toMatchObject({resolutionState:'FAILED',unresolved:true,attentionRequired:true});
 });
 it('labels retention and no-exposure tombstones without implying execution',()=>{
  const zero={accountCycles:[],correlationDecisions:[{signalId:10,decisionType:'EXIT_PENDING',accountCycleId:null,reasonCode:'EXIT_ACCEPTED_AWAITING_ENTRY'}]};
  expect(classifyExitObligation(cycle({...zero,status:'TERMINAL_NO_EXPOSURE',terminalReasonCode:'UNMATCHED_EXIT_RETENTION_EXPIRED'}),signal())).toMatchObject({resolutionState:'RETENTION_EXPIRED',unresolved:false,brokerExitApplied:false});
  expect(classifyExitObligation(cycle({...zero,status:'TERMINAL_NO_EXPOSURE',terminalReasonCode:'LIVE_ROUTES_EXCLUDED'}),signal())).toMatchObject({resolutionState:'NO_EXPOSURE_TERMINAL',unresolved:false,brokerExitApplied:false});
 });
 it('detects incomplete multi-account coverage and contradictory decisions',()=>{
  expect(classifyExitObligation(cycle({accountCycles:[{id:20},{id:21}]}),signal())).toMatchObject({resolutionState:'INCONSISTENT',attentionRequired:true});
  expect(classifyExitObligation(cycle({correlationDecisions:[{signalId:10,decisionType:'EXIT_PENDING',accountCycleId:999,reasonCode:'BAD'}]}),signal())).toMatchObject({resolutionState:'INCONSISTENT',attentionRequired:true});
 });
});
