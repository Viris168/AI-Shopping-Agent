import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RequireAuth } from '../src/components/RequireAuth';
import { LoginPage } from '../src/pages/AuthPages';
import { CartPage } from '../src/pages/CartPage';
import { emptyCart, mockApi, renderApp } from './helpers';

const session = {
  accessToken: 'tok',
  tokenType: 'Bearer',
  user: { id: 'u1', email: 'alice@example.com', name: 'Alice', role: 'CUSTOMER' },
};
const cartWithJacket = {
  ...emptyCart,
  items: [
    {
      productId: 'p1',
      sku: 'CLO-002',
      name: 'Packable Rain Jacket',
      quantity: 1,
      unitPrice: '$79.00',
      unitPriceCents: 7900,
      lineTotal: '$79.00',
      inStock: true,
    },
  ],
  itemCount: 1,
  subtotalCents: 7900,
  totalCents: 7900,
  subtotal: '$79.00',
  total: '$79.00',
};

beforeEach(() => localStorage.clear());
afterEach(() => vi.unstubAllGlobals());

describe('login', () => {
  it('sends guests to login and back to the page they wanted', async () => {
    mockApi({ 'POST /auth/login': session, 'GET /cart': emptyCart });
    renderApp(
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/orders" element={<RequireAuth><p>Your orders page</p></RequireAuth>} />
      </Routes>,
      { path: '/orders' },
    );
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Email'), 'alice@example.com');
    await user.type(screen.getByLabelText('Password'), 'Password123!');
    await user.click(screen.getByRole('button', { name: 'Log in' }));
    expect(await screen.findByText('Your orders page')).toBeTruthy();
    expect(localStorage.getItem('storefront.token')).toBe('tok');
  });

  it('shows the API error for a wrong password', async () => {
    mockApi({ 'POST /auth/login': () => ({ status: 401, body: { message: 'Wrong email or password' } }) });
    renderApp(<LoginPage />, { path: '/login' });
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Email'), 'alice@example.com');
    await user.type(screen.getByLabelText('Password'), 'nope');
    await user.click(screen.getByRole('button', { name: 'Log in' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Wrong email or password');
  });
});

describe('cart and Pay', () => {
  it('applies a coupon, pays, and opens the PAID order', async () => {
    localStorage.setItem('storefront.token', 'tok');
    localStorage.setItem('storefront.user', JSON.stringify(session.user));
    let paid = false;
    const { calls } = mockApi({
      'GET /cart': () => ({ body: paid ? emptyCart : cartWithJacket }),
      'POST /cart/coupon': {
        ...cartWithJacket,
        couponCode: 'WELCOME10',
        discountCents: 790,
        discount: '$7.90',
        totalCents: 7110,
        total: '$71.10',
      },
      'POST /checkout': () => {
        paid = true;
        return { status: 201, body: { orderNumber: 'ORD-2001', status: 'PAID' } };
      },
    });
    renderApp(
      <Routes>
        <Route path="/cart" element={<CartPage />} />
        <Route path="/orders/:orderNumber" element={<p>Order page</p>} />
      </Routes>,
      { path: '/cart' },
    );
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Coupon code'), 'welcome10');
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    expect(await screen.findByText('−$7.90')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Pay $71.10' }));
    expect(await screen.findByText('Order page')).toBeTruthy();
    await waitFor(() => expect(calls.filter((c) => c.path === '/checkout')).toHaveLength(1));
  });

  it('sends the shopper to the payment page when checkout returns one', async () => {
    localStorage.setItem('storefront.token', 'tok');
    const assign = vi.spyOn(window.location, 'assign').mockImplementation(() => undefined);
    mockApi({
      'GET /cart': cartWithJacket,
      'POST /checkout': () => ({
        status: 201,
        body: {
          orderNumber: 'ORD-2001',
          status: 'PENDING',
          checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_test_1',
        },
      }),
    });
    renderApp(
      <Routes>
        <Route path="/cart" element={<CartPage />} />
        <Route path="/orders/:orderNumber" element={<p>Order page</p>} />
      </Routes>,
      { path: '/cart' },
    );
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Pay $79.00' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://checkout.stripe.com/c/pay/cs_test_1'));
    expect(screen.getByRole('button', { name: 'Going to payment…' })).toHaveProperty('disabled', true);
    expect(screen.queryByText('Order page')).toBeNull();
    assign.mockRestore();
  });

  it('keeps the shopper on the cart when Pay fails', async () => {
    localStorage.setItem('storefront.token', 'tok');
    mockApi({
      'GET /cart': cartWithJacket,
      'POST /checkout': () => ({ status: 400, body: { message: 'Only 0 of "Packable Rain Jacket" in stock' } }),
    });
    renderApp(<CartPage />, { path: '/cart' });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Pay $79.00' }));
    expect((await screen.findByRole('alert')).textContent).toContain('in stock');
    expect(screen.getByRole('button', { name: 'Pay $79.00' })).toBeTruthy();
  });
});
