import { prisma } from '../db/prisma.js';
import { HttpError } from '../errors/http-error.js';
import { audit } from './external-signal-config.service.js';
import { inspectSignalEvidence } from './external-signal-normalization.js';

export async function listStrategySignalRevisions(bindingId: number, client = prisma) {
  if (!await client.strategySignalBinding.findUnique({ where: { id: bindingId }, select: { id: true } })) throw new HttpError(404, 'Binding not found.');
  return client.strategySignalRevision.findMany({ where: { strategySignalBindingId: bindingId }, orderBy: { revision: 'desc' } });
}

export async function changeStrategySignalRevision(bindingId: number, action: 'prepare' | 'activate' | 'retire',
  revisionId: number | null, changeNote: string | undefined, actorUserId: number, client = prisma) {
  return client.$transaction(async db => {
    // The same binding lock is used by ingress. Activation and acceptance have a
    // definite order, including requests already in flight when activation starts.
    await db.$queryRaw`SELECT id FROM "StrategySignalBinding" WHERE id = ${bindingId} FOR UPDATE`;
    const binding = await db.strategySignalBinding.findUnique({ where: { id: bindingId } });
    if (!binding) throw new HttpError(404, 'Binding not found.');
    const now = new Date();
    if (action === 'prepare') {
      if (await db.strategySignalRevision.findFirst({ where: { strategySignalBindingId: bindingId, status: 'PREPARED' } })) throw new HttpError(409, 'A prepared revision already exists. Activate or retire it first.');
      const latest = await db.strategySignalRevision.findFirst({ where: { strategySignalBindingId: bindingId }, orderBy: { revision: 'desc' } });
      if (!latest || latest.revision >= 2147483647) throw new HttpError(409, 'Revision sequence unavailable.');
      // Notes are descriptive only. Reject common credential material; never echo notes in audits.
      if (changeNote) {
        const source = await db.externalSignalSource.findUniqueOrThrow({ where: { id: binding.signalSourceId }, select: { webhookTokenHash: true } });
        if (inspectSignalEvidence({ changeNote }, [source.webhookTokenHash]).sensitive || /[A-Za-z0-9_-]{43,}/.test(changeNote)) throw new HttpError(400, 'Change notes must not contain credentials.');
      }
      const row = await db.strategySignalRevision.create({ data: { strategySignalBindingId: bindingId, revision: latest.revision + 1, status: 'PREPARED', changeNote: changeNote ?? null } });
      await audit(db, 'strategy_signal_revision_prepared', 'strategy_signal_revision', row.id, actorUserId, { strategySignalBindingId: bindingId, revision: row.revision });
      return row;
    }
    const selected = await db.strategySignalRevision.findFirst({ where: { id: revisionId!, strategySignalBindingId: bindingId } });
    if (!selected) throw new HttpError(404, 'Revision not found.');
    if (selected.status !== 'PREPARED') throw new HttpError(409, 'Only a prepared revision can be activated or abandoned.');
    if (action === 'activate') {
      const active = await db.strategySignalRevision.findFirst({ where: { strategySignalBindingId: bindingId, status: 'ACTIVE' } });
      if (!active) throw new HttpError(409, 'Binding has no active revision.');
      await db.strategySignalRevision.update({ where: { id: active.id }, data: { status: 'RETIRED', retiredAt: now } });
      await audit(db, 'strategy_signal_revision_retired', 'strategy_signal_revision', active.id, actorUserId, { strategySignalBindingId: bindingId, revision: active.revision });
    }
    const row = await db.strategySignalRevision.update({ where: { id: selected.id }, data: action === 'activate'
      ? { status: 'ACTIVE', activatedAt: now } : { status: 'RETIRED', retiredAt: now } });
    await db.strategySignalBinding.update({ where: { id: bindingId }, data: { updatedAt: now } });
    await audit(db, action === 'activate' ? 'strategy_signal_revision_activated' : 'strategy_signal_revision_retired', 'strategy_signal_revision', row.id, actorUserId, { strategySignalBindingId: bindingId, revision: row.revision });
    return row;
  });
}
