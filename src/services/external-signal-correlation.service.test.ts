import { describe, expect, it } from 'vitest';
import { classifyExternalSignalCorrelationError } from './external-signal-correlation.service.js';

describe('external signal correlation retry classification', () => {
  it.each(['40001', '40P01'])('recognizes adapter SQLSTATE %s nested in P2010 metadata', sqlState => {
    expect(classifyExternalSignalCorrelationError({ code: 'P2010', meta: {
      driverAdapterError: { cause: { originalCode: sqlState } },
    } }))
      .toEqual({ retryable: true, code: `SQLSTATE_${sqlState}` });
  });
  it('sanitizes arbitrary exception messages', () => {
    expect(classifyExternalSignalCorrelationError(new Error('password=secret payload body')))
      .toEqual({ retryable: false, code: 'UNCLASSIFIED_CORRELATION_FAILURE' });
  });
});
