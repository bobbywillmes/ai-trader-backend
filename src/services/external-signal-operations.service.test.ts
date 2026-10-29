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
 it.each(['PENDING','RETRY_WAIT'])('keeps an accepted EXIT unresolved while ENTRY work is %s',(status)=>{
  const pendingEntry={id:11,event:'ENTRY_LONG',correlationWork:work(status)};
  expect(classifyExitObligation(cycle({status:'ENTRY_RECEIVED',accountCycles:[],signals:[pendingEntry]}),signal()))
    .toMatchObject({resolutionState:'CORRELATION_PENDING',unresolved:true,attentionRequired:false,brokerExitApplied:false});
 });
 it('surfaces failed ENTRY correlation behind an accepted EXIT',()=>{
  const failedEntry={id:11,event:'ENTRY_LONG',correlationWork:work('FAILED')};
  expect(classifyExitObligation(cycle({status:'ENTRY_RECEIVED',accountCycles:[],signals:[failedEntry]}),signal()))
    .toMatchObject({resolutionState:'FAILED',unresolved:true,attentionRequired:true,brokerExitApplied:false});
 });
 it('recognizes durable multi-account EXIT-before-ENTRY suppression without weakening normal coverage',()=>{
  const accountCycles=[{id:20,status:'TERMINAL_NO_EXPOSURE',noExposureProof:{reason:'accepted_exit'}},{id:21,status:'TERMINAL_NO_EXPOSURE',noExposureProof:{reason:'accepted_exit'}}];
  const correlationDecisions=[
   {signalId:10,decisionType:'EXIT_PENDING',accountCycleId:null,reasonCode:'EXIT_ACCEPTED_AWAITING_ENTRY'},
   {signalId:11,decisionType:'ENTRY_SUPPRESSED',accountCycleId:20,reasonCode:'PENDING_EXIT_PREEMPTED_ENTRY'},
   {signalId:11,decisionType:'ENTRY_SUPPRESSED',accountCycleId:21,reasonCode:'PENDING_EXIT_PREEMPTED_ENTRY'},
  ];
  expect(classifyExitObligation(cycle({status:'TERMINAL_NO_EXPOSURE',terminalReasonCode:'ENTRY_PREEMPTED_BY_ACCEPTED_EXIT',accountCycles,correlationDecisions,signals:[{id:11,event:'ENTRY_LONG',correlationWork:work()}]}),signal()))
   .toMatchObject({resolutionState:'NO_EXPOSURE_TERMINAL',unresolved:false,attentionRequired:false,brokerExitApplied:false});
 });
});
