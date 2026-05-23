import { Router } from 'express';
import { getEtfWatchContextController } from '../controllers/etf-watch-context.controller.js';

const router = Router();

router.get('/context', getEtfWatchContextController);

export default router;