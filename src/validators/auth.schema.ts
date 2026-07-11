import { z } from 'zod';

export const bootstrapSchema = z.object({
  email: z.string().email().trim().toLowerCase(),
  password: z.string().min(12, 'Password must be at least 12 characters.'),
});

export const loginSchema = z.object({
  email: z.string().email().trim().toLowerCase(),
  password: z.string().min(1, 'Password is required.'),
});

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, 'Current password is required.'),
    newPassword: z.string().min(12, 'Password must be at least 12 characters.'),
  })
  .refine((data) => data.currentPassword !== data.newPassword, {
    message: 'New password must differ from current password.',
    path: ['newPassword'],
  });

export const setupPasswordSchema = z
  .object({
    password: z.string().min(12, 'Password must be at least 12 characters.'),
    confirmPassword: z.string().min(1, 'Password confirmation is required.'),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: 'Passwords must match.',
    path: ['confirmPassword'],
  });

export type BootstrapInput = z.infer<typeof bootstrapSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
export type SetupPasswordInput = z.infer<typeof setupPasswordSchema>;
