import { el } from '../safe';
import { type CardContext, str } from './context';

/** Renders both `ticket_created` cards and `handoff` events. */
export function ticket(data: any, ctx: CardContext): HTMLElement {
  const { t } = ctx.i18n;
  const eta = str(data?.expectedResponse);
  return el('section', { class: 'card card-success', role: 'status' },
    el('h3', { class: 'card-title' }, `✓ ${t('ticketCreated')}`),
    eta && el('p', {}, t('ticketEta', { eta })),
    data?.ticketId && el('div', { class: 'muted' }, t('ticketRef', { id: str(data.ticketId) })),
  );
}
