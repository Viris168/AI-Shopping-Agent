import type { Coupon } from '../database/entities.js';
import { couponProblem, priceCart } from './pricing.js';

const coupon = (c: Partial<Coupon>): Coupon =>
  ({
    code: 'X',
    percentOff: null,
    amountOffCents: null,
    minSubtotalCents: 0,
    expiresAt: null,
    isActive: true,
    ...c,
  }) as Coupon;

describe('priceCart', () => {
  it('charges $5.99 shipping under $50 and nothing for an empty cart', () => {
    expect(priceCart([{ priceCents: 3200, quantity: 1 }], null)).toMatchObject({
      subtotalCents: 3200,
      shippingCents: 599,
      totalCents: 3799,
      freeShippingRemainingCents: 1800,
    });
    expect(priceCart([], null)).toMatchObject({
      totalCents: 0,
      shippingCents: 0,
      freeShippingRemainingCents: null,
    });
  });

  it('applies percent coupons with rounding and checks free shipping after discount', () => {
    const p = priceCart(
      [{ priceCents: 5500, quantity: 1 }],
      coupon({ percentOff: 10 }),
    );
    // $55.00 - $5.50 = $49.50 → below $50, so shipping is charged.
    expect(p).toMatchObject({
      discountCents: 550,
      shippingCents: 599,
      totalCents: 5549,
    });
  });

  it('caps amount-off coupons at the subtotal', () => {
    const p = priceCart(
      [{ priceCents: 1000, quantity: 1 }],
      coupon({ amountOffCents: 2000 }),
    );
    expect(p.discountCents).toBe(1000);
  });

  it('gives no discount when the coupon stopped applying', () => {
    const save20 = coupon({ amountOffCents: 2000, minSubtotalCents: 10000 });
    expect(
      priceCart([{ priceCents: 9999, quantity: 1 }], save20).discountCents,
    ).toBe(0);
    const expired = coupon({
      percentOff: 50,
      expiresAt: new Date('2023-12-31T23:59:59Z'),
    });
    expect(
      priceCart([{ priceCents: 9999, quantity: 1 }], expired).discountCents,
    ).toBe(0);
  });
});

describe('couponProblem', () => {
  it('reports invalid, minimum or nothing', () => {
    expect(couponProblem(null, 0)).toBe('invalid');
    expect(couponProblem(coupon({ isActive: false }), 0)).toBe('invalid');
    expect(couponProblem(coupon({ minSubtotalCents: 10000 }), 9999)).toBe(
      'minimum',
    );
    expect(couponProblem(coupon({ minSubtotalCents: 10000 }), 10000)).toBe(
      null,
    );
  });
});
