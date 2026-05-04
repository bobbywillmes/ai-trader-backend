import React, { FormEvent, Fragment, useEffect, useState } from 'react';
import { ToastContainer, toast } from 'react-toastify';
import 'react-toastify/dist/ReactToastify.css';
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
  OpenOrder,
} from './types/api';

import { patchSubscription } from './lib/api';

type DashboardData = {
  strategies: Strategy[];
  subscriptions: Subscription[];
  exitProfiles: ExitProfile[];
  openPositions: TrackedPosition[];
  openOrders: OpenOrder[];
};

type ExitProfileForm = {
  key: string;
  name: string;
  description: string;
  targetPct: string;
  stopLossPct: string;
  trailingStopPct: string;
  maxHoldDays: string;
  exitMode: string;
  takeProfitBehavior: string;
  enabled: boolean;
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
  const [hasSellOrder, setHasSellOrder] = useState(false);
  const [isClosing, setIsClosing] = useState(false);

  const [editingExitProfileId, setEditingExitProfileId] = useState<number | null>(null);
  const [creatingExitProfile, setCreatingExitProfile] = useState(false);

  const [exitProfileForm, setExitProfileForm] = useState<ExitProfileForm>({
    key: '',
    name: '',
    description: '',
    targetPct: '',
    stopLossPct: '',
    trailingStopPct: '',
    maxHoldDays: '',
    exitMode: 'fixed_bracket',
    takeProfitBehavior: 'immediate',
    enabled: true,
  });

  type MessageType = 'info' | 'success' | 'error' | 'warning';

  function showMessage(text: string, type: MessageType = 'info') {
    if (type === 'success') {
      toast.success(text);
      return;
    }

    if (type === 'error') {
      toast.error(text);
      return;
    }

    if (type === 'warning') {
      toast.warning(text);
      return;
    }

    toast.info(text);
  }


  async function loadDashboard(authToken?: string) {
    const tokenToUse = authToken ?? token ?? getAdminToken();

    if (!tokenToUse) {
      throw new Error('Admin session token is missing.');
    }

    const [
      strategies,
      subscriptions,
      exitProfiles,
      trackedPositions,
      openOrders
    ] = await Promise.all([
        apiRequest<Strategy[]>('/api/strategies', { token: tokenToUse }),
        apiRequest<Subscription[]>('/api/subscriptions', { token: tokenToUse }),
        apiRequest<ExitProfile[]>('/api/exit-profiles', { token: tokenToUse }),
        apiRequest<TrackedPosition[]>('/api/tracked-positions', { token: tokenToUse }),
        apiRequest<OpenOrder[]>('/api/orders/open', { token: tokenToUse }),
      ]);

    const dashboardData = {
      strategies,
      subscriptions,
      exitProfiles,
      openOrders,
      openPositions: trackedPositions.filter(
        (position) => position.status === 'open' || position.status === 'closing',
      ),
    };

    setData(dashboardData);

    return dashboardData;
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

  async function handleCancelOrder(orderId: string, symbol?: string) {
    if (!token) {
      showMessage('Admin session token is missing.', 'error');
      return;
    }

    const confirmed = window.confirm(
      `Cancel open order${symbol ? ` for ${symbol}` : ''}?`,
    );

    if (!confirmed) return;

    try {
      showMessage('Canceling order...', 'info');

      await apiRequest(`/api/orders/${encodeURIComponent(orderId)}`, {
        method: 'DELETE',
        token,
      });

      showMessage(`Order canceled${symbol ? ` for ${symbol}` : ''}.`, 'success');
      await loadDashboard(token);
    } catch (error) {
      showMessage(
        error instanceof Error ? error.message : 'Failed to cancel order.',
        'error',
      );
    }
  }

  async function handleClosePosition(symbol: string) {
    if (!token) {
      showMessage('Admin session token is missing.', 'error');
      return;
    }

    const confirmed = window.confirm(
      `Submit sell order to close ${symbol}?`,
    );

    if (!confirmed) return;

    try {
      showMessage(`Submitting close order for ${symbol}...`, 'info');
      setIsClosing(true);

      await apiRequest(`/api/positions/${encodeURIComponent(symbol)}`, {
        method: 'DELETE',
        token,
      });

      showMessage(`Close order submitted for ${symbol}.`, 'success');
      setHasSellOrder(true);

      await wait(500);
      await refreshDashboardUntilPositionSettles(token, symbol);
    } catch (error) {
      showMessage(
        error instanceof Error
          ? error.message
          : `Failed to close ${symbol}.`,
        'error',
      );
    }
  }

  async function handleSaveExitProfile() {
    if (!token) {
      showMessage('Admin session token is missing.', 'error');
      return;
    }

    try {
      const payload = buildExitProfilePayload(exitProfileForm);

      if (!payload.key) {
        throw new Error('Exit profile key is required.');
      }

      if (!payload.name) {
        throw new Error('Exit profile name is required.');
      }

      const matchingProfile = data?.exitProfiles.find(
        (profile) => profile.id === editingExitProfileId
      );

      const usedByEnabledSubscriptions =
        matchingProfile && data
          ? data.subscriptions.filter(
              (subscription) =>
                subscription.enabled &&
                subscription.exitProfile?.key === matchingProfile.key
            )
          : [];

      if (editingExitProfileId && usedByEnabledSubscriptions.length > 0) {
        const confirmed = window.confirm(
          `This exit profile is used by ${usedByEnabledSubscriptions.length} enabled subscription(s). Saving will affect live exit behavior. Continue?`
        );

        if (!confirmed) {
          return;
        }
      }

      if (creatingExitProfile) {
        await apiRequest('/api/exit-profiles', {
          method: 'POST',
          token,
          body: payload,
        });

        showMessage(`Exit profile created: ${payload.key}`, 'success');
      } else if (editingExitProfileId) {
        const { key, ...patchPayload } = payload;

        await apiRequest(`/api/exit-profiles/${editingExitProfileId}`, {
          method: 'PATCH',
          token,
          body: patchPayload,
        });

        showMessage(`Exit profile updated: ${payload.key}`, 'success');
      }

      setCreatingExitProfile(false);
      setEditingExitProfileId(null);
      await loadDashboard(token);
    } catch (error) {
      showMessage(
        error instanceof Error ? error.message : 'Failed to save exit profile.',
        'error'
      );
    }
  }

  function wait(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function refreshDashboardUntilPositionSettles(
    authToken: string,
    symbol: string,
  ) {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const latestData = await loadDashboard(authToken);

      const stillActive = latestData.openPositions.some(
        (position) => position.symbol === symbol,
      );

      if (!stillActive) {
        return;
      }

      await wait(750);
    }
  }

  function exitProfileToForm(profile: ExitProfile): ExitProfileForm {
    return {
      key: profile.key,
      name: profile.name,
      description: profile.description ?? '',
      targetPct: profile.targetPct === null ? '' : String(profile.targetPct),
      stopLossPct: profile.stopLossPct === null ? '' : String(profile.stopLossPct),
      trailingStopPct: profile.trailingStopPct === null ? '' : String(profile.trailingStopPct),
      maxHoldDays: profile.maxHoldDays === null ? '' : String(profile.maxHoldDays),
      exitMode: profile.exitMode,
      takeProfitBehavior: profile.takeProfitBehavior,
      enabled: profile.enabled,
    };
  }

  function emptyToNumberOrNull(value: string): number | null {
    const trimmed = value.trim();

    if (!trimmed) {
      return null;
    }

    const parsed = Number(trimmed);

    if (Number.isNaN(parsed)) {
      throw new Error(`Invalid number: ${value}`);
    }

    return parsed;
  }

  function emptyToIntOrNull(value: string): number | null {
    const parsed = emptyToNumberOrNull(value);

    if (parsed === null) {
      return null;
    }

    if (!Number.isInteger(parsed)) {
      throw new Error(`Expected whole number: ${value}`);
    }

    return parsed;
  }

  function buildExitProfilePayload(form: ExitProfileForm) {
    return {
      key: form.key.trim(),
      name: form.name.trim(),
      description: form.description.trim() || null,
      targetPct: emptyToNumberOrNull(form.targetPct),
      stopLossPct: emptyToNumberOrNull(form.stopLossPct),
      trailingStopPct: emptyToNumberOrNull(form.trailingStopPct),
      maxHoldDays: emptyToIntOrNull(form.maxHoldDays),
      exitMode: form.exitMode,
      takeProfitBehavior: form.takeProfitBehavior,
      enabled: form.enabled,
    };
  }

  function startCreatingExitProfile() {
    setCreatingExitProfile(true);
    setEditingExitProfileId(null);
    setExitProfileForm({
      key: '',
      name: '',
      description: '',
      targetPct: '',
      stopLossPct: '',
      trailingStopPct: '',
      maxHoldDays: '',
      exitMode: 'fixed_bracket',
      takeProfitBehavior: 'immediate',
      enabled: true,
    });
  }

  function startEditingExitProfile(profile: ExitProfile) {
    setCreatingExitProfile(false);
    setEditingExitProfileId(profile.id);
    setExitProfileForm(exitProfileToForm(profile));
  }

  function cancelExitProfileForm() {
    setCreatingExitProfile(false);
    setEditingExitProfileId(null);
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

      {/* {message && (
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
      )} */}

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
        <SummaryCard
          label="Open Orders"
          value={data?.openOrders.length ?? 0}
        />
      </section>
      


      <section className="card">
        <h2>Open Orders</h2>

        {!data?.openOrders.length ? (
          <p className="muted">No open orders.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Symbol</th>
                <th>Side</th>
                <th>Type</th>
                <th>Qty</th>
                <th>Filled</th>
                <th>Limit</th>
                <th>Status</th>
                <th>Submitted</th>
                <th>Actions</th>
              </tr>
            </thead>

            <tbody>
              {data?.openOrders.map((order) => {
                const filledQty = order.filled_qty ?? order.filledQty ?? '0';
                const limitPrice = order.limit_price ?? order.limitPrice ?? '—';
                const submittedAt = order.submitted_at ?? order.submittedAt ?? null;

                return (
                  <tr key={order.id}>
                    <td>{order.symbol}</td>
                    <td>{order.side}</td>
                    <td>{order.type}</td>
                    <td>{order.qty ?? '—'}</td>
                    <td>{filledQty}</td>
                    <td>{limitPrice}</td>
                    <td>{order.status}</td>
                    <td>
                      {submittedAt
                        ? new Date(submittedAt).toLocaleString()
                        : '—'}
                    </td>
                    <td>
                      <button
                        className="small-button danger"
                        onClick={() => handleCancelOrder(order.id, order.symbol)}
                      >
                        Cancel
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
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
                <th>Actions</th>
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
                  <td>
                    {isClosing || hasSellOrder ? (
                      <span className="status-pill warning">closing</span>
                    ) : (
                      position.status
                    )}
                  </td>
                  <td>
                    {isClosing || hasSellOrder ? (
                      <button className="small-button" disabled>
                        Sell pending
                      </button>
                    ) : (
                      <button
                        className="small-button danger"
                        onClick={() => handleClosePosition(position.symbol)}
                      >
                        Close
                      </button>
                    )}
                  </td>
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

      <section className="card">
        <div className="section-header">
          <h2>Exit Profiles</h2>
          <button className="small-button" onClick={startCreatingExitProfile}>
            New Exit Profile
          </button>
        </div>

        {creatingExitProfile && (
          <ExitProfileEditor
            form={exitProfileForm}
            setForm={setExitProfileForm}
            onSave={handleSaveExitProfile}
            onCancel={cancelExitProfileForm}
            isCreating={true}
          />
        )}

        {!data?.exitProfiles.length ? (
          <p className="muted">No exit profiles.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Key</th>
                <th>Target</th>
                <th>Stop</th>
                <th>Trail</th>
                <th>Mode</th>
                <th>Behavior</th>
                <th>Enabled</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {data.exitProfiles.map((profile) => (
                <Fragment key={profile.id}>
                  <tr>
                    <td>{profile.key}</td>
                    <td>{profile.targetPct ?? '—'}</td>
                    <td>{profile.stopLossPct ?? '—'}</td>
                    <td>{profile.trailingStopPct ?? '—'}</td>
                    <td>{profile.exitMode}</td>
                    <td>{profile.takeProfitBehavior}</td>
                    <td>{profile.enabled ? 'Yes' : 'No'}</td>
                    <td>
                      <button
                        className="small-button secondary"
                        onClick={() => startEditingExitProfile(profile)}
                      >
                        Edit
                      </button>
                    </td>
                  </tr>

                  {editingExitProfileId === profile.id && (
                    <tr>
                      <td colSpan={8}>
                        <ExitProfileEditor
                          form={exitProfileForm}
                          setForm={setExitProfileForm}
                          onSave={handleSaveExitProfile}
                          onCancel={cancelExitProfileForm}
                          isCreating={false}
                        />
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <p className="status">{status}</p>

      <ToastContainer
        position="top-right"
        autoClose={5000}
        hideProgressBar={false}
        newestOnTop
        closeOnClick
        pauseOnFocusLoss
        draggable
        pauseOnHover
        theme="dark"
      />

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


type ExitProfileEditorProps = {
  form: ExitProfileForm;
  setForm: React.Dispatch<React.SetStateAction<ExitProfileForm>>;
  onSave: () => void;
  onCancel: () => void;
  isCreating: boolean;
};

function ExitProfileEditor({
  form,
  setForm,
  onSave,
  onCancel,
  isCreating,
}: ExitProfileEditorProps) {
  return (
    <div className="inline-editor">
      <label>
        <span>Key</span>
        <input
          value={form.key}
          disabled={!isCreating}
          onChange={(event) =>
            setForm((current) => ({
              ...current,
              key: event.target.value,
            }))
          }
        />
      </label>

      <label>
        <span>Name</span>
        <input
          value={form.name}
          onChange={(event) =>
            setForm((current) => ({
              ...current,
              name: event.target.value,
            }))
          }
        />
      </label>

      <label className="wide-field">
        <span>Description</span>
        <input
          value={form.description}
          onChange={(event) =>
            setForm((current) => ({
              ...current,
              description: event.target.value,
            }))
          }
        />
      </label>

      <label>
        <span>Target %</span>
        <input
          value={form.targetPct}
          onChange={(event) =>
            setForm((current) => ({
              ...current,
              targetPct: event.target.value,
            }))
          }
        />
      </label>

      <label>
        <span>Stop %</span>
        <input
          value={form.stopLossPct}
          onChange={(event) =>
            setForm((current) => ({
              ...current,
              stopLossPct: event.target.value,
            }))
          }
        />
      </label>

      <label>
        <span>Trail %</span>
        <input
          value={form.trailingStopPct}
          onChange={(event) =>
            setForm((current) => ({
              ...current,
              trailingStopPct: event.target.value,
            }))
          }
        />
      </label>

      <label>
        <span>Max Hold Days</span>
        <input
          value={form.maxHoldDays}
          onChange={(event) =>
            setForm((current) => ({
              ...current,
              maxHoldDays: event.target.value,
            }))
          }
        />
      </label>

      <label>
        <span>Exit Mode</span>
        <select
          value={form.exitMode}
          onChange={(event) =>
            setForm((current) => ({
              ...current,
              exitMode: event.target.value,
            }))
          }
        >
          <option value="fixed_target">fixed_target</option>
          <option value="fixed_bracket">fixed_bracket</option>
          <option value="hybrid">hybrid</option>
          <option value="ai_assisted">ai_assisted</option>
        </select>
      </label>

      <label>
        <span>Take Profit Behavior</span>
        <select
          value={form.takeProfitBehavior}
          onChange={(event) =>
            setForm((current) => ({
              ...current,
              takeProfitBehavior: event.target.value,
            }))
          }
        >
          <option value="immediate">immediate</option>
          <option value="trail_after_target">trail_after_target</option>
          <option value="ai_confirm">ai_confirm</option>
        </select>
      </label>

      <label className="checkbox-row">
        <input
          type="checkbox"
          checked={form.enabled}
          onChange={(event) =>
            setForm((current) => ({
              ...current,
              enabled: event.target.checked,
            }))
          }
        />
        <span>Enabled</span>
      </label>

      <div className="editor-actions">
        <button className="small-button" onClick={onSave}>
          Save
        </button>
        <button className="small-button secondary" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}