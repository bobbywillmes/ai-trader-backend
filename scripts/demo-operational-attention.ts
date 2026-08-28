import { OperationalAttentionResolutionPolicy, SystemEventSeverity } from '@prisma/client';
import { env } from '../src/config/env.js';
import { prisma } from '../src/db/prisma.js';
import { OPERATIONAL_ATTENTION_CODES, OPERATIONAL_ATTENTION_SOURCES, openOrObserveOperationalAttention } from '../src/services/operational-attention.service.js';
import { assertDemoOperationalAttentionSafety } from '../src/services/demo-operational-attention-safety.service.js';

async function main() {
  const accountId = Number(process.argv[2]); const severity = String(process.argv[3] ?? 'WARNING').toUpperCase() as SystemEventSeverity;
  if (![SystemEventSeverity.WARNING, SystemEventSeverity.ERROR, SystemEventSeverity.CRITICAL].includes(severity)) throw new Error('Severity must be WARNING, ERROR, or CRITICAL.');
  const account = await prisma.tradingAccount.findUnique({ where: { id: accountId }, select: { id: true, displayName: true, environment: true } });
  if (!account) throw new Error(`TradingAccount ${accountId} was not found.`);
  assertDemoOperationalAttentionSafety({ nodeEnv: env.NODE_ENV, deploymentRole: env.LIVE_WRITE_DEPLOYMENT_ROLE, accountEnvironment: account.environment, accountId });
  const result = await openOrObserveOperationalAttention({ tradingAccountId: account.id, code: OPERATIONAL_ATTENTION_CODES.DEMO_OPERATIONAL_ATTENTION, source: OPERATIONAL_ATTENTION_SOURCES.DEMO, severity, title: 'Demo operational attention', message: `Safe local ${severity.toLowerCase()} demonstration for ${account.displayName}.`, details: { demo: true, accountId }, fingerprint: `account:${account.id}|demo:operational-attention`, resolutionPolicy: OperationalAttentionResolutionPolicy.MANUAL_ALLOWED });
  console.log(JSON.stringify({ id: result.attention.id, created: result.created, escalated: result.escalated, url: `/operational-attention?account=${account.id}&attention=${result.attention.id}` }, null, 2));
}
if (process.env.NODE_ENV !== 'test') main().finally(() => prisma.$disconnect());
