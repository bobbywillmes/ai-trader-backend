import { createHash, randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import { authenticateExternalSignal, ingestExternalSignal, type SignalRequestEvidence } from '../services/external-signal-ingestion.service.js';
import { MAX_SIGNAL_BODY_BYTES } from '../services/external-signal-normalization.js';
import { createSystemEvent } from '../services/system-event.service.js';
import { logger } from '../config/logger.js';

export async function readSignalRequest(req: Request, requestId: string, receivedAt: Date): Promise<SignalRequestEvidence> {
  const hash = createHash('sha256');
  let bodySizeBytes = 0;
  const chunks: Buffer[] = [];
  const deadline = setTimeout(() => req.destroy(), 10000);
  try {
    for await (const chunk of req) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bodySizeBytes += bytes.length;
      if (bodySizeBytes > 2147483647) throw new Error('Body exceeds evidence size range.');
      hash.update(bytes);
      if (bodySizeBytes <= MAX_SIGNAL_BODY_BYTES) chunks.push(bytes);
      else chunks.length = 0;
    }
  } finally { clearTimeout(deadline); }
  // Store only the normalized media type, never attacker-supplied parameters.
  const mediaType = (req.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase();
  const validContentType = mediaType === 'application/json'
    && /^(?:application\/json)(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?\s*$/i.test(req.headers['content-type'] ?? '')
    && (!req.headers['content-encoding'] || req.headers['content-encoding'] === 'identity');
  return { requestId, receivedAt, bodySizeBytes, rawPayloadHash: hash.digest('hex'),
    body: Buffer.concat(chunks), tooLarge: bodySizeBytes > MAX_SIGNAL_BODY_BYTES,
    validContentType, contentType: mediaType === 'application/json' ? 'application/json' : null };
}

export async function externalSignalIngressController(req: Request, res: Response) {
  const receivedAt = new Date();
  const requestId = randomUUID();
  res.setHeader('Cache-Control', 'no-store');
  let sourceId: number | null = null;
  try {
    const webhookKey = String(req.params.webhookKey ?? '');
    const source = await authenticateExternalSignal(webhookKey);
    if (!source) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    sourceId = source.id;
    const evidence = await readSignalRequest(req, requestId, receivedAt);
    const delivery = await ingestExternalSignal(source, webhookKey, evidence);
    if (!delivery) { res.status(401).json({ error: 'Unauthorized' }); return; }
    if (delivery.status === 'REJECTED') {
      res.status(delivery.rejectionCode === 'PAYLOAD_TOO_LARGE' ? 413 : 400).json({ error: 'Signal rejected', requestId });
      return;
    }
    res.status(delivery.status === 'NORMALIZED' ? 201 : 200).json({ status: delivery.status, requestId });
  } catch {
    // Never forward raw parser/Prisma errors to the shared handler: they can
    // contain attacker-supplied credentials, JSON fragments or request URLs.
    logger.error({ requestId, signalSourceId: sourceId }, 'External signal processing failed.');
    try {
      await createSystemEvent({ type: 'external_signal_processing_failed', entityType: 'external_signal_source',
        entityId: sourceId ?? 'unknown', severity: 'ERROR', payloadJson: { requestId, signalSourceId: sourceId } });
    } catch {
      logger.error({ requestId }, 'Could not persist external signal processing failure event.');
    }
    if (!res.headersSent && !res.destroyed) res.status(503).json({ error: 'Signal processing unavailable', requestId });
  }
}
