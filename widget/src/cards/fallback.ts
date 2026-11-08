import { el } from '../safe';
import type { CardContext } from './context';
import { button } from './product';

/**
 * Shown in place of a reply when the model is down (`model_unavailable`) or the assistant has
 * been switched off (503). Points the shopper at the help page, so the shop still works without us.
 */
export function fallback(ctx: CardContext, helpUrl: string | null, retry: (() => void) | null): HTMLElement {
  const { t } = ctx.i18n;
  const help = helpUrl && ctx.links.safeUrl(helpUrl);
  return el('section', { class: 'card card-fallback', role: 'alert' },
    el('h3', { class: 'card-title' }, t('fallbackTitle')),
    el('p', {}, t(help ? 'fallbackHelp' : 'fallbackText')),
    (retry || help) && el('div', { class: 'row' },
      help && el('a', { class: 'btn', href: help, target: '_top' }, t('help')),
      retry && button('btn btn-ghost', t('retry'), retry),
    ),
  );
}
