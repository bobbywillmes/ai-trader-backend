import 'dotenv/config';
import { prisma } from '../src/db/prisma.js';
import {
  applyEntryExposureRemediation,
  previewEntryExposureRemediation,
  requireRemediationOwner,
} from '../src/services/entry-exposure-remediation.service.js';

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
  const actor = await requireRemediationOwner(actorUserId);
  if (!apply) {
    const preview = await previewEntryExposureRemediation(claimId);
    process.stdout.write(`${JSON.stringify({ mode: 'PREVIEW', actor: { id: actor.id, email: actor.email }, ...preview }, null, 2)}\n`);
    return;
  }
  if (!confirmation) throw new Error('Release refused: --confirm must equal the fresh preview confirmationFingerprint.');
  // Apply re-runs fresh broker verification and compares the exact fingerprint before any release.
  const result = await applyEntryExposureRemediation({ claimId, actorUserId: actor.id, confirmationFingerprint: confirmation });
  process.stdout.write(`${JSON.stringify({ mode: 'APPLY', actor: { id: actor.id, email: actor.email }, ...result }, null, 2)}\n`);
  if (!result.released) throw new Error(`Release refused: ${result.reason}`);
}

main().finally(() => prisma.$disconnect());
