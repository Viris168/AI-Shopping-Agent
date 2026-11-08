import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { formatMoney } from '../common/money.js';
import {
  Cart,
  CartItem,
  Coupon,
  Order,
  OrderItem,
  Product,
} from '../database/entities.js';
import { OrdersService } from '../orders/orders.module.js';
import { ProductsService } from '../products/products.service.js';
import { MAX_QTY_PER_ITEM } from './cart.dto.js';
import { couponProblem, priceCart } from './pricing.js';

const outOfStock = (p: Product) =>
  new BadRequestException(`"${p.name}" is out of stock`);
const notEnough = (p: Product) =>
  new BadRequestException(`Only ${p.stock} of "${p.name}" in stock`);

@Injectable()
export class CartService {
  constructor(
    @InjectDataSource() private readonly db: DataSource,
    @InjectRepository(Cart) private readonly carts: Repository<Cart>,
    @InjectRepository(CartItem)
    private readonly cartItems: Repository<CartItem>,
    @InjectRepository(Coupon) private readonly coupons: Repository<Coupon>,
    private readonly products: ProductsService,
    private readonly orders: OrdersService,
  ) {}

  async view(userId: string) {
    const cart = await this.cartFor(userId);
    const items = await this.itemsOf(this.db.manager, cart.id);
    return this.toDto(cart, items, await this.couponFor(cart));
  }

  async addItem(userId: string, productRef: string, quantity: number) {
    const product = await this.products.find(productRef);
    const cart = await this.cartFor(userId);
    const existing = await this.cartItems.findOneBy({
      cartId: cart.id,
      productId: product.id,
    });
    const total = (existing?.quantity ?? 0) + quantity;
    if (total > MAX_QTY_PER_ITEM) {
      throw new BadRequestException(
        `You can have up to ${MAX_QTY_PER_ITEM} of one item in your cart`,
      );
    }
    this.checkStock(product, total);
    await this.cartItems.upsert(
      { cartId: cart.id, productId: product.id, quantity: total },
      ['cartId', 'productId'],
    );
    return this.view(userId);
  }

  async updateItem(userId: string, productRef: string, quantity: number) {
    if (quantity === 0) return this.removeItem(userId, productRef);
    const product = await this.products.find(productRef);
    const cart = await this.cartFor(userId);
    this.checkStock(product, quantity);
    const result = await this.cartItems.update(
      { cartId: cart.id, productId: product.id },
      { quantity },
    );
    if (!result.affected) throw new NotFoundException('Item not in cart');
    return this.view(userId);
  }

  async removeItem(userId: string, productRef: string) {
    // Inactive products can still be removed from a cart.
    const product = await this.products.find(productRef, {
      includeInactive: true,
    });
    const cart = await this.cartFor(userId);
    const result = await this.cartItems.delete({
      cartId: cart.id,
      productId: product.id,
    });
    if (!result.affected) throw new NotFoundException('Item not in cart');
    return this.view(userId);
  }

  async applyCoupon(userId: string, code: string) {
    const cart = await this.cartFor(userId);
    const coupon = await this.coupons.findOneBy({ code: code.toUpperCase() });
    const items = await this.itemsOf(this.db.manager, cart.id);
    const { subtotalCents } = priceCart(this.lines(items), null);
    const problem = couponProblem(coupon, subtotalCents);
    if (problem === 'invalid')
      throw new BadRequestException('Coupon is invalid or expired');
    if (problem === 'minimum')
      throw new BadRequestException(
        `Coupon requires a subtotal of at least ${formatMoney(coupon!.minSubtotalCents)}`,
      );
    await this.carts.update({ id: cart.id }, { couponCode: coupon!.code });
    return this.view(userId);
  }

  async removeCoupon(userId: string) {
    await this.carts.update({ userId }, { couponCode: null });
    return this.view(userId);
  }

  /**
   * Demo checkout: there is no payment step, so the order is saved as PAID straight away.
   * One transaction: lock the cart (a double-click waits, then finds it empty), take stock
   * with conditional updates so it can never go negative, snapshot names and prices,
   * then empty the cart. Totals use the same pricing the shopper saw in the cart.
   */
  async checkout(userId: string) {
    const orderNumber = await this.db.transaction(async (m) => {
      await this.ensureCart(m, userId);
      const cart = await m.findOneOrFail(Cart, {
        where: { userId },
        lock: { mode: 'pessimistic_write' },
      });
      const items = await this.itemsOf(m, cart.id);
      if (items.length === 0)
        throw new BadRequestException('Your cart is empty');

      // Same order every time, so two checkouts can't deadlock on product rows.
      for (const item of [...items].sort((a, b) =>
        a.productId.localeCompare(b.productId),
      )) {
        // Conditional decrement: matches no row if another order took the stock first.
        const taken = await m
          .createQueryBuilder()
          .update(Product)
          .set({ stock: () => 'stock - :qty' })
          .where('id = :id AND is_active AND stock >= :qty', {
            id: item.productId,
            qty: item.quantity,
          })
          .execute();
        if (!taken.affected) {
          const p = await m.findOneByOrFail(Product, { id: item.productId });
          if (!p.isActive)
            throw new BadRequestException(`"${p.name}" is no longer available`);
          throw p.stock === 0 ? outOfStock(p) : notEnough(p);
        }
      }

      const coupon = await this.couponFor(cart, m);
      const price = priceCart(this.lines(items), coupon);
      const [{ next }] = await m.query(
        `SELECT 'ORD-' || nextval('order_number_seq') AS next`,
      );
      const order = await m.save(
        m.create(Order, {
          orderNumber: next,
          userId,
          status: 'PAID',
          subtotalCents: price.subtotalCents,
          discountCents: price.discountCents,
          shippingCents: price.shippingCents,
          totalCents: price.totalCents,
          couponCode: price.discountCents > 0 ? coupon!.code : null,
        }),
      );
      await m.save(
        items.map((i) =>
          m.create(OrderItem, {
            orderId: order.id,
            productId: i.productId,
            nameSnapshot: i.product.name,
            unitPriceCents: i.product.priceCents,
            quantity: i.quantity,
          }),
        ),
      );
      await m.delete(CartItem, { cartId: cart.id });
      await m.update(Cart, { id: cart.id }, { couponCode: null });
      return order.orderNumber;
    });
    return this.orders.get(userId, orderNumber);
  }

  private checkStock(product: Product, quantity: number) {
    if (product.stock === 0) throw outOfStock(product);
    if (quantity > product.stock) throw notEnough(product);
  }

  /** Creates the user's cart if needed; safe under concurrent requests. */
  private async ensureCart(m: EntityManager, userId: string) {
    await m
      .createQueryBuilder()
      .insert()
      .into(Cart)
      .values({ userId })
      .orIgnore()
      .execute();
  }

  private async cartFor(userId: string): Promise<Cart> {
    await this.ensureCart(this.db.manager, userId);
    return this.carts.findOneByOrFail({ userId });
  }

  private itemsOf(m: EntityManager, cartId: string) {
    return m.find(CartItem, {
      where: { cartId },
      relations: { product: true },
      order: { product: { name: 'ASC' } },
    });
  }

  private async couponFor(cart: Cart, m: EntityManager = this.db.manager) {
    return cart.couponCode
      ? m.findOneBy(Coupon, { code: cart.couponCode })
      : null;
  }

  private lines(items: CartItem[]) {
    return items.map((i) => ({
      priceCents: i.product.priceCents,
      quantity: i.quantity,
    }));
  }

  // Shape from docs/AGENT.md §4; every cart mutation returns it.
  private toDto(cart: Cart, items: CartItem[], coupon: Coupon | null) {
    const p = priceCart(this.lines(items), coupon);
    return {
      items: items.map((i) => ({
        productId: i.productId,
        sku: i.product.sku,
        name: i.product.name,
        quantity: i.quantity,
        unitPrice: formatMoney(i.product.priceCents),
        unitPriceCents: i.product.priceCents,
        lineTotal: formatMoney(i.product.priceCents * i.quantity),
        inStock: i.product.isActive && i.product.stock >= i.quantity,
      })),
      itemCount: items.reduce((n, i) => n + i.quantity, 0),
      couponCode: cart.couponCode,
      subtotalCents: p.subtotalCents,
      discountCents: p.discountCents,
      shippingCents: p.shippingCents,
      totalCents: p.totalCents,
      subtotal: formatMoney(p.subtotalCents),
      discount: formatMoney(p.discountCents),
      shipping: formatMoney(p.shippingCents),
      total: formatMoney(p.totalCents),
      freeShippingRemaining:
        p.freeShippingRemainingCents === null
          ? null
          : formatMoney(p.freeShippingRemainingCents),
    };
  }
}
