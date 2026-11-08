import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, configureApi } from '../src/api';
import { safeNext } from '../src/components/RequireAuth';
import { mockApi } from './helpers';

afterEach(() => {
  vi.unstubAllGlobals();
  configureApi(() => null, () => {});
});

describe('api client', () => {
  it('sends the bearer token and JSON body', async () => {
    const { calls } = mockApi({ 'POST /cart/items': { itemCount: 1 } });
    configureApi(() => 'tok', () => {});
    await api.addToCart('SHOE-001', 2);
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer tok');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ productId: 'SHOE-001', quantity: 2 });
  });

  it('builds query strings and skips empty values', async () => {
    const { fetchMock } = mockApi({ 'GET /products': { total: 0, items: [] } });
    await api.products({ q: 'rain jacket', category: undefined, inStock: true, limit: 12 });
    expect(String(fetchMock.mock.calls[0]![0])).toBe('/api/v1/products?q=rain+jacket&inStock=true&limit=12');
  });

  it('turns API errors into readable messages', async () => {
    mockApi({
      'POST /cart/coupon': () => ({ status: 400, body: { message: 'Coupon is invalid or expired' } }),
      'POST /auth/register': () => ({ status: 400, body: { message: ['Please enter a valid email address', 'Password must be at least 8 characters'] } }),
    });
    await expect(api.applyCoupon('OLD2023')).rejects.toMatchObject({ status: 400, message: 'Coupon is invalid or expired' });
    await expect(api.register('A', 'x', 'y')).rejects.toThrow('Please enter a valid email address. Password must be at least 8 characters');
  });

  it('signs out when a logged-in request gets 401', async () => {
    mockApi({ 'GET /cart': () => ({ status: 401, body: { message: 'Invalid or expired token' } }) });
    const onUnauthorized = vi.fn();
    configureApi(() => 'expired', onUnauthorized);
    await expect(api.cart()).rejects.toBeInstanceOf(ApiError);
    expect(onUnauthorized).toHaveBeenCalledOnce();
  });

  it('reports network failures in plain words', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    await expect(api.categories()).rejects.toThrow(/Can’t reach the store/);
  });
});

describe('safeNext', () => {
  it('only allows same-site paths', () => {
    expect(safeNext('/orders/ORD-1001')).toBe('/orders/ORD-1001');
    expect(safeNext('//evil.example')).toBe('/');
    expect(safeNext('https://evil.example')).toBe('/');
    expect(safeNext(null)).toBe('/');
  });
});
