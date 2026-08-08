import { z } from 'zod';

export const lifecycleExercisePreviewSchema = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  reason: z.string().trim().min(1).max(1000),
  subscriptionId: z.coerce.number().int().positive(),
  selectionMode: z.enum(['SELECTED_USERS', 'ALL_ELIGIBLE']),
  userIds: z.array(z.coerce.number().int().positive()).max(100).optional(),
  environment: z.literal('PAPER'),
}).strict().superRefine((value, context) => {
  if (value.selectionMode === 'SELECTED_USERS' && !value.userIds?.length) {
    context.addIssue({ code: 'custom', path: ['userIds'], message: 'Select at least one account holder.' });
  }
  if (value.selectionMode === 'ALL_ELIGIBLE' && value.userIds?.length) {
    context.addIssue({ code: 'custom', path: ['userIds'], message: 'userIds must be empty for ALL_ELIGIBLE.' });
  }
});

export const lifecycleExerciseLaunchSchema = z.object({
  confirmation: z.literal('LAUNCH PAPER EXERCISE'),
}).strict();

export const subscriptionEntryCandidatesQuerySchema = z.object({
  subscriptionId: z.coerce.number().int().positive(),
}).strict();

export const subscriptionEntryPreviewSchema = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  reason: z.string().trim().min(1).max(1000),
  subscriptionId: z.coerce.number().int().positive(),
  tradingAccountSubscriptionIds: z.array(z.coerce.number().int().positive()),
  environment: z.literal('PAPER'),
}).strict().superRefine((value, context) => {
  if (value.tradingAccountSubscriptionIds.length === 0) {
    context.addIssue({
      code: 'custom', path: ['tradingAccountSubscriptionIds'],
      message: 'Select at least one assignment.', params: { code: 'EMPTY_ASSIGNMENT_SELECTION' },
    });
  }
  if (value.tradingAccountSubscriptionIds.length > 25) {
    context.addIssue({
      code: 'custom', path: ['tradingAccountSubscriptionIds'],
      message: 'Lifecycle Exercises support at most 25 assignments.',
      params: { code: 'ASSIGNMENT_TARGET_LIMIT_EXCEEDED', limit: 25 },
    });
  }
  const seen = new Set<number>();
  value.tradingAccountSubscriptionIds.forEach((assignmentId, index) => {
    if (seen.has(assignmentId)) {
      context.addIssue({
        code: 'custom',
        path: ['tradingAccountSubscriptionIds', index],
        message: 'Duplicate assignment IDs are not allowed.',
        params: { code: 'DUPLICATE_ASSIGNMENT_ID', tradingAccountSubscriptionId: assignmentId },
      });
    }
    seen.add(assignmentId);
  });
});

export const lifecycleExerciseCancelSchema = z.object({
  reason: z.string().trim().min(1).max(1000),
}).strict();

export type LifecycleExercisePreviewInput = z.infer<typeof lifecycleExercisePreviewSchema>;
export type SubscriptionEntryPreviewInput = z.infer<typeof subscriptionEntryPreviewSchema>;
