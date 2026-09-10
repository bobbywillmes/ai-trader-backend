import { Prisma, type ExternalSignalSource } from '@prisma/client';
import { prisma } from '../db/prisma.js';
import { hashWebhookKey } from './external-signal-config.service.js';
import { createSystemEvent } from './system-event.service.js';
import { canonicalJson, hashCanonicalPayload, inspectSignalEvidence, MAX_SIGNAL_BODY_BYTES, normalizeSignalEnvelope, SignalRejection } from './external-signal-normalization.js';

export type SignalRequestEvidence = {
  requestId: string; receivedAt: Date; contentType: string | null;
  bodySizeBytes: number; rawPayloadHash: string; body: Buffer;
  tooLarge: boolean; validContentType: boolean;
};
type SignalDb = Pick<typeof prisma, '$transaction' | 'externalSignalSource'>;

export async function authenticateExternalSignal(webhookKey: string, db: SignalDb = prisma) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(webhookKey)) return null;
  return db.externalSignalSource.findUnique({ where: { webhookKeyHash: hashWebhookKey(webhookKey) } });
}

export async function ingestExternalSignal(source: ExternalSignalSource, webhookKey: string,
  evidence: SignalRequestEvidence, db: SignalDb = prisma) {
  let payload: unknown;
  let rawPayloadRedacted: Prisma.InputJsonValue = { omitted: 'unparseable_or_oversized_body' };
  let preflightRejection: SignalRejection | undefined;
  if (evidence.tooLarge) preflightRejection = new SignalRejection('PAYLOAD_TOO_LARGE', { bodySizeBytes: evidence.bodySizeBytes, maxBodySizeBytes: MAX_SIGNAL_BODY_BYTES });
  else if (!evidence.validContentType) preflightRejection = new SignalRejection('INVALID_CONTENT_TYPE', { requiredContentType: 'application/json', requiredCharset: 'utf-8', compressionAllowed: false });
  else {
    try {
      payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(evidence.body));
      const inspection = inspectSignalEvidence(payload, [webhookKey, source.webhookKeyHash]);
      rawPayloadRedacted = inspection.redacted ?? { value: null };
      if (inspection.sensitive || inspection.tooDeep) {
        preflightRejection = new SignalRejection('INVALID_ENVELOPE', {
          reason: inspection.tooDeep ? 'nesting_limit' : 'credentials_not_allowed',
        });
      }
    } catch {
      preflightRejection = new SignalRejection('INVALID_JSON', { reason: 'body_not_valid_utf8_json' });
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
      rejectionCode: rejection.code, rejectionDetails: rejection.details !== null &&
        (typeof rejection.details !== 'object' || Object.keys(rejection.details).length > 0)
        ? rejection.details : Prisma.DbNull,
    } });
    // Recheck configuration after the body has arrived. Rotation invalidates an
    // in-flight credential; disabling a source or binding applies prospectively.
    await tx.$queryRaw`SELECT id FROM "ExternalSignalSource" WHERE id = ${source.id} FOR SHARE`;
    const currentSource = await tx.externalSignalSource.findUnique({ where: { id: source.id } });
    if (!currentSource || currentSource.webhookKeyHash !== hashWebhookKey(webhookKey)) return null;
    if (!currentSource.enabled) return reject(new SignalRejection('SOURCE_DISABLED', { reason: 'source_not_enabled' }));
    if (preflightRejection) return reject(preflightRejection);

    try {
      const normalized = normalizeSignalEnvelope(payload, evidence.receivedAt);
      const binding = await tx.strategySignalBinding.findUnique({ where: {
        signalSourceId_externalStrategyKey: { signalSourceId: source.id, externalStrategyKey: normalized.externalStrategyKey },
      } });
      if (!binding) throw new SignalRejection('UNKNOWN_STRATEGY_BINDING', { fields: ['externalStrategyKey'], reason: 'no_binding_for_source_and_key' });
      await tx.$queryRaw`SELECT id FROM "StrategySignalBinding" WHERE id = ${binding.id} FOR UPDATE`;
      const active = await tx.strategySignalRevision.findFirst({ where: { strategySignalBindingId: binding.id, status: 'ACTIVE' } });
      if (!binding.enabled) throw new SignalRejection('STRATEGY_BINDING_DISABLED', { strategySignalBindingId: binding.id, reason: 'binding_not_enabled' });
      if (!active || active.revision !== normalized.strategyRevision) throw new SignalRejection('STRATEGY_REVISION_MISMATCH', {
        strategySignalBindingId: binding.id, activeRevision: active?.revision ?? null, receivedRevision: normalized.strategyRevision,
      });
      const security = await tx.security.findUnique({ where: { symbol: normalized.symbol }, select: { id: true, symbol: true } });
      if (!security) throw new SignalRejection('UNKNOWN_SYMBOL', { fields: ['symbol'], reason: 'symbol_not_in_security_catalog' });
      const eventFingerprint = hashCanonicalPayload({
        signalSourceId: source.id, strategySignalBindingId: binding.id, strategySignalRevisionId: active.id,
        securityId: security.id, event: normalized.event, timeframe: normalized.timeframe,
        eventOccurrenceTime: (normalized.barTime ?? normalized.signalTime).toISOString(),
      });
      const content = {
        signalSourceId: source.id, strategySignalBindingId: binding.id, strategyId: binding.strategyId,
        strategySignalRevisionId: active.id,
        securityId: security.id, symbol: security.symbol, schemaVersion: 1,
        eventFingerprint, strategyRevision: normalized.strategyRevision,
        event: normalized.event, timeframe: normalized.timeframe,
        signalTime: normalized.signalTime.toISOString(), barTime: normalized.barTime?.toISOString() ?? null,
        metadata: normalized.metadata ?? null,
      };
      const canonicalPayloadHash = hashCanonicalPayload(content);
      const existing = await tx.signal.findUnique({ where: {
        signalSourceId_eventFingerprint: { signalSourceId: source.id, eventFingerprint },
      } });
      if (existing) {
        if (existing.canonicalPayloadHash !== canonicalPayloadHash) {
          const previousContent = { ...existing, signalTime: existing.signalTime.toISOString(), barTime: existing.barTime?.toISOString() ?? null };
          const differingFields = (Object.keys(content) as (keyof typeof content)[])
            .filter(field => canonicalJson(content[field]) !== canonicalJson(previousContent[field]));
          const delivery = await reject(new SignalRejection('EVENT_FINGERPRINT_CONFLICT', {
            eventFingerprint, existingSignalId: existing.id, differingFields,
            reason: 'same_event_identity_different_canonical_payload',
          }));
          await createSystemEvent({ type: 'external_signal_event_fingerprint_conflict', entityType: 'signal_delivery',
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
