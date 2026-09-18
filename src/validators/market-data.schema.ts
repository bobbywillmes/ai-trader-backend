import { z } from 'zod';
import { validDate } from '../services/market-calendar.js';
export const marketDateSchema = z.string().refine(validDate, 'Use a real YYYY-MM-DD date.');
export const calendarYearSchema = z.coerce.number().int().min(2000).max(2100);
export const marketIdSchema = z.coerce.number().int().positive();
export const calendarInputSchema = z.object({
  sessionDate: marketDateSchema,
  name: z.string().trim().min(1).max(160),
  type: z.enum(['CLOSED', 'EARLY_CLOSE']),
  closeTimeMinutesEt: z.number().int().nullable(),
}).strict().refine(row => row.type === 'CLOSED' ? row.closeTimeMinutesEt === null : row.closeTimeMinutesEt !== null && row.closeTimeMinutesEt > 570 && row.closeTimeMinutesEt < 960, 'Closed dates have no close time; early close must be after 09:30 and before 16:00 Eastern.');
export const marketRangeSchema = z.object({ from: marketDateSchema, to: marketDateSchema }).strict().refine(row => row.from <= row.to, 'Start must not follow end.');
