import type { TradingAccount, TradingAccountReadinessAssessment } from '../../../types';

export type CurrentApproval = {
  effective: boolean;
  approval: { revision: number } | null;
};

type LiveEntryWorkflowAccount = Pick<
  TradingAccount,
  'status' | 'tradingEnabled' | 'killSwitchEnabled' | 'activeLiveEntryArmingId' |
  'latestLiveEntryArming' | 'credential'
>;

const RISK_GRANT_ALLOWED_BLOCKERS = new Set([
  'ARMING_RISK_REDUCING_APPROVAL',
  'ARMING_ENTRY_APPROVAL_CURRENT',
]);

function armingGates(assessment: TradingAccountReadinessAssessment | null) {
  return assessment?.purpose === 'LIVE_ENTRY_ARMING'
    ? assessment.stages?.find((stage) => stage.key === 'LIVE_ENTRY_ARMING_READY')?.gates ?? []
    : [];
}

function credentialState(account: LiveEntryWorkflowAccount, assessment: TradingAccountReadinessAssessment | null) {
  if (!account.credential?.verifiedAt) return 'NEVER_VERIFIED' as const;
  if (assessment?.purpose !== 'LIVE_ENTRY_ARMING') return 'ASSESSMENT_REQUIRED' as const;
  if (assessment.validity !== 'CURRENT') return 'STALE' as const;
  const gate = armingGates(assessment).find(
    (item) => item.code === 'ARMING_CREDENTIAL_VERIFICATION_CURRENT',
  );
  if (!gate) return 'ASSESSMENT_REQUIRED' as const;
  return gate.outcome === 'PASSED' ? 'CURRENT' as const : 'STALE' as const;
}

function firstRiskGrantBlocker(assessment: TradingAccountReadinessAssessment | null) {
  return armingGates(assessment).find(
    (gate) => gate.outcome === 'BLOCKED' && !RISK_GRANT_ALLOWED_BLOCKERS.has(gate.code),
  ) ?? null;
}

export function deriveLiveEntryAuthorizationState({ account, assessment, riskApproval }: {
  account: LiveEntryWorkflowAccount;
  assessment: TradingAccountReadinessAssessment | null;
  riskApproval: CurrentApproval | null;
}) {
  const credentials = credentialState(account, assessment);
  const riskGrantExecutable = Boolean(
    assessment?.purpose === 'LIVE_ENTRY_ARMING' &&
    assessment.validity === 'CURRENT' &&
    assessment.evidence.prerequisitesForRiskReducingGrantPassed === true,
  );
  const entryGrantExecutable = Boolean(
    assessment?.purpose === 'LIVE_ENTRY_ARMING' &&
    assessment.validity === 'CURRENT' &&
    assessment.evidence.prerequisitesForEntryGrantPassed === true,
  );
  const riskBlocker = firstRiskGrantBlocker(assessment);
  const capturedRiskRevision = assessment?.evidence.liveWriteApprovalRevisions?.riskReducing;
  const freshAssessmentGuidance = 'Run a fresh Live Entry Arming assessment.';
  const riskGrantGuidance = riskGrantExecutable ? null
    : !account.credential?.verifiedAt
      ? 'Verify broker credentials, then run a fresh Live Entry Arming assessment.'
      : assessment?.purpose !== 'LIVE_ENTRY_ARMING'
        ? freshAssessmentGuidance
        : assessment.validity === 'EXPIRED'
          ? 'The selected readiness assessment has expired. Run a fresh Live Entry Arming assessment.'
          : assessment.validity !== 'CURRENT'
            ? freshAssessmentGuidance
            : riskBlocker?.code === 'ARMING_CREDENTIAL_VERIFICATION_CURRENT'
              ? 'Broker credential verification is no longer current. Verify credentials and run a fresh Live Entry Arming assessment.'
              : riskBlocker
                ? `${riskBlocker.message} Resolve this prerequisite and run a fresh Live Entry Arming assessment.`
                : freshAssessmentGuidance;
  const entryGrantGuidance = entryGrantExecutable ? null
    : assessment?.purpose !== 'LIVE_ENTRY_ARMING'
      ? freshAssessmentGuidance
      : assessment.validity === 'EXPIRED'
        ? 'The selected readiness assessment has expired. Run a fresh Live Entry Arming assessment.'
        : assessment.validity !== 'CURRENT'
          ? freshAssessmentGuidance
          : riskApproval?.effective && capturedRiskRevision !== riskApproval.approval?.revision
            ? 'ENTRY approval requires a fresh readiness assessment containing the current RISK_REDUCING revision.'
            : riskBlocker?.code === 'ARMING_CREDENTIAL_VERIFICATION_CURRENT'
              ? 'Broker credential verification is no longer current. Verify credentials and run a fresh Live Entry Arming assessment.'
              : freshAssessmentGuidance;

  return {
    credentials,
    riskGrantExecutable,
    riskGrantBlocker: riskBlocker,
    riskGrantGuidance,
    entryGrantExecutable,
    entryGrantGuidance,
  };
}

