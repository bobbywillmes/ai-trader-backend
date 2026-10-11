import { describe, expect, it } from 'vitest';
import { resolveBrokerOpportunityApplicability } from './order-intent-broker-opportunity.service.js';

describe('broker opportunity applicability', () => {
  it('uses only the frozen coverage classification and account environment', () => {
    expect(resolveBrokerOpportunityApplicability({environment:'PAPER',provenance:'ACTIVE_EXACT',captureSchemaVersion:2})).toBe('APPLICABLE_ACTIVE');
    expect(resolveBrokerOpportunityApplicability({environment:'PAPER',provenance:'SUPERSEDED_COMPARE_ONLY',captureSchemaVersion:2})).toBe('APPLICABLE_SUPERSEDED');
    expect(resolveBrokerOpportunityApplicability({environment:'PAPER',provenance:'UNENROLLED',captureSchemaVersion:2})).toBe('NOT_APPLICABLE_UNENROLLED');
    expect(resolveBrokerOpportunityApplicability({environment:'PAPER',provenance:'CAPTURE_UNKNOWN',captureSchemaVersion:2})).toBe('NOT_APPLICABLE_UNKNOWN');
    expect(resolveBrokerOpportunityApplicability({environment:'PAPER',provenance:'ACTIVE_EXACT',captureSchemaVersion:1})).toBe('NOT_APPLICABLE_LEGACY');
    expect(resolveBrokerOpportunityApplicability({environment:'LIVE',provenance:'ACTIVE_EXACT',captureSchemaVersion:2})).toBe('NOT_APPLICABLE_LIVE');
  });
});
