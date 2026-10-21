import { OperationalAttentionResolutionPolicy, SystemEventSeverity } from '@prisma/client';
import { prisma } from '../db/prisma.js';
import {
  OPERATIONAL_ATTENTION_CODES, OPERATIONAL_ATTENTION_SOURCES,
  openOrObserveOperationalAttention, resolveOperationalAttentionAuthoritatively,
} from './operational-attention.service.js';
import type { PaperAccountAuthorityAssessment } from './paper-broker-write-authority.service.js';

const fingerprintFor = (tradingAccountId: number) => `paper-executor-authority:${tradingAccountId}`;
const MAX_REVISION_RETRIES = 3;

export async function reconcilePaperBrokerWriteAuthorityAttention(item: PaperAccountAuthorityAssessment) {
  const active = await prisma.operationalAttention.findFirst({ where: {
    tradingAccountId: item.tradingAccountId, code: OPERATIONAL_ATTENTION_CODES.PAPER_EXECUTOR_AUTHORITY_MISMATCH,
    fingerprint: fingerprintFor(item.tradingAccountId), status: { in: ['OPEN', 'ACKNOWLEDGED'] },
  }, select: { id: true, revision: true } });
  const authoritativeResolution = item.outcome === 'AUTHORIZED'
    ? { reason: 'Fresh account-aware verification proved expected PAPER executor authority is restored.', evidence: {
      tradingAccountId: item.tradingAccountId, outcome: item.outcome, expectedBrokerAccountId: item.expectedBrokerAccountId,
      brokerAccountIdVerified: item.brokerAccountIdVerified, credentialUsable: item.credentialUsable,
      credentialFingerprintConsistent: item.credentialFingerprintConsistent } }
    : item.outcome === 'INTENTIONAL_OBSERVATION_ONLY' && item.openLifecycleExposure === false
      ? { reason: 'Fresh canonical lifecycle queries proved the explicitly observed PAPER account has no remaining local exposure.', evidence: {
        tradingAccountId: item.tradingAccountId, outcome: item.outcome, ownershipRole: item.ownershipRole,
        openLifecycleExposure: item.openLifecycleExposure, exposure: item.exposure } }
      : null;
  if (authoritativeResolution) {
    if (!active) return null;
    for (let attempt = 0; attempt < MAX_REVISION_RETRIES; attempt += 1) {
      const current = attempt === 0 ? active : await prisma.operationalAttention.findFirst({ where: {
        tradingAccountId: item.tradingAccountId, code: OPERATIONAL_ATTENTION_CODES.PAPER_EXECUTOR_AUTHORITY_MISMATCH,
        fingerprint: fingerprintFor(item.tradingAccountId), status: { in: ['OPEN', 'ACKNOWLEDGED'] },
      }, select: { id: true, revision: true } });
      if (!current) return null;
      try {
        return await resolveOperationalAttentionAuthoritatively({ id: current.id, expectedRevision: current.revision,
          reason: authoritativeResolution.reason, evidence: authoritativeResolution.evidence });
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes('revision is stale') || attempt === MAX_REVISION_RETRIES - 1) throw error;
      }
    }
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

export async function reconcileAllPaperBrokerWriteAuthorityAttention(
  assess: () => Promise<{ accounts: PaperAccountAuthorityAssessment[]; unresolved?: string[] }> = async () => {
    const { assessPaperBrokerWriteAuthority } = await import('./paper-broker-write-authority.service.js');
    return assessPaperBrokerWriteAuthority();
  },
) {
  const assessment = await assess();
  const failures: Array<{ tradingAccountId: number; error: string }> = [];
  for (const item of assessment.accounts) {
    try { await reconcilePaperBrokerWriteAuthorityAttention(item); }
    catch (error) { failures.push({ tradingAccountId: item.tradingAccountId, error: error instanceof Error ? error.message : 'Unknown reconciliation error.' }); }
  }
  return { assessed: assessment.accounts.length, failures, assessmentUnresolved: assessment.unresolved ?? [] };
}
