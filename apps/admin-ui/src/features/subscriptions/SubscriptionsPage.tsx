import { useEffect, useState, Fragment } from 'react';

import type { ExitProfile, Subscription } from '../../types/api';
import { apiRequest, patchSubscription, getAdminToken } from '../../lib/api';
import { toast, ToastContainer } from 'react-toastify';


export function SubscriptionsPage() {
  const [token, setToken] = useState<string | null>(null);
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([]);
  const [exitProfiles, setExitProfiles] = useState<ExitProfile[]>([]);
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [editingSubscriptionId, setEditingSubscriptionId] = useState<number | null>(null);
  const [editSizingValue, setEditSizingValue] = useState("");
  const [editExitProfileKey, setEditExitProfileKey] = useState("");
  
  useEffect(() => {
    loadData();
  }, []);

  async function loadData() {
    const token = getAdminToken();
    setToken(token);
    setLoading(true);
    const [subscriptions, exitProfiles] = await Promise.all([
      apiRequest<Subscription[]>('/api/subscriptions', { token }),
      apiRequest<ExitProfile[]>('/api/exit-profiles', { token }),
    ]);
    setLoading(false);
    setSubscriptions(subscriptions);
    setExitProfiles(exitProfiles);
  }

  async function handleToggleSubscription(subscriptionId: number, enabled: boolean) {
  try {
    await patchSubscription(subscriptionId, { enabled }, token || '');

    showMessage(`Subscription ${enabled ? 'enabled' : 'disabled'}.`, 'info');

    await loadData();
  } catch (error) {
    setErrorMessage(
      error instanceof Error ? error.message : "Failed to toggle subscription"
    );
  }
  }

  function startEditingSubscription(subscription: Subscription) {
    setEditingSubscriptionId(subscription.id);
    setEditSizingValue(String(subscription.sizingValue ?? ''));
    setEditExitProfileKey(subscription.exitProfile?.key ?? '');
  }

  function cancelEditingSubscription() {
    setEditingSubscriptionId(null);
    setEditSizingValue('');
    setEditExitProfileKey('');
  }

  type MessageType = 'success' | 'error' | 'warning' | 'info';

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

  async function handleUpdateSubscription(subscriptionId: number) {
    if (!token) {
      showMessage('Admin session is missing. Please log in again.');
      return;
    }

    const parsedSizingValue = Number(editSizingValue);

    if (!Number.isFinite(parsedSizingValue) || parsedSizingValue <= 0) {
      showMessage('Sizing value must be a positive number.', 'error');
      return;
    }

    if (!editExitProfileKey) {
      showMessage('Exit profile is required.', 'error');
      return;
    }

    try {

      await apiRequest<Subscription>(`/api/subscriptions/${subscriptionId}`, {
        method: 'PATCH',
        token,
        body: {
          sizingValue: parsedSizingValue,
          exitProfileKey: editExitProfileKey,
        },
      });

      showMessage('Subscription updated.', 'info');
      cancelEditingSubscription();
      await loadData();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to update subscription.';
      showMessage(message, 'error');
    }
  }

  return (
    <section>
      <div className="page-header">
        <p className="eyebrow">AI Trader Admin</p>
        <h1>Subscriptions</h1>
        <p className="muted">
          View, edit, enable, and disable strategy subscriptions.
        </p>
      </div>

      <section className="card">
        <h2>Subscriptions</h2>

      {errorMessage && <p className="error">{errorMessage}</p>}

      {subscriptions.length === 0 && !loading && <p className="muted">No subscriptions.</p>}
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
            {subscriptions.map((subscription) => {
              const isEditing = editingSubscriptionId === subscription.id;

              return (
                <Fragment key={subscription.id}>
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
                              {exitProfiles.map((exitProfile) => (
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
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </section>

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

    </section>
  );
}



