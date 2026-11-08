import { useEffect, useState, type FormEvent } from 'react';
import { Link, useLocation, useParams, useSearchParams } from 'react-router';
import { api, ApiError } from '../api';
import { useCart } from '../cart';
import { ErrorBox, Loading, Notice, StatusBadge } from '../components/ui';
import { formatDate } from '../format';
import type { OrderDetail, ReturnCreated } from '../types';
import { useAsync } from '../useAsync';

// Stripe sends the shopper back before its webhook marks the order PAID; poll until it does.
export const PAYMENT_POLL_MS = 2000;
const PAYMENT_POLL_TRIES = 15;

export function OrderPage() {
  const { orderNumber = '' } = useParams();
  const location = useLocation();
  const justPlaced = (location.state as { justPlaced?: boolean } | null)?.justPlaced;
  // Set by Stripe's return URLs (?payment=success|cancelled). Only picks the message;
  // whether the order is paid always comes from its status.
  const [params] = useSearchParams();
  const { refresh: refreshCart } = useCart();
  const payment = params.get('payment');
  const order = useAsync(() => api.order(orderNumber), [orderNumber]);
  const [returned, setReturned] = useState<ReturnCreated>();
  const [stillConfirming, setStillConfirming] = useState(false);
  // Why the order stopped being PENDING when the shopper tried to resume payment.
  const [settledMessage, setSettledMessage] = useState<string>();

  const status = order.data?.status;
  const { setData } = order;
  useEffect(() => {
    if (payment !== 'success' || status !== 'PENDING') return;
    let tries = 0;
    const timer = setInterval(() => {
      tries++;
      // Quiet refresh: keep showing the order while checking.
      api.order(orderNumber).then(setData, () => undefined);
      if (tries >= PAYMENT_POLL_TRIES) {
        clearInterval(timer);
        setStillConfirming(true);
      }
    }, PAYMENT_POLL_MS);
    return () => clearInterval(timer);
  }, [payment, status, orderNumber, setData]);

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
      {(justPlaced || payment === 'success') && o.status === 'PAID' && (
        <Notice>
          <strong>Thank you! Your order is placed and paid.</strong> We’ll let you know when it ships.
        </Notice>
      )}
      {o.status === 'PENDING' && (
        <PendingNotice
          orderNumber={o.orderNumber}
          payment={payment}
          stillConfirming={stillConfirming}
          onSettled={(message) => {
            setSettledMessage(message);
            order.reload();
            void refreshCart(); // a cancelled order puts its items back in the cart
          }}
        />
      )}
      {settledMessage && <Notice tone="info">{settledMessage}</Notice>}
      {payment === 'cancelled' && o.status === 'CANCELLED' && (
        <Notice tone="info">This order was cancelled because it wasn’t paid. You haven’t been charged.</Notice>
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

function PendingNotice({
  orderNumber,
  payment,
  stillConfirming,
  onSettled,
}: {
  orderNumber: string;
  payment: string | null;
  stillConfirming: boolean;
  onSettled: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  if (payment === 'success')
    return (
      <Notice tone="info">
        {stillConfirming ? (
          <>
            <strong>We’re still confirming your payment.</strong> This can take a few minutes. Refresh this
            page or check <Link to="/orders">your orders</Link> later.
          </>
        ) : (
          <>
            <strong>Payment received.</strong> Confirming it with the payment provider…
          </>
        )}
      </Notice>
    );

  const resume = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const { checkoutUrl } = await api.resumePayment(orderNumber);
      // Busy stays set so the button can't be clicked again while Stripe loads.
      window.location.assign(checkoutUrl);
    } catch (err) {
      setBusy(false);
      // 409: the order was settled instead (paid or cancelled); show why and reload it.
      if (err instanceof ApiError && err.status === 409) onSettled(err.message);
      else setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <Notice tone="info">
      {payment === 'cancelled' ? (
        <>
          <strong>Payment wasn’t completed</strong>, so you haven’t been charged.
        </>
      ) : (
        'This order is waiting for payment.'
      )}{' '}
      Your items are held for 30 minutes after placing the order; after that it’s cancelled automatically.
      <div className="notice-actions">
        <button type="button" className="btn btn-small btn-primary" onClick={resume} disabled={busy}>
          {busy ? 'Going to payment…' : 'Complete payment'}
        </button>
      </div>
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
    </Notice>
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
