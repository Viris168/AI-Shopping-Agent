import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { api } from '../api';
import { useCart } from '../cart';
import { ErrorBox, Loading } from '../components/ui';
import type { Cart } from '../types';

export function CartPage() {
  const { cart, loading, setCart, refresh } = useCart();
  const navigate = useNavigate();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string>();
  const [coupon, setCoupon] = useState('');
  const [couponError, setCouponError] = useState<string>();

  /** Runs a cart change; `key` marks which control is busy. */
  const change = async (key: string, action: () => Promise<Cart>) => {
    setBusy(key);
    setError(undefined);
    try {
      setCart(await action());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const applyCoupon = async (e: FormEvent) => {
    e.preventDefault();
    if (!coupon.trim()) return;
    setBusy('coupon');
    setCouponError(undefined);
    try {
      setCart(await api.applyCoupon(coupon.trim()));
      setCoupon('');
    } catch (err) {
      setCouponError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const pay = async () => {
    setBusy('pay');
    setError(undefined);
    try {
      const order = await api.checkout();
      await refresh();
      navigate(`/orders/${order.orderNumber}`, { state: { justPlaced: true } });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(null);
      void refresh(); // stock may have changed
    }
  };

  if (!cart) return loading ? <Loading label="Loading your cart…" /> : <ErrorBox error="Couldn’t load your cart." onRetry={() => void refresh()} />;

  if (cart.items.length === 0)
    return (
      <div className="empty">
        <h1>Your cart is empty</h1>
        <Link to="/" className="btn btn-primary">
          Start shopping
        </Link>
      </div>
    );

  const unavailable = cart.items.some((i) => !i.inStock);

  return (
    <>
      <h1>Your cart</h1>
      <div className="cart-layout">
        <section aria-label="Items">
          <ul className="cart-items">
            {cart.items.map((item) => (
              <li key={item.productId} className="cart-item">
                <div className="cart-item-info">
                  <Link to={`/products/${item.sku.toLowerCase()}`} className="cart-item-name">
                    {item.name}
                  </Link>
                  <span className="muted">{item.unitPrice} each</span>
                  {!item.inStock && <span className="stock stock-out">Not enough stock for this quantity</span>}
                </div>
                <div className="qty" role="group" aria-label={`Quantity of ${item.name}`}>
                  <button
                    type="button"
                    aria-label="Decrease quantity"
                    disabled={busy !== null || item.quantity <= 1}
                    onClick={() => change(item.productId, () => api.updateCartItem(item.productId, item.quantity - 1))}
                  >
                    −
                  </button>
                  <span aria-live="polite">{item.quantity}</span>
                  <button
                    type="button"
                    aria-label="Increase quantity"
                    disabled={busy !== null || item.quantity >= 20}
                    onClick={() => change(item.productId, () => api.updateCartItem(item.productId, item.quantity + 1))}
                  >
                    +
                  </button>
                </div>
                <span className="cart-item-total">{item.lineTotal}</span>
                <button
                  type="button"
                  className="btn btn-small btn-ghost"
                  disabled={busy !== null}
                  onClick={() => change(item.productId, () => api.removeCartItem(item.productId))}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
          {error && <ErrorBox error={error} />}
        </section>

        <aside className="summary" aria-label="Order summary">
          <h2>Summary</h2>
          <dl>
            <div>
              <dt>Subtotal</dt>
              <dd>{cart.subtotal}</dd>
            </div>
            {cart.couponCode && (
              <div className="discount">
                <dt>Discount ({cart.couponCode})</dt>
                <dd>{cart.discountCents > 0 ? `−${cart.discount}` : 'Not applied'}</dd>
              </div>
            )}
            <div>
              <dt>Shipping</dt>
              <dd>{cart.shippingCents === 0 ? 'Free' : cart.shipping}</dd>
            </div>
            <div className="summary-total">
              <dt>Total</dt>
              <dd>{cart.total}</dd>
            </div>
          </dl>
          {cart.freeShippingRemaining && <p className="hint">Add {cart.freeShippingRemaining} more for free shipping.</p>}
          {cart.couponCode && cart.discountCents === 0 && cart.subtotalCents > 0 && (
            <p className="hint">Coupon {cart.couponCode} no longer applies to this cart.</p>
          )}

          <form className="coupon-form" onSubmit={applyCoupon}>
            <label htmlFor="coupon">Coupon code</label>
            <div className="inline-field">
              <input
                id="coupon"
                value={coupon}
                maxLength={40}
                autoComplete="off"
                onChange={(e) => setCoupon(e.target.value)}
                aria-invalid={couponError ? true : undefined}
                aria-describedby={couponError ? 'coupon-error' : undefined}
              />
              <button type="submit" className="btn btn-small btn-ghost" disabled={busy !== null || !coupon.trim()}>
                Apply
              </button>
            </div>
            {couponError && (
              <p id="coupon-error" className="field-error" role="alert">
                {couponError}
              </p>
            )}
          </form>

          <button type="button" className="btn btn-primary btn-block" onClick={pay} disabled={busy !== null || unavailable}>
            {busy === 'pay' ? 'Placing order…' : `Pay ${cart.total}`}
          </button>
          <p className="hint">Demo store: no card needed. Your order is marked paid right away.</p>
        </aside>
      </div>
    </>
  );
}
