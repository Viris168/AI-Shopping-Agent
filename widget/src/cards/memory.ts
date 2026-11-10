import { el } from '../safe';
import type { CardContext } from './context';

/** Tells the shopper the assistant is using what they asked it to remember (PLAN-18). */
export function memory(data: any, ctx: CardContext): HTMLElement {
  const { t } = ctx.i18n;
  const manage = ctx.links.safeUrl(data?.manageUrl);
  return el('p', { class: 'memory-note muted', role: 'note' },
    t('memoryNote'),
    manage && ' ',
    manage && el('a', { href: manage, target: '_top' }, t('memoryManage')),
  );
}
