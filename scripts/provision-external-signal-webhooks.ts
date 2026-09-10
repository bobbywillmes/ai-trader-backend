import 'dotenv/config';
import { prisma } from '../src/db/prisma.js';
import { getExternalSignalWebhook } from '../src/services/external-signal-config.service.js';

// Idempotent post-migration provisioning. Never print identifiers or ciphertext.
try {
  const sources = await prisma.externalSignalSource.findMany({ where: { webhookKeyCiphertext: null }, select: { id: true } });
  for (const source of sources) await getExternalSignalWebhook(source.id, -1);
  console.log(`Provisioned ${sources.length} stable external source webhook URLs.`);
} catch {
  console.error('Webhook provisioning failed. Check database access and credential encryption configuration.');
  process.exitCode = 1;
} finally { await prisma.$disconnect(); }
