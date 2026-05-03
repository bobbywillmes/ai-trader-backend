import { FormEvent, useEffect, useState } from 'react';
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
  const [data, setData] = useState<DashboardData | null>(null);
  const [status, setStatus] = useState('Checking session...');
  const [loading, setLoading] = useState(false);

  async function loadDashboard() {
    const [strategies, subscriptions, exitProfiles, trackedPositions] =
      await Promise.all([
        apiRequest<Strategy[]>('/api/strategies'),
        apiRequest<Subscription[]>('/api/subscriptions'),
        apiRequest<ExitProfile[]>('/api/exit-profiles'),
        apiRequest<TrackedPosition[]>('/api/tracked-positions'),
      ]);

    setData({
      strategies,
      subscriptions,
      exitProfiles,
      openPositions: trackedPositions.filter(
        (position) => position.status === 'open',
      ),
    });
  }

  async function checkSession() {
    const token = getAdminToken();

    if (!token) {
      setStatus('Not logged in.');
      return;
    }

    try {
      const me = await apiRequest<MeResponse>('/api/admin-auth/me');
      setAdminEmail(me.adminUser.email);
      setStatus('Logged in. Loading dashboard...');

      try {
        await loadDashboard();
        setStatus('Logged in.');
      } catch (error) {
        setData(null);
        setStatus(
          error instanceof Error
            ? `Logged in, but dashboard failed: ${error.message}`
            : 'Logged in, but dashboard failed.',
        );
      }
    } catch {
      clearAdminToken();
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
      setAdminEmail(response.adminUser.email);
      setStatus('Logged in. Loading dashboard...');

      try {
        await loadDashboard();
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
              </tr>
            </thead>
            <tbody>
              {data.subscriptions.map((subscription) => (
                <tr key={subscription.id}>
                  <td>{subscription.key}</td>
                  <td>{subscription.symbol}</td>
                  <td>
                    {subscription.sizingValue} {subscription.sizingType}
                  </td>
                  <td>{subscription.enabled ? 'Yes' : 'No'}</td>
                  <td>{subscription.exitProfile?.key ?? subscription.exitProfileId}</td>
                </tr>
              ))}
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