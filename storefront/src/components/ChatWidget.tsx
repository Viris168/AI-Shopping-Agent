import { useEffect, useRef } from 'react';
import { useAuth } from '../auth';
import { useCart } from '../cart';

// Embeds the shopping-assistant widget (../widget) the way any host store would: a <script> tag
// plus window.ShopChat.getToken. The widget renders in its own Shadow DOM; this component only
// connects it to our login and cart.

const STORE = 'main';
const SCRIPT_ID = 'shopchat-script';
const WIDGET_SRC = import.meta.env.VITE_WIDGET_SRC ?? '/widget.js';
// agent-service origin. Empty = this origin (the dev server proxies /v1 to it).
const AGENT_URL = import.meta.env.VITE_AGENT_URL ?? '';
// Off-store hosts the widget may link to: carrier tracking pages (commerce-api orders.module.ts).
const LINK_DOMAINS = 'ups.com,fedex.com,usps.com,dhl.com';

export function ChatWidget() {
  const { token, user } = useAuth();
  const { refresh } = useCart();

  // The widget asks for the token on every request, so login/logout apply to the next message.
  const tokenRef = useRef(token);
  tokenRef.current = token;

  useEffect(() => {
    window.ShopChat = Object.assign(window.ShopChat ?? {}, { getToken: () => tokenRef.current });
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
    if (prev && prev !== userId) resetChat();
  }, [userId]);

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
