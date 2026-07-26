export type AccountCoordinatorOutcome =
  | 'PROCESSED'
  | 'SKIPPED'
  | 'CREDENTIALS_UNAVAILABLE'
  | 'FAILED';

export type AccountCoordinatorResult = {
  outcome: AccountCoordinatorOutcome;
  account: {
    tradingAccountId: number;
    displayName: string;
  };
  error?: string;
};

export class AccountCoordinatorFailureError extends Error {
  readonly code = 'ACCOUNT_COORDINATOR_PARTIAL_FAILURE';

  constructor(
    readonly workflow: string,
    readonly failedAccounts: number,
    readonly credentialUnavailableAccounts: number,
    message: string
  ) {
    super(message);
    this.name = 'AccountCoordinatorFailureError';
  }
}

export function assertAccountCoordinatorHealthy(
  workflow: string,
  results: AccountCoordinatorResult[]
) {
  const unhealthy = results.filter(
    (result) =>
      result.outcome === 'FAILED' ||
      result.outcome === 'CREDENTIALS_UNAVAILABLE'
  );
  if (unhealthy.length === 0) return;

  const failedAccounts = unhealthy.filter(
    (result) => result.outcome === 'FAILED'
  ).length;
  const credentialUnavailableAccounts = unhealthy.length - failedAccounts;
  const accountSummary = unhealthy
    .map(
      (result) =>
        `${result.account.tradingAccountId}:${result.account.displayName}:${result.outcome}`
    )
    .join(', ');

  throw new AccountCoordinatorFailureError(
    workflow,
    failedAccounts,
    credentialUnavailableAccounts,
    `${workflow} completed with account failures (${accountSummary}).`
  );
}
