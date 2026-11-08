import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OrderPage, PAYMENT_POLL_MS } from '../src/pages/OrderPage';
import { emptyCart, mockApi, renderApp } from './helpers';

const order = (status: string) => ({
  orderNumber: 'ORD-2001',
  status,
  placedAt: '2026-11-09T10:00:00Z',
  total: '$79.00',
  totalCents: 7900,
  itemCount: 1,
  carrier: null,
  trackingNumber: null,
  trackingUrl: null,
  shippedAt: null,
  deliveredAt: null,
  returnEligible: false,
  returnDeadline: null,
  couponCode: null,
  subtotal: '$79.00',
  discount: '$0.00',
  shipping: '$0.00',
  items: [{ orderItemId: 'i1', productId: 'p1', name: 'Packable Rain Jacket', quantity: 1, unitPrice: '$79.00', unitPriceCents: 7900 }],
  returns: [],
});

function open(query: string) {
  renderApp(
    <Routes>
      <Route path="/orders/:orderNumber" element={<OrderPage />} />
    </Routes>,
    { path: `/orders/ORD-2001${query}` },
  );
}

// Stripe's return URLs (commerce-api PaymentsService.createSession).
describe('returning from the payment page', () => {
  beforeEach(() => {
    localStorage.setItem('storefront.token', 'tok');
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('waits for the webhook, then thanks the shopper', async () => {
    const statuses = ['PENDING', 'PENDING', 'PAID'];
    const { calls } = mockApi({ 'GET /orders/ORD-2001': () => ({ body: order(statuses.shift() ?? 'PAID') }) });
    open('?payment=success');
    expect(await screen.findByText(/Confirming it with the payment provider/)).toBeTruthy();
    expect(screen.queryByText(/placed and paid/)).toBeNull();

    await act(() => vi.advanceTimersByTimeAsync(PAYMENT_POLL_MS * 2));
    expect(await screen.findByText(/placed and paid/)).toBeTruthy();
    expect(screen.queryByText(/Confirming it/)).toBeNull();

    // Polling stops once the order is paid.
    const fetched = calls.length;
    await act(() => vi.advanceTimersByTimeAsync(PAYMENT_POLL_MS * 3));
    expect(calls.length).toBe(fetched);
  });

  it('says so when confirmation takes too long', async () => {
    mockApi({ 'GET /orders/ORD-2001': order('PENDING') });
    open('?payment=success');
    await screen.findByText(/Confirming it/);
    await act(() => vi.advanceTimersByTimeAsync(PAYMENT_POLL_MS * 15));
    expect(await screen.findByText(/still confirming your payment/)).toBeTruthy();
  });

  it('doesn’t trust ?payment=success on its own', async () => {
    mockApi({ 'GET /orders/ORD-2001': order('CANCELLED') });
    open('?payment=success');
    await screen.findByText('Order ORD-2001');
    expect(screen.queryByText(/placed and paid/)).toBeNull();
    expect(screen.queryByText(/Confirming it/)).toBeNull();
  });

  it('explains a cancelled payment', async () => {
    mockApi({ 'GET /orders/ORD-2001': order('PENDING') });
    open('?payment=cancelled');
    expect(await screen.findByText(/Payment wasn’t completed/)).toBeTruthy();
    expect(screen.queryByText(/placed and paid/)).toBeNull();
  });

  it('sends the shopper back to Stripe from the Complete payment button', async () => {
    const assign = vi.spyOn(window.location, 'assign').mockImplementation(() => undefined);
    mockApi({
      'GET /orders/ORD-2001': order('PENDING'),
      'POST /orders/ORD-2001/payment': { checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_test_1' },
    });
    open('?payment=cancelled');
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await user.click(await screen.findByRole('button', { name: 'Complete payment' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://checkout.stripe.com/c/pay/cs_test_1'));
    expect(screen.getByRole('button', { name: 'Going to payment…' })).toHaveProperty('disabled', true);
    assign.mockRestore();
  });

  it('shows why when the order was settled instead, and reloads it', async () => {
    let status = 'PENDING';
    const { calls } = mockApi({
      'GET /orders/ORD-2001': () => ({ body: order(status) }),
      'GET /cart': emptyCart,
      'POST /orders/ORD-2001/payment': () => {
        status = 'CANCELLED';
        return {
          status: 409,
          body: { message: 'This payment link has expired, so the order was cancelled. Its items are back in your cart.' },
        };
      },
    });
    open('');
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const cartLoads = () => calls.filter((c) => c.path === '/cart').length;
    const button = await screen.findByRole('button', { name: 'Complete payment' });
    await waitFor(() => expect(cartLoads()).toBeGreaterThan(0)); // CartProvider's first load
    const before = cartLoads();
    await user.click(button);
    expect(await screen.findByText(/items are back in your cart/)).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Complete payment' })).toBeNull());
    expect(cartLoads()).toBeGreaterThan(before); // header cart count picks up the restored items
    expect(calls.some((c) => c.method === 'POST' && c.path === '/orders/ORD-2001/payment')).toBe(true);
  });
});
