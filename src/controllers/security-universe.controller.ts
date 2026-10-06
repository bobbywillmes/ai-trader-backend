import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { HttpError } from '../errors/http-error.js';
import { exportSecurityCatalog, exportUniverseSnapshot, freezeBreadthUniverse, getBreadthUniverseStatus, importSecurityUniverses } from '../services/security-universe-import.service.js';
import { etDate } from '../services/market-calendar.js';

const importTiming = z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('immediate') }), z.strictObject({ kind: z.literal('scheduled'), membershipEffectiveDate: z.iso.date() })]);
const importBody = z.strictObject({ csv: z.string().min(1).max(2_000_000), timing: importTiming.default({ kind: 'immediate' }) });
const freezeBody = z.strictObject({ effectiveDate: z.iso.date().optional(), expectedAsOfDate: z.iso.date().optional(), expectedConstituentHash: z.string().regex(/^[a-f0-9]{64}$/).optional() });
let lastExportTimestamp = 0;

export function exportFilename(kind: 'universe-snapshot' | 'security-catalog') {
  // Keep filenames distinct when two requests arrive during the same millisecond.
  lastExportTimestamp = Math.max(Date.now(), lastExportTimestamp + 1);
  return `${kind}-${new Date(lastExportTimestamp).toISOString().replace(/[:.]/g, '-')}.csv`;
}

export function importController(apply: boolean) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = importBody.safeParse(req.body);
      if (!body.success) { res.status(400).json({ message: 'Invalid import request.', details: body.error.flatten() }); return; }
      res.json(await importSecurityUniverses(body.data.csv, { timing: body.data.timing, apply }));
    } catch (error) { next(error instanceof Error ? new HttpError(400, error.message) : error); }
  };
}

export function freezeController(apply: boolean) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = freezeBody.safeParse(req.body);
      if (!body.success) { res.status(400).json({ message: 'Invalid freeze request.', details: body.error.flatten() }); return; }
      const today = etDate(new Date());
      if (body.data.expectedAsOfDate && body.data.expectedAsOfDate !== today) { res.status(409).json({ message: 'Breadth preview is stale; refresh status and preview again.' }); return; }
      res.json(await freezeBreadthUniverse({ effectiveDate: body.data.effectiveDate ?? today, ...(body.data.expectedConstituentHash ? { expectedConstituentHash: body.data.expectedConstituentHash } : {}), apply }));
    } catch (error) { next(error instanceof Error ? new HttpError(400, error.message) : error); }
  };
}

export async function breadthStatusController(_req: Request, res: Response, next: NextFunction) {
  try { res.json(await getBreadthUniverseStatus()); }
  catch (error) { next(error instanceof Error ? new HttpError(409, error.message) : error); }
}

export function exportController(kind: 'universe-snapshot' | 'security-catalog') {
  return async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const csv = kind === 'universe-snapshot' ? await exportUniverseSnapshot() : await exportSecurityCatalog();
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${exportFilename(kind)}"`);
      res.send(csv);
    } catch (error) { next(error); }
  };
}
