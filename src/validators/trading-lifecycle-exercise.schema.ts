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

export const lifecycleExerciseCancelSchema = z.object({
  reason: z.string().trim().min(1).max(1000),
}).strict();

export type LifecycleExercisePreviewInput = z.infer<typeof lifecycleExercisePreviewSchema>;
