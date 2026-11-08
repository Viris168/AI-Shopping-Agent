import { el } from '../safe';
import { type CardContext, list, str } from './context';

function statusBadge(status: unknown, ctx: CardContext): HTMLElement {
  const code = str(status).toLowerCase();
  return el('span', { class: `badge status-${code}` }, ctx.i18n.status(status));
}

export function order(data: any, ctx: CardContext): HTMLElement {
  const { t, date } = ctx.i18n;
  const tracking = ctx.links.safeUrl(data?.trackingUrl);
  return el('section', { class: 'card', 'aria-label': t('order', { number: str(data.orderNumber) }) },
    el('div', { class: 'row space' },
      el('h3', { class: 'card-title' }, t('order', { number: str(data.orderNumber) })),
      statusBadge(data.status, ctx),
    ),
    data.placedAt && el('div', { class: 'muted' }, t('placed', { date: date(data.placedAt) })),
    list(data.items).length > 0 &&
      el('ul', { class: 'lines' },
        ...list(data.items).map((i) =>
          el('li', { class: 'line' },
            el('span', {}, str(i.name)),
            el('span', { class: 'muted' }, t('qty', { n: str(i.quantity) })),
            el('strong', {}, str(i.unitPrice)),
          ),
        ),
      ),
    data.total && el('div', { class: 'total-row total-strong' }, el('span', {}, t('total')), el('span', {}, str(data.total))),
    data.trackingNumber &&
      el('div', { class: 'muted' }, t('trackingNumber', { carrier: str(data.carrier), number: str(data.trackingNumber) })),
    // Carrier links render only if the carrier's domain is in data-link-domains.
    tracking && el('a', { class: 'btn btn-ghost', href: tracking, target: '_blank', rel: 'noopener noreferrer' }, t('track')),
    data.returnEligible && data.returnDeadline && el('div', { class: 'muted' }, t('returnBy', { date: date(data.returnDeadline) })),
  );
}

export function orderList(data: any, ctx: CardContext): HTMLElement | null {
  const { t, date } = ctx.i18n;
  const orders = Array.isArray(data) ? data : list(data?.items);
  if (!orders.length) return null;
  return el('section', { class: 'card' },
    el('h3', { class: 'card-title' }, t('orders')),
    el('ul', { class: 'lines' },
      ...orders.map((o) =>
        el('li', { class: 'line' },
          el('span', {}, str(o.orderNumber)),
          el('span', { class: 'muted' }, date(o.placedAt)),
          statusBadge(o.status, ctx),
        ),
      ),
    ),
  );
}

export function returnCreated(data: any, ctx: CardContext): HTMLElement {
  const { t } = ctx.i18n;
  return el('section', { class: 'card card-success', role: 'status' },
    el('h3', { class: 'card-title' }, `✓ ${t('returnCreated')}`),
    data.nextSteps && el('p', {}, str(data.nextSteps)),
    data.returnId && el('div', { class: 'muted' }, t('ticketRef', { id: str(data.returnId) })),
  );
}
