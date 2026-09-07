import type { Server } from 'node:http';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ authenticate: vi.fn(), ingest: vi.fn(), event: vi.fn(), logs: [] as string[] }));
vi.mock('../services/external-signal-ingestion.service.js', () => ({
  authenticateExternalSignal: mocks.authenticate, ingestExternalSignal: mocks.ingest,
}));
vi.mock('../services/system-event.service.js', async importOriginal => ({
  ...await importOriginal<object>(), createSystemEvent: mocks.event,
}));
vi.mock('../config/logger.js', async () => {
  const { default: pino } = await import('pino');
  return { logger: pino({ level: 'trace' }, { write: (line: string) => { mocks.logs.push(line); } }) };
});
import { createApp } from '../app/app.js';
import { MAX_SIGNAL_BODY_BYTES } from '../services/external-signal-normalization.js';
import { redactSensitiveRequestUrl } from '../middleware/redact-request-url.js';

describe('public external signal HTTP boundary', () => {
  let server: Server;
  let baseUrl: string;
  const token = 'c'.repeat(43);
  beforeEach(async () => {
    vi.clearAllMocks(); mocks.logs.length = 0;
    mocks.authenticate.mockResolvedValue({ id: 1 });
    mocks.ingest.mockResolvedValue({ status: 'NORMALIZED' });
    server = createApp().listen(0);
    await new Promise<void>(resolve => server.once('listening', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No TCP address');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });
  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  function post(body: string, headers: Record<string, string> = { 'content-type': 'application/json' }) {
    return fetch(`${baseUrl}/api/external-signals/${token}`, { method: 'POST', headers, body });
  }
  it('bypasses global JSON parsing and captures exact malformed bytes', async () => {
    mocks.ingest.mockResolvedValue({ status: 'REJECTED', rejectionCode: 'INVALID_JSON' });
    const body = '{ "broken" : ';
    const response = await post(body);
    expect(response.status).toBe(400);
    const evidence = mocks.ingest.mock.calls[0]![2];
    expect(evidence.body.toString()).toBe(body);
    expect(evidence.rawPayloadHash).toBe(createHash('sha256').update(body).digest('hex'));
    expect(evidence.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(await response.json()).not.toHaveProperty('rejectionCode');
  });
  it('returns 413 for oversized input while hashing all bytes and retaining none', async () => {
    mocks.ingest.mockResolvedValue({ status: 'REJECTED', rejectionCode: 'PAYLOAD_TOO_LARGE' });
    const body = 'x'.repeat(MAX_SIGNAL_BODY_BYTES + 1000);
    const response = await post(body);
    expect(response.status).toBe(413);
    const evidence = mocks.ingest.mock.calls[0]![2];
    expect(evidence.tooLarge).toBe(true); expect(evidence.body.length).toBe(0);
    expect(evidence.bodySizeBytes).toBe(Buffer.byteLength(body));
    expect(evidence.rawPayloadHash).toBe(createHash('sha256').update(body).digest('hex'));
  });
  it('rejects unknown tokens without invoking evidence ingestion', async () => {
    mocks.authenticate.mockResolvedValue(null);
    expect((await post('{}')).status).toBe(401);
    expect(mocks.ingest).not.toHaveBeenCalled(); expect(mocks.event).not.toHaveBeenCalled();
  });
  it.each(['text/plain', 'application/json; charset=latin1', 'application/json; secret=credential'])('does not accept %s', async contentType => {
    await post('{}', { 'content-type': contentType });
    expect(mocks.ingest.mock.calls[0]![2].validContentType).toBe(false);
    expect(String(mocks.ingest.mock.calls[0]![2].contentType)).not.toContain('credential');
  });
  it('suppresses credentials in application request logs, extra paths, and query strings', async () => {
    await post('{}', { 'content-type': 'application/json', authorization: `Bearer ${token}` });
    const response = await fetch(`${baseUrl}/API/EXTERNAL-SIGNALS/${token}/extra?token=${token}`);
    expect(response.status).toBe(404);
    expect(JSON.stringify(await response.json())).not.toContain(token);
    expect(mocks.logs.join('')).not.toContain(token);
    expect(mocks.logs.join('')).toContain('/api/external-signals/[redacted]');
  });
  it('keeps processing errors private and emits a sanitized failure event', async () => {
    mocks.ingest.mockRejectedValue(new Error(`Database error with ${token}`));
    const response = await post('{}');
    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toContain(token);
    expect(mocks.logs.join('')).not.toContain(token);
    expect(JSON.stringify(mocks.event.mock.calls)).not.toContain(token);
    expect(mocks.event.mock.calls[0]![0].type).toBe('external_signal_processing_failed');
  });
  it('handles malformed percent encoding without forwarding credential-bearing errors', async () => {
    const response = await fetch(`${baseUrl}/api/external-signals/${token}%ZZ`);
    expect(response.status).toBe(400);
    expect(mocks.logs.join('')).not.toContain(token);
    expect(redactSensitiveRequestUrl(`/api/external-signals/${token}%ZZ`)).not.toContain(token);
  });
});
