import { PlatformRole } from '@prisma/client';
import { z } from 'zod';

export const platformRoleSchema = z.enum(PlatformRole);

const tradingAccountIdsSchema = z.array(z.coerce.number().int().positive());

export const createUserInvitationSchema = z.object({
  email: z.string().email().trim().toLowerCase(),
  name: z.string().trim().min(1).max(200).nullable().optional(),
  platformRole: platformRoleSchema.default(PlatformRole.ACCOUNT_USER),
  enabled: z.boolean().default(true),
  tradingAccountIds: tradingAccountIdsSchema.default([]),
});

export const replaceUserTradingAccountMembershipsSchema = z.object({
  tradingAccountIds: tradingAccountIdsSchema,
});

export const updateUserSchema = z
  .object({
    name: z.string().trim().min(1).max(200).nullable().optional(),
    platformRole: platformRoleSchema.optional(),
    enabled: z.boolean().optional(),
  })
  .refine((input) => Object.keys(input).length > 0, {
    message: 'At least one update field is required.',
  });

export type CreateUserInvitationInput = z.infer<typeof createUserInvitationSchema>;
export type ReplaceUserTradingAccountMembershipsInput = z.infer<
  typeof replaceUserTradingAccountMembershipsSchema
>;
export type UpdateUserInput = z.infer<typeof updateUserSchema>;
