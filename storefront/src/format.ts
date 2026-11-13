/**
 * Order dates are the store's calendar dates (VITE_STORE_TZ, the same zone as agent-service's
 * STORE_TZ), so the order page, the chat card and the assistant agree on a return deadline.
 * Unset or unknown → the shopper's own zone.
 */
export function storeTimeZone(zone: string | undefined): string | undefined {
  if (!zone) return undefined;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return zone;
  } catch {
    return undefined;
  }
}

const dateFmt = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  timeZone: storeTimeZone(import.meta.env.VITE_STORE_TZ),
});

export const formatDate = (iso: string | null) => (iso ? dateFmt.format(new Date(iso)) : '—');

const STATUS_LABELS: Record<string, string> = {
  PENDING: 'Awaiting payment',
  PAID: 'Paid',
  PROCESSING: 'Processing',
  SHIPPED: 'Shipped',
  DELIVERED: 'Delivered',
  CANCELLED: 'Cancelled',
  REFUNDED: 'Refunded',
  REQUESTED: 'Return requested',
  APPROVED: 'Return approved',
  REJECTED: 'Return rejected',
  RECEIVED: 'Return received',
};

export const statusLabel = (status: string) => STATUS_LABELS[status] ?? status;
