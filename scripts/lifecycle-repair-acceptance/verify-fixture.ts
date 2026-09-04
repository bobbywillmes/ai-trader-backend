import { assertLifecycleRepairAcceptanceEnvironment } from './guard.js';
import { installMockAlpacaTransport } from '../manual-acceptance/mock-alpaca-transport.js';
import { MANUAL_ACCEPTANCE_SENTINEL } from '../../src/services/manual-acceptance-environment.js';

assertLifecycleRepairAcceptanceEnvironment();
process.env.MANUAL_ACCEPTANCE_HARNESS = MANUAL_ACCEPTANCE_SENTINEL;
installMockAlpacaTransport();

const [{ prisma }, { previewHistoricalEntryLifecycleRepair }] = await Promise.all([
  import('../../src/db/prisma.js'),
  import('../../src/services/historical-entry-lifecycle-workbench.service.js'),
]);
const attention = await prisma.operationalAttention.findFirst({ where: { code: 'HISTORICAL_ENTRY_LIFECYCLE_INCOMPLETE' }, orderBy: { id: 'desc' } });
const owner = await prisma.user.findFirst({ where: { platformRole: 'SYSTEM_OWNER', email: { endsWith: '@example.invalid' } }, orderBy: { id: 'desc' } });
if (!attention || !owner) throw new Error('Synthetic lifecycle fixture was not seeded.');
const repairCase = await previewHistoricalEntryLifecycleRepair({ attentionId: attention.id, actorUserId: owner.id });
const repeated = await previewHistoricalEntryLifecycleRepair({ attentionId: attention.id, actorUserId: owner.id });
if (repeated.id !== repairCase.id) throw new Error('Current unchanged preview was not idempotent.');
const types = new Set(repairCase.actions.map((action) => action.actionType));
if (!types.has('TERMINALIZE_ORDER_LIFECYCLE') || !types.has('LINK_ENTRY_LIFECYCLE_TO_POSITION')) {
  throw new Error(`Expected independent terminalization and link proposals; received ${[...types].join(', ') || 'none'}.`);
}
await prisma.lifecycleRepairCase.update({ where: { id: repairCase.id }, data: { expiresAt: new Date(Date.now() - 1_000) } });
const renewed = await previewHistoricalEntryLifecycleRepair({ attentionId: attention.id, actorUserId: owner.id });
if (renewed.id === repairCase.id || renewed.generation !== repairCase.generation + 1 || renewed.supersedesCaseId !== repairCase.id) throw new Error('Expired preview did not create immutable superseding generation.');
console.log(JSON.stringify({ attentionId: attention.id, caseId: repairCase.id, renewedCaseId: renewed.id, generation: renewed.generation, actionTypes: [...types] }, null, 2));
await prisma.$disconnect();
