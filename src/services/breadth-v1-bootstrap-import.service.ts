import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Prisma, type PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../db/prisma.js';
import { HttpError } from '../errors/http-error.js';
import { marketSession, type CalendarException } from './market-calendar.js';
import { BREADTH_V1_EVIDENCE_SCHEMA_VERSION, BREADTH_V1_UNIVERSE_DEFINITION_VERSION } from './breadth-v1-calculation.js';
import { withBreadthObservationLock } from './breadth-observation-lock.service.js';

/** Historical BREADTH_V1 evidence import: insert-only, from the frozen checked-in bootstrap
 * artifact. Never fetches from Massive. Never touches MarketRegimeDimensionAssessment —
 * this imports raw/derived market evidence only, never an authoritative assessment. */

export const BREADTH_V1_BOOTSTRAP_ARTIFACT_PATH = path.join('prisma', 'bootstrap', 'breadth-v1-bootstrap-artifact.json');
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const json = (value: unknown): Prisma.InputJsonValue => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;

const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const rowSchema = z.object({
  sessionDate: dateString, previousSessionDate: dateString,
  universeCount: z.number().int().nonnegative(), currentBarCount: z.number().int().nonnegative(), priorBarCount: z.number().int().nonnegative(),
  advancingCount: z.number().int().nonnegative(), decliningCount: z.number().int().nonnegative(), unchangedCount: z.number().int().nonnegative(),
  directionalCount: z.number().int().positive(), excludedCount: z.number().int().nonnegative(),
  advanceShare: z.number().min(0).max(1), netBreadth: z.number().min(-1).max(1),
  canonicalInputHash: z.string().length(64),
  provenance: z.object({ universeHash: z.string().length(64), currentGroupedHash: z.string().length(64), priorGroupedHash: z.string().length(64) }).strict(),
}).strict()
  .refine(row => row.directionalCount === row.advancingCount + row.decliningCount, { message: 'directionalCount must equal advancingCount + decliningCount' })
  .refine(row => row.previousSessionDate < row.sessionDate, { message: 'previousSessionDate must precede sessionDate' });

const artifactSchema = z.object({
  artifactVersion: z.literal(1), provider: z.literal('MASSIVE'), universeDefinitionVersion: z.literal(BREADTH_V1_UNIVERSE_DEFINITION_VERSION),
  evidenceSchemaVersion: z.literal(BREADTH_V1_EVIDENCE_SCHEMA_VERSION), from: dateString, through: dateString,
  rowCount: z.number().int().positive(), rows: z.array(rowSchema), canonicalArtifactHash: z.string().length(64),
}).strict();
export type BreadthV1BootstrapArtifact = z.infer<typeof artifactSchema>;
export type BreadthV1BootstrapRow = BreadthV1BootstrapArtifact['rows'][number];

/** Reads and validates the checked-in artifact: shape, top-level canonical hash, every
 * per-row canonical hash, rowCount consistency, and strict chronological ordering. Fails
 * closed (throws) rather than importing anything unverifiable. */
