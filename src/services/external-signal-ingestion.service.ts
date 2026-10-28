import { Prisma, type ExternalSignalSource } from '@prisma/client';
import { prisma } from '../db/prisma.js';
import { hashWebhookKey } from './external-signal-config.service.js';
import { createSystemEvent } from './system-event.service.js';
import { routeSignalInTransaction } from './signal-routing.service.js';
import { evaluateNewSignalRoute } from './signal-evaluation.service.js';
import { processSignalMarketEligibilityRoutes } from './signal-route-market-eligibility.service.js';
import { canonicalJson, canonicalSignalPayload, hashCanonicalPayload, inspectSignalEvidence, MAX_SIGNAL_BODY_BYTES, normalizeSignalEnvelope, SignalRejection } from './external-signal-normalization.js';

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
    await tx.$queryRaw`SELECT id FROM "ExternalSignalSource" WHERE id = ${source.id} FOR UPDATE`;
    const currentSource = await tx.externalSignalSource.findUnique({ where: { id: source.id } });
    if (!currentSource || currentSource.webhookKeyHash !== hashWebhookKey(webhookKey)) return null;
    if (!currentSource.enabled) return reject(new SignalRejection('SOURCE_DISABLED', { reason: 'source_not_enabled' }));
    if (preflightRejection) return reject(preflightRejection);

    try {
      const normalized = normalizeSignalEnvelope(payload, evidence.receivedAt);
      // The parser selects v2 explicitly. Keep the exact identifiers in a
      // separately narrowed value because the legacy/v2 Zod union shares the
      // remaining envelope shape.
      const v2Identity = normalized.schemaVersion === 2
        ? normalized as typeof normalized & { externalEventId: string; externalTradeCycleRef: string }
        : null;
      const binding = await tx.strategySignalBinding.findUnique({ where: {
        signalSourceId_externalStrategyKey: { signalSourceId: source.id, externalStrategyKey: normalized.externalStrategyKey },
      } });
      if (!binding) throw new SignalRejection('UNKNOWN_STRATEGY_BINDING', { fields: ['externalStrategyKey'], reason: 'no_binding_for_source_and_key' });
      await tx.$queryRaw`SELECT id FROM "StrategySignalBinding" WHERE id = ${binding.id} FOR UPDATE`;
      const active = await tx.strategySignalRevision.findFirst({ where: { strategySignalBindingId: binding.id, status: 'ACTIVE' } });
      if (!binding.enabled) throw new SignalRejection('STRATEGY_BINDING_DISABLED', { strategySignalBindingId: binding.id, reason: 'binding_not_enabled' });
      let acceptedRevision = active;
      if (!active || active.revision !== normalized.strategyRevision) {
        const historicalCycle = v2Identity && normalized.event === 'EXIT_LONG'
          ? await tx.externalSignalTradeCycle.findUnique({ where: { strategySignalBindingId_externalTradeCycleRef: {
            strategySignalBindingId: binding.id, externalTradeCycleRef: v2Identity.externalTradeCycleRef,
          } } }) : null;
        if (!historicalCycle || historicalCycle.strategyRevision !== normalized.strategyRevision ||
          ['TERMINAL_NO_EXPOSURE', 'TERMINAL_CLOSED', 'CONFLICT'].includes(historicalCycle.status)) {
          throw new SignalRejection('STRATEGY_REVISION_MISMATCH', {
            strategySignalBindingId: binding.id, activeRevision: active?.revision ?? null, receivedRevision: normalized.strategyRevision,
          });
        }
        acceptedRevision = await tx.strategySignalRevision.findUnique({ where: { id: historicalCycle.strategySignalRevisionId } });
      }
      if (!acceptedRevision) throw new SignalRejection('STRATEGY_REVISION_MISMATCH', {
        strategySignalBindingId: binding.id, activeRevision: active?.revision ?? null, receivedRevision: normalized.strategyRevision,
      });
      const security = await tx.security.findUnique({ where: { symbol: normalized.symbol }, select: { id: true, symbol: true } });
      if (!security) throw new SignalRejection('UNKNOWN_SYMBOL', { fields: ['symbol'], reason: 'symbol_not_in_security_catalog' });
      const fingerprintIdentity = {
        signalSourceId: source.id, strategySignalBindingId: binding.id, strategySignalRevisionId: acceptedRevision.id,
        securityId: security.id, event: normalized.event, timeframe: normalized.timeframe,
        eventOccurrenceTime: (normalized.barTime ?? normalized.signalTime).toISOString(),
        ...(v2Identity ? {
          schemaVersion: 2, externalEventId: v2Identity.externalEventId,
          externalTradeCycleRef: v2Identity.externalTradeCycleRef,
        } : {}),
      };
      const eventFingerprint = hashCanonicalPayload(fingerprintIdentity);
      const content = {
        signalSourceId: source.id, strategySignalBindingId: binding.id, strategyId: binding.strategyId,
        strategySignalRevisionId: acceptedRevision.id,
        securityId: security.id, symbol: security.symbol, schemaVersion: normalized.schemaVersion,
        eventFingerprint, strategyRevision: normalized.strategyRevision,
        event: normalized.event, timeframe: normalized.timeframe,
        signalTime: normalized.signalTime.toISOString(), barTime: normalized.barTime?.toISOString() ?? null,
        metadata: normalized.metadata ?? null,
        ...(v2Identity ? {
          externalEventId: v2Identity.externalEventId,
          externalTradeCycleRef: v2Identity.externalTradeCycleRef,
        } : {}),
      };
      const incomingPayload = canonicalSignalPayload(content, binding.externalStrategyKey);
      const canonicalPayloadHash = hashCanonicalPayload(incomingPayload);
      const existing = await tx.signal.findUnique({ where: v2Identity
        ? { signalSourceId_externalEventId: { signalSourceId: source.id, externalEventId: v2Identity.externalEventId } }
        : { signalSourceId_eventFingerprint: { signalSourceId: source.id, eventFingerprint } } });
      if (existing) {
        if (v2Identity && existing.strategySignalBindingId !== binding.id) {
          const delivery = await reject(new SignalRejection('EVENT_KEY_CONFLICT', {
            externalEventId: v2Identity.externalEventId,
            existingSignalId: existing.id,
            reason: 'cross_binding_event_id_reuse',
          }));
          await createSystemEvent({ type: 'external_signal_event_fingerprint_conflict', entityType: 'signal_delivery',
            entityId: delivery.id, severity: 'WARNING', payloadJson: {
              signalSourceId: source.id, existingSignalId: existing.id, deliveryId: delivery.id,
            } }, tx);
          return delivery;
        }
        // Compare both sides through the same projection. Older immutable hashes
        // included storage fields; do not rewrite them or mix hash representations.
        const previousPayload = canonicalSignalPayload(existing, binding.externalStrategyKey);
        if (hashCanonicalPayload(previousPayload) !== canonicalPayloadHash) {
          const differingFields = (Object.keys(incomingPayload) as (keyof typeof incomingPayload)[])
            .filter(field => canonicalJson(incomingPayload[field]) !== canonicalJson(previousPayload[field]));
          const conflictCode = v2Identity ? 'EVENT_KEY_CONFLICT' : 'EVENT_FINGERPRINT_CONFLICT';
          const delivery = await reject(new SignalRejection(conflictCode, {
            ...(v2Identity ? { externalEventId: v2Identity.externalEventId } : { eventFingerprint }),
            existingSignalId: existing.id, differingFields,
            reason: v2Identity
              ? 'same_external_event_id_different_canonical_payload'
              : 'same_event_identity_different_canonical_payload',
          }));
          await createSystemEvent({ type: 'external_signal_event_fingerprint_conflict', entityType: 'signal_delivery',
            entityId: delivery.id, severity: 'WARNING', payloadJson: {
              signalSourceId: source.id, existingSignalId: existing.id, deliveryId: delivery.id,
            } }, tx);
          return delivery;
        }
        if (existing.schemaVersion !== 2) await routeSignalInTransaction(existing.id, tx);
        return tx.signalDelivery.create({ data: { ...deliveryBase, processedAt: new Date(), status: 'DUPLICATE', signalId: existing.id } });
      }
      let tradeCycle: { id: number; strategySignalBindingId: number; strategySignalRevisionId: number; strategyRevision: number; securityId: number } | null = null;
      if (v2Identity) {
        tradeCycle = await tx.externalSignalTradeCycle.findUnique({ where: {
          strategySignalBindingId_externalTradeCycleRef: {
            strategySignalBindingId: binding.id,
            externalTradeCycleRef: v2Identity.externalTradeCycleRef,
          },
        }, select: { id: true, strategySignalBindingId: true, strategySignalRevisionId: true, strategyRevision: true, securityId: true } });
        if (tradeCycle) await tx.$queryRaw`SELECT id FROM "ExternalSignalTradeCycle" WHERE id = ${tradeCycle.id} FOR UPDATE`;
        if (tradeCycle && (tradeCycle.strategySignalRevisionId !== acceptedRevision.id || tradeCycle.strategyRevision !== acceptedRevision.revision ||
          tradeCycle.securityId !== security.id)) {
          throw new SignalRejection('EVENT_KEY_CONFLICT', {
            fields: ['externalTradeCycleRef'], reason: 'same_trade_cycle_identity_different_authority',
          });
        }
        tradeCycle ??= await tx.externalSignalTradeCycle.create({ data: {
          strategySignalBindingId: binding.id, strategySignalRevisionId: acceptedRevision.id,
          strategyRevision: acceptedRevision.revision, securityId: security.id,
          externalTradeCycleRef: v2Identity.externalTradeCycleRef,
          status: normalized.event === 'ENTRY_LONG' ? 'ENTRY_RECEIVED' : 'AWAITING_ENTRY',
        }, select: { id: true, strategySignalBindingId: true, strategySignalRevisionId: true, strategyRevision: true, securityId: true } });
        if (normalized.event === 'ENTRY_LONG') {
          const originalEntry = await tx.signal.findFirst({ where: {
            externalSignalTradeCycleId: tradeCycle.id,
            event: 'ENTRY_LONG',
          }, select: { id: true, externalEventId: true } });
          if (originalEntry) {
            const delivery = await reject(new SignalRejection('EVENT_KEY_CONFLICT', {
              externalTradeCycleRef: v2Identity.externalTradeCycleRef,
              existingSignalId: originalEntry.id,
              reason: 'trade_cycle_already_has_entry',
            }));
            await createSystemEvent({ type: 'external_signal_event_fingerprint_conflict', entityType: 'signal_delivery',
              entityId: delivery.id, severity: 'WARNING', payloadJson: {
                signalSourceId: source.id, existingSignalId: originalEntry.id, deliveryId: delivery.id,
              } }, tx);
            return delivery;
          }
          await tx.externalSignalTradeCycle.updateMany({ where: { id: tradeCycle.id, status: 'AWAITING_ENTRY' }, data: { status: 'ENTRY_RECEIVED' } });
        }
      }
      const signal = await tx.signal.create({ data: {
        ...content, ...(tradeCycle ? { externalSignalTradeCycleId: tradeCycle.id } : {}),
        signalTime: normalized.signalTime, barTime: normalized.barTime,
        metadata: normalized.metadata as Prisma.InputJsonObject | undefined ?? Prisma.DbNull,
        canonicalPayloadHash,
      } });
      if (v2Identity) {
        await tx.externalSignalCorrelationWork.create({ data: { signalId: signal.id } });
      } else {
        const routing = await routeSignalInTransaction(signal.id, tx);
        for (const route of routing.routes) await evaluateNewSignalRoute(route.id, tx);
      }
      return tx.signalDelivery.create({ data: { ...deliveryBase, processedAt: new Date(), status: 'NORMALIZED', signalId: signal.id } });
    } catch (error) {
      if (error instanceof SignalRejection) {
        const delivery = await reject(error);
        if (error.code === 'EVENT_KEY_CONFLICT' && (error.details as { reason?: string } | null)?.reason === 'same_trade_cycle_identity_different_authority') {
          await createSystemEvent({ type: 'external_signal_cycle_authority_conflict', entityType: 'signal_delivery',
            entityId: delivery.id, severity: 'WARNING', payloadJson: { signalSourceId: source.id, deliveryId: delivery.id } }, tx);
        }
        return delivery;
      }
      throw error;
    }
  });

  try {
    const delivery = await persist();
    if (delivery?.signalId) await processSignalMarketEligibilityRoutes(delivery.signalId, db as typeof prisma).catch(() => undefined);
    return delivery;
  } catch (error) {
    // A competing create can win after our lookup. The losing transaction rolls
    // back in full; a fresh transaction then compares the committed content.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const delivery = await persist();
      if (delivery?.signalId) await processSignalMarketEligibilityRoutes(delivery.signalId, db as typeof prisma).catch(() => undefined);
      return delivery;
    }
    throw error;
  }
}
