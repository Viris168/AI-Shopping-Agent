// Bootstrap: read the <script> tag, mount everything inside a Shadow DOM, expose window.ShopChat.
//
//   <script src="https://chat.yourstore.com/v1/widget.js" data-store="main" async></script>
//   <script>window.ShopChat = { getToken: () => fetch('/api/v1/auth/agent-token', {
//     method: 'POST', credentials: 'include', headers: { 'X-Requested-With': 'shop' },
//   }).then(r => r.ok ? r.json().then(b => b.token) : null) };</script>
//   The chat token is short-lived and only works via agent-service; never pass the store session.
//
// Optional data-* attributes: data-api (agent-service origin; default: the script's origin),
// data-locale, data-link-domains (extra allowed link hosts, comma-separated, e.g. carriers),
// data-help-url (fallback "track an order / contact us" page), data-privacy-url (linked from the
// storage notice), data-max-chars, data-layout ("docked": a full-height panel on the right instead
// of a popup; the host page makes room for it on `shopchat:open`/`close`, width
// --shopchat-dock-width).
//
// Events on window: shopchat:ready ({ open }) once mounted, shopchat:open, shopchat:close,
// shopchat:cart-updated.
//
// Before mounting it asks agent-service whether it's switched on and inside the rollout
// (src/rollout.ts); otherwise nothing is added to the page.

import { ChatApi } from './api';
import { Controller } from './controller';
import { createI18n, pickLocale } from './i18n';
import { fetchConfig, shouldMount } from './rollout';
import { LinkPolicy, el } from './safe';
import { Store } from './state';
import styles from './styles.css?inline';
import { createBubble } from './ui/bubble';
import { createComposer } from './ui/composer';
import { createMessageList } from './ui/message-list';
import { createPanel, PANEL_ID } from './ui/panel';

// The loading screen stays at least this long, so a fast connection doesn't make it flash.
const LOADING_MIN_MS = 500;

interface ShopChatGlobal {
  getToken?: () => Promise<string | null> | string | null;
  open?: () => void;
  close?: () => void;
  toggle?: () => void;
  reset?: () => void;
}

declare global {
  interface Window {
    ShopChat?: ShopChatGlobal;
  }
}

function findScript(): HTMLScriptElement | null {
  return (
    (document.currentScript as HTMLScriptElement | null) ??
    document.querySelector<HTMLScriptElement>('script[data-shopchat], script[src*="widget.js"]')
  );
}

function apiBaseOf(script: HTMLScriptElement | null): string {
  const scriptOrigin = script?.src ? new URL(script.src, location.href).origin : location.origin;
  return (script?.dataset.api ?? scriptOrigin).replace(/\/$/, '');
}

function mount(script: HTMLScriptElement | null, timeZone?: string): void {
  if (document.getElementById('shopchat-root')) return; // loaded twice
  const data = script?.dataset ?? {};
  const apiBase = apiBaseOf(script);
  const store = data.store ?? 'main';
  const maxChars = Number(data.maxChars) || 2000;
  const i18n = createI18n(
    pickLocale(data.locale, document.documentElement.lang, navigator.language),
    timeZone,
  );
  const links = new LinkPolicy([
    location.hostname,
    new URL(apiBase).hostname,
    ...(data.linkDomains ?? '').split(','),
  ]);

  const host = el('div', { id: 'shopchat-root' });
  if (data.layout === 'docked') host.setAttribute('data-layout', 'docked');
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = styles;
  shadow.append(style);

  const emit = (name: string, detail?: unknown) =>
    window.dispatchEvent(new CustomEvent(`shopchat:${name}`, { detail }));

  const state = new Store(`shopchat:v1:${store}`);
  // Read the token getter at call time: the host page may define it after this script runs.
  const api = new ChatApi(apiBase, () => window.ShopChat?.getToken?.() ?? null);
  let panel: ReturnType<typeof createPanel>;
  const controller = new Controller(state, api, i18n, {
    maxChars,
    onCartUpdated: (cart) => emit('cart-updated', cart),
    announce: (text) => panel.announce(text),
  });

  const list = createMessageList(
    {
      i18n,
      links,
      send: (text) => void controller.send(text),
      confirm: (id) => void controller.confirm(id),
      cancel: (id) => void controller.cancel(id),
    },
    {
      send: (text) => void controller.send(text),
      retry: (id) => void controller.retry(id),
      rate: (id, rating) => void controller.rate(id, rating),
    },
    data.helpUrl ?? null,
  );
  const composer = createComposer(i18n, maxChars, (text) => void controller.send(text));

  // First open on this page: show the loading screen while the shopper's token is fetched.
  let warmed = false;
  const warmUp = () => {
    if (warmed) return;
    warmed = true;
    panel.setLoading(true);
    const minimum = new Promise((r) => setTimeout(r, LOADING_MIN_MS));
    void Promise.all([api.warmUp(), minimum]).then(() => panel.setLoading(false));
  };

  // Focus goes back to whatever opened the chat (e.g. the host's "Ask AI" button), else the bubble.
  let opener: HTMLElement | null = null;
  const setOpen = (open: boolean) => {
    if (open === state.state.open) return;
    const active = document.activeElement;
    if (open) {
      const fromPage = active instanceof HTMLElement && active !== host && active !== document.body;
      opener = fromPage ? active : null;
    }
    state.set({ open });
    emit(open ? 'open' : 'close');
    if (open) {
      warmUp();
      composer.focus();
    } else {
      (opener?.isConnected ? opener : bubble.element).focus();
      opener = null;
    }
  };
  const bubble = createBubble(i18n, PANEL_ID, () => setOpen(!state.state.open));
  panel = createPanel(i18n, { list: list.element, composer: composer.element }, {
    close: () => setOpen(false),
    reset: () => controller.reset(),
  }, { links, url: data.privacyUrl ?? null });

  const render = () => {
    const s = state.state;
    bubble.setOpen(s.open);
    panel.setOpen(s.open);
    composer.setBusy(s.busy);
    if (s.busy) panel.setLoading(false); // the shopper sent a message: show it
    list.render(s);
  };
  state.subscribe(render);
  render();

  shadow.append(panel.element, bubble.element);
  document.body.append(host);

  window.ShopChat = Object.assign(window.ShopChat ?? {}, {
    open: () => setOpen(true),
    close: () => setOpen(false),
    toggle: () => setOpen(!state.state.open),
    reset: () => controller.reset(),
  });
  if (state.state.open) warmUp(); // reopened from the saved conversation
  emit('ready', { open: state.state.open });
}

const script = findScript(); // only readable synchronously, before the first await
void fetchConfig(apiBaseOf(script)).then((config) => {
  if (!shouldMount(config, location.search)) return;
  if (document.body) mount(script, config?.timeZone);
  else document.addEventListener('DOMContentLoaded', () => mount(script, config?.timeZone), { once: true });
});
