import { useState } from 'react';
import { toast, ToastContainer } from 'react-toastify';
import { getAdminToken } from '../../lib/api';
import { useOpenOrders, useCancelOrder } from './hooks';

type MessageType = 'success' | 'error' | 'warning' | 'info';

function showMessage(text: string, type: MessageType = 'info') {
  if (type === 'success') { toast.success(text); return; }
  if (type === 'error') { toast.error(text); return; }
  if (type === 'warning') { toast.warning(text); return; }
  toast.info(text);
}

export function OrdersPage() {
  const [token] = useState<string | null>(() => getAdminToken());

  const {
    data: orders = [],
    isLoading,
    isError,
    error,
  } = useOpenOrders(token);

  const cancelOrderMutation = useCancelOrder(token);

  async function handleCancelOrder(orderId: string, symbol?: string) {
    const confirmed = window.confirm(
      `Cancel open order${symbol ? ` for ${symbol}` : ''}?`
    );
    if (!confirmed) return;

    try {
      await cancelOrderMutation.mutateAsync(orderId);
      showMessage(
        `Order canceled${symbol ? ` for ${symbol}` : ''}.`,
        'success'
      );
    } catch (err) {
      showMessage(
        err instanceof Error ? err.message : 'Failed to cancel order.',
        'error'
      );
    }
  }

  return (
    <section>
      <div className="page-header">
        <p className="eyebrow">AI Trader Admin</p>
        <h1>Open Orders</h1>
        <p className="muted">View and cancel open orders.</p>
      </div>

      <section className="card">
        <h2>Open Orders</h2>

        {isError && (
          <p className="error">
            {error instanceof Error
              ? error.message
              : 'Failed to load orders.'}
          </p>
        )}

        {isLoading && <p className="muted">Loading orders...</p>}

        {!isLoading && !orders.length && (
          <p className="muted">No open orders.</p>
        )}

        {orders.length > 0 && (
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
              {orders.map((order) => {
                const filledQty = order.filled_qty ?? order.filledQty ?? '0';
                const limitPrice = order.limit_price ?? order.limitPrice ?? '—';
                const submittedAt = order.submitted_at ?? order.submittedAt ?? null;
                const isCanceling =
                  cancelOrderMutation.isPending &&
                  cancelOrderMutation.variables === order.id;

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
                        disabled={isCanceling}
                        onClick={() =>
                          handleCancelOrder(order.id, order.symbol)
                        }
                      >
                        {isCanceling ? 'Canceling...' : 'Cancel'}
                      </button>
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
