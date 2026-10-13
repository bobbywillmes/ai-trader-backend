import { describe, expect, it, vi } from 'vitest';
import { acceptanceReadOnlyGuard } from './write-guard.js';
import { acceptanceBrokerTransport } from './broker-transport.js';
describe('acceptance write guard', () => {
  it.each(['/api/orders/1/cancel','/api/subscriptions','/api/config','/api/users/1'])('denies business writes to %s', path => {
    const status=vi.fn().mockReturnThis(), json=vi.fn(); acceptanceReadOnlyGuard({method:'POST',path} as any,{status,json} as any,vi.fn()); expect(status).toHaveBeenCalledWith(405);
  });
  it.each(['POST /api/auth/login','POST /api/auth/logout'])('allows exact session endpoint %s', value => { const [method,path]=value.split(' '); const next=vi.fn(); acceptanceReadOnlyGuard({method,path} as any,{} as any,next); expect(next).toHaveBeenCalled(); });
  it('does not broadly allow auth writes', () => { const status=vi.fn().mockReturnThis(); acceptanceReadOnlyGuard({method:'POST',path:'/api/auth/change-password'} as any,{status,json:vi.fn()} as any,vi.fn()); expect(status).toHaveBeenCalledWith(405); });
  it('uses a broker transport that throws before network access', async () => { await expect(acceptanceBrokerTransport()).rejects.toThrow('BLOCKED_BEFORE_NETWORK'); });
});
