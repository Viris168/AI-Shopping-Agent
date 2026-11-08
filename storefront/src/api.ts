import type {
  Cart,
  Category,
  FaqResult,
  FaqTopic,
  OrderDetail,
  OrderSummary,
  ProductDetail,
  ProductPage,
  ReturnCreated,
  Session,
  TicketCreated,
  User,
} from './types';

const BASE = `${import.meta.env.VITE_API_URL ?? ''}/api/v1`;

/** An error from commerce-api. `message` is written for shoppers and safe to show. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

type TokenGetter = () => string | null;
type UnauthorizedHandler = () => void;

let getToken: TokenGetter = () => null;
let onUnauthorized: UnauthorizedHandler = () => {};

/** Wired up once by AuthProvider. */
export function configureApi(token: TokenGetter, unauthorized: UnauthorizedHandler) {
  getToken = token;
  onUnauthorized = unauthorized;
}

function messageOf(body: unknown, status: number): string {
  const m = (body as { message?: unknown } | null)?.message;
  if (Array.isArray(m)) return m.join('. ');
  if (typeof m === 'string' && m) return m;
  if (status === 429) return 'Too many requests. Please wait a moment and try again.';
  if (status >= 500) return 'Something went wrong on our side. Please try again.';
  return 'Something went wrong. Please try again.';
}

export async function request<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const token = getToken();
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        Accept: 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, 'Can’t reach the store right now. Check your connection and try again.');
  }
  const data: unknown = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) {
    // An expired session on a logged-in request: sign out so the UI asks to log in again.
    if (res.status === 401 && token) onUnauthorized();
    throw new ApiError(res.status, messageOf(data, res.status));
  }
  return data as T;
}

const q = (params: Record<string, string | number | boolean | undefined>) => {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params))
    if (v !== undefined && v !== '') s.set(k, String(v));
  const str = s.toString();
  return str ? `?${str}` : '';
};
const seg = encodeURIComponent;

export interface ProductQuery {
  q?: string;
  category?: string;
  brand?: string;
  minPriceCents?: number;
  maxPriceCents?: number;
  inStock?: boolean;
  sort?: 'relevance' | 'price_asc' | 'price_desc' | 'rating' | 'newest';
  limit?: number;
  offset?: number;
}

export const api = {
  login: (email: string, password: string) =>
    request<Session>('POST', '/auth/login', { email, password }),
  register: (name: string, email: string, password: string) =>
    request<Session>('POST', '/auth/register', { name, email, password }),
  me: () => request<User>('GET', '/auth/me'),

  products: (query: ProductQuery) =>
    request<ProductPage>('GET', `/products${q({ ...query })}`),
  product: (idOrSlug: string) =>
    request<ProductDetail>('GET', `/products/${seg(idOrSlug)}`),
  recommendations: (idOrSlug: string) =>
    request<{ basedOn: string; items: ProductPage['items'] }>(
      'GET',
      `/products/${seg(idOrSlug)}/recommendations`,
    ),
  categories: () => request<Category[]>('GET', '/categories'),

  cart: () => request<Cart>('GET', '/cart'),
  addToCart: (productId: string, quantity: number) =>
    request<Cart>('POST', '/cart/items', { productId, quantity }),
  updateCartItem: (productId: string, quantity: number) =>
    request<Cart>('PATCH', `/cart/items/${seg(productId)}`, { quantity }),
  removeCartItem: (productId: string) =>
    request<Cart>('DELETE', `/cart/items/${seg(productId)}`),
  applyCoupon: (code: string) => request<Cart>('POST', '/cart/coupon', { code }),
  checkout: () => request<OrderDetail>('POST', '/checkout'),

  orders: () => request<OrderSummary[]>('GET', '/orders'),
  order: (orderNumber: string) =>
    request<OrderDetail>('GET', `/orders/${seg(orderNumber)}`),
  createReturn: (
    orderNumber: string,
    reason: string,
    items: { orderItemId: string; quantity: number }[],
  ) => request<ReturnCreated>('POST', '/returns', { orderNumber, reason, items }),

  searchFaq: (query: string, topic?: FaqTopic) =>
    request<{ results: FaqResult[] }>('GET', `/faq/search${q({ q: query, topic })}`),
  createTicket: (ticket: {
    subject: string;
    summary: string;
    priority?: 'low' | 'normal' | 'high' | 'urgent';
    contactEmail?: string;
  }) => request<TicketCreated>('POST', '/support/tickets', ticket),
};
