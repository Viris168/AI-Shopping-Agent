import { el } from '../safe';
import { type CardContext, list, str } from './context';

function stock(p: any, ctx: CardContext): HTMLElement {
  const { t } = ctx.i18n;
  if (!p.inStock) return el('span', { class: 'badge badge-out' }, t('outOfStock'));
  const n = Number(p.stock);
  return el('span', { class: 'badge' }, n > 0 && n <= 5 ? t('onlyLeft', { n }) : t('inStock'));
}

function productTile(p: any, ctx: CardContext, detailed = false): HTMLElement {
  const { t } = ctx.i18n;
  const image = ctx.links.safeUrl(p.imageUrl);
  const url = ctx.links.safeUrl(p.url);
  const name = str(p.name);
  const img = image ? el('img', { src: image, alt: '', loading: 'lazy', class: 'product-img' }) : null;
  // A missing image just disappears instead of showing a broken-image icon.
  img?.addEventListener('error', () => img.remove(), { once: true });
  return el(
    'article',
    { class: detailed ? 'product product-detail' : 'product', 'aria-label': name },
    img,
    el('div', { class: 'product-body' },
      el('h4', { class: 'product-name' }, name),
      p.brand && el('div', { class: 'muted' }, str(p.brand)),
      el('div', { class: 'product-meta' },
        el('strong', {}, str(p.price)),
        p.rating && el('span', { class: 'muted', 'aria-label': `${p.rating} / 5` }, `★ ${str(p.rating)}`),
      ),
      stock(p, ctx),
      detailed && p.description && el('p', { class: 'product-desc' }, str(p.description)),
      el('div', { class: 'row' },
        url && el('a', { class: 'btn btn-ghost', href: url, target: '_blank', rel: 'noopener noreferrer' }, t('view')),
        p.inStock &&
          button('btn', t('addToCart'), () => ctx.send(t('addMessage', { name, id: str(p.id) })), `${t('addToCart')}: ${name}`),
      ),
    ),
  );
}

export function button(cls: string, label: string, onClick: () => void, ariaLabel?: string): HTMLButtonElement {
  const b = el('button', { type: 'button', class: cls, 'aria-label': ariaLabel }, label);
  b.addEventListener('click', onClick);
  return b;
}

export function productList(data: any, ctx: CardContext): HTMLElement | null {
  const items = list(data?.items);
  if (!items.length) return null;
  return el('section', { class: 'card' },
    data.basedOn && el('h3', { class: 'card-title' }, ctx.i18n.t('similarTo', { name: str(data.basedOn) })),
    el('div', { class: 'carousel', role: 'list' },
      ...items.map((p) => {
        const li = el('div', { role: 'listitem' }, productTile(p, ctx));
        return li;
      }),
    ),
  );
}

export function product(data: any, ctx: CardContext): HTMLElement {
  return el('section', { class: 'card' }, productTile(data, ctx, true));
}
