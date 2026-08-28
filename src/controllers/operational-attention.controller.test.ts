import { OperationalAttentionStatus } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { parseOperationalAttentionStatuses } from './operational-attention.controller.js';

describe('OperationalAttention status query parsing', () => {
  it('uses unresolved defaults when status is omitted', () => expect(parseOperationalAttentionStatuses(undefined)).toBeUndefined());
  it('maps all to one explicit three-status server filter', () => expect(parseOperationalAttentionStatuses('all')).toEqual(Object.values(OperationalAttentionStatus)));
  it.each(Object.values(OperationalAttentionStatus))('accepts %s', (status) => expect(parseOperationalAttentionStatuses(status)).toEqual([status]));
  it('accepts the canonical unresolved pair', () => expect(parseOperationalAttentionStatuses('OPEN,ACKNOWLEDGED')).toEqual(['OPEN', 'ACKNOWLEDGED']));
  it('rejects invalid status input', () => expect(() => parseOperationalAttentionStatuses('unread')).toThrow('Invalid filter value.'));
});
