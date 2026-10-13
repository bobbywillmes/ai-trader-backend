import { describe, expect, it } from 'vitest';
import { bestEffortAppendBrokerOpportunityEvent, bestEffortCaptureOrderIntentBrokerPostOpportunity, createBrokerObservationBudget, getBrokerEvidenceTransactionLimits, resolveBrokerOpportunityApplicability } from './order-intent-broker-opportunity.service.js';
import { vi } from 'vitest';

describe('broker opportunity applicability', () => {
  it('uses only the frozen coverage classification and account environment', () => {
    expect(resolveBrokerOpportunityApplicability({environment:'PAPER',provenance:'ACTIVE_EXACT',captureSchemaVersion:2})).toBe('APPLICABLE_ACTIVE');
    expect(resolveBrokerOpportunityApplicability({environment:'PAPER',provenance:'SUPERSEDED_COMPARE_ONLY',captureSchemaVersion:2})).toBe('APPLICABLE_SUPERSEDED');
    expect(resolveBrokerOpportunityApplicability({environment:'PAPER',provenance:'UNENROLLED',captureSchemaVersion:2})).toBe('NOT_APPLICABLE_UNENROLLED');
    expect(resolveBrokerOpportunityApplicability({environment:'PAPER',provenance:'CAPTURE_UNKNOWN',captureSchemaVersion:2})).toBe('NOT_APPLICABLE_UNKNOWN');
    expect(resolveBrokerOpportunityApplicability({environment:'PAPER',provenance:'ACTIVE_EXACT',captureSchemaVersion:1})).toBe('NOT_APPLICABLE_LEGACY');
    expect(resolveBrokerOpportunityApplicability({environment:'LIVE',provenance:'ACTIVE_EXACT',captureSchemaVersion:2})).toBe('NOT_APPLICABLE_LIVE');
  });
  it('contains anchor and event persistence failures',async()=>{const db={$transaction:vi.fn().mockRejectedValue(new Error('database unavailable')),orderIntentBrokerPostOpportunity:{findFirst:vi.fn().mockRejectedValue(new Error('database unavailable'))}} as any;await expect(bestEffortCaptureOrderIntentBrokerPostOpportunity(10,db)).resolves.toBeNull();await expect(bestEffortAppendBrokerOpportunityEvent({opportunityId:20,eventType:'DELIVERY_UNCERTAIN'},db)).resolves.toBe(false);});
  it('derives transaction limits from one cumulative monotonic budget',()=>{const limits=getBrokerEvidenceTransactionLimits(createBrokerObservationBudget());expect(limits).not.toBeNull();expect(limits!.maxWait).toBe(100);expect(limits!.timeout).toBeGreaterThanOrEqual(139);expect(limits!.timeout).toBeLessThanOrEqual(140);expect(limits!.statementTimeoutMs).toBe(limits!.timeout-1);expect(getBrokerEvidenceTransactionLimits({startedAtMs:0,deadlineAtMs:performance.now()+109})).toBeNull();});
  it('does not start a missing-observation fallback after the cumulative budget is spent',async()=>{const transaction=vi.fn(async()=>{await new Promise(resolve=>setTimeout(resolve,20));throw new Error('BROKER_OPPORTUNITY_ANCHOR_UNAVAILABLE');});const budget=createBrokerObservationBudget(performance.now(),125);await expect(bestEffortCaptureOrderIntentBrokerPostOpportunity(10,{$transaction:transaction} as any,budget)).resolves.toBeNull();expect(transaction).toHaveBeenCalledTimes(1);});
});
