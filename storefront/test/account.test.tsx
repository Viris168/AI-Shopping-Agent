import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountPage } from '../src/pages/AccountPage';
import { emptyCart, mockApi, renderApp } from './helpers';

const user = { id: 'u1', email: 'alice@example.com', name: 'Alice', role: 'CUSTOMER' };
const fact = { id: 'f1', kind: 'size', value: 'M', updatedAt: '2026-11-03T10:00:00.000Z' };
const episode = {
  id: 'e1',
  conversationId: 'c1',
  summary: 'Shopper asked: return the shirt <b>now</b> | Order: ORD-1001',
  outcome: 'resolved',
  createdAt: '2026-11-03T10:00:00.000Z',
};
const off = { enabled: false, facts: [], episodes: [] };
const on = { enabled: true, facts: [fact], episodes: [episode] };

beforeEach(() => localStorage.setItem('storefront.user', JSON.stringify(user)));
afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
});

const page = () => renderApp(<AccountPage />, { path: '/account' });
const sent = (calls: { method: string; path: string; init: RequestInit }[], method: string) =>
  calls.filter((c) => c.method === method && c.path.startsWith('/account/memory'));

describe('account page: assistant memory', () => {
  it('is off by default and the shopper can switch it on', async () => {
    const { calls } = mockApi({
      'GET /cart': emptyCart,
      'GET /account/memory': off,
      'PUT /account/memory': { ...off, enabled: true },
    });
    page();
    const toggle = await screen.findByRole('switch', { name: /remember my preferences/ });
    expect((toggle as HTMLInputElement).checked).toBe(false);
    expect(screen.getAllByText('Nothing saved.')).toHaveLength(2);

    await userEvent.setup().click(toggle);
    await waitFor(() => expect((toggle as HTMLInputElement).checked).toBe(true));
    expect(JSON.parse(String(sent(calls, 'PUT')[0]!.init.body))).toEqual({ enabled: true });
    expect(screen.getByRole('status').textContent).toContain('Memory is on');
  });

  it('lists what is remembered as text and forgets one preference', async () => {
    let view: typeof on = on;
    const { calls } = mockApi({
      'GET /cart': emptyCart,
      'GET /account/memory': () => ({ body: view }),
      'DELETE /account/memory/facts/f1': () => {
        view = { ...on, facts: [] };
        return { status: 204, body: null };
      },
    });
    page();
    const list = await screen.findByText('M');
    expect(list.closest('li')!.textContent).toContain('Size:');
    // Summaries are text, never HTML.
    expect(screen.getByText(/return the shirt <b>now<\/b>/)).toBeTruthy();
    expect(document.querySelector('.memory-list b')).toBeNull();

    await userEvent.setup().click(screen.getByRole('button', { name: 'Forget Size: M' }));
    await waitFor(() => expect(screen.queryByText('M')).toBeNull());
    expect(sent(calls, 'DELETE').map((c) => c.path)).toEqual(['/account/memory/facts/f1']);
  });

  it('asks before switching off, which deletes everything', async () => {
    const confirm = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
    vi.stubGlobal('confirm', confirm);
    const { calls } = mockApi({
      'GET /cart': emptyCart,
      'GET /account/memory': on,
      'PUT /account/memory': off,
    });
    page();
    const toggle = await screen.findByRole('switch');
    const click = userEvent.setup();

    await click.click(toggle); // cancelled
    expect(sent(calls, 'PUT')).toHaveLength(0);
    expect((toggle as HTMLInputElement).checked).toBe(true);

    await click.click(toggle);
    await waitFor(() => expect((toggle as HTMLInputElement).checked).toBe(false));
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(screen.getAllByText('Nothing saved.')).toHaveLength(2);
    expect(screen.getByRole('status').textContent).toContain('everything was deleted');
  });

  it('deletes everything after confirming, and shows API errors as-is', async () => {
    vi.stubGlobal('confirm', vi.fn(() => true));
    mockApi({
      'GET /cart': emptyCart,
      'GET /account/memory': on,
      'DELETE /account/memory': () => ({ status: 500, body: { message: 'The store is busy' } }),
    });
    page();
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Delete everything' }));
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('The store is busy')).toBeTruthy();
  });
});
