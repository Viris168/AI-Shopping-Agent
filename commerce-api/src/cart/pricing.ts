import type { Coupon } from '../database/entities.js';

export const FREE_SHIPPING_MIN_CENTS = 5000;
export const SHIPPING_CENTS = 599;

export interface PriceLine {
  priceCents: number;
  quantity: number;
}

/** Why a coupon can't be used right now, or null if it can. */
export function couponProblem(
  coupon: Coupon | null,
  subtotalCents: number,
  now = new Date(),
): 'invalid' | 'minimum' | null {
  if (!coupon || !coupon.isActive) return 'invalid';
  if (coupon.expiresAt && coupon.expiresAt <= now) return 'invalid';
  if (subtotalCents < coupon.minSubtotalCents) return 'minimum';
  return null;
}

/**
 * Cart totals in integer cents. A coupon that no longer applies (expired, or the
 * subtotal dropped below its minimum) gives no discount. Shipping is free once the
 * subtotal after discount reaches $50.
 */
export function priceCart(
  lines: PriceLine[],
  coupon: Coupon | null,
  now = new Date(),
) {
  const subtotalCents = lines.reduce(
    (n, l) => n + l.priceCents * l.quantity,
    0,
  );
  let discountCents = 0;
  if (coupon && couponProblem(coupon, subtotalCents, now) === null) {
    discountCents = coupon.percentOff
      ? Math.round((subtotalCents * coupon.percentOff) / 100)
      : (coupon.amountOffCents ?? 0);
    discountCents = Math.min(discountCents, subtotalCents);
  }
  const afterDiscount = subtotalCents - discountCents;
  const shippingCents =
    lines.length === 0 || afterDiscount >= FREE_SHIPPING_MIN_CENTS
      ? 0
      : SHIPPING_CENTS;
  return {
    subtotalCents,
    discountCents,
    shippingCents,
    totalCents: afterDiscount + shippingCents,
    freeShippingRemainingCents:
      lines.length > 0 && afterDiscount < FREE_SHIPPING_MIN_CENTS
        ? FREE_SHIPPING_MIN_CENTS - afterDiscount
        : null,
  };
}
