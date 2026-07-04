import { Router } from 'express';
import {
  expireStaleMomentumCandidatesController,
  generateMomentumCandidatesController,
  getMomentumCandidateController,
  listMomentumCandidatesController,
} from '../controllers/momentum-candidates.controller.js';

const router = Router();

router.get('/', listMomentumCandidatesController);
router.post('/generate-from-catalysts', generateMomentumCandidatesController);
router.post('/expire-stale', expireStaleMomentumCandidatesController);
router.get('/:id', getMomentumCandidateController);

export default router;
