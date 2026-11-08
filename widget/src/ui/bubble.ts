import type { I18n } from '../i18n';
import { el } from '../safe';

export function createBubble(i18n: I18n, panelId: string, onClick: () => void) {
  const icon = el('span', { class: 'bubble-icon', 'aria-hidden': 'true' }, '💬');
  const button = el('button', {
    type: 'button',
    class: 'bubble',
    'aria-label': i18n.t('open'),
    'aria-controls': panelId,
    'aria-expanded': 'false',
  }, icon);
  button.addEventListener('click', onClick);
  return {
    element: button,
    setOpen(open: boolean) {
      button.setAttribute('aria-expanded', String(open));
      button.setAttribute('aria-label', open ? i18n.t('close') : i18n.t('open'));
      icon.textContent = open ? '✕' : '💬';
    },
  };
}
