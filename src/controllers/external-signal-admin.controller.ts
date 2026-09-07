import type { Request, Response, NextFunction } from 'express';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { HttpError } from '../errors/http-error.js';
import * as schemas from '../validators/external-signal.schema.js';
import * as config from '../services/external-signal-config.service.js';
import { getExternalSignalResource, listExternalSignalResources, type ExternalSignalResource } from '../services/external-signal-read.service.js';

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new HttpError(400, 'Invalid external signal request.',
    result.error.issues.map(issue => ({ path: issue.path, code: issue.code })));
  return result.data;
}

export function externalSignalAdminController(resource: ExternalSignalResource,
  action: 'list' | 'read' | 'create' | 'update' | 'rotate') {
  return async (req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      if (!res.locals.user) throw new HttpError(401, 'Authentication required.');
      const actorUserId = res.locals.user.id;
      const id = action === 'read' || action === 'update' || action === 'rotate'
        ? parse(schemas.externalSignalIdSchema, req.params.id) : 0;
      let result: unknown;
      if (action === 'list') result = await listExternalSignalResources(resource, parse(schemas.externalSignalListSchema, req.query));
      else if (action === 'read') result = await getExternalSignalResource(resource, id);
      else if (action === 'rotate') result = await config.rotateExternalSignalToken(id, actorUserId);
      else if (resource === 'sources') result = action === 'create'
        ? await config.createExternalSignalSource(parse(schemas.createExternalSignalSourceSchema, req.body), actorUserId)
        : await config.updateExternalSignalSource(id, parse(schemas.updateExternalSignalSourceSchema, req.body), actorUserId);
      else result = action === 'create'
        ? await config.createStrategySignalBinding(parse(schemas.createStrategySignalBindingSchema, req.body), actorUserId)
        : await config.updateStrategySignalBinding(id, parse(schemas.updateStrategySignalBindingSchema, req.body), actorUserId);
      res.status(action === 'create' ? 201 : 200).json(result);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError) {
        if (error.code === 'P2002') return next(new HttpError(409, 'Configuration identity already exists.'));
        if (error.code === 'P2025') return next(new HttpError(404, 'Resource not found.'));
        if (error.code === 'P2003') return next(new HttpError(400, 'Referenced resource does not exist.'));
      }
      next(error);
    }
  };
}
