import { Router } from 'express';
import { requireSystemOwnerAccess } from '../middleware/rbac.js';
import { externalSignalAdminController as controller } from '../controllers/external-signal-admin.controller.js';
import { strategySignalRevisionController as revisions } from '../controllers/external-signal-admin.controller.js';
import { externalSignalOperationsController, requeueExternalSignalCorrelationController } from '../controllers/external-signal-admin.controller.js';
import {
  createExternalSignalExecutionGenerationController, externalSignalExecutionRolloutController,
  grantExternalSignalEntryExecutionAuthorizationController, listExternalSignalEntryExecutionAuthorizationsController,
  listExternalSignalExecutionRolloutsController, revokeExternalSignalEntryExecutionAuthorizationController,
} from '../controllers/external-signal-admin.controller.js';

const router = Router();
router.use(requireSystemOwnerAccess);
router.get('/operations', externalSignalOperationsController);
router.get('/operations/:id', externalSignalOperationsController);
router.post('/correlation-work/:id/requeue', requeueExternalSignalCorrelationController);
router.get('/execution-rollouts', listExternalSignalExecutionRolloutsController);
router.post('/execution-rollouts', createExternalSignalExecutionGenerationController);
router.post('/execution-rollouts/:id/activate', externalSignalExecutionRolloutController('ACTIVATE'));
router.post('/execution-rollouts/:id/deactivate', externalSignalExecutionRolloutController('DEACTIVATE'));
router.get('/accounts/:accountId/assignments/:assignmentId/entry-execution-authorizations', listExternalSignalEntryExecutionAuthorizationsController);
router.post('/accounts/:accountId/assignments/:assignmentId/entry-execution-authorizations', grantExternalSignalEntryExecutionAuthorizationController);
router.post('/accounts/:accountId/assignments/:assignmentId/entry-execution-authorizations/revoke', revokeExternalSignalEntryExecutionAuthorizationController);
for (const resource of ['sources', 'bindings', 'deliveries', 'signals'] as const) {
  router.get(`/${resource}`, controller(resource, 'list'));
  router.get(`/${resource}/:id`, controller(resource, 'read'));
}
for (const resource of ['sources', 'bindings'] as const) {
  router.post(`/${resource}`, controller(resource, 'create'));
  router.patch(`/${resource}/:id`, controller(resource, 'update'));
}
router.get('/sources/:id/webhook', controller('sources', 'webhook'));
router.post('/sources/:id/regenerate-webhook', controller('sources', 'regenerate'));
router.get('/bindings/:id/revisions', revisions('list'));
router.post('/bindings/:id/revisions', revisions('prepare'));
router.post('/bindings/:id/revisions/:revisionId/activate', revisions('activate'));
router.post('/bindings/:id/revisions/:revisionId/retire', revisions('retire'));
router.patch('/bindings/:id/revisions/:revisionId/authority', revisions('authority'));
export default router;
