import {
  OperationalAttentionResolutionMethod,
  OperationalAttentionResolutionPolicy,
  OperationalAttentionStatus,
  Prisma,
  SystemEventSeverity,
} from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  attentions: [] as any[],
  events: [] as any[],
  links: [] as any[],
  nextAttentionId: 1,
  nextEventId: 1,
}));

const tx = vi.hoisted(() => ({
  tradingAccount: { findUnique: vi.fn(async ({ where }) => where.id === 2 ? { id: 2 } : null) },
  trackedPosition: { findUnique: vi.fn(async ({ where }) => where.id === 80 ? { tradingAccountId: 2 } : where.id === 81 ? { tradingAccountId: 3 } : null) },
  orderIntent: { findUnique: vi.fn(async () => null) },
  brokerOrder: { findUnique: vi.fn(async () => null) },
  operationalAttention: {
    findUnique: vi.fn(async ({ where }) => state.attentions.find((item) =>
      where.id !== undefined ? item.id === where.id : item.activeKey === where.activeKey) ?? null),
    create: vi.fn(async ({ data }) => {
      if (data.activeKey && state.attentions.some((item) => item.activeKey === data.activeKey)) {
        throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
          code: 'P2002',
          clientVersion: '7.8.0',
        });
      }
      const row = { id: state.nextAttentionId++, acknowledgedAt: null, acknowledgedByUserId: null, resolvedAt: null, resolvedByUserId: null, resolutionMethod: null, resolutionReason: null, createdAt: new Date(), updatedAt: new Date(), ...data };
      state.attentions.push(row);
      return row;
    }),
    update: vi.fn(async ({ where, data }) => {
      const row = state.attentions.find((item) => item.id === where.id);
      for (const [key, value] of Object.entries(data)) {
        row[key] = value && typeof value === 'object' && 'increment' in value ? row[key] + (value as any).increment : value;
      }
      row.updatedAt = new Date();
      return { ...row };
    }),
  },
  systemEvent: { create: vi.fn(async ({ data }) => { const row = { id: state.nextEventId++, ...data }; state.events.push(row); return row; }) },
  operationalAttentionSystemEvent: { create: vi.fn(async ({ data }) => { state.links.push(data); return data; }) },
  $queryRaw: vi.fn(async () => [{ id: 1 }]),
}));

vi.mock('../db/prisma.js', () => ({
  prisma: {
    $transaction: vi.fn(async (callback) => callback(tx)),
  },
}));
vi.mock('../config/logger.js', () => ({ logger: { trace: vi.fn() } }));
vi.mock('./trading-account.service.js', () => ({ TRADING_ACCOUNT_SUMMARY_SELECT: { id: true } }));

import {
  OPERATIONAL_ATTENTION_CODES,
  OPERATIONAL_ATTENTION_SOURCES,
  acknowledgeOperationalAttention,
  openOrObserveOperationalAttention,
  resolveOperationalAttentionAuthoritatively,
  resolveOperationalAttentionManually,
  sanitizeOperationalAttentionDetails,
} from './operational-attention.service.js';

const base = {
  tradingAccountId: 2,
  code: OPERATIONAL_ATTENTION_CODES.EXIT_QUANTITY_MISMATCH,
  source: OPERATIONAL_ATTENTION_SOURCES.EXIT_VERIFICATION,
  severity: SystemEventSeverity.WARNING,
  title: 'Exit quantity differs',
  message: 'Broker and tracked quantities differ.',
  details: { symbol: 'RSP', localQty: 4, apiSecret: 'never-store-this' },
  fingerprint: 'account:2|EXIT_QUANTITY_MISMATCH|position:80|symbol:RSP',
  resolutionPolicy: OperationalAttentionResolutionPolicy.MANUAL_ALLOWED,
  trackedPositionId: 80,
};

