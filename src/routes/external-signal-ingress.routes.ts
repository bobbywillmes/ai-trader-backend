import { Router, type ErrorRequestHandler } from 'express';
import { externalSignalIngressController } from '../controllers/external-signal-ingress.controller.js';
const router = Router();
router.post('/:webhookKey', externalSignalIngressController);
router.use((_req, res) => { res.status(404).json({ error: 'Not Found' }); });
// Includes malformed percent-encoding in route parameters, without logging URLs.
const ingressErrorHandler: ErrorRequestHandler = (_error, _req, res, _next) => {
  res.status(400).json({ error: 'Invalid request' });
};
router.use(ingressErrorHandler);
export default router;
