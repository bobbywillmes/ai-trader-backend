import { createHash } from 'node:crypto';
import { SignalDeliveryRejectionCode, type Prisma } from '@prisma/client';
import { externalSignalEnvelopeSchema } from '../validators/external-signal.schema.js';

export const MAX_SIGNAL_BODY_BYTES = 64 * 1024;
const secretKey = /^auth$|authorization|authentication|password|passwd|secret|token|apikey|accesskey|credential|cookie|privatekey|signature/i;
const secretValue = /\b(?:Bearer|Basic)\s+\S+|\/api\/external-signals\/[^\s"?#]+|https?:\/\/[^/\s]*@|[?&](?:token|api[_-]?key|secret|password)=/i;
const timeframeAliases: Record<string, string> = {
  '1m': '1m', '5m': '5m', '15m': '15m', '30m': '30m', '1h': '1h', '4h': '4h', '1d': '1d', '1w': '1w',
  '1 minute': '1m', '5 minutes': '5m', '15 minutes': '15m', '30 minutes': '30m',
  '60m': '1h', '1 hour': '1h', '4 hours': '4h', '240m': '4h', '1 day': '1d', '1 week': '1w',
};

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function hashCanonicalPayload(value: unknown) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

// Bounded recursive traversal before Zod's recursive JSON validator. Never retain
// malformed text; parseable evidence is recursively scrubbed, including key names.
export function inspectSignalEvidence(value: unknown, credentials: readonly string[], depth = 0): {
  redacted: Prisma.InputJsonValue | null; sensitive: boolean; tooDeep: boolean;
} {
  const sensitiveText = (text: string) => secretValue.test(text) || credentials.some(secret => text.includes(secret));
  if (depth > 16) return { redacted: '[depth limit]', sensitive: false, tooDeep: true };
  if (typeof value === 'string') return {
    redacted: sensitiveText(value) ? '[redacted]' : value,
    sensitive: sensitiveText(value), tooDeep: false,
  };
  if (value === null || typeof value === 'number' || typeof value === 'boolean') {
    return { redacted: value, sensitive: false, tooDeep: false };
  }
  const result: Record<string, Prisma.InputJsonValue | null> = Object.create(null);
  const array: (Prisma.InputJsonValue | null)[] = [];
  let sensitive = false;
  let tooDeep = false;
  for (const [key, child] of Object.entries(value as object)) {
    const hidden = secretKey.test(key.replace(/[^a-z]/gi, '')) || sensitiveText(key);
    const inspected = hidden ? { redacted: '[redacted]', sensitive: true, tooDeep: false }
      : inspectSignalEvidence(child, credentials, depth + 1);
    sensitive ||= inspected.sensitive;
    tooDeep ||= inspected.tooDeep;
    if (Array.isArray(value)) array.push(inspected.redacted);
    else result[sensitiveText(key) ? '[redacted key]' : key] = inspected.redacted;
  }
  return { redacted: Array.isArray(value) ? array : result, sensitive, tooDeep };
}

export class SignalRejection extends Error {
  constructor(public code: SignalDeliveryRejectionCode,
    public details: Prisma.InputJsonValue | null = null) { super(code); }
}

export function normalizeSignalEnvelope(value: unknown, receivedAt: Date) {
  const result = externalSignalEnvelopeSchema.safeParse(value);
  if (!result.success) {
    const fields = result.error.issues.map(issue => String(issue.path[0] ?? 'envelope'));
    const code = fields.includes('schemaVersion') && value !== null && typeof value === 'object'
      && 'schemaVersion' in value && value.schemaVersion !== 1 ? 'UNSUPPORTED_SCHEMA_VERSION'
      : fields.includes('event') ? 'INVALID_EVENT'
      : fields.includes('timeframe') ? 'INVALID_TIMEFRAME'
      : fields.some(field => field === 'signalTime' || field === 'barTime') ? 'INVALID_TIMESTAMP'
      : 'INVALID_ENVELOPE';
    // Only schema-owned field names and diagnostic codes: never reflect values,
    // unknown keys, nested metadata paths, or parser messages into these details.
    throw new SignalRejection(code, {
      fields: [...new Set(fields)],
      issues: result.error.issues.map(issue => ({ field: String(issue.path[0] ?? 'envelope'), code: issue.code })),
      ...(code === 'INVALID_EVENT' ? { allowedEvents: ['ENTRY_LONG', 'EXIT_LONG'] } : {}),
      ...(code === 'UNSUPPORTED_SCHEMA_VERSION' ? { supportedSchemaVersions: [1] } : {}),
    });
  }
  const input = result.data;
  const timeframe = Object.hasOwn(timeframeAliases, input.timeframe) ? timeframeAliases[input.timeframe] : undefined;
  if (!timeframe) throw new SignalRejection('INVALID_TIMEFRAME', {
    fields: ['timeframe'], reason: 'unsupported_timeframe',
    canonicalTimeframes: ['1m', '5m', '15m', '30m', '1h', '4h', '1d', '1w'],
  });
  const signalTime = new Date(input.signalTime);
  const barTime = input.barTime ? new Date(input.barTime) : null;
  // A bounded allowance for sender clock skew, not a trading staleness policy.
  if (signalTime.getTime() > receivedAt.getTime() + 5 * 60 * 1000) {
    throw new SignalRejection('INVALID_TIMESTAMP', { fields: ['signalTime'], reason: 'signal_time_in_future', allowedClockSkewSeconds: 300 });
  }
  if (barTime && barTime > signalTime) throw new SignalRejection('INVALID_TIMESTAMP', { fields: ['barTime'], reason: 'bar_time_after_signal_time' });
  return { ...input, timeframe, signalTime, barTime };
}
