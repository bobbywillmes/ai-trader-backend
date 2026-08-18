import type { TradingAccount, TradingAccountReadinessAssessment } from '../../../types';

export type CurrentApproval = {
  effective: boolean;
  approval: { revision: number } | null;
};

export function deriveLiveEntrySetupState({ account, assessment, canaryStaged, riskApproval, entryApproval }: {
  account: TradingAccount;
  assessment: TradingAccountReadinessAssessment | null;
  canaryStaged: boolean;
  riskApproval: CurrentApproval | null;
  entryApproval: CurrentApproval | null;
}) {
  const riskEffective = riskApproval?.effective === true && Boolean(riskApproval.approval);
  const entryEffective = entryApproval?.effective === true && Boolean(entryApproval.approval);
  const approvalRevisions = assessment?.evidence.liveWriteApprovalRevisions;
  const assessmentMatchesCurrentApprovals = Boolean(
    assessment?.purpose === 'LIVE_ENTRY_ARMING' &&
    assessment.result === 'PASSED' &&
    assessment.validity === 'CURRENT' &&
    riskEffective &&
    entryEffective &&
    approvalRevisions?.riskReducing === riskApproval?.approval?.revision &&
    approvalRevisions?.entry === entryApproval?.approval?.revision,
  );
  const credentialsCurrent = Boolean(account.credential?.verifiedAt);
  const armed = Boolean(account.activeLiveEntryArmingId && account.tradingEnabled && !account.killSwitchEnabled);
  const consumedHistorically = account.latestLiveEntryArming?.terminations.some((item) => item.type === 'CONSUMED') === true;
  const entryGrantReady = Boolean(
    assessment?.purpose === 'LIVE_ENTRY_ARMING' &&
    assessment.validity === 'CURRENT' &&
    assessment.evidence.prerequisitesForEntryGrantPassed === true,
  );

  const nextKey = consumedHistorically ? 'consumed'
    : armed ? 'consume'
      : !canaryStaged ? 'canary'
        : !credentialsCurrent ? 'credentials'
          : !riskEffective ? 'risk'
            : !entryEffective ? (entryGrantReady ? 'entry' : 'readiness')
              : !assessmentMatchesCurrentApprovals ? 'readiness'
                : 'arm';
  const nextAction = nextKey === 'consumed' ? 'Verify execution evidence and DISARM.'
    : nextKey === 'consume' ? 'Execute the one-shot RSP canary.'
      : nextKey === 'canary' ? 'Stage the RSP canary.'
        : nextKey === 'credentials' ? 'Verify credentials and run a fresh Live Entry Arming assessment.'
          : nextKey === 'risk' ? 'Grant RISK_REDUCING authorization.'
            : nextKey === 'entry' ? 'Grant ENTRY authorization.'
              : nextKey === 'readiness' ? 'Run a fresh Live Entry Arming assessment.'
                : 'ARM LIVE ENTRIES.';

  const milestoneValues = [
    ['activated', 'Account activated', account.status === 'ACTIVE'],
    ['canary', 'RSP canary staged', canaryStaged],
    ['credentials', 'Credentials recently verified', credentialsCurrent],
    ['risk', 'RISK_REDUCING effective', riskEffective],
    ['entry', 'ENTRY effective', entryEffective],
    ['readiness', 'Live Entry Arming assessment passed and current', assessmentMatchesCurrentApprovals],
    ['arm', 'Live entries armed with an active binding', armed],
    ['consume', 'One-shot authority consumed previously', consumedHistorically],
  ] as const;

  return {
    armed,
    consumedHistorically,
    readyToArm: assessmentMatchesCurrentApprovals && !armed && !consumedHistorically,
    nextAction,
    milestones: milestoneValues.map(([key, label, complete]) => ({
      key,
      label,
      status: complete ? 'DONE' as const : key === nextKey ? 'NEXT' as const : 'PENDING' as const,
    })),
  };
}
