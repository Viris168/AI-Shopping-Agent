import { useEffect, useRef } from 'react';
import { api } from '../api';
import { useAuth } from '../auth';
import { useCart } from '../cart';

// Embeds the shopping-assistant widget (../widget) the way any host store would: a <script> tag
// plus window.ShopChat.getToken, which hands out a short-lived chat token (never the session). The widget renders in its own Shadow DOM; this component only
// connects it to our login and cart.

const STORE = 'main';
const SCRIPT_ID = 'shopchat-script';
const WIDGET_SRC = import.meta.env.VITE_WIDGET_SRC ?? '/widget.js';
// agent-service origin. Empty = this origin (the dev server proxies /v1 to it).
const AGENT_URL = import.meta.env.VITE_AGENT_URL ?? '';
// Off-store hosts the widget may link to: carrier tracking pages (commerce-api orders.module.ts).
const LINK_DOMAINS = 'ups.com,fedex.com,usps.com,dhl.com';
// Fetch a fresh chat token this long before the current one expires.
const REFRESH_EARLY_MS = 60_000;

// The docked panel needs the page to make room while it's open (styles.css). `ready` carries the
// open state restored from the last page.
const dock = (open: boolean) => document.body.classList.toggle('chat-docked', open);
window.addEventListener('shopchat:ready', (e) => dock(Boolean((e as CustomEvent<{ open?: boolean }>).detail?.open)));
window.addEventListener('shopchat:open', () => dock(true));
window.addEventListener('shopchat:close', () => dock(false));

/**
 * Chat tokens for the signed-in shopper, cached until shortly before they expire. The token only
 * works for agent-service (commerce-api also needs its service token), so it is fine in page JS.
 */
export function chatTokens() {
  let cached: { token: string; expiresAt: number } | null = null;
  let pending: Promise<string | null> | null = null;
  let generation = 0; // bumped by clear(), so a request still in flight for the last shopper is dropped
  return {
    get(signedIn: boolean): Promise<string | null> {
      if (!signedIn) return Promise.resolve(null);
      if (cached && cached.expiresAt - REFRESH_EARLY_MS > Date.now()) return Promise.resolve(cached.token);
      const gen = generation;
      pending ??= api
        .agentToken()
        .then(({ token, expiresAt }) => {
          if (gen !== generation) return null;
          cached = { token, expiresAt: Date.parse(expiresAt) };
          return token;
        })
        // Staff accounts, expired sessions, network errors: chat as a guest.
        .catch(() => null)
        .finally(() => {
          if (gen === generation) pending = null;
        });
      return pending;
    },
    clear() {
      generation++;
      cached = null;
      pending = null;
    },
  };
}

export function ChatWidget() {
  const { user } = useAuth();
  const { refresh } = useCart();

  // The widget asks for the token on every request, so login/logout apply to the next message.
  const signedInRef = useRef(user !== null);
  signedInRef.current = user !== null;
  const tokens = useRef(chatTokens()).current;

  useEffect(() => {
    window.ShopChat = Object.assign(window.ShopChat ?? {}, {
      getToken: () => tokens.get(signedInRef.current),
    });
    if (document.getElementById(SCRIPT_ID)) return; // StrictMode runs effects twice
    const script = document.createElement('script');
    script.id = SCRIPT_ID;
    script.src = WIDGET_SRC;
    script.async = true;
    script.dataset.shopchat = '';
    script.dataset.store = STORE;
    script.dataset.api = AGENT_URL || location.origin;
    script.dataset.helpUrl = `${location.origin}/help`;
    script.dataset.linkDomains = LINK_DOMAINS;
    script.dataset.layout = 'docked';
    document.body.append(script);
    // No cleanup: the widget mounts once per page and survives route changes on purpose.
  }, []);

  // The agent changed the cart (add/remove/coupon): reload it so the header badge is right.
  useEffect(() => {
    const onCartUpdated = () => void refresh();
    window.addEventListener('shopchat:cart-updated', onCartUpdated);
    return () => window.removeEventListener('shopchat:cart-updated', onCartUpdated);
  }, [refresh]);

  // A different shopper (or a guest) must not see the previous shopper's chat. Guest → login
  // keeps the conversation, so a guest can log in midway and carry on.
  const userId = user?.id ?? null;
  const prevUserId = useRef(userId);
  useEffect(() => {
    const prev = prevUserId.current;
    prevUserId.current = userId;
    if (prev !== userId) tokens.clear(); // never reuse the previous shopper's token
    if (prev && prev !== userId) resetChat();
  }, [userId, tokens]);

  return null;
}

function resetChat() {
  if (window.ShopChat?.reset) window.ShopChat.reset();
  else {
    // Widget not loaded yet: drop the saved conversation it would restore.
    try {
      sessionStorage.removeItem(`shopchat:v1:${STORE}`);
    } catch {
      // Storage blocked: nothing was saved.
    }
  }
}

declare global {
  interface Window {
    ShopChat?: {
      getToken?: () => Promise<string | null> | string | null;
      open?: () => void;
      close?: () => void;
      toggle?: () => void;
      reset?: () => void;
    };
  }
}