describe('operational attention lifecycle', () => {
  beforeEach(() => {
    state.attentions.length = 0;
    state.events.length = 0;
    state.links.length = 0;
    state.nextAttentionId = 1;
    state.nextEventId = 1;
    vi.clearAllMocks();
  });

  it('creates one active episode with sanitized immutable opening evidence', async () => {
    const result = await openOrObserveOperationalAttention(base);
    expect(result).toMatchObject({ created: true, escalated: false, attention: { status: 'OPEN', occurrenceCount: 1, activeKey: base.fingerprint } });
    expect(result.attention.detailsJson).toMatchObject({ apiSecret: '[REDACTED]' });
    expect(state.events).toHaveLength(1);
    expect(state.events[0]).toMatchObject({ type: 'operational_attention.opened', severity: 'WARNING' });
    expect(state.links[0]).toMatchObject({ operationalAttentionId: 1, systemEventId: 1, relationKind: 'OPENED' });
  });

  it('refreshes an identical observation without event spam', async () => {
    const first = await openOrObserveOperationalAttention(base);
    const observedAt = new Date('2026-08-27T12:00:00Z');
    const second = await openOrObserveOperationalAttention({ ...base, observedAt });
    expect(second.attention.id).toBe(first.attention.id);
    expect(second.attention).toMatchObject({ occurrenceCount: 2, lastObservedAt: observedAt, revision: 2 });
    expect(state.events).toHaveLength(1);
  });

  it('converges concurrent observations on one active episode', async () => {
    const [first, second] = await Promise.all([
      openOrObserveOperationalAttention(base),
      openOrObserveOperationalAttention(base),
    ]);
    expect(first.attention.id).toBe(second.attention.id);
    expect(state.attentions).toHaveLength(1);
    expect(state.attentions[0].occurrenceCount).toBe(2);
    expect(state.events).toHaveLength(1);
  });

  it('escalates but never reduces severity and links escalation evidence', async () => {
    await openOrObserveOperationalAttention(base);
    await openOrObserveOperationalAttention({ ...base, severity: SystemEventSeverity.CRITICAL });
    const reduced = await openOrObserveOperationalAttention(base);
    expect(reduced.attention.severity).toBe(SystemEventSeverity.CRITICAL);
    expect(state.events.map((event) => event.type)).toEqual(['operational_attention.opened', 'operational_attention.escalated']);
    expect(state.links[1].relationKind).toBe('ESCALATED');
  });

  it('reopens acknowledged attention when the condition materially escalates', async () => {
    const opened = await openOrObserveOperationalAttention(base);
    await acknowledgeOperationalAttention({ id: opened.attention.id, actorUserId: 7, expectedRevision: 1 });
    const escalated = await openOrObserveOperationalAttention({ ...base, severity: SystemEventSeverity.CRITICAL });
    expect(escalated.attention).toMatchObject({ status: OperationalAttentionStatus.OPEN, severity: SystemEventSeverity.CRITICAL, acknowledgedAt: null, acknowledgedByUserId: null });
  });

  it('rejects informational attention and lifecycle ownership mismatches', async () => {
    await expect(openOrObserveOperationalAttention({ ...base, severity: SystemEventSeverity.INFO } as never)).rejects.toBeDefined();
    await expect(openOrObserveOperationalAttention({ ...base, trackedPositionId: 81 })).rejects.toMatchObject({ statusCode: 409 });
  });

  it('acknowledges OPEN only, retains active identity, and rejects stale revisions', async () => {
    const opened = await openOrObserveOperationalAttention(base);
    const acknowledged = await acknowledgeOperationalAttention({ id: opened.attention.id, actorUserId: 7, expectedRevision: 1 });
    expect(acknowledged).toMatchObject({ status: 'ACKNOWLEDGED', activeKey: base.fingerprint, acknowledgedByUserId: 7, revision: 2 });
    expect(state.events.at(-1)).toMatchObject({ type: 'operational_attention.acknowledged', actorUserId: 7 });
    await expect(acknowledgeOperationalAttention({ id: opened.attention.id, actorUserId: 7, expectedRevision: 1 })).rejects.toMatchObject({ statusCode: 409 });
  });

  it('resolves authoritatively and creates a distinct recurrence', async () => {
    const opened = await openOrObserveOperationalAttention({ ...base, resolutionPolicy: OperationalAttentionResolutionPolicy.AUTHORITATIVE_ONLY });
    const resolved = await resolveOperationalAttentionAuthoritatively({ id: opened.attention.id, expectedRevision: 1, reason: 'Broker and lifecycle evidence prove no remaining exposure.', evidence: { brokerQty: 0 } });
    expect(resolved).toMatchObject({ status: 'RESOLVED', activeKey: null, resolutionMethod: OperationalAttentionResolutionMethod.AUTHORITATIVE, revision: 2 });
    const recurrence = await openOrObserveOperationalAttention(base);
    expect(recurrence.attention.id).not.toBe(opened.attention.id);
    expect(state.attentions[0].status).toBe(OperationalAttentionStatus.RESOLVED);
  });

  it('enforces manual policy, actor, reason, and terminal state', async () => {
    const authoritative = await openOrObserveOperationalAttention({ ...base, resolutionPolicy: OperationalAttentionResolutionPolicy.AUTHORITATIVE_ONLY });
    await expect(resolveOperationalAttentionManually({ id: authoritative.attention.id, expectedRevision: 1, actorUserId: 7, reason: 'Reviewed.' })).rejects.toMatchObject({ statusCode: 409 });
    state.attentions.length = 0;
    const manual = await openOrObserveOperationalAttention(base);
    await expect(resolveOperationalAttentionManually({ id: manual.attention.id, expectedRevision: 1, actorUserId: 7, reason: '   ' })).rejects.toMatchObject({ statusCode: 400 });
    const resolved = await resolveOperationalAttentionManually({ id: manual.attention.id, expectedRevision: 1, actorUserId: 7, reason: 'Operator verified external correction.' });
    expect(resolved).toMatchObject({ resolutionMethod: 'MANUAL', resolvedByUserId: 7, activeKey: null });
    expect(state.events.at(-1)?.type).toBe('operational_attention.manually_resolved');
    await expect(resolveOperationalAttentionAuthoritatively({ id: manual.attention.id, expectedRevision: 2, reason: 'Again', evidence: {} })).rejects.toMatchObject({ statusCode: 409 });
  });

  it('redacts nested sensitive keys', () => {
    expect(sanitizeOperationalAttentionDetails({ nested: { authorization: 'Bearer x', safe: 'ok' } })).toEqual({ nested: { authorization: '[REDACTED]', safe: 'ok' } });
  });
});