export function deriveLiveEntrySetupState({ account, assessment, canaryPresent, canaryStaged, riskApproval, entryApproval }: {
  account: TradingAccount;
  assessment: TradingAccountReadinessAssessment | null;
  canaryPresent: boolean;
  canaryStaged: boolean;
  riskApproval: CurrentApproval | null;
  entryApproval: CurrentApproval | null;
}) {
  const authorization = deriveLiveEntryAuthorizationState({ account, assessment, riskApproval });
  const riskEffective = riskApproval?.effective === true && Boolean(riskApproval.approval);
  const entryEffective = entryApproval?.effective === true && Boolean(entryApproval.approval);
  const approvalRevisions = assessment?.evidence.liveWriteApprovalRevisions;
  const assessmentMatchesCurrentApprovals = Boolean(
    assessment?.purpose === 'LIVE_ENTRY_ARMING' && assessment.result === 'PASSED' &&
    assessment.validity === 'CURRENT' && riskEffective && entryEffective &&
    approvalRevisions?.riskReducing === riskApproval?.approval?.revision &&
    approvalRevisions?.entry === entryApproval?.approval?.revision,
  );
  const credentialsCurrent = authorization.credentials === 'CURRENT';
  const armed = Boolean(account.activeLiveEntryArmingId && account.tradingEnabled && !account.killSwitchEnabled);
  const consumedHistorically = account.latestLiveEntryArming?.terminations.some((item) => item.type === 'CONSUMED') === true;
  const safelyDisarmedAfterConsumption = Boolean(
    consumedHistorically && !account.activeLiveEntryArmingId &&
    !account.tradingEnabled && account.killSwitchEnabled && canaryPresent && !canaryStaged,
  );
  const cleanupRequired = consumedHistorically && !safelyDisarmedAfterConsumption;
  const next = safelyDisarmedAfterConsumption
    ? { key: 'complete', action: 'Acceptance canary completed successfully. One-shot authority was consumed and the account is safely disarmed.' }
    : cleanupRequired ? { key: 'cleanup', action: 'DISARM and restore the account, arming binding, and canary assignment to the safe posture.' }
      : armed ? { key: 'consume', action: 'Execute the one-shot RSP canary.' }
      : !canaryStaged ? { key: 'canary', action: 'Stage the RSP canary.' }
        : !riskEffective && !authorization.riskGrantExecutable
          ? { key: authorization.credentials === 'CURRENT' ? 'readiness' : 'credentials', action: authorization.riskGrantGuidance! }
          : !credentialsCurrent ? { key: 'credentials', action: authorization.riskGrantGuidance ?? 'Run a fresh Live Entry Arming assessment.' }
            : !riskEffective ? { key: 'risk', action: 'Grant RISK_REDUCING authorization.' }
              : !entryEffective ? authorization.entryGrantExecutable
                ? { key: 'entry', action: 'Grant ENTRY authorization.' }
                : { key: 'readiness', action: authorization.entryGrantGuidance! }
                : !assessmentMatchesCurrentApprovals ? { key: 'readiness', action: 'Run a fresh Live Entry Arming assessment.' }
                  : { key: 'arm', action: 'ARM LIVE ENTRIES.' };
  const credentialLabel = authorization.credentials === 'NEVER_VERIFIED' ? 'Broker credentials never verified'
    : authorization.credentials === 'ASSESSMENT_REQUIRED' ? 'Broker credentials verified; fresh arming assessment required'
      : authorization.credentials === 'STALE' ? 'Broker credential verification stale for arming'
        : 'Credentials recently verified';
  const ceremonyCompleted = consumedHistorically;
  const milestoneValues = [
    ['activated', 'Account activated', ceremonyCompleted || account.status === 'ACTIVE'],
    ['canary', ceremonyCompleted ? 'RSP canary was staged for consumed ceremony' : 'RSP canary staged', ceremonyCompleted || canaryStaged],
    ['credentials', ceremonyCompleted ? 'Credentials were current for consumed ceremony' : credentialLabel, ceremonyCompleted || credentialsCurrent],
    ['risk', ceremonyCompleted ? 'RISK_REDUCING was effective for consumed ceremony' : 'RISK_REDUCING effective', ceremonyCompleted || riskEffective],
    ['entry', ceremonyCompleted ? 'ENTRY was effective for consumed ceremony' : 'ENTRY effective', ceremonyCompleted || entryEffective],
    ['readiness', ceremonyCompleted ? 'Live Entry Arming assessment passed for consumed ceremony' : 'Live Entry Arming assessment passed and current', ceremonyCompleted || assessmentMatchesCurrentApprovals],
    ['arm', ceremonyCompleted ? 'Live entries were armed for consumed ceremony' : 'Live entries armed with an active binding', ceremonyCompleted || armed],
    ['consume', 'One-shot authority consumed previously', consumedHistorically],
    ['cleanup', 'Account safely disarmed after canary', safelyDisarmedAfterConsumption],
  ] as const;

  return {
    ...authorization,
    armed,
    consumedHistorically,
    completed: safelyDisarmedAfterConsumption,
    cleanupRequired,
    readyToArm: assessmentMatchesCurrentApprovals && !armed && !consumedHistorically,
    nextAction: next.action,
    milestones: milestoneValues.map(([key, label, complete]) => ({
      key, label,
      status: complete ? 'DONE' as const : key === next.key ? 'NEXT' as const : 'PENDING' as const,
    })),
  };
}
