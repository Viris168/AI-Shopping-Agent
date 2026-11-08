import { Link } from 'react-router';
import { api } from '../api';
import { ErrorBox, Loading, StatusBadge } from '../components/ui';
import { formatDate } from '../format';
import { useAsync } from '../useAsync';

export function OrdersPage() {
  const orders = useAsync(() => api.orders(), []);

  if (orders.error) return <ErrorBox error={orders.error} onRetry={orders.reload} />;
  if (!orders.data) return <Loading label="Loading your orders…" />;
  if (orders.data.length === 0)
    return (
      <div className="empty">
        <h1>No orders yet</h1>
        <Link to="/" className="btn btn-primary">
          Start shopping
        </Link>
      </div>
    );

  return (
    <>
      <h1>Your orders</h1>
      <ul className="order-list">
        {orders.data.map((o) => (
          <li key={o.orderNumber}>
            <Link to={`/orders/${o.orderNumber}`} className="order-row">
              <span className="order-number">{o.orderNumber}</span>
              <span className="muted">{formatDate(o.placedAt)}</span>
              <span className="muted">
                {o.itemCount} {o.itemCount === 1 ? 'item' : 'items'}
              </span>
              <span className="order-total">{o.total}</span>
              <StatusBadge status={o.status} />
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}
