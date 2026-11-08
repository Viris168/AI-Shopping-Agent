import { useState, type FormEvent } from 'react';
import { Link, useLocation, useParams } from 'react-router';
import { api, ApiError } from '../api';
import { ErrorBox, Loading, Notice, StatusBadge } from '../components/ui';
import { formatDate } from '../format';
import type { OrderDetail, ReturnCreated } from '../types';
import { useAsync } from '../useAsync';

export function OrderPage() {
  const { orderNumber = '' } = useParams();
  const location = useLocation();
  const justPlaced = (location.state as { justPlaced?: boolean } | null)?.justPlaced;
  const order = useAsync(() => api.order(orderNumber), [orderNumber]);
  const [returned, setReturned] = useState<ReturnCreated>();

  if (order.error)
    return order.error instanceof ApiError && order.error.status === 404 ? (
      <div className="empty">
        <h1>Order not found</h1>
        <Link to="/orders">Back to your orders</Link>
      </div>
    ) : (
      <ErrorBox error={order.error} onRetry={order.reload} />
    );
  if (!order.data) return <Loading label="Loading order…" />;
  const o = order.data;
  const openReturn = o.returns.some((r) => r.status === 'REQUESTED' || r.status === 'APPROVED');

  return (
    <>
      <nav className="breadcrumbs" aria-label="Breadcrumb">
        <Link to="/orders">Orders</Link> <span aria-hidden="true">/</span> {o.orderNumber}
      </nav>
      {justPlaced && (
        <Notice>
          <strong>Thank you! Your order is placed and paid.</strong> We’ll let you know when it ships.
        </Notice>
      )}
      <div className="order-header">
        <h1>Order {o.orderNumber}</h1>
        <StatusBadge status={o.status} />
      </div>

      <div className="order-layout">
        <section aria-labelledby="items-heading">
          <h2 id="items-heading">Items</h2>
          <ul className="order-items">
            {o.items.map((i) => (
              <li key={i.orderItemId}>
                <span>
                  {i.quantity} × {i.name}
                </span>
                <span className="muted">{i.unitPrice} each</span>
              </li>
            ))}
          </ul>
          <dl className="totals">
            <div>
              <dt>Subtotal</dt>
              <dd>{o.subtotal}</dd>
            </div>
            {o.couponCode && (
              <div className="discount">
                <dt>Discount ({o.couponCode})</dt>
                <dd>−{o.discount}</dd>
              </div>
            )}
            <div>
              <dt>Shipping</dt>
              <dd>{o.shipping === '$0.00' ? 'Free' : o.shipping}</dd>
            </div>
            <div className="summary-total">
              <dt>Total</dt>
              <dd>{o.total}</dd>
            </div>
          </dl>
        </section>

        <aside className="order-side">
          <section className="panel">
            <h2>Details</h2>
            <dl className="details">
              <div>
                <dt>Placed</dt>
                <dd>{formatDate(o.placedAt)}</dd>
              </div>
              {o.shippedAt && (
                <div>
                  <dt>Shipped</dt>
                  <dd>{formatDate(o.shippedAt)}</dd>
                </div>
              )}
              {o.deliveredAt && (
                <div>
                  <dt>Delivered</dt>
                  <dd>{formatDate(o.deliveredAt)}</dd>
                </div>
              )}
              {o.carrier && (
                <div>
                  <dt>Carrier</dt>
                  <dd>{o.carrier}</dd>
                </div>
              )}
            </dl>
            {o.trackingUrl && (
              <a className="btn btn-small btn-ghost" href={o.trackingUrl} target="_blank" rel="noopener noreferrer">
                Track package
              </a>
            )}
          </section>

          <section className="panel">
            <h2>Returns</h2>
            {o.returns.length > 0 && (
              <ul className="return-list">
                {o.returns.map((r) => (
                  <li key={r.returnId}>
                    <StatusBadge status={r.status} /> <span className="muted">{formatDate(r.createdAt)}</span>
                  </li>
                ))}
              </ul>
            )}
            {returned && <Notice>{returned.nextSteps}</Notice>}
            {o.returnEligible && !openReturn && !returned ? (
              <ReturnForm
                order={o}
                onCreated={(r) => {
                  setReturned(r);
                  order.reload();
                }}
              />
            ) : (
              !returned && <p className="muted">{returnNote(o, openReturn)}</p>
            )}
          </section>
        </aside>
      </div>
    </>
  );
}

function returnNote(o: OrderDetail, openReturn: boolean): string {
  if (openReturn) return 'A return is already open for this order.';
  if (o.status !== 'DELIVERED') return 'You can start a return once the order is delivered.';
  return o.returnDeadline
    ? `The return window closed on ${formatDate(o.returnDeadline)}.`
    : 'This order can’t be returned.';
}

function ReturnForm({ order, onCreated }: { order: OrderDetail; onCreated: (r: ReturnCreated) => void }) {
  const [open, setOpen] = useState(false);
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  if (!open)
    return (
      <>
        <p className="muted">Return by {formatDate(order.returnDeadline)}.</p>
        <button type="button" className="btn btn-small" onClick={() => setOpen(true)}>
          Start a return
        </button>
      </>
    );

  const items = Object.entries(quantities)
    .filter(([, q]) => q > 0)
    .map(([orderItemId, quantity]) => ({ orderItemId, quantity }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (items.length === 0) {
      setError('Choose at least one item to return.');
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      onCreated(await api.createReturn(order.orderNumber, reason.trim(), items));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <form className="form" onSubmit={submit}>
      <fieldset>
        <legend>What are you returning?</legend>
        {order.items.map((i) => (
          <label key={i.orderItemId} className="return-item">
            <span>{i.name}</span>
            <select
              aria-label={`How many ${i.name} to return`}
              value={quantities[i.orderItemId] ?? 0}
              onChange={(e) => setQuantities({ ...quantities, [i.orderItemId]: Number(e.target.value) })}
            >
              {Array.from({ length: i.quantity + 1 }, (_, n) => (
                <option key={n} value={n}>
                  {n === 0 ? 'None' : `Return ${n}`}
                </option>
              ))}
            </select>
          </label>
        ))}
      </fieldset>
      <label>
        Reason
        <textarea required maxLength={500} rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
      </label>
      {error && <ErrorBox error={error} />}
      <div className="form-actions">
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy ? 'Sending…' : 'Request return'}
        </button>
        <button type="button" className="btn btn-ghost" onClick={() => setOpen(false)} disabled={busy}>
          Cancel
        </button>
      </div>
    </form>
  );
}
