import { z } from 'zod';

export const cancelOrderParamsSchema = z.object({
  orderId: z.string().trim().min(1)
});

export type CancelOrderParams = z.infer<typeof cancelOrderParamsSchema>;