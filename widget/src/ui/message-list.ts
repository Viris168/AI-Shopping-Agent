import { type CardContext, renderCard } from '../cards';
import { button } from '../cards/product';
import { el, linkify } from '../safe';
import type { ChatState, Message } from '../state';

export interface ListActions {
  send(text: string): void;
  retry(id: string): void;
  rate(id: string, rating: 'up' | 'down'): void;
}

interface Rendered {
  root: HTMLElement;
  key: string;
}

/** Keyed rendering: a message's DOM is rebuilt only when that message changes. */
export function createMessageList(ctx: CardContext, actions: ListActions, helpUrl: string | null) {
  const { t } = ctx.i18n;
  const list = el('div', { class: 'messages', role: 'log', 'aria-label': t('title'), 'aria-live': 'off' });
  const rendered = new Map<string, Rendered>();

  const empty = el('div', { class: 'empty' },
    el('p', {}, t('greeting')),
    el('div', { class: 'chips' }, ...ctx.i18n.chips.map((c) => button('chip', c, () => actions.send(c)))),
  );

  function renderMessage(m: Message): HTMLElement {
    const who = m.role === 'user' ? t('you') : t('assistant');
    const root = el('div', { class: `msg msg-${m.role}`, 'aria-busy': String(m.status === 'streaming') },
      el('span', { class: 'sr-only' }, `${who}: `),
    );
    if (m.text) root.append(el('div', { class: 'bubble-text' }, linkify(m.text, ctx.links)));
    if (m.status === 'streaming' && !m.text) {
      root.append(el('div', { class: 'typing', role: 'status', 'aria-label': t('typing') }, el('span'), el('span'), el('span')));
    }
    // A confirmed ticket arrives as both a ticket_created card and a handoff event; show one.
    const hasTicket = m.cards.some((c) => c.type === 'ticket_created');
    for (const card of m.cards) {
      if (card.type === 'handoff' && hasTicket) continue;
      const node = renderCard(card, ctx);
      if (node) root.append(node);
    }
    if (m.status === 'error' && m.error) {
      const help = helpUrl && ctx.links.safeUrl(helpUrl);
      root.append(
        el('div', { class: 'card card-error', role: 'alert' },
          el('p', {}, m.error.message),
          el('div', { class: 'row' },
            m.error.retryable && button('btn', t('retry'), () => actions.retry(m.id)),
            help && el('a', { class: 'btn btn-ghost', href: help, target: '_top' }, t('help')),
          ),
        ),
      );
    }
    if (m.role === 'assistant' && m.status === 'done' && m.serverId && m.text) {
      root.append(feedback(m));
    }
    return root;
  }

  function feedback(m: Message): HTMLElement {
    if (m.rating) return el('div', { class: 'feedback muted', role: 'status' }, t('thanks'));
    return el('div', { class: 'feedback' },
      button('icon-btn', '👍', () => actions.rate(m.id, 'up'), t('helpful')),
      button('icon-btn', '👎', () => actions.rate(m.id, 'down'), t('notHelpful')),
    );
  }

  return {
    element: list,
    render(state: ChatState) {
      const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
      if (!state.messages.length) {
        rendered.clear();
        list.replaceChildren(empty);
        return;
      }
      if (empty.isConnected) empty.remove();

      const ids = new Set(state.messages.map((m) => m.id));
      for (const [id, r] of rendered) {
        if (!ids.has(id)) {
          r.root.remove();
          rendered.delete(id);
        }
      }
      let previous: HTMLElement | null = null;
      for (const m of state.messages) {
        const key = JSON.stringify(m);
        let r = rendered.get(m.id);
        if (!r || r.key !== key) {
          const root = renderMessage(m);
          if (r) r.root.replaceWith(root);
          r = { root, key };
          rendered.set(m.id, r);
        }
        const expectedNext: ChildNode | null = previous ? previous.nextSibling : list.firstChild;
        if (r.root !== expectedNext) list.insertBefore(r.root, expectedNext);
        previous = r.root;
      }
      if (nearBottom) list.scrollTop = list.scrollHeight;
    },
  };
}
