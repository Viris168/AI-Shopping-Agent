import { act, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuth } from '../src/auth';
import { ChatWidget } from '../src/components/ChatWidget';
import { emptyCart, mockApi, renderApp } from './helpers';

const session = {
  user: { id: 'u1', email: 'alice@example.com', name: 'Alice', role: 'CUSTOMER' },
  expiresAt: '2030-01-01T00:00:00.000Z',
};

let auth: ReturnType<typeof useAuth>;
function Harness() {
  auth = useAuth();
  return <ChatWidget />;
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  document.getElementById('shopchat-script')?.remove();
  delete window.ShopChat;
});
afterEach(() => vi.unstubAllGlobals());

describe('chat widget', () => {
  it('adds the widget script once, pointed at this store', () => {
    mockApi({});
    renderApp(<Harness />);
    const scripts = document.querySelectorAll<HTMLScriptElement>('#shopchat-script');
    expect(scripts).toHaveLength(1);
    expect(scripts[0]!.src).toMatch(/\/widget\.js$/);
    expect(scripts[0]!.dataset.store).toBe('main');
    expect(scripts[0]!.dataset.api).toBe(location.origin);
  });

  it('gives the widget a short-lived chat token, never the session', async () => {
    let issued = 0;
    const { calls } = mockApi({
      'POST /auth/login': session,
      'POST /auth/logout': () => ({ status: 204, body: null }),
      'POST /auth/agent-token': () => ({
        body: { token: `chat-${++issued}`, expiresAt: new Date(Date.now() + 15 * 60_000).toISOString() },
      }),
      'GET /cart': emptyCart,
    });
    renderApp(<Harness />);
    expect(await window.ShopChat?.getToken?.()).toBeNull();
    await act(() => auth.login('alice@example.com', 'Password123!'));
    expect(await window.ShopChat?.getToken?.()).toBe('chat-1');
    // Cached until shortly before it expires; concurrent asks share one request.
    await Promise.all([window.ShopChat?.getToken?.(), window.ShopChat?.getToken?.()]);
    expect(calls.filter((c) => c.path === '/auth/agent-token')).toHaveLength(1);
    act(() => auth.logout());
    expect(calls.some((c) => c.method === 'POST' && c.path === '/auth/logout')).toBe(true);
    expect(await window.ShopChat?.getToken?.()).toBeNull();
    // The next shopper gets a new token, not the cached one.
    await act(() => auth.login('alice@example.com', 'Password123!'));
    expect(await window.ShopChat?.getToken?.()).toBe('chat-2');
  });

  it('chats as a guest when no chat token is issued (e.g. staff accounts)', async () => {
    localStorage.setItem('storefront.user', JSON.stringify(session.user));
    mockApi({
      'POST /auth/agent-token': () => ({ status: 403, body: { message: 'The assistant is for shopper accounts only' } }),
      'GET /cart': emptyCart,
    });
    renderApp(<Harness />);
    expect(await window.ShopChat?.getToken?.()).toBeNull();
  });

  it('reloads the cart when the agent changes it', async () => {
    localStorage.setItem('storefront.user', JSON.stringify(session.user));
    const { calls } = mockApi({ 'GET /cart': emptyCart });
    renderApp(<Harness />);
    await waitFor(() => expect(calls.filter((c) => c.path === '/cart')).toHaveLength(1));
    window.dispatchEvent(new CustomEvent('shopchat:cart-updated', { detail: { itemCount: 1 } }));
    await waitFor(() => expect(calls.filter((c) => c.path === '/cart')).toHaveLength(2));
  });

  it('clears the chat on logout but keeps it when a guest logs in', async () => {
    mockApi({
      'POST /auth/login': session,
      'POST /auth/logout': () => ({ status: 204, body: null }),
      'GET /cart': emptyCart,
    });
    renderApp(<Harness />);
    const reset = vi.fn();
    window.ShopChat!.reset = reset;
    await act(() => auth.login('alice@example.com', 'Password123!'));
    expect(reset).not.toHaveBeenCalled();
    act(() => auth.logout());
    expect(reset).toHaveBeenCalledOnce();
  });

  it('docks the panel, and the page makes room while it is open', () => {
    mockApi({});
    renderApp(<Harness />);
    expect(document.querySelector<HTMLScriptElement>('#shopchat-script')!.dataset.layout).toBe('docked');
    act(() => void window.dispatchEvent(new CustomEvent('shopchat:ready', { detail: { open: true } })));
    expect(document.body.classList.contains('chat-docked')).toBe(true);
    act(() => void window.dispatchEvent(new CustomEvent('shopchat:close')));
    expect(document.body.classList.contains('chat-docked')).toBe(false);
    act(() => void window.dispatchEvent(new CustomEvent('shopchat:open')));
    expect(document.body.classList.contains('chat-docked')).toBe(true);
    act(() => void window.dispatchEvent(new CustomEvent('shopchat:close')));
  });
});
