import type { I18n } from '../i18n';
import { el } from '../safe';
import { button } from '../cards/product';

export const PANEL_ID = 'shopchat-panel';

export function createPanel(
  i18n: I18n,
  parts: { list: HTMLElement; composer: HTMLElement },
  handlers: { close(): void; reset(): void },
) {
  const { t } = i18n;
  const announcer = el('div', { class: 'sr-only', 'aria-live': 'polite', 'aria-atomic': 'true' });
  const panel = el('div', {
    id: PANEL_ID,
    class: 'panel',
    role: 'dialog',
    'aria-modal': 'false',
    'aria-labelledby': 'shopchat-title',
    hidden: true,
  },
    el('header', { class: 'panel-header' },
      el('h2', { id: 'shopchat-title', class: 'panel-title' }, t('title')),
      button('icon-btn', '↺', handlers.reset, t('newChat')),
      button('icon-btn', '✕', handlers.close, t('close')),
    ),
    parts.list,
    parts.composer,
    announcer,
  );
  panel.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      handlers.close();
    }
  });
  return {
    element: panel,
    setOpen(open: boolean) {
      panel.hidden = !open;
    },
    announce(text: string) {
      announcer.textContent = '';
      // A fresh text node after a tick makes screen readers read repeated text too.
      setTimeout(() => (announcer.textContent = text), 50);
    },
  };
}
