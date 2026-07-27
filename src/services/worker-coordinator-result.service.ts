export type AccountCoordinatorOutcome =
  | 'PROCESSED'
  | 'SKIPPED'
  | 'LOCK_SKIPPED'
  | 'BACKING_OFF'
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
      result.outcome === 'CREDENTIALS_UNAVAILABLE' ||
      result.outcome === 'BACKING_OFF'
  );
  if (unhealthy.length === 0) return;

  const failedAccounts = unhealthy.filter(
    (result) =>
      result.outcome === 'FAILED' ||
      result.outcome === 'BACKING_OFF'
  ).length;
  const credentialUnavailableAccounts = unhealthy.filter(
    (result) => result.outcome === 'CREDENTIALS_UNAVAILABLE'
  ).length;
  const accountSummary = unhealthy
    .map(
      (result) =>
        result.account.tradingAccountId
    )
    .sort((left, right) => left - right)
    .join(', ');

  throw new AccountCoordinatorFailureError(
    workflow,
    failedAccounts,
    credentialUnavailableAccounts,
    `${workflow} has unhealthy accounts (${accountSummary}).`
  );
}
