import type { I18n } from '../i18n';
import { el, type LinkPolicy } from '../safe';
import { button } from '../cards/product';

export const PANEL_ID = 'shopchat-panel';

export function createPanel(
  i18n: I18n,
  parts: { list: HTMLElement; composer: HTMLElement },
  handlers: { close(): void; reset(): void },
  privacy: { links: LinkPolicy; url: string | null },
) {
  const { t } = i18n;
  // Shoppers should know the chat is kept before they type anything personal (PRD: privacy).
  const privacyUrl = privacy.url && privacy.links.safeUrl(privacy.url);
  const notice = el('p', { id: 'shopchat-notice', class: 'notice' },
    t('storageNotice'),
    privacyUrl && ' ',
    privacyUrl && el('a', { href: privacyUrl, target: '_blank', rel: 'noopener noreferrer' }, t('privacyLink')),
  );
  const announcer = el('div', { class: 'sr-only', 'aria-live': 'polite', 'aria-atomic': 'true' });
  const panel = el('div', {
    id: PANEL_ID,
    class: 'panel',
    role: 'dialog',
    'aria-modal': 'false',
    'aria-labelledby': 'shopchat-title',
    'aria-describedby': 'shopchat-notice',
    hidden: true,
  },
    el('header', { class: 'panel-header' },
      el('h2', { id: 'shopchat-title', class: 'panel-title' }, t('title')),
      button('icon-btn', '↺', handlers.reset, t('newChat')),
      button('icon-btn', '✕', handlers.close, t('close')),
    ),
    parts.list,
    parts.composer,
    notice,
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
