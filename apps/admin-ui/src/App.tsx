import React, { FormEvent, useEffect, useState } from 'react';
import './App.css';
import {
  apiRequest,
  clearAdminToken,
  getAdminToken,
  setAdminToken,
} from './lib/api';
import type {
  ExitProfile,
  LoginResponse,
  MeResponse,
  Strategy,
  Subscription,
  TrackedPosition,
} from './types/api';

import { patchSubscription } from './lib/api';

type DashboardData = {
  strategies: Strategy[];
  subscriptions: Subscription[];
  exitProfiles: ExitProfile[];
  openPositions: TrackedPosition[];
};

function App() {
  const [email, setEmail] = useState('bobby@example.com');
  const [password, setPassword] = useState('');
  const [adminEmail, setAdminEmail] = useState<string | null>(null);
  const [token, setToken] = useState<string>('');
  const [data, setData] = useState<DashboardData | null>(null);
  const [status, setStatus] = useState('Checking session...');
  const [loading, setLoading] = useState(false);
  const [editingSubscriptionId, setEditingSubscriptionId] = useState<number | null>(null);
  const [editSizingValue, setEditSizingValue] = useState<string>('');
  const [editExitProfileKey, setEditExitProfileKey] = useState<string>('');

  type MessageType = 'info' | 'success' | 'error';

  const [message, setMessage] = useState<string | null>(null);
  const [messageType, setMessageType] = useState<MessageType>('info');

  function showMessage(text: string, type: MessageType = 'info') {
    setMessage(text);
    setMessageType(type);
  }

  function clearMessage() {
    setMessage(null);
  }

  async function loadDashboard(authToken?: string) {
    const tokenToUse = authToken || token || getAdminToken();

    if (!tokenToUse) {
      throw new Error('Admin session token is missing.');
    }

    const [strategies, subscriptions, exitProfiles, trackedPositions] =
      await Promise.all([
        apiRequest<Strategy[]>('/api/strategies', { token: tokenToUse }),
        apiRequest<Subscription[]>('/api/subscriptions', { token: tokenToUse }),
        apiRequest<ExitProfile[]>('/api/exit-profiles', { token: tokenToUse }),
        apiRequest<TrackedPosition[]>('/api/tracked-positions', { token: tokenToUse }),
      ]);

    setData({
      strategies,
      subscriptions,
      exitProfiles,
      openPositions: trackedPositions.filter(
        (position) => position.status === 'open'
      ),
    });
  }

  async function checkSession() {
    const savedToken = getAdminToken();

    if (!savedToken) {
      setStatus('Not logged in.');
      return;
    }

    try {
      const me = await apiRequest<MeResponse>('/api/admin-auth/me', {
        token: savedToken,
      });

      setAdminEmail(me.adminUser.email);
      setToken(savedToken);
      setStatus('Logged in. Loading dashboard...');

      await loadDashboard(savedToken);
      setStatus('Logged in.');
    } catch {
      clearAdminToken();
      setToken('');
      setAdminEmail(null);
      setData(null);
      setStatus('Session expired. Please log in again.');
    }
  }

  useEffect(() => {
    checkSession();
  }, []);

  async function handleLogin(event: FormEvent) {
    event.preventDefault();
    setLoading(true);
    setStatus('Logging in...');

    try {
      const response = await apiRequest<LoginResponse>('/api/admin-auth/login', {
        method: 'POST',
        body: JSON.stringify({
          email,
          password,
        }),
      });

      setAdminToken(response.token);
      setToken(response.token);
      setAdminEmail(response.adminUser.email);
      setStatus('Logged in. Loading dashboard...');

      try {
        await loadDashboard(response.token);
        setStatus('Logged in.');
      } catch (error) {
        setData(null);
        setStatus(
          error instanceof Error
            ? `Logged in, but dashboard failed: ${error.message}`
            : 'Logged in, but dashboard failed.',
        );
      }
    } catch (error) {
      clearAdminToken();
      setAdminEmail(null);
      setData(null);
      setStatus(error instanceof Error ? error.message : 'Login failed.');
    } finally {
      setLoading(false);
    }
  }

  async function handleLogout() {
    setLoading(true);
    setStatus('Logging out...');

    try {
      await apiRequest('/api/admin-auth/logout', {
        method: 'POST',
      });
    } catch {
      // Clear local token either way.
    } finally {
      clearAdminToken();
      setAdminEmail(null);
      setData(null);
      setPassword('');
      setStatus('Logged out.');
      setLoading(false);
    }
  }

  if (!adminEmail) {
    return (
      <main className="page">
        <section className="card login-card">
          <p className="eyebrow">AI Trader Admin</p>
          <h1>Sign in</h1>
          <p className="muted">
            Use the admin account created through the bootstrap endpoint.
          </p>

          <form onSubmit={handleLogin} className="form">
            <label>
              Email
              <input
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                type="email"
                autoComplete="email"
              />
            </label>

            <label>
              Password
              <input
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                type="password"
                autoComplete="current-password"
              />
            </label>

            <button disabled={loading} type="submit">
              {loading ? 'Signing in...' : 'Sign in'}
            </button>
          </form>

          <p className="status">{status}</p>
        </section>
      </main>
    );
  }

  async function handleToggleSubscription(subscriptionId: number, enabled: boolean) {
    try {
      showMessage(enabled ? 'Enabling subscription...' : 'Disabling subscription...', 'info');

      await patchSubscription(subscriptionId, { enabled }, token);

      showMessage(enabled ? 'Subscription enabled.' : 'Subscription disabled.', 'success');

      await loadDashboard();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to update subscription.';

      showMessage(message, 'error');
    }
  }

  function startEditingSubscription(subscription: Subscription) {
    setEditingSubscriptionId(subscription.id);
    setEditSizingValue(String(subscription.sizingValue ?? ''));
    setEditExitProfileKey(subscription.exitProfile?.key ?? '');
    setMessage(null);
  }

  function cancelEditingSubscription() {
    setEditingSubscriptionId(null);
    setEditSizingValue('');
    setEditExitProfileKey('');
  }

  async function handleUpdateSubscription(subscriptionId: number) {
    if (!token) {
      setMessage('Admin session is missing. Please log in again.');
      return;
    }

    const parsedSizingValue = Number(editSizingValue);

    if (!Number.isFinite(parsedSizingValue) || parsedSizingValue <= 0) {
      setMessage('Sizing value must be a positive number.');
      return;
    }

    if (!editExitProfileKey) {
      setMessage('Exit profile is required.');
      return;
    }

    try {
      setMessage('Updating subscription...');

      await apiRequest<Subscription>(`/api/subscriptions/${subscriptionId}`, {
        method: 'PATCH',
        token,
        body: {
          sizingValue: parsedSizingValue,
          exitProfileKey: editExitProfileKey,
        },
      });

      setMessage('Subscription updated.');
      cancelEditingSubscription();
      await loadDashboard();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to update subscription.';
      setMessage(message);
    }
  }

  return (
    <main className="page">
      <section className="header">
        <div>
          <p className="eyebrow">AI Trader Admin</p>
          <h1>Dashboard</h1>
          <p className="muted">Signed in as {adminEmail}</p>
        </div>

        <button disabled={loading} onClick={handleLogout}>
          Logout
        </button>
      </section>

      {message && (
        <div className={`status-banner status-${messageType}`} role="status">
          <span>{message}</span>

          <button
            type="button"
            className="status-dismiss"
            onClick={clearMessage}
            aria-label="Dismiss message"
          >
            ×
          </button>
        </div>
      )}

      <section className="grid">
        <SummaryCard label="Strategies" value={data?.strategies.length ?? 0} />
        <SummaryCard
          label="Subscriptions"
          value={data?.subscriptions.length ?? 0}
        />
        <SummaryCard
          label="Exit Profiles"
          value={data?.exitProfiles.length ?? 0}
        />
        <SummaryCard
          label="Open Positions"
          value={data?.openPositions.length ?? 0}
        />
      </section>

      <section className="card">
        <h2>Open Positions</h2>

        {!data?.openPositions.length ? (
          <p className="muted">No open positions.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Symbol</th>
                <th>Qty</th>
                <th>Avg Entry</th>
                <th>Current</th>
                <th>P/L</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {data.openPositions.map((position) => (
                <tr key={position.id}>
                  <td>{position.symbol}</td>
                  <td>{position.qty}</td>
                  <td>{position.avgEntryPrice.toFixed(2)}</td>
                  <td>{position.currentPrice.toFixed(2)}</td>
                  <td>{position.unrealizedPnL.toFixed(2)}</td>
                  <td>{position.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="card">
        <h2>Subscriptions</h2>

        {!data?.subscriptions.length ? (
          <p className="muted">No subscriptions.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Key</th>
                <th>Symbol</th>
                <th>Size</th>
                <th>Enabled</th>
                <th>Exit Profile</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {data.subscriptions.map((subscription) => {
                const isEditing = editingSubscriptionId === subscription.id;

                return (
                  <React.Fragment key={subscription.id}>
                    <tr>
                      <td>{subscription.key}</td>
                      <td>{subscription.symbol}</td>
                      <td>
                        {subscription.sizingValue} {subscription.sizingType}
                      </td>
                      <td>{subscription.enabled ? 'Yes' : 'No'}</td>
                      <td>{subscription.exitProfile?.key ?? subscription.exitProfileId}</td>
                      <td>
                        <div className="action-row">
                          {subscription.enabled ? (
                            <button
                              className="small-button danger"
                              onClick={() => handleToggleSubscription(subscription.id, false)}
                            >
                              Disable
                            </button>
                          ) : (
                            <button
                              className="small-button"
                              onClick={() => handleToggleSubscription(subscription.id, true)}
                            >
                              Enable
                            </button>
                          )}

                          <button
                            className="small-button secondary"
                            onClick={() => startEditingSubscription(subscription)}
                          >
                            Edit
                          </button>
                        </div>
                      </td>
                    </tr>

                    {isEditing && (
                      <tr className="edit-row">
                        <td colSpan={6}>
                          <div className="edit-panel">
                            <div>
                              <label>Sizing Value</label>
                              <input
                                type="number"
                                min="0"
                                step="1"
                                value={editSizingValue}
                                onChange={(event) => setEditSizingValue(event.target.value)}
                              />
                            </div>

                            <div>
                              <label>Exit Profile</label>
                              <select
                                value={editExitProfileKey}
                                onChange={(event) => setEditExitProfileKey(event.target.value)}
                              >
                                <option value="">Select exit profile</option>
                                {data.exitProfiles.map((exitProfile) => (
                                  <option key={exitProfile.id} value={exitProfile.key}>
                                    {exitProfile.key}
                                  </option>
                                ))}
                              </select>
                            </div>

                            <div className="edit-actions">
                              <button
                                className="small-button"
                                onClick={() => handleUpdateSubscription(subscription.id)}
                              >
                                Save
                              </button>

                              <button
                                className="small-button secondary"
                                onClick={cancelEditingSubscription}
                              >
                                Cancel
                              </button>
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      <p className="status">{status}</p>
    </main>
  );
}

function SummaryCard({ label, value }: { label: string; value: number }) {
  return (
    <section className="card summary-card">
      <p className="muted">{label}</p>
      <strong>{value}</strong>
    </section>
  );
}

export default App;