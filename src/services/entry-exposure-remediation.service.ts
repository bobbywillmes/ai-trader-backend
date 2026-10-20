import { prisma } from '../db/prisma.js';
import { HttpError } from '../errors/http-error.js';
import {
  previewEntryExposureClaimRemediation,
  releaseClosedAdoptedPositionClaim,
  releaseConfirmedTerminalEntryClaim,
} from './entry-exposure-claim.service.js';
import { DELIVERY_EVIDENCE_EVENT_TYPES } from './entry-delivery-evidence.service.js';
import {
  assessEntryClaimRelease,
  loadEntryDispatchRecords,
  releaseVerifiedEntryExposureClaim,
} from './entry-dispatch-recovery.service.js';

// Fingerprinted SYSTEM_OWNER remediation of an unreleased EntryExposureClaim. Preview is read-only;
// apply re-runs fresh broker verification, requires the exact preview fingerprint, and releases only
// through the evidence-checked release paths. It never places, cancels or requeues an order, and
// there is no force-release.

export type EntryExposureRemediationDisposition =
  | 'TERMINAL_BROKER_ORDER_NO_EXPOSURE'
  | 'CLOSED_ADOPTED_POSITION'
  | 'DISPATCHED_ENTRY_VERIFIED_NO_EXPOSURE'
  | 'NO_DISPATCH_RECORD_VERIFIED_NO_EXPOSURE'
  | 'UNSUPPORTED';

function investigationFor(assessment: Awaited<ReturnType<typeof assessEntryClaimRelease>>) {
  if (assessment.conclusiveness === 'CONCLUSIVE') return null;
  const clientOrderId = assessment.orderIntent.clientOrderId;
  return {
    conclusiveness: assessment.conclusiveness,
    claimRetained: true,
    // Absence never authorizes a release of uncertain delivery. The only positive evidence that
    // does is the exact order itself: once the stable client order ID resolves at Alpaca to a
    // terminal order whose fills are fully accounted and no position or executable BUY remains, the
    // TERMINAL_BROKER_ORDER_NO_EXPOSURE disposition releases it; a live order is managed as exposure.
    releaseRequires: assessment.conclusiveness === 'AMBIGUOUS_ABSENCE' ? 'POSITIVE_BROKER_ORDER_EVIDENCE' : 'COMPLETE_FRESH_VERIFICATION',
    guidance: assessment.conclusiveness === 'AMBIGUOUS_ABSENCE'
      ? [
          'Delivery may have reached Alpaca; absence from the exact lookup is not proof of non-delivery.',
          `Review the Alpaca order history (all statuses) and account activities for client_order_id ${clientOrderId} since ${assessment.dispatchStartedAt?.toISOString() ?? 'the entry was claimed for submission'}.`,
          'An order that appears is recovered through the TERMINAL_BROKER_ORDER_NO_EXPOSURE disposition once terminal, or managed as exposure.',
          'The claim stays UNRESOLVED; no time-based, absence-based or forced release exists, and the intent is never resubmitted.',
        ]
      : assessment.conclusiveness === 'CONTRADICTED'
        ? ['Broker or local evidence shows possible exposure for this account and Security; resolve it before any release.']
        : ['Evidence is not yet complete (settle window, outcome recording, or broker lookup); preview again later.'],
  };
}

