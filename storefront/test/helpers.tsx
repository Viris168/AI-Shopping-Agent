import { render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { vi } from 'vitest';
import { AuthProvider } from '../src/auth';
import { CartProvider } from '../src/cart';

type Handler = (url: string, init: RequestInit) => { status?: number; body: unknown };

/** Replaces fetch with a router keyed by "METHOD /path" (path without /api/v1 and query). */
export function mockApi(routes: Record<string, Handler | unknown>) {
  const calls: { method: string; path: string; init: RequestInit }[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    const method = init.method ?? 'GET';
    const path = url.replace(/^.*\/api\/v1/, '').split('?')[0]!;
    calls.push({ method, path, init });
    const route = routes[`${method} ${path}`];
    if (route === undefined) return new Response(JSON.stringify({ message: `No mock for ${method} ${path}` }), { status: 500 });
    const { status = 200, body } = typeof route === 'function' ? (route as Handler)(url, init) : { body: route };
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls, fetchMock };
}

export function renderApp(ui: ReactNode, { path = '/' } = {}) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider>
        <CartProvider>{ui}</CartProvider>
      </AuthProvider>
    </MemoryRouter>,
  );
}

export const emptyCart = {
  items: [],
  itemCount: 0,
  couponCode: null,
  subtotalCents: 0,
  discountCents: 0,
  shippingCents: 0,
  totalCents: 0,
  subtotal: '$0.00',
  discount: '$0.00',
  shipping: '$0.00',
  total: '$0.00',
  freeShippingRemaining: null,
};
