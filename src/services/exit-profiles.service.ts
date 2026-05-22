import { prisma } from '../db/prisma.js';
import { HttpError } from '../errors/http-error.js';
import { createAdminAuditEvent } from './admin-audit.service.js';
import type {
  CreateExitProfileInput,
  UpdateExitProfileInput
} from '../validators/algo-admin.schema.js';

export async function getExitProfiles() {
  return prisma.exitProfile.findMany({
    orderBy: { key: 'asc' }
  });
}

export async function findExitProfile(key: string) {
  const normalizedKey = key.trim().toLowerCase();

  const exitProfile = await prisma.exitProfile.findUnique({
    where: { key: normalizedKey },
  });

  return exitProfile;
}

export async function createExitProfile(input: CreateExitProfileInput) {
  return prisma.exitProfile.create({
    data: {
      key: input.key,
      name: input.name,
      ...(input.description !== undefined && { description: input.description }),
      ...(input.targetPct !== undefined && { targetPct: input.targetPct }),
      ...(input.stopLossPct !== undefined && { stopLossPct: input.stopLossPct }),
      ...(input.trailingStopPct !== undefined && { trailingStopPct: input.trailingStopPct }),
      ...(input.maxHoldDays !== undefined && { maxHoldDays: input.maxHoldDays }),
      exitMode: input.exitMode,
      takeProfitBehavior: input.takeProfitBehavior,
      enabled: input.enabled ?? true,
    },
  });
}

export async function updateExitProfile(key: string, input: UpdateExitProfileInput) {
  const normalizedKey = key.trim().toLowerCase();

  // Check if the profile exists first
  const existingProfile = await prisma.exitProfile.findUnique({
    where: { key: normalizedKey },
  });

  if (!existingProfile) {
    throw new HttpError(404, 'Exit profile not found');
  }

  if (!input) {
    throw new HttpError(400, 'No valid fields to update');
  }

  // Prevent disabling an exit profile if it is being used by an active subscription
  if (input.enabled === false) {
    const activeSubscriptions = await prisma.subscription.findMany({
      where: { exitProfileId: existingProfile.id, enabled: true },
      select: { id: true, key: true, name: true, symbol: true },
    });
    if (activeSubscriptions.length > 0) {
      const error = new HttpError(400, `Cannot disable exit profile "${normalizedKey}" — it is being used by ${activeSubscriptions.length} active subscription(s)`);
      (error as any).activeSubscriptions = activeSubscriptions;
      throw error;
    }
  }

  const exitProfile = await prisma.exitProfile.update({
    where: { key: normalizedKey },
    data: {
      ...(input.key !== undefined && { key: input.key }),
      ...(input.name !== undefined && { name: input.name }),
      ...(input.description !== undefined && { description: input.description }),
      ...(input.targetPct !== undefined && { targetPct: input.targetPct }),
      ...(input.stopLossPct !== undefined && { stopLossPct: input.stopLossPct }),
      ...(input.trailingStopPct !== undefined && { trailingStopPct: input.trailingStopPct }),
      ...(input.maxHoldDays !== undefined && { maxHoldDays: input.maxHoldDays }),
      ...(input.exitMode !== undefined && { exitMode: input.exitMode }),
      ...(input.takeProfitBehavior !== undefined && { takeProfitBehavior: input.takeProfitBehavior }),
      ...(input.enabled !== undefined && { enabled: input.enabled }),
    },
  });

  await createAdminAuditEvent({
    eventType: 'update',
    entityType: 'exitProfile',
    entityId: normalizedKey,
    message: `Updated exit profile ${normalizedKey}`,
    payload: input,
  });

  return exitProfile;
}