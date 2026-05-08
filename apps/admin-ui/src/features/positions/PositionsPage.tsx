import { useState } from 'react';
import { toast, ToastContainer } from 'react-toastify';
import { getAdminToken } from '../../lib/api';
import { useOpenPositions, useClosePosition } from './hooks';

type MessageType = 'success' | 'error' | 'warning' | 'info';

function showMessage(text: string, type: MessageType = 'info') {
  if (type === 'success') { toast.success(text); return; }
  if (type === 'error') { toast.error(text); return; }
  if (type === 'warning') { toast.warning(text); return; }
  toast.info(text);
}

export function PositionsPage() {
  const [token] = useState<string | null>(() => getAdminToken());

  const {
    data: positions = [],
    isLoading,
    isError,
    error,
  } = useOpenPositions(token);

  const closePositionMutation = useClosePosition(token);

  async function handleClosePosition(symbol: string) {
    const confirmed = window.confirm(`Submit sell order to close ${symbol}?`);
    if (!confirmed) return;

    try {
      await closePositionMutation.mutateAsync(symbol);
      showMessage(`Close order submitted for ${symbol}.`, 'success');
    } catch (err) {
      showMessage(
        err instanceof Error ? err.message : `Failed to close ${symbol}.`,
        'error'
      );
    }
  }

  return (
    <section>
      <div className="page-header">
        <p className="eyebrow">AI Trader Admin</p>
        <h1>Open Positions</h1>
        <p className="muted">View and close open tracked positions.</p>
      </div>

      <section className="card">
        <h2>Open Positions</h2>

        {isError && (
          <p className="error">
            {error instanceof Error
              ? error.message
              : 'Failed to load positions.'}
          </p>
        )}

        {isLoading && <p className="muted">Loading positions...</p>}

        {!isLoading && !positions.length && (
          <p className="muted">No open positions.</p>
        )}

        {positions.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>Symbol</th>
                <th>Side</th>
                <th>Qty</th>
                <th>Avg Entry</th>
                <th>Current</th>
                <th>P/L</th>
                <th>P/L %</th>
                <th>Status</th>
                <th>Subscription</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {positions.map((position) => {
                const isClosing =
                  closePositionMutation.isPending &&
                  closePositionMutation.variables === position.symbol;

                return (
                  <tr key={position.id}>
                    <td>{position.symbol}</td>
                    <td>{position.side}</td>
                    <td>{position.qty}</td>
                    <td>{position.avgEntryPrice.toFixed(2)}</td>
                    <td>{position.currentPrice.toFixed(2)}</td>
                    <td>{position.unrealizedPnL.toFixed(2)}</td>
                    <td>{position.unrealizedPnLPct.toFixed(2)}%</td>
                    <td>
                      {isClosing ? (
                        <span className="status-pill warning">closing</span>
                      ) : (
                        position.status
                      )}
                    </td>
                    <td>{position.subscription?.key ?? '—'}</td>
                    <td>
                      {isClosing ? (
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
                );
              })}
            </tbody>
          </table>
        )}
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
