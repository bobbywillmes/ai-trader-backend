import { Router } from 'express';
import { accountController } from '../controllers/account.controller.js';

const router = Router();

router.get('/', accountController);

export default router;