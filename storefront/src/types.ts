// Response shapes from commerce-api (commerce-api/docs/AGENT.md §4). Money comes as
// integer cents plus a formatted string; the UI shows the formatted one.

export interface User {
  id: string;
  email: string;
  name: string;
  role: string;
}

/** The session itself is an httpOnly cookie that page scripts can't read. */
export interface Session {
  user: User;
  expiresAt: string;
}

/** Short-lived token the chat widget hands to agent-service. */
export interface AgentToken {
  token: string;
  expiresAt: string;
}

export interface ProductListItem {
  id: string;
  sku: string;
  name: string;
  slug: string;
  brand: string;
  category: string;
  price: string;
  priceCents: number;
  inStock: boolean;
  stock: number;
  rating: number;
  imageUrl: string;
  url: string;
  summary: string;
}

export interface ProductDetail extends Omit<ProductListItem, 'summary'> {
  description: string;
  attributes: Record<string, string>;
  tags: string[];
}

export interface ProductPage {
  total: number;
  items: ProductListItem[];
}

export interface Category {
  name: string;
  slug: string;
}

export interface CartItem {
  productId: string;
  sku: string;
  name: string;
  quantity: number;
  unitPrice: string;
  unitPriceCents: number;
  lineTotal: string;
  inStock: boolean;
}

export interface Cart {
  items: CartItem[];
  itemCount: number;
  couponCode: string | null;
  subtotalCents: number;
  discountCents: number;
  shippingCents: number;
  totalCents: number;
  subtotal: string;
  discount: string;
  shipping: string;
  total: string;
  freeShippingRemaining: string | null;
}

export type OrderStatus =
  | 'PENDING'
  | 'PAID'
  | 'PROCESSING'
  | 'SHIPPED'
  | 'DELIVERED'
  | 'CANCELLED'
  | 'REFUNDED';

export interface OrderSummary {
  orderNumber: string;
  status: OrderStatus;
  placedAt: string;
  total: string;
  totalCents: number;
  itemCount: number;
  carrier: string | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
  shippedAt: string | null;
  deliveredAt: string | null;
  returnEligible: boolean;
  returnDeadline: string | null;
}

export interface OrderItem {
  orderItemId: string;
  productId: string | null;
  name: string;
  quantity: number;
  unitPrice: string;
  unitPriceCents: number;
}

export interface OrderReturn {
  returnId: string;
  status: 'REQUESTED' | 'APPROVED' | 'REJECTED' | 'RECEIVED' | 'REFUNDED';
  createdAt: string;
}

export interface OrderDetail extends OrderSummary {
  couponCode: string | null;
  subtotal: string;
  discount: string;
  shipping: string;
  items: OrderItem[];
  returns: OrderReturn[];
}

/** `POST /checkout`: with payments on, the order is PENDING until paid on `checkoutUrl` (Stripe). */
export interface CheckoutResult extends OrderDetail {
  checkoutUrl: string | null;
}

export interface ReturnCreated {
  returnId: string;
  status: string;
  nextSteps: string;
}

export type FaqTopic =
  | 'shipping'
  | 'returns'
  | 'payment'
  | 'orders'
  | 'account'
  | 'warranty';

export interface FaqResult {
  topic: FaqTopic;
  question: string;
  answer: string;
  score: string;
}

export interface TicketCreated {
  ticketId: string;
  status: string;
  expectedResponse: string;
}

/** The shopping assistant's long-term memory of this shopper (commerce-api /account/memory). */
export type MemoryFactKind = 'size' | 'style' | 'diet' | 'brand_like' | 'brand_dislike' | 'other';

export interface MemoryFact {
  id: string;
  kind: MemoryFactKind;
  value: string;
  updatedAt: string;
}

export interface MemoryEpisode {
  id: string;
  conversationId: string;
  summary: string;
  outcome: string | null;
  createdAt: string;
}

export interface MemoryView {
  enabled: boolean;
  facts: MemoryFact[];
  episodes: MemoryEpisode[];
}
