import { createHash, randomBytes } from 'node:crypto';
import { Prisma } from '@prisma/client';
import type { z } from 'zod';
import { prisma } from '../db/prisma.js';
import { encryptSecret, decryptSecret } from './trading-credential-crypto.service.js';
import { HttpError } from '../errors/http-error.js';
import { createSystemEvent } from './system-event.service.js';
import type {
  createExternalSignalSourceSchema, updateExternalSignalSourceSchema,
  createStrategySignalBindingSchema, updateStrategySignalBindingSchema,
} from '../validators/external-signal.schema.js';

export const externalSignalSourceSelect = {
  id: true, name: true, provider: true, enabled: true, authMethod: true,
  createdAt: true, updatedAt: true,
} satisfies Prisma.ExternalSignalSourceSelect;

export function hashWebhookKey(webhookKey: string) {
  return createHash('sha256').update(webhookKey).digest('hex');
}

export async function audit(db: Prisma.TransactionClient, type: string, entityType: string,
  entityId: number, actorUserId: number, payloadJson: Prisma.InputJsonValue) {
  return createSystemEvent({ type, entityType, entityId,
    actorUserId: actorUserId > 0 ? actorUserId : null, payloadJson }, db);
}

export async function createExternalSignalSource(
  input: z.infer<typeof createExternalSignalSourceSchema>, actorUserId: number,
) {
  const webhookKey = randomBytes(32).toString('base64url');
  const source = await prisma.$transaction(async db => {
    const created = await db.externalSignalSource.create({
      data: { ...input, enabled: input.enabled ?? true, webhookKeyHash: hashWebhookKey(webhookKey), webhookKeyCiphertext: encryptSecret(webhookKey) }, select: externalSignalSourceSelect,
    });
    await audit(db, 'external_signal_source_created', 'external_signal_source', created.id,
      actorUserId, { provider: created.provider, enabled: created.enabled });
    return created;
  });
  return source;
}

export async function updateExternalSignalSource(id: number,
  input: z.infer<typeof updateExternalSignalSourceSchema>, actorUserId: number) {
  return prisma.$transaction(async db => {
    const source = await db.externalSignalSource.update({ where: { id }, data: {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
    },
      select: externalSignalSourceSelect });
    await audit(db, 'external_signal_source_updated', 'external_signal_source', id, actorUserId, input);
    return source;
  });
}

export async function regenerateExternalSignalWebhook(id: number, actorUserId: number, client = prisma) {
  const webhookKey = randomBytes(32).toString('base64url');
  const source = await client.$transaction(async db => {
    const updated = await db.externalSignalSource.update({ where: { id },
      data: { webhookKeyHash: hashWebhookKey(webhookKey), webhookKeyCiphertext: encryptSecret(webhookKey) }, select: externalSignalSourceSelect });
    await audit(db, 'external_signal_source_webhook_regenerated', 'external_signal_source', id,
      actorUserId, {});
    return updated;
  });
  return source;
}

export async function createStrategySignalBinding(
  input: z.infer<typeof createStrategySignalBindingSchema>, actorUserId: number, client = prisma,
) {
  return client.$transaction(async db => {
    const [source, strategy] = await Promise.all([
      db.externalSignalSource.findUnique({ where: { id: input.signalSourceId }, select: { id: true } }),
      db.strategy.findUnique({ where: { id: input.strategyId }, select: { id: true } }),
    ]);
    if (!source || !strategy) throw new HttpError(400, 'Source and Strategy must already exist.');
    const binding = await db.strategySignalBinding.create({ data: { ...input, enabled: input.enabled ?? true,
      revisions: { create: { revision: 1, status: 'ACTIVE', activatedAt: new Date() } },
    }, include: bindingRevisionInclude });
    await audit(db, 'strategy_signal_binding_created', 'strategy_signal_binding', binding.id,
      actorUserId, input);
    return binding;
  });
}

export async function updateStrategySignalBinding(id: number,
  input: z.infer<typeof updateStrategySignalBindingSchema>, actorUserId: number) {
  return prisma.$transaction(async db => {
    const binding = await db.strategySignalBinding.update({ where: { id }, data: {
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
    }, include: bindingRevisionInclude });
    await audit(db, 'strategy_signal_binding_updated', 'strategy_signal_binding', id, actorUserId, input);
    return binding;
  });
}

// Only current deployment state accompanies normal binding reads; full history has its own API.
export const bindingRevisionInclude = {
  revisions: { where: { status: { in: ['ACTIVE', 'PREPARED'] } }, orderBy: { revision: 'desc' } },
} satisfies Prisma.StrategySignalBindingInclude;

// Dedicated owner endpoint only. Never include this value in ordinary source DTOs.
// Row locking makes first retrieval/provisioning and regeneration stable under races.
export async function getExternalSignalWebhook(id: number, actorUserId: number, client = prisma) {
  return client.$transaction(async db => {
    await db.$queryRaw`SELECT id FROM "ExternalSignalSource" WHERE id = ${id} FOR UPDATE`;
    const source = await db.externalSignalSource.findUnique({ where: { id } });
    if (!source) throw new HttpError(404, 'Source not found.');
    if (source.webhookKeyCiphertext) return { webhookKey: decryptSecret(source.webhookKeyCiphertext) };
    const webhookKey = randomBytes(32).toString('base64url');
    await db.externalSignalSource.update({ where: { id }, data: {
      webhookKeyHash: hashWebhookKey(webhookKey), webhookKeyCiphertext: encryptSecret(webhookKey),
    } });
    await audit(db, 'external_signal_source_webhook_provisioned', 'external_signal_source', id, actorUserId, {});
    return { webhookKey };
  });
}
