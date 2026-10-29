import { describe, expect, it, vi } from 'vitest';
import { classifyExternalSignalCorrelationError, terminalizeAbandonedExternalSignalCycles } from './external-signal-correlation.service.js';

describe('external signal correlation retry classification', () => {
  it.each(['40001', '40P01'])('recognizes adapter SQLSTATE %s nested in P2010 metadata', sqlState => {
    expect(classifyExternalSignalCorrelationError({ code: 'P2010', meta: {
      driverAdapterError: { cause: { originalCode: sqlState } },
    } }))
      .toEqual({ retryable: true, code: `SQLSTATE_${sqlState}` });
  });
  it('sanitizes arbitrary exception messages', () => {
    expect(classifyExternalSignalCorrelationError(new Error('password=secret payload body')))
      .toEqual({ retryable: true, code: 'UNCLASSIFIED_CORRELATION_FAILURE' });
  });
  it.each(['P2024','P1001','P1017','ECONNRESET'])('retries transient infrastructure code %s',code=>expect(classifyExternalSignalCorrelationError({code})).toEqual({retryable:true,code}));
  it.each(['40001','40P01','55P03'])('retries PostgreSQL SQLSTATE %s',sqlState=>expect(classifyExternalSignalCorrelationError({sqlState})).toEqual({retryable:true,code:`SQLSTATE_${sqlState}`}));
  it('retries Prisma initialization failures without exposing their message',()=>expect(classifyExternalSignalCorrelationError({name:'PrismaClientInitializationError',message:'password=secret'})).toEqual({retryable:true,code:'PRISMA_CLIENT_INITIALIZATION'}));
  it('makes deterministic domain violations permanent',()=>expect(classifyExternalSignalCorrelationError(new Error('INCOMPLETE_ENTRY_CORRELATION_EVIDENCE'))).toEqual({retryable:false,code:'INCOMPLETE_ENTRY_CORRELATION_EVIDENCE'}));

  it('isolates serialization conflicts to one housekeeping candidate',async()=>{
    const db={
      externalSignalTradeCycle:{findMany:vi.fn().mockResolvedValue([{id:1},{id:2}])},
      $transaction:vi.fn()
        .mockRejectedValueOnce({sqlState:'40001'})
        .mockResolvedValueOnce(true),
    } as any;
    await expect(terminalizeAbandonedExternalSignalCycles({db,limit:10,now:new Date('2026-10-29T00:00:00Z')}))
      .resolves.toEqual({examined:2,terminalized:1,serializationConflicts:1});
    expect(db.$transaction).toHaveBeenCalledTimes(2);
  });

  it('does not suppress unexpected housekeeping failures',async()=>{
    const db={
      externalSignalTradeCycle:{findMany:vi.fn().mockResolvedValue([{id:1}])},
      $transaction:vi.fn().mockRejectedValue(new Error('persistent invariant failure')),
    } as any;
    await expect(terminalizeAbandonedExternalSignalCycles({db,now:new Date('2026-10-29T00:00:00Z')}))
      .rejects.toThrow('persistent invariant failure');
  });
});
