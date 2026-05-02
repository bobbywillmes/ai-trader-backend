import { z } from 'zod';

export const adminBootstrapSchema = z.object({
  email: z.string().email().trim().toLowerCase(),
  password: z.string().min(12, 'Password must be at least 12 characters.'),
});

export const adminLoginSchema = z.object({
  email: z.string().email().trim().toLowerCase(),
  password: z.string().min(1, 'Password is required.'),
});

export type AdminBootstrapInput = z.infer<typeof adminBootstrapSchema>;
export type AdminLoginInput = z.infer<typeof adminLoginSchema>;