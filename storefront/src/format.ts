const dateFmt = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

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
