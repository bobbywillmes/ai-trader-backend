import { z } from 'zod';

export const setMarketPolicyEnforcementRolloutSchema = z.strictObject({
  expectedVersion: z.coerce.number().int().min(0),
  reason: z.string().trim().min(1).max(500),
  // Explicit acknowledgement of the PAPER-only trading effect of this change.
  confirmPaperOnlyTradingEffect: z.literal(true),
});
