import { act, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuth } from '../src/auth';
import { ChatWidget } from '../src/components/ChatWidget';
import { emptyCart, mockApi, renderApp } from './helpers';

const session = {
  accessToken: 'tok',
  tokenType: 'Bearer',
  user: { id: 'u1', email: 'alice@example.com', name: 'Alice', role: 'CUSTOMER' },
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

  it('gives the widget the current shopper token', async () => {
    mockApi({ 'POST /auth/login': session, 'GET /cart': emptyCart });
    renderApp(<Harness />);
    expect(window.ShopChat?.getToken?.()).toBeNull();
    await act(() => auth.login('alice@example.com', 'Password123!'));
    expect(window.ShopChat?.getToken?.()).toBe('tok');
    act(() => auth.logout());
    expect(window.ShopChat?.getToken?.()).toBeNull();
  });

  it('reloads the cart when the agent changes it', async () => {
    localStorage.setItem('storefront.token', 'tok');
    localStorage.setItem('storefront.user', JSON.stringify(session.user));
    const { calls } = mockApi({ 'GET /cart': emptyCart });
    renderApp(<Harness />);
    await waitFor(() => expect(calls.filter((c) => c.path === '/cart')).toHaveLength(1));
    window.dispatchEvent(new CustomEvent('shopchat:cart-updated', { detail: { itemCount: 1 } }));
    await waitFor(() => expect(calls.filter((c) => c.path === '/cart')).toHaveLength(2));
  });

  it('clears the chat on logout but keeps it when a guest logs in', async () => {
    mockApi({ 'POST /auth/login': session, 'GET /cart': emptyCart });
    renderApp(<Harness />);
    const reset = vi.fn();
    window.ShopChat!.reset = reset;
    await act(() => auth.login('alice@example.com', 'Password123!'));
    expect(reset).not.toHaveBeenCalled();
    act(() => auth.logout());
    expect(reset).toHaveBeenCalledOnce();
  });
});
