import type { NextFunction, Request, Response } from 'express';
import { getCurrentStrategyEligibility, getStrategyEligibilityDecision, listCurrentStrategyEligibility, listStrategyEligibilityDecisions } from '../services/strategy-market-eligibility.service.js';

function positive(value: unknown, fallback?: number) { const parsed = Number(value ?? fallback); if (!Number.isInteger(parsed) || parsed <= 0) throw new Error('Expected a positive integer.'); return parsed; }
export async function currentStrategyEligibilityController(req: Request, res: Response, next: NextFunction) { try { res.json(await getCurrentStrategyEligibility(positive(req.params.id))); } catch (error) { next(error); } }
export async function strategyEligibilityHistoryController(req: Request, res: Response, next: NextFunction) { try { res.json(await listStrategyEligibilityDecisions(Math.min(100, positive(req.query.limit, 20)), req.query.beforeId ? positive(req.query.beforeId) : undefined, req.params.id ? positive(req.params.id) : undefined)); } catch (error) { next(error); } }
export async function strategyEligibilityDetailController(req: Request, res: Response, next: NextFunction) { try { res.json(await getStrategyEligibilityDecision(positive(req.params.decisionId ?? req.params.id))); } catch (error) { next(error); } }
export async function currentStrategyEligibilitySummaryController(_req: Request, res: Response, next: NextFunction) { try { res.json(await listCurrentStrategyEligibility()); } catch (error) { next(error); } }
