import { PlatformRole } from '@prisma/client';
import type { NextFunction, Request, Response } from 'express';
import { HttpError } from '../errors/http-error.js';
import {
  getMarketPolicyEnforcementRuntimeStatus,
  listMarketPolicyEnforcementRuntimeRolloutEvents,
  redactMarketPolicyEnforcementRuntimeStatus,
  setMarketPolicyEnforcementRuntimeRollout,
} from '../services/market-policy-enforcement-rollout.service.js';
import { setMarketPolicyEnforcementRolloutSchema } from '../validators/market-policy-enforcement.schema.js';
import { assessMarketPolicyBrokerEnforcementReadiness } from '../services/market-policy-broker-readiness.service.js';

function requireActorUserId(res: Response) {
  const user = res.locals.user;
  if (!user) throw new HttpError(401, 'Authentication required.');
  return user.id as number;
}

export async function getMarketPolicyEnforcementRuntimeRolloutController(_req: Request, res: Response, next: NextFunction) {
  try {
    const status = await getMarketPolicyEnforcementRuntimeStatus();
    const owner = res.locals.user?.platformRole === PlatformRole.SYSTEM_OWNER;
    res.status(200).json({ runtimeEnforcement: owner ? status : redactMarketPolicyEnforcementRuntimeStatus(status) });
  } catch (error) { next(error); }
}

export async function listMarketPolicyEnforcementRuntimeRolloutEventsController(_req: Request, res: Response, next: NextFunction) {
  try {
    res.status(200).json({ events: await listMarketPolicyEnforcementRuntimeRolloutEvents() });
  } catch (error) { next(error); }
}

// Read-only Phase 3C.3 pre-activation inventory of queued PAPER BUY intents and unresolved lapses.
export async function getMarketPolicyBrokerEnforcementReadinessController(_req: Request, res: Response, next: NextFunction) {
  try {
    res.status(200).json(await assessMarketPolicyBrokerEnforcementReadiness());
  } catch (error) { next(error); }
}

function setRolloutController(enabled: boolean) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const input = setMarketPolicyEnforcementRolloutSchema.parse(req.body);
      const runtimeEnforcement = await setMarketPolicyEnforcementRuntimeRollout(enabled, input, requireActorUserId(res));
      res.status(200).json({ runtimeEnforcement });
    } catch (error) { next(error); }
  };
}

export const activateMarketPolicyEnforcementRuntimeRolloutController = setRolloutController(true);
export const deactivateMarketPolicyEnforcementRuntimeRolloutController = setRolloutController(false);
