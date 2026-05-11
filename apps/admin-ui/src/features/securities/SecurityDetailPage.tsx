import { Link, useParams } from 'react-router-dom';
import { useSecurity, useUpdateSecurity, useUpdateSecuritySubscription } from './hooks';
import { notifications } from '@mantine/notifications';
import './SecurityDetailPage.css';

function formatSizing(type: string, value: number) {
  if (type === 'dollar_amount') {
    return `$${value.toLocaleString()}`;
  }

  return value.toLocaleString();
}

function formatPct(value: number | null) {
  if (value === null) {
    return '-';
  }

  return `${value}%`;
}

function getErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  return 'Something went wrong.';
}

export function SecurityDetailPage() {
  const { symbol } = useParams<{ symbol: string }>();

  const securityQuery = useSecurity(symbol);
  const updateSecurityMutation = useUpdateSecurity(symbol);
  const updateSubscriptionMutation = useUpdateSecuritySubscription(symbol);

  const security = securityQuery.data?.security;

  if (securityQuery.isLoading) {
    return (
      <div className="security-detail-page">
        <div className="detail-message">Loading security...</div>
      </div>
    );
  }

  if (securityQuery.isError || !security) {
    return (
      <div className="security-detail-page">
        <Link className="back-link" to="/securities">
          ← Back to securities
        </Link>
        <div className="detail-message error-message">
          Failed to load security.
        </div>
      </div>
    );
  }

  function handleToggleSecurity() {
    if (!security) {
      return;
    }

    const nextEnabled = !security.enabled;

    updateSecurityMutation.mutate(
      {
        enabled: nextEnabled,
      },
      {
        onSuccess: () => {
          notifications.show({
            title: 'Security updated',
            message: `${security.symbol} trading has been ${
              nextEnabled ? 'enabled' : 'disabled'
            }.`,
            color: nextEnabled ? 'green' : 'red',
          });
        },
        onError: (error) => {
          notifications.show({
            title: 'Security update failed',
            message: getErrorMessage(error),
            color: 'red',
          });
        },
      }
    );
  }

  function handleToggleSubscription(
    subscriptionId: number,
    enabled: boolean,
    subscriptionName: string
  ) {
    const nextEnabled = !enabled;

    updateSubscriptionMutation.mutate(
      {
        subscriptionId,
        enabled: nextEnabled,
      },
      {
        onSuccess: () => {
          notifications.show({
            title: 'Subscription updated',
            message: `${subscriptionName} has been ${
              nextEnabled ? 'enabled' : 'disabled'
            }.`,
            color: nextEnabled ? 'green' : 'red',
          });
        },
        onError: (error) => {
          notifications.show({
            title: 'Subscription update failed',
            message: getErrorMessage(error),
            color: 'red',
          });
        },
      }
    );
  }
  return (
    <div className="security-detail-page">
      <div className="detail-header">
        <div>
          <Link className="back-link" to="/securities">
            ← Back to securities
          </Link>

          <h1>
            {security.symbol}
            <span>{security.name}</span>
          </h1>

          <p>
            {security.assetType} · {security.sector ?? 'No sector'} ·{' '}
            {security.industry ?? 'No industry'}
          </p>
        </div>

        <button
          type="button"
          className={
            security.enabled
              ? 'danger-button'
              : 'primary-button'
          }
          disabled={updateSecurityMutation.isPending}
          onClick={handleToggleSecurity}
        >
          {security.enabled ? 'Disable Trading' : 'Enable Trading'}
        </button>
      </div>

      <section className="detail-grid">
        <article className="detail-card">
          <h2>Security Details</h2>

          <dl className="detail-list">
            <div>
              <dt>Symbol</dt>
              <dd>{security.symbol}</dd>
            </div>

            <div>
              <dt>Name</dt>
              <dd>{security.name}</dd>
            </div>

            <div>
              <dt>Type</dt>
              <dd>{security.assetType}</dd>
            </div>

            <div>
              <dt>Sector</dt>
              <dd>{security.sector ?? '-'}</dd>
            </div>

            <div>
              <dt>Industry</dt>
              <dd>{security.industry ?? '-'}</dd>
            </div>

            <div>
              <dt>Status</dt>
              <dd>
                <span
                  className={
                    security.enabled
                      ? 'status-pill status-enabled'
                      : 'status-pill status-disabled'
                  }
                >
                  {security.enabled ? 'Enabled' : 'Disabled'}
                </span>
              </dd>
            </div>
          </dl>
        </article>

        <article className="detail-card">
          <h2>Trading Control</h2>

          <p className="control-note">
            Disabling this security should act as a master trading lockout.
            Subscriptions can remain configured, but new entries should be
            blocked while the security is disabled.
          </p>

          <div className="control-state">
            Current state:{' '}
            <strong>{security.enabled ? 'Trading enabled' : 'Trading disabled'}</strong>
          </div>
        </article>
      </section>

      <section className="detail-card subscriptions-card">
        <div className="section-title-row">
          <div>
            <h2>Subscriptions</h2>
            <p>
              {security.subscriptions.length} configured subscription
              {security.subscriptions.length === 1 ? '' : 's'}
            </p>
          </div>
        </div>

        {security.subscriptions.length === 0 ? (
          <div className="detail-message">No subscriptions for this security.</div>
        ) : (
          <table className="detail-table">
            <thead>
              <tr>
                <th>Key</th>
                <th>Name</th>
                <th>Broker</th>
                <th>Mode</th>
                <th>Sizing</th>
                <th>Strategy</th>
                <th>Exit Profile</th>
                <th>Target</th>
                <th>Stop</th>
                <th>Status</th>
                <th>Action</th>
              </tr>
            </thead>

            <tbody>
              {security.subscriptions.map((subscription) => (
                <tr key={subscription.id}>
                  <td className="mono-cell">{subscription.key}</td>
                  <td>{subscription.name}</td>
                  <td>{subscription.broker}</td>
                  <td>{subscription.brokerMode}</td>
                  <td>
                    {formatSizing(
                      subscription.sizingType,
                      subscription.sizingValue
                    )}
                  </td>
                  <td>{subscription.strategy?.key ?? '-'}</td>
                  <td>{subscription.exitProfile?.key ?? '-'}</td>
                  <td>{formatPct(subscription.exitProfile?.targetPct ?? null)}</td>
                  <td>{formatPct(subscription.exitProfile?.stopLossPct ?? null)}</td>
                  <td>
                    <span
                      className={
                        subscription.enabled
                          ? 'status-pill status-enabled'
                          : 'status-pill status-disabled'
                      }
                    >
                      {subscription.enabled ? 'Enabled' : 'Disabled'}
                    </span>
                  </td>
                  <td>
                    <button
                      type="button"
                      className={
                        subscription.enabled
                          ? 'small-danger-button'
                          : 'small-primary-button'
                      }
                      disabled={
                        updateSubscriptionMutation.isPending &&
                        updateSubscriptionMutation.variables?.subscriptionId === subscription.id
                      }
                      onClick={() =>
                        handleToggleSubscription(subscription.id, subscription.enabled, subscription.name)
                      }
                    >
                      {subscription.enabled ? 'Disable' : 'Enable'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}