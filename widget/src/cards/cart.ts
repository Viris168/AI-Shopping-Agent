import { el } from '../safe';
import { type CardContext, list, str } from './context';

function line(label: string, value: unknown, cls = ''): HTMLElement {
  return el('div', { class: `total-row ${cls}` }, el('span', {}, label), el('span', {}, str(value)));
}

export function cart(data: any, ctx: CardContext): HTMLElement {
  const { t } = ctx.i18n;
  const items = list(data?.items);
  return el('section', { class: 'card', 'aria-label': t('cart') },
    el('h3', { class: 'card-title' }, t('cart')),
    items.length
      ? el('ul', { class: 'lines' },
          ...items.map((i) =>
            el('li', { class: 'line' },
              el('span', {}, str(i.name)),
              el('span', { class: 'muted' }, t('qty', { n: str(i.quantity) })),
              el('strong', {}, str(i.lineTotal)),
            ),
          ),
        )
      : el('p', { class: 'muted' }, t('cartEmpty')),
    items.length > 0 &&
      el('div', { class: 'totals' },
        line(t('subtotal'), data.subtotal),
        data.discountCents > 0 &&
          line(data.couponCode ? t('coupon', { code: str(data.couponCode) }) : t('discount'), `−${str(data.discount)}`),
        line(t('shipping'), data.shipping),
        line(t('total'), data.total, 'total-strong'),
      ),
    data.freeShippingRemaining && el('p', { class: 'muted' }, t('freeShipping', { amount: str(data.freeShippingRemaining) })),
  );
}

export function checkoutLink(data: any, ctx: CardContext): HTMLElement | null {
  const { t } = ctx.i18n;
  const url = ctx.links.safeUrl(data?.url);
  if (!url) return null;
  return el('section', { class: 'card' },
    el('p', {}, t('checkoutNote')),
    el('a', { class: 'btn btn-block', href: url, target: '_top' }, t('checkout')),
  );
}
