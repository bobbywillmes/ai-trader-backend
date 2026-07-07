import { z } from 'zod';

const adminUserRoleSchema = z.enum([
  'owner',
  'account_manager',
  'account_viewer',
]);

const tradingAccountAccessRoleSchema = z.enum(['OWNER', 'MANAGER', 'VIEWER']);

const tradingAccountAccessAssignmentSchema = z.object({
  tradingAccountId: z.coerce.number().int().positive(),
  role: tradingAccountAccessRoleSchema.default('VIEWER'),
});

export const createAdminUserInvitationSchema = z.object({
  email: z.string().email().trim().toLowerCase(),
  name: z.string().trim().min(1).max(200).nullable().optional(),
  role: adminUserRoleSchema.default('account_viewer'),
  enabled: z.boolean().default(true),
  tradingAccountAccess: z.array(tradingAccountAccessAssignmentSchema).default([]),
});

export const updateAdminUserTradingAccountAccessSchema = z.object({
  tradingAccountAccess: z.array(tradingAccountAccessAssignmentSchema),
});

export type CreateAdminUserInvitationInput = z.infer<
  typeof createAdminUserInvitationSchema
>;
export type UpdateAdminUserTradingAccountAccessInput = z.infer<
  typeof updateAdminUserTradingAccountAccessSchema
>;
