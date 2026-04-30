import { Router } from 'express';
import { 
  closePositionController,
  positionsController
} from '../controllers/positions.controller.js';

const router = Router();

router.get('/', positionsController);
router.delete('/:symbol', closePositionController);

export default router;