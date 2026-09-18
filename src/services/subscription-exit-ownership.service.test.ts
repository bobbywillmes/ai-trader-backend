import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ findUnique: vi.fn(), update: vi.fn(), create: vi.fn(), audit: vi.fn() }));
vi.mock('../db/prisma.js', () => ({ prisma: { subscription: { findUnique: mocks.findUnique, update: mocks.update, create: mocks.create },
  strategy: { findUnique: vi.fn().mockResolvedValue({ id: 1 }) }, exitProfile: { findUnique: vi.fn().mockResolvedValue({ id: 2 }) },
  security: { findUnique: vi.fn().mockResolvedValue({ id: 3 }) } } }));
vi.mock('./admin-audit.service.js', async importOriginal => ({ ...await importOriginal<typeof import('./admin-audit.service.js')>(), createAdminAuditEvent: mocks.audit }));
import { createSubscription, updateSubscription } from './subscription.service.js';
beforeEach(() => vi.clearAllMocks());
it('defaults new subscriptions to backend ownership', async () => {
  mocks.create.mockImplementation(async ({ data }) => ({ id: 1, ...data, accountSubscriptions: [] }));
  expect(await createSubscription({ key: 'test', name: 'Test', symbol: 'QQQ', strategyId: 1, exitProfileId: 2 })).toMatchObject({ exitManagementMode: 'BACKEND_MANAGED' });
});
it('audits an operator ownership change with before/after evidence', async () => {
  const current = { id: 1, key: 'test', exitManagementMode: 'BACKEND_MANAGED' };
  mocks.findUnique.mockResolvedValue(current);
  mocks.update.mockResolvedValue({ ...current, exitManagementMode: 'EXTERNAL_SIGNAL' });
  await updateSubscription(1, { exitManagementMode: 'EXTERNAL_SIGNAL' });
  expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({ data: { exitManagementMode: 'EXTERNAL_SIGNAL' } }));
  expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'subscription_updated', payload: expect.objectContaining({
    changedFields: ['exitManagementMode'], before: expect.objectContaining({ exitManagementMode: 'BACKEND_MANAGED' }),
    after: expect.objectContaining({ exitManagementMode: 'EXTERNAL_SIGNAL' }),
  }) }));
});
