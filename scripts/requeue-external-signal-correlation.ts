import 'dotenv/config';
import { prisma } from '../src/db/prisma.js';
import { requeueFailedExternalSignalCorrelationWork } from '../src/services/external-signal-correlation.service.js';

const workId = Number(process.argv[2]);
const actorUserId = Number(process.argv[3]);
if (!Number.isInteger(workId) || workId <= 0 || !Number.isInteger(actorUserId) || actorUserId <= 0) {
  throw new Error('Usage: npm run external-signals:requeue-correlation -- <workId> <systemOwnerUserId>');
}
try {
  const result = await requeueFailedExternalSignalCorrelationWork({ workId, actorUserId });
  process.stdout.write(JSON.stringify({ workId: result.id, signalId: result.signalId, status: result.status }) + '\n');
} finally {
  await prisma.$disconnect();
}