export async function previewEntryExposureRemediation(claimId: number) {
  const base = await previewEntryExposureClaimRemediation(claimId);
  const orderIntentId = base.claim.orderIntentId;
  if (orderIntentId && !base.localOrder && !base.brokerOrder) {
    const [records, deliveryEvidenceEvents] = await Promise.all([
      loadEntryDispatchRecords(orderIntentId),
      prisma.entryExposureClaimEvent.count({ where: { claimId, eventType: { in: [...DELIVERY_EVIDENCE_EVENT_TYPES] } } }),
    ]);
    if (records.present || deliveryEvidenceEvents > 0 || base.claim.status === 'UNRESOLVED') {
      // A dispatched entry, or one with recorded delivery evidence (including a no-record UNRESOLVED
      // claim) and no broker order: release only under the delivery evidence standard, never as
      // BROKER_ORDER_NOT_ESTABLISHED or as never-submitted. Without a dispatch record the basis must
      // come from recorded structured not-sent evidence or an observed definitive rejection.
      const assessment = await assessEntryClaimRelease(orderIntentId, { operation: 'manual_admin_action' });
      return {
        disposition: assessment.disposition as EntryExposureRemediationDisposition,
        claimId, orderIntentId,
        eligible: assessment.eligible,
        blockers: assessment.blockers,
        confirmationFingerprint: assessment.confirmationFingerprint,
        evidence: assessment,
        investigation: investigationFor(assessment),
      };
    }
  }
  const positionOnly = !orderIntentId && base.claim.trackedPositionStatus === 'closed';
  return {
    disposition: (base.brokerOrder ? 'TERMINAL_BROKER_ORDER_NO_EXPOSURE' : positionOnly ? 'CLOSED_ADOPTED_POSITION' : 'UNSUPPORTED') as EntryExposureRemediationDisposition,
    claimId, orderIntentId,
    eligible: base.eligible,
    blockers: base.blockers,
    confirmationFingerprint: base.confirmationFingerprint,
    evidence: base,
    investigation: null,
  };
}

export async function requireRemediationOwner(actorUserId: number) {
  const actor = await prisma.user.findUnique({ where: { id: actorUserId }, select: { id: true, platformRole: true, email: true, enabled: true } });
  if (!actor || actor.platformRole !== 'SYSTEM_OWNER' || !actor.enabled) {
    throw new HttpError(403, 'Claim remediation requires an explicit, enabled SYSTEM_OWNER actor.');
  }
  return actor;
}

export async function applyEntryExposureRemediation(args: { claimId: number; actorUserId: number; confirmationFingerprint: string }) {
  const actor = await requireRemediationOwner(args.actorUserId);
  const preview = await previewEntryExposureRemediation(args.claimId);
  const refused = (reason: string) => ({ released: false as const, claimId: args.claimId, disposition: preview.disposition, reason, preview });

  if (preview.disposition === 'DISPATCHED_ENTRY_VERIFIED_NO_EXPOSURE' || preview.disposition === 'NO_DISPATCH_RECORD_VERIFIED_NO_EXPOSURE') {
    // Fresh verification, exact fingerprint, locked revalidation and immutable authorization and
    // release evidence all happen inside the verified release.
    const result = await releaseVerifiedEntryExposureClaim({
      orderIntentId: preview.orderIntentId!, mode: 'OPERATOR', actorUserId: actor.id, confirmationFingerprint: args.confirmationFingerprint,
    });
    if (!result.released) return refused(result.reason);
    const claim = await prisma.entryExposureClaim.findUniqueOrThrow({ where: { id: args.claimId } });
    return { released: true as const, claimId: args.claimId, disposition: preview.disposition, reason: result.reason, releasedAt: claim.releasedAt, releaseReason: claim.releaseReason, preview };
  }

  if (!preview.eligible) return refused(`BLOCKED:${preview.blockers.join(',')}`);
  if (args.confirmationFingerprint !== preview.confirmationFingerprint) return refused('CONFIRMATION_FINGERPRINT_MISMATCH');
  await prisma.entryExposureClaimEvent.create({
    data: {
      claimId: args.claimId,
      eventType: 'OPERATOR_REMEDIATION_AUTHORIZED',
      evidenceJson: JSON.parse(JSON.stringify({
        actorUserId: actor.id, actorEmail: actor.email, confirmationFingerprint: args.confirmationFingerprint,
        disposition: preview.disposition, preview: preview.evidence,
      })),
    },
  });
  const evidence = preview.evidence as Awaited<ReturnType<typeof previewEntryExposureClaimRemediation>>;
  const released = evidence.claim.orderIntentId && evidence.brokerOrder
    ? await releaseConfirmedTerminalEntryClaim({ orderIntentId: evidence.claim.orderIntentId, brokerStatus: evidence.brokerOrder.status, allowUnresolved: true })
    : await releaseClosedAdoptedPositionClaim({ claimId: args.claimId, actorUserId: actor.id });
  if (!released?.releasedAt) return refused('REFUSED_DURING_FINAL_BROKER_LOOKUP_OR_LOCKED_REVALIDATION');
  return { released: true as const, claimId: args.claimId, disposition: preview.disposition, reason: released.releaseReason ?? 'RELEASED', releasedAt: released.releasedAt, releaseReason: released.releaseReason, preview };
}