export async function loadValidatedBreadthV1BootstrapArtifact(artifactPath: string = BREADTH_V1_BOOTSTRAP_ARTIFACT_PATH): Promise<BreadthV1BootstrapArtifact> {
  let raw: string;
  try { raw = await readFile(artifactPath, 'utf8'); }
  catch { throw new HttpError(500, `BREADTH_V1 bootstrap artifact not found at ${artifactPath}. STOP — generate it from the accepted research cache before bootstrapping.`); }
  const artifact = artifactSchema.parse(JSON.parse(raw));
  if (artifact.rows.length !== artifact.rowCount) throw new HttpError(500, 'Bootstrap artifact rowCount does not match rows.length. STOP.');
  const { canonicalArtifactHash, ...withoutHash } = artifact;
  if (hash(withoutHash) !== canonicalArtifactHash) throw new HttpError(500, 'Bootstrap artifact canonicalArtifactHash does not match its own content. STOP.');
  for (const row of artifact.rows) {
    const { canonicalInputHash, provenance } = row;
    const recomputed = hash({
      sessionDate: row.sessionDate, previousSessionDate: row.previousSessionDate,
      universeHash: provenance.universeHash, currentGroupedHash: provenance.currentGroupedHash, priorGroupedHash: provenance.priorGroupedHash,
      provider: artifact.provider, universeDefinitionVersion: artifact.universeDefinitionVersion, evidenceSchemaVersion: artifact.evidenceSchemaVersion,
    });
    if (recomputed !== canonicalInputHash) throw new HttpError(500, `Bootstrap artifact row ${row.sessionDate} canonicalInputHash does not match its own content. STOP.`);
  }
  for (let i = 1; i < artifact.rows.length; i++) {
    if (artifact.rows[i]!.sessionDate <= artifact.rows[i - 1]!.sessionDate) throw new HttpError(500, 'Bootstrap artifact rows are not strictly chronological. STOP.');
  }
  return artifact;
}

export type BreadthV1BootstrapConflict = { sessionDate: string; reason: string };
type Classified = { inserts: BreadthV1BootstrapRow[]; existingMatches: BreadthV1BootstrapRow[]; conflicts: BreadthV1BootstrapConflict[] };

async function classifyRows(db: PrismaClient, artifact: BreadthV1BootstrapArtifact): Promise<Classified> {
  const existing = await db.marketBreadthObservation.findMany({
    where: { provider: artifact.provider, universeDefinitionVersion: artifact.universeDefinitionVersion, sessionDate: { in: artifact.rows.map(row => new Date(row.sessionDate)) } },
  });
  const existingByDate = new Map(existing.map(row => [row.sessionDate.toISOString().slice(0, 10), row]));
  const inserts: BreadthV1BootstrapRow[] = [], existingMatches: BreadthV1BootstrapRow[] = [], conflicts: BreadthV1BootstrapConflict[] = [];
  for (const row of artifact.rows) {
    const found = existingByDate.get(row.sessionDate);
    if (!found) { inserts.push(row); continue; }
    const equivalent = found.previousSessionDate.toISOString().slice(0, 10) === row.previousSessionDate
      && found.universeCount === row.universeCount && found.currentBarCount === row.currentBarCount && found.priorBarCount === row.priorBarCount
      && found.advancingCount === row.advancingCount && found.decliningCount === row.decliningCount && found.unchangedCount === row.unchangedCount
      && found.directionalCount === row.directionalCount && found.excludedCount === row.excludedCount
      // Stored as Decimal(7,6); compare against the artifact's raw float rounded to the same
      // precision the column enforces, not the unrounded float.
      && found.advanceShare.equals(new Prisma.Decimal(row.advanceShare).toDecimalPlaces(6)) && found.netBreadth.equals(new Prisma.Decimal(row.netBreadth).toDecimalPlaces(6))
      && found.canonicalInputHash === row.canonicalInputHash;
    if (equivalent) existingMatches.push(row);
    else conflicts.push({ sessionDate: row.sessionDate, reason: 'An existing MarketBreadthObservation row for this session differs from the artifact row.' });
  }
  return { inserts, existingMatches, conflicts };
}

export type BreadthV1BootstrapPreview = {
  artifactRows: number; canonicalArtifactHash: string; from: string; through: string;
  inserts: number; existingMatches: number; conflicts: BreadthV1BootstrapConflict[];
};
/** Preview: read-only, makes no writes. Reports what `apply` would do. */
export async function previewBreadthV1Bootstrap(options: { db?: PrismaClient; artifactPath?: string } = {}): Promise<BreadthV1BootstrapPreview> {
  const db = options.db ?? prisma;
  const artifact = await loadValidatedBreadthV1BootstrapArtifact(options.artifactPath);
  const { inserts, existingMatches, conflicts } = await classifyRows(db, artifact);
  return { artifactRows: artifact.rowCount, canonicalArtifactHash: artifact.canonicalArtifactHash, from: artifact.from, through: artifact.through, inserts: inserts.length, existingMatches: existingMatches.length, conflicts };
}

