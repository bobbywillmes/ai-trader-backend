import { describe, expect, it } from 'vitest';
import { bestEffortAppendBrokerOpportunityEvent, bestEffortCaptureOrderIntentBrokerPostOpportunity, resolveBrokerOpportunityApplicability } from './order-intent-broker-opportunity.service.js';
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
});
