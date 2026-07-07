import { z } from 'zod';

export const adminBootstrapSchema = z.object({
  email: z.string().email().trim().toLowerCase(),
  password: z.string().min(12, 'Password must be at least 12 characters.'),
});

export const adminLoginSchema = z.object({
  email: z.string().email().trim().toLowerCase(),
  password: z.string().min(1, 'Password is required.'),
});

export const adminChangePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, 'Current password is required.'),
    newPassword: z.string().min(12, 'Password must be at least 12 characters.'),
  })
  .refine((data) => data.currentPassword !== data.newPassword, {
    message: 'New password must differ from current password.',
    path: ['newPassword'],
  });

export const adminSetupPasswordSchema = z
  .object({
    password: z.string().min(12, 'Password must be at least 12 characters.'),
    confirmPassword: z.string().min(1, 'Password confirmation is required.'),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: 'Passwords must match.',
    path: ['confirmPassword'],
  });

export type AdminBootstrapInput = z.infer<typeof adminBootstrapSchema>;
export type AdminLoginInput = z.infer<typeof adminLoginSchema>;
export type AdminChangePasswordInput = z.infer<typeof adminChangePasswordSchema>;
export type AdminSetupPasswordInput = z.infer<typeof adminSetupPasswordSchema>;