export type BreadthV1BootstrapApplyResult = { inserted: number; skipped: number; conflicts: BreadthV1BootstrapConflict[] };
/** Apply: inserts missing rows only, inside one transaction under an exclusive advisory
 * lock. Fails closed on any conflicting existing row — nothing is written if any conflict
 * exists. Never updates or deletes. Rerunning after a successful apply is a full no-op
 * (every row becomes an existing exact match). */
export async function applyBreadthV1Bootstrap(options: { db?: PrismaClient; artifactPath?: string; now?: Date } = {}): Promise<BreadthV1BootstrapApplyResult> {
  const db = options.db ?? prisma;
  const now = options.now ?? new Date();
  return withBreadthObservationLock(() => db.$transaction(async tx => {
    const artifact = await loadValidatedBreadthV1BootstrapArtifact(options.artifactPath);
    const { inserts, existingMatches, conflicts } = await classifyRows(tx as PrismaClient, artifact);
    if (conflicts.length) throw new HttpError(409, `Bootstrap import found ${conflicts.length} conflicting existing session(s); refusing to write anything. First conflict: ${conflicts[0]!.sessionDate}.`);
    if (!inserts.length) return { inserted: 0, skipped: existingMatches.length, conflicts: [] };
    const exceptionRows = await tx.marketCalendarException.findMany({ where: { sessionDate: { gte: new Date(artifact.from), lte: new Date(artifact.through) } }, orderBy: { sessionDate: 'asc' } });
    const exceptions: CalendarException[] = exceptionRows.map(row => ({ ...row, sessionDate: row.sessionDate.toISOString().slice(0, 10) }));
    const data = inserts.map(row => {
      const session = marketSession(row.sessionDate, exceptions);
      if (!session) throw new HttpError(500, `Bootstrap row ${row.sessionDate} has no calendar session; calendar exceptions may have changed since the artifact was generated. STOP.`);
      return {
        sessionDate: new Date(row.sessionDate), previousSessionDate: new Date(row.previousSessionDate),
        provider: artifact.provider, universeDefinitionVersion: artifact.universeDefinitionVersion, evidenceSchemaVersion: artifact.evidenceSchemaVersion,
        universeCount: row.universeCount, currentBarCount: row.currentBarCount, priorBarCount: row.priorBarCount,
        advancingCount: row.advancingCount, decliningCount: row.decliningCount, unchangedCount: row.unchangedCount,
        directionalCount: row.directionalCount, excludedCount: row.excludedCount,
        advanceShare: row.advanceShare, netBreadth: row.netBreadth, dataThroughAt: session.closeAt,
        canonicalInputHash: row.canonicalInputHash,
        evidenceJson: json({ source: 'HISTORICAL_BOOTSTRAP_ARTIFACT', canonicalArtifactHash: artifact.canonicalArtifactHash, provenance: row.provenance }),
        startedAt: now, completedAt: now,
      };
    });
    await tx.marketBreadthObservation.createMany({ data });
    await tx.systemEvent.create({ data: { type: 'breadth_bootstrap_imported', entityType: 'market_breadth_observation', entityId: 'bootstrap', severity: 'INFO', message: `BREADTH_V1 bootstrap import inserted ${data.length} observation(s).`, payloadJson: { inserted: data.length, skipped: existingMatches.length, from: artifact.from, through: artifact.through, canonicalArtifactHash: artifact.canonicalArtifactHash } } });
    return { inserted: data.length, skipped: existingMatches.length, conflicts: [] };
  }, { timeout: 120_000, maxWait: 5_000 }));
}
