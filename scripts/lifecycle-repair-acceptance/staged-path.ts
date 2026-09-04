import { randomUUID } from 'node:crypto';

import { assertLifecycleRepairAcceptanceEnvironment } from './guard.js';
import { installMockAlpacaTransport, mockAlpacaState } from '../manual-acceptance/mock-alpaca-transport.js';
import { MANUAL_ACCEPTANCE_SENTINEL } from '../../src/services/manual-acceptance-environment.js';

assertLifecycleRepairAcceptanceEnvironment();
process.env.MANUAL_ACCEPTANCE_HARNESS = MANUAL_ACCEPTANCE_SENTINEL;
installMockAlpacaTransport();

const [{ prisma }, workbench, reconciliation] = await Promise.all([
  import('../../src/db/prisma.js'),
  import('../../src/services/historical-entry-lifecycle-workbench.service.js'),
  import('../../src/services/reconciliation.service.js'),
]);
const attention = await prisma.operationalAttention.findFirst({ where: { code: 'HISTORICAL_ENTRY_LIFECYCLE_INCOMPLETE' }, orderBy: { id: 'desc' } });
const owner = await prisma.user.findFirst({ where: { platformRole: 'SYSTEM_OWNER', email: { endsWith: '@example.invalid' } }, orderBy: { id: 'desc' } });
if (!attention?.brokerOrderId || !owner) throw new Error('Synthetic fixture is required.');
const original = await prisma.brokerOrder.findUniqueOrThrow({ where: { id: attention.brokerOrderId }, include: { orderIntent: true, brokerActivities: true } });
const positionId = Number((attention.detailsJson as Record<string, unknown>).candidatePositionId);
const originalPosition = await prisma.trackedPosition.findUniqueOrThrow({ where: { id: positionId } });

const first = await workbench.previewHistoricalEntryLifecycleRepair({ attentionId: attention.id, actorUserId: owner.id });
const terminal = first.actions.find((action) => action.actionType === 'TERMINALIZE_ORDER_LIFECYCLE');
if (!terminal) throw new Error('Terminalization action was not proposed.');
const approvedTerminal = await workbench.decideHistoricalLifecycleAction({ actionId: terminal.id, actorUserId: owner.id, expectedRevision: terminal.revision, decision: 'APPROVE', reason: 'Synthetic staged acceptance terminalization.' });
const terminalAttemptKey = `accept-terminal-${randomUUID()}`;
const terminalAttempts = await Promise.all([
  workbench.applyHistoricalLifecycleAction({ actionId: terminal.id, actorUserId: owner.id, expectedRevision: approvedTerminal.revision, reason: 'Synthetic staged acceptance terminalization.', confirmation: workbench.TERMINALIZE_CONFIRMATION, attemptKey: terminalAttemptKey }),
  workbench.applyHistoricalLifecycleAction({ actionId: terminal.id, actorUserId: owner.id, expectedRevision: approvedTerminal.revision, reason: 'Synthetic staged acceptance terminalization.', confirmation: workbench.TERMINALIZE_CONFIRMATION, attemptKey: terminalAttemptKey }),
]);
if (terminalAttempts[0].execution.id !== terminalAttempts[1].execution.id) throw new Error('Concurrent same-key Apply did not converge on one execution.');

await reconciliation.reconcileTradingAccount(original.tradingAccountId!, { persistEvents: true, persistAttention: true });
const terminalAfter = await prisma.lifecycleRepairAction.findUniqueOrThrow({ where: { id: terminal.id } });
const activeAfterTerminal = await prisma.operationalAttention.findUniqueOrThrow({ where: { id: attention.id } });
if (terminalAfter.status !== 'VERIFIED' || activeAfterTerminal.status === 'RESOLVED') throw new Error('Terminalization verification did not preserve link-only attention.');

const second = await workbench.previewHistoricalEntryLifecycleRepair({ attentionId: attention.id, actorUserId: owner.id });
const link = second.actions.find((action) => action.actionType === 'LINK_ENTRY_LIFECYCLE_TO_POSITION');
if (!link || second.actions.some((action) => action.actionType === 'TERMINALIZE_ORDER_LIFECYCLE')) throw new Error('Fresh preview did not offer only the remaining link action.');
const approvedLink = await workbench.decideHistoricalLifecycleAction({ actionId: link.id, actorUserId: owner.id, expectedRevision: link.revision, decision: 'APPROVE', reason: 'Synthetic staged acceptance link confirmation.' });
await workbench.applyHistoricalLifecycleAction({ actionId: link.id, actorUserId: owner.id, expectedRevision: approvedLink.revision, reason: 'Synthetic staged acceptance link confirmation.', confirmation: workbench.LINK_CONFIRMATION, attemptKey: `accept-link-${randomUUID()}` });
await reconciliation.reconcileTradingAccount(original.tradingAccountId!, { persistEvents: true, persistAttention: true });
await reconciliation.reconcileTradingAccount(original.tradingAccountId!, { persistEvents: true, persistAttention: true });

const [linkAfter, finalAttention, finalOrder, finalPosition] = await Promise.all([
  prisma.lifecycleRepairAction.findUniqueOrThrow({ where: { id: link.id } }),
  prisma.operationalAttention.findUniqueOrThrow({ where: { id: attention.id } }),
  prisma.brokerOrder.findUniqueOrThrow({ where: { id: original.id }, include: { orderIntent: true, brokerActivities: true } }),
  prisma.trackedPosition.findUniqueOrThrow({ where: { id: positionId } }),
]);
if (linkAfter.status !== 'VERIFIED' || finalAttention.status !== 'RESOLVED') throw new Error('Link verification did not resolve the lifecycle attention.');
if (JSON.stringify(originalPosition) !== JSON.stringify(finalPosition)) throw new Error('TrackedPosition financial or exposure state changed.');
if (JSON.stringify(original.rawBrokerJson) !== JSON.stringify(finalOrder.rawBrokerJson) || JSON.stringify(original.orderIntent.rawRequestJson) !== JSON.stringify(finalOrder.orderIntent.rawRequestJson)) throw new Error('Historical payload changed.');
const brokerObservation = mockAlpacaState();
if (brokerObservation.postCount !== 0 || brokerObservation.recentRequests.some((request) => request.method !== 'GET')) throw new Error('Repair acceptance attempted a broker write.');
const verifiedEvents = await prisma.systemEvent.count({ where: { type: 'lifecycle_repair.action_verified', entityType: 'lifecycleRepairAction', entityId: { in: [String(terminal.id), String(link.id)] } } });
if (verifiedEvents !== 2) throw new Error(`Expected two action verification events, received ${verifiedEvents}.`);
console.log(JSON.stringify({ firstCaseId: first.id, renewedCaseId: second.id, terminalAction: terminalAfter.status, linkAction: linkAfter.status, attention: finalAttention.status, mockedBrokerReads: brokerObservation.getCount, brokerWrites: brokerObservation.postCount }, null, 2));
await prisma.$disconnect();
