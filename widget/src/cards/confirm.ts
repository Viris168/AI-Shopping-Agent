import { el } from '../safe';
import { type CardContext, str } from './context';
import { button } from './product';

/** The only way a return or ticket gets created: the shopper presses Confirm here. */
export function confirm(data: any, ctx: CardContext): HTMLElement {
  const { t, time } = ctx.i18n;
  const actionId = str(data.actionId);
  const state = str(data.state) || 'pending';
  const summary = el('p', { class: 'confirm-summary', id: `confirm-${actionId}` }, str(data.summary));
  const card = el('section', { class: `card card-confirm state-${state}`, role: 'group', 'aria-labelledby': summary.id }, summary);

  if (state === 'pending') {
    const yes = button('btn', t('confirm'), () => ctx.confirm(actionId));
    yes.setAttribute('aria-describedby', summary.id);
    const no = button('btn btn-ghost', t('cancel'), () => ctx.cancel(actionId));
    card.append(
      el('div', { class: 'row' }, yes, no),
      data.expiresAt ? el('div', { class: 'muted' }, t('expiresAt', { time: time(data.expiresAt) })) : '',
    );
  } else {
    const label = { working: t('confirming'), confirmed: `✓ ${t('confirmed')}`, cancelled: t('cancelled'), expired: t('expired') }[state];
    card.append(el('div', { class: 'muted', role: 'status' }, label ?? ''));
  }
  return card;
}
