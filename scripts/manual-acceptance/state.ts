type StateDb = {
  tradingAccount: {
    findFirst(args: unknown): Promise<any>;
  };
};

type ApprovalState = {
  capabilities: Array<{
    capability: string;
    effective: boolean;
    reason: string | null;
    approval: null | {
      status: string;
      revision: number;
      expiresAt: Date | null;
    };
  }>;
};

type TransportState = {
  totalRequests: number;
  getCount: number;
  postCount: number;
  recentRequests: unknown[];
};

export async function buildManualAcceptanceState(args: {
  db: StateDb;
  getApprovalState(tradingAccountId: number): Promise<ApprovalState>;
  getTransportState(): TransportState;
}) {
  const account = await args.db.tradingAccount.findFirst({
    where: { displayName: 'Synthetic Live Acceptance' },
    select: {
      id: true,
      status: true,
      tradingEnabled: true,
      killSwitchEnabled: true,
      activeLiveEntryArmingId: true,
      accountSubscriptions: {
        where: { subscription: { key: 'rsp_dip_core' } },
        take: 1,
        select: {
          id: true,
          enabled: true,
          entriesEnabled: true,
          exitsEnabled: true,
          subscription: { select: { key: true } },
        },
      },
      liveEntryArmings: {
        orderBy: { id: 'desc' },
        take: 1,
        select: {
          id: true,
          entryApprovalId: true,
          entryApprovalRevision: true,
          riskReducingApprovalId: true,
          riskReducingApprovalRevision: true,
          tradingAccountSubscriptionId: true,
          armedAt: true,
          terminations: {
            orderBy: { occurredAt: 'asc' },
            select: {
              type: true,
              reason: true,
              orderIntentId: true,
              clientOrderId: true,
              occurredAt: true,
            },
          },
        },
      },
    },
  });
  if (!account) throw new Error('Synthetic Live Acceptance account was not found.');

  const approvalState = await args.getApprovalState(account.id);
  const approval = (capability: 'RISK_REDUCING' | 'ENTRY') => {
    const item = approvalState.capabilities.find((candidate) => candidate.capability === capability);
    return {
      storedStatus: item?.approval?.status ?? 'MISSING',
      effective: item?.effective ?? false,
      ineffectiveReason: item?.reason ?? (item ? null : 'MISSING'),
      revision: item?.approval?.revision ?? null,
      expiresAt: item?.approval?.expiresAt?.toISOString() ?? null,
    };
  };
  const latestArming = account.liveEntryArmings[0] ?? null;
  const consumed = latestArming?.terminations.find((item: { type: string }) => item.type === 'CONSUMED') ?? null;

  return {
    account: {
      id: account.id,
      status: account.status,
      tradingEnabled: account.tradingEnabled,
      killSwitchEnabled: account.killSwitchEnabled,
      activeLiveEntryArmingId: account.activeLiveEntryArmingId,
    },
    canaryAssignment: account.accountSubscriptions[0] ?? null,
    approvals: {
      riskReducing: approval('RISK_REDUCING'),
      entry: approval('ENTRY'),
    },
    arming: latestArming ? {
      id: latestArming.id,
      active: account.activeLiveEntryArmingId === latestArming.id,
      entryApprovalId: latestArming.entryApprovalId,
      entryApprovalRevision: latestArming.entryApprovalRevision,
      riskReducingApprovalId: latestArming.riskReducingApprovalId,
      riskReducingApprovalRevision: latestArming.riskReducingApprovalRevision,
      tradingAccountSubscriptionId: latestArming.tradingAccountSubscriptionId,
      armedAt: latestArming.armedAt.toISOString(),
      oneShotStatus: consumed ? 'CONSUMED' : account.activeLiveEntryArmingId === latestArming.id ? 'AVAILABLE' : 'TERMINATED',
      consumption: consumed ? {
        orderIntentId: consumed.orderIntentId,
        clientOrderId: consumed.clientOrderId,
        reason: consumed.reason,
        occurredAt: consumed.occurredAt.toISOString(),
      } : null,
      terminations: latestArming.terminations.map((item: any) => ({ ...item, occurredAt: item.occurredAt.toISOString() })),
    } : null,
    mockTransport: args.getTransportState(),
  };
}
