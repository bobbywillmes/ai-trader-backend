import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';

import { HttpError } from '../errors/http-error.js';
import {
  cancelTradingLifecycleExercise,
  getTradingLifecycleExercise,
  launchTradingLifecycleExercise,
  listTradingLifecycleExercises,
  previewTradingLifecycleExercise,
  listSubscriptionEntryCandidates,
  previewSubscriptionEntryLifecycleExercise,
  reconcileTradingLifecycleExerciseTarget,
  recoverStaleTradingLifecycleExerciseDispatches,
} from '../services/trading-lifecycle-exercise.service.js';
import {
  lifecycleExerciseCancelSchema,
  lifecycleExerciseLaunchSchema,
  lifecycleExercisePreviewSchema,
  subscriptionEntryCandidatesQuerySchema,
  subscriptionEntryPreviewSchema,
} from '../validators/trading-lifecycle-exercise.schema.js';

function id(value: unknown, label: string) {
  const parsed = typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isInteger(parsed) || parsed <= 0) throw new HttpError(400, `Invalid ${label}.`);
  return parsed;
}

export async function listSubscriptionEntryCandidatesController(req: Request, res: Response, next: NextFunction) {
  try {
    const input = subscriptionEntryCandidatesQuerySchema.parse(req.query);
    res.status(200).json(await listSubscriptionEntryCandidates(input.subscriptionId));
  } catch (error) {
    if (!invalid(error, next, 'Invalid Subscription-entry candidate request.')) next(error);
  }
}

export async function previewSubscriptionEntryLifecycleExerciseController(req: Request, res: Response, next: NextFunction) {
  try {
    const input = subscriptionEntryPreviewSchema.parse(req.body);
    res.status(201).json({ exercise: await previewSubscriptionEntryLifecycleExercise(input, actor(res)) });
  } catch (error) {
    if (error instanceof ZodError) {
      next(new HttpError(400, 'Invalid explicit-assignment lifecycle exercise preview request.', {
        code: 'INVALID_EXPLICIT_ASSIGNMENT_PREVIEW_REQUEST',
        errors: error.issues.map((issue) => {
          const params = 'params' in issue ? issue.params as Record<string, unknown> | undefined : undefined;
          return {
            code: typeof params?.code === 'string' ? params.code : 'INVALID_FIELD',
            path: issue.path, message: issue.message,
          };
        }),
      }));
    } else next(error);
  }
}

function actor(res: Response) {
  if (!res.locals.user) throw new HttpError(401, 'Authentication required.');
  return res.locals.user.id as number;
}

function invalid(error: unknown, next: NextFunction, message: string) {
  if (error instanceof ZodError) {
    next(new HttpError(400, message, error.flatten()));
    return true;
  }
  return false;
}

export async function previewLifecycleExerciseController(req: Request, res: Response, next: NextFunction) {
  try {
    const exercise = await previewTradingLifecycleExercise(lifecycleExercisePreviewSchema.parse(req.body), actor(res));
    res.status(201).json({ exercise });
  } catch (error) {
    if (!invalid(error, next, 'Invalid lifecycle exercise preview request.')) next(error);
  }
}

export async function launchLifecycleExerciseController(req: Request, res: Response, next: NextFunction) {
  try {
    lifecycleExerciseLaunchSchema.parse(req.body);
    res.status(200).json({ exercise: await launchTradingLifecycleExercise(id(req.params.id, 'exercise id'), actor(res)) });
  } catch (error) {
    if (!invalid(error, next, 'Invalid lifecycle exercise launch confirmation.')) next(error);
  }
}

export async function cancelLifecycleExerciseController(req: Request, res: Response, next: NextFunction) {
  try {
    const input = lifecycleExerciseCancelSchema.parse(req.body);
    res.status(200).json({
      exercise: await cancelTradingLifecycleExercise(id(req.params.id, 'exercise id'), input.reason, actor(res)),
      warning: 'Cancellation prevents undispatched work only. Existing orders and positions continue through normal lifecycle management.',
    });
  } catch (error) {
    if (!invalid(error, next, 'Invalid lifecycle exercise cancellation request.')) next(error);
  }
}

export async function listLifecycleExercisesController(req: Request, res: Response, next: NextFunction) {
  try {
    const limit = typeof req.query.limit === 'string' ? Number(req.query.limit) : 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new HttpError(400, 'limit must be between 1 and 100.');
    res.status(200).json({ exercises: await listTradingLifecycleExercises(limit) });
  } catch (error) {
    next(error);
  }
}

export async function getLifecycleExerciseController(req: Request, res: Response, next: NextFunction) {
  try {
    res.status(200).json({ exercise: await getTradingLifecycleExercise(id(req.params.id, 'exercise id')) });
  } catch (error) {
    next(error);
  }
}

export async function reconcileLifecycleExerciseTargetController(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await reconcileTradingLifecycleExerciseTarget(
      id(req.params.exerciseId, 'exercise id'), id(req.params.targetId, 'target id'), actor(res)
    );
    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
}

export async function recoverLifecycleExerciseDispatchesController(req: Request, res: Response, next: NextFunction) {
  try {
    res.status(200).json(await recoverStaleTradingLifecycleExerciseDispatches(id(req.params.id, 'exercise id'), actor(res)));
  } catch (error) {
    next(error);
  }
}
