import 'dotenv/config';
import { prisma } from '../src/db/prisma.js';
import {
  previewEntryExposureClaimRemediation,
  releaseClosedAdoptedPositionClaim,
  releaseConfirmedTerminalEntryClaim,
} from '../src/services/entry-exposure-claim.service.js';

function argument(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main() {
  const claimId = Number(argument('--claim'));
  const actorUserId = Number(argument('--actor-user-id'));
  const apply = process.argv.includes('--apply');
  const confirmation = argument('--confirm');
  if (!Number.isSafeInteger(claimId) || claimId <= 0) throw new Error('--claim must be a positive integer.');
  if (!Number.isSafeInteger(actorUserId) || actorUserId <= 0) throw new Error('--actor-user-id must identify the approving SYSTEM_OWNER.');
  const actor = await prisma.user.findUnique({ where: { id: actorUserId }, select: { id: true, platformRole: true, email: true } });
  if (!actor || actor.platformRole !== 'SYSTEM_OWNER') throw new Error('Claim remediation requires an explicit SYSTEM_OWNER actor.');
  const preview = await previewEntryExposureClaimRemediation(claimId);
  process.stdout.write(`${JSON.stringify({ mode: apply ? 'APPLY' : 'PREVIEW', actor, ...preview }, null, 2)}\n`);
  if (!apply) return;
  if (!preview.eligible) throw new Error(`Release refused: ${preview.blockers.join(', ')}`);
  if (!confirmation || confirmation !== preview.confirmationFingerprint) {
    throw new Error('Release refused: --confirm must equal the fresh preview confirmationFingerprint.');
  }
  await prisma.entryExposureClaimEvent.create({
    data: {
      claimId,
      eventType: 'OPERATOR_REMEDIATION_AUTHORIZED',
      evidenceJson: {
        actorUserId: actor.id,
        actorEmail: actor.email,
        confirmationFingerprint: confirmation,
        preview,
      },
    },
  });
  const released = preview.claim.orderIntentId && preview.brokerOrder
    ? await releaseConfirmedTerminalEntryClaim({
        orderIntentId: preview.claim.orderIntentId,
        brokerStatus: preview.brokerOrder.status,
      allowUnresolved: true,
      })
    : await releaseClosedAdoptedPositionClaim({ claimId, actorUserId: actor.id });
  if (!released?.releasedAt) throw new Error('Release refused during final fresh broker lookup or locked database revalidation.');
  process.stdout.write(`${JSON.stringify({ released: true, claimId, releasedAt: released.releasedAt, releaseReason: released.releaseReason }, null, 2)}\n`);
}

main().finally(() => prisma.$disconnect());
