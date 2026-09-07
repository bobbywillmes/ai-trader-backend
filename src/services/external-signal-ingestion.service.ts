import { Prisma, type ExternalSignalSource } from '@prisma/client';
import { prisma } from '../db/prisma.js';
import { hashWebhookToken } from './external-signal-config.service.js';
import { createSystemEvent } from './system-event.service.js';
import { hashCanonicalPayload, inspectSignalEvidence, normalizeSignalEnvelope, SignalRejection } from './external-signal-normalization.js';

export type SignalRequestEvidence = {
  requestId: string; receivedAt: Date; contentType: string | null;
  bodySizeBytes: number; rawPayloadHash: string; body: Buffer;
  tooLarge: boolean; validContentType: boolean;
};
type SignalDb = Pick<typeof prisma, '$transaction' | 'externalSignalSource'>;

export async function authenticateExternalSignal(token: string, db: SignalDb = prisma) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  return db.externalSignalSource.findUnique({ where: { webhookTokenHash: hashWebhookToken(token) } });
}

export async function ingestExternalSignal(source: ExternalSignalSource, token: string,
  evidence: SignalRequestEvidence, db: SignalDb = prisma) {
  let payload: unknown;
  let rawPayloadRedacted: Prisma.InputJsonValue = { omitted: 'unparseable_or_oversized_body' };
  let preflightRejection: SignalRejection | undefined;
  if (evidence.tooLarge) preflightRejection = new SignalRejection('PAYLOAD_TOO_LARGE');
  else if (!evidence.validContentType) preflightRejection = new SignalRejection('INVALID_CONTENT_TYPE');
  else {
    try {
      payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(evidence.body));
      const inspection = inspectSignalEvidence(payload, [token, source.webhookTokenHash]);
      rawPayloadRedacted = inspection.redacted ?? { value: null };
      if (inspection.sensitive || inspection.tooDeep) {
        preflightRejection = new SignalRejection('INVALID_ENVELOPE', {
          reason: inspection.tooDeep ? 'nesting_limit' : 'credentials_not_allowed',
        });
      }
    } catch {
      preflightRejection = new SignalRejection('INVALID_JSON');
    }
  }
  const deliveryBase = {
    signalSourceId: source.id, requestId: evidence.requestId, receivedAt: evidence.receivedAt,
    contentType: evidence.contentType, bodySizeBytes: evidence.bodySizeBytes,
    rawPayloadHash: evidence.rawPayloadHash, rawPayloadRedacted,
  };

  const persist = () => db.$transaction(async tx => {
    const reject = (rejection: SignalRejection) => tx.signalDelivery.create({ data: {
      ...deliveryBase, processedAt: new Date(), status: 'REJECTED',
      rejectionCode: rejection.code, rejectionDetails: rejection.details,
    } });
    // Recheck configuration after the body has arrived. Rotation invalidates an
    // in-flight credential; disabling a source or binding applies prospectively.
    const currentSource = await tx.externalSignalSource.findUnique({ where: { id: source.id } });
    if (!currentSource || currentSource.webhookTokenHash !== hashWebhookToken(token)) return null;
    if (!currentSource.enabled) return reject(new SignalRejection('SOURCE_DISABLED'));
    if (preflightRejection) return reject(preflightRejection);

    try {
      const normalized = normalizeSignalEnvelope(payload, evidence.receivedAt);
      const binding = await tx.strategySignalBinding.findUnique({ where: {
        signalSourceId_externalStrategyKey: { signalSourceId: source.id, externalStrategyKey: normalized.externalStrategyKey },
      } });
      if (!binding) throw new SignalRejection('UNKNOWN_STRATEGY_BINDING');
      if (!binding.enabled) throw new SignalRejection('STRATEGY_BINDING_DISABLED');
      if (binding.expectedRevision !== normalized.strategyRevision) throw new SignalRejection('STRATEGY_REVISION_MISMATCH');
      const security = await tx.security.findUnique({ where: { symbol: normalized.symbol }, select: { id: true, symbol: true } });
      if (!security) throw new SignalRejection('UNKNOWN_SYMBOL');
      const content = {
        signalSourceId: source.id, strategySignalBindingId: binding.id, strategyId: binding.strategyId,
        securityId: security.id, symbol: security.symbol, schemaVersion: normalized.schemaVersion,
        externalEventKey: normalized.eventKey, strategyRevision: normalized.strategyRevision,
        event: normalized.event, timeframe: normalized.timeframe,
        signalTime: normalized.signalTime.toISOString(), barTime: normalized.barTime?.toISOString() ?? null,
        metadata: normalized.metadata ?? null,
      };
      const canonicalPayloadHash = hashCanonicalPayload(content);
      const existing = await tx.signal.findUnique({ where: {
        signalSourceId_externalEventKey: { signalSourceId: source.id, externalEventKey: normalized.eventKey },
      } });
      if (existing) {
        if (existing.canonicalPayloadHash !== canonicalPayloadHash) {
          const delivery = await reject(new SignalRejection('EVENT_KEY_CONFLICT'));
          await createSystemEvent({ type: 'external_signal_event_key_conflict', entityType: 'signal_delivery',
            entityId: delivery.id, severity: 'WARNING', payloadJson: {
              signalSourceId: source.id, existingSignalId: existing.id, deliveryId: delivery.id,
            } }, tx);
          return delivery;
        }
        return tx.signalDelivery.create({ data: { ...deliveryBase, processedAt: new Date(), status: 'DUPLICATE', signalId: existing.id } });
      }
      const signal = await tx.signal.create({ data: {
        ...content, signalTime: normalized.signalTime, barTime: normalized.barTime,
        metadata: normalized.metadata as Prisma.InputJsonObject | undefined ?? Prisma.DbNull,
        canonicalPayloadHash,
      } });
      return tx.signalDelivery.create({ data: { ...deliveryBase, processedAt: new Date(), status: 'NORMALIZED', signalId: signal.id } });
    } catch (error) {
      if (error instanceof SignalRejection) return reject(error);
      throw error;
    }
  });

  try {
    return await persist();
  } catch (error) {
    // A competing create can win after our lookup. The losing transaction rolls
    // back in full; a fresh transaction then compares the committed content.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return persist();
    throw error;
  }
}
