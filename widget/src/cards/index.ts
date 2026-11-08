import type { Card } from '../state';
import { cart, checkoutLink } from './cart';
import { confirm } from './confirm';
import type { CardContext } from './context';
import { order, orderList, returnCreated } from './order';
import { product, productList } from './product';
import { ticket } from './ticket';

export type { CardContext } from './context';

const RENDERERS: Record<string, (data: any, ctx: CardContext) => HTMLElement | null> = {
  product_list: productList,
  product,
  cart,
  checkout_link: checkoutLink,
  order,
  order_list: orderList,
  return_created: returnCreated,
  ticket_created: ticket,
  handoff: ticket,
  confirm,
};

export function renderCard(card: Card, ctx: CardContext): HTMLElement | null {
  const render = RENDERERS[card.type];
  return render ? render(card.data ?? {}, ctx) : null;
}
