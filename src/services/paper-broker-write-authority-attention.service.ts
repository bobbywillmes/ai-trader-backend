import { OperationalAttentionResolutionPolicy, SystemEventSeverity } from '@prisma/client';
import { prisma } from '../db/prisma.js';
import {
  OPERATIONAL_ATTENTION_CODES, OPERATIONAL_ATTENTION_SOURCES,
  openOrObserveOperationalAttention, resolveOperationalAttentionAuthoritatively,
} from './operational-attention.service.js';
import type { PaperAccountAuthorityAssessment } from './paper-broker-write-authority.service.js';

const fingerprintFor = (tradingAccountId: number) => `paper-executor-authority:${tradingAccountId}`;

export async function reconcilePaperBrokerWriteAuthorityAttention(item: PaperAccountAuthorityAssessment) {
  const active = await prisma.operationalAttention.findFirst({ where: {
    tradingAccountId: item.tradingAccountId, code: OPERATIONAL_ATTENTION_CODES.PAPER_EXECUTOR_AUTHORITY_MISMATCH,
    fingerprint: fingerprintFor(item.tradingAccountId), status: { in: ['OPEN', 'ACKNOWLEDGED'] },
  }, select: { id: true, revision: true } });
  if (item.outcome === 'AUTHORIZED') {
    if (!active) return null;
    return resolveOperationalAttentionAuthoritatively({ id: active.id, expectedRevision: active.revision,
      reason: 'Fresh account-aware verification proved expected PAPER executor authority is restored.',
      evidence: { tradingAccountId: item.tradingAccountId, outcome: item.outcome,
        expectedBrokerAccountId: item.expectedBrokerAccountId, brokerAccountIdVerified: item.brokerAccountIdVerified,
        credentialUsable: item.credentialUsable, credentialFingerprintConsistent: item.credentialFingerprintConsistent } });
  }
  if (item.outcome === 'INTENTIONAL_OBSERVATION_ONLY' || (item.openLifecycleExposure === false && item.intendedExecutor !== true)) return null;
  return openOrObserveOperationalAttention({ tradingAccountId: item.tradingAccountId,
    code: OPERATIONAL_ATTENTION_CODES.PAPER_EXECUTOR_AUTHORITY_MISMATCH, source: OPERATIONAL_ATTENTION_SOURCES.SYSTEM,
    severity: SystemEventSeverity.ERROR, title: 'PAPER executor authority mismatch',
    message: 'A PAPER account with lifecycle exposure lacks verified executor authority.',
    details: { outcome: item.outcome, reason: item.reason, ownershipRole: item.ownershipRole,
      openLifecycleExposure: item.openLifecycleExposure, exposure: item.exposure },
    fingerprint: fingerprintFor(item.tradingAccountId),
    materialFingerprint: `${fingerprintFor(item.tradingAccountId)}:${item.outcome}:${item.ownershipRole}:${item.reason}`,
    resolutionPolicy: OperationalAttentionResolutionPolicy.AUTHORITATIVE_ONLY });
}
