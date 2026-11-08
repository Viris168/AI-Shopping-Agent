import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';

// Column types are always explicit so nothing depends on emitted decorator metadata.

export type Role = 'CUSTOMER' | 'SUPPORT' | 'ADMIN';
export type OrderStatus =
  | 'PENDING'
  | 'PAID'
  | 'PROCESSING'
  | 'SHIPPED'
  | 'DELIVERED'
  | 'CANCELLED'
  | 'REFUNDED';
export type ReturnStatus =
  'REQUESTED' | 'APPROVED' | 'REJECTED' | 'RECEIVED' | 'REFUNDED';
export type TicketStatus = 'OPEN' | 'ASSIGNED' | 'RESOLVED';
export type TicketPriority = 'low' | 'normal' | 'high' | 'urgent';
export const FAQ_TOPICS = [
  'shipping',
  'returns',
  'payment',
  'orders',
  'account',
  'warranty',
] as const;
export type FaqTopic = (typeof FAQ_TOPICS)[number];

@Entity('users')
export class User {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 254 })
  email: string;

  @Column({ name: 'password_hash', type: 'varchar', length: 100 })
  passwordHash: string;

  @Column({ type: 'varchar', length: 100 })
  name: string;

  @Column({ type: 'varchar', length: 20, default: 'CUSTOMER' })
  role: Role;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}

@Entity('categories')
export class Category {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 60 })
  name: string;

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 60 })
  slug: string;
}

@Entity('products')
@Index(['isActive', 'priceCents'])
// Search indexes created by the SearchIndexes migration; TypeORM must not drop them.
@Index('IDX_products_name_trgm', { synchronize: false })
@Index('IDX_products_description_trgm', { synchronize: false })
@Index('IDX_products_tags', { synchronize: false })
@Check(`"stock" >= 0`)
@Check(`"price_cents" >= 0`)
export class Product {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 40 })
  sku: string;

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 120 })
  slug: string;

  @Column({ type: 'varchar', length: 200 })
  name: string;

  @Column({ type: 'varchar', length: 60 })
  brand: string;

  @Column({ type: 'text' })
  description: string;

  @Column({ name: 'price_cents', type: 'integer' })
  priceCents: number;

  @Column({ type: 'integer', default: 0 })
  stock: number;

  @Column({ type: 'real', default: 0 })
  rating: number;

  @Column({ type: 'text', array: true, default: () => "'{}'" })
  tags: string[];

  @Column({ type: 'jsonb', default: () => "'{}'" })
  attributes: Record<string, string>;

  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive: boolean;

  @Column({ name: 'category_id', type: 'uuid' })
  categoryId: string;

  @ManyToOne(() => Category, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'category_id' })
  category: Category;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}

@Entity('carts')
export class Cart {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index({ unique: true })
  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @Column({ name: 'coupon_code', type: 'varchar', length: 40, nullable: true })
  couponCode: string | null;

  @OneToMany(() => CartItem, (i) => i.cart)
  items: CartItem[];

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}

@Entity('cart_items')
@Unique(['cartId', 'productId'])
@Check(`"quantity" > 0`)
export class CartItem {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'cart_id', type: 'uuid' })
  cartId: string;

  @ManyToOne(() => Cart, (c) => c.items, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'cart_id' })
  cart: Cart;

  @Column({ name: 'product_id', type: 'uuid' })
  productId: string;

  @ManyToOne(() => Product, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'product_id' })
  product: Product;

  @Column({ type: 'integer' })
  quantity: number;
}

@Entity('coupons')
export class Coupon {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 40 })
  code: string;

  @Column({ name: 'percent_off', type: 'integer', nullable: true })
  percentOff: number | null;

  @Column({ name: 'amount_off_cents', type: 'integer', nullable: true })
  amountOffCents: number | null;

  @Column({ name: 'min_subtotal_cents', type: 'integer', default: 0 })
  minSubtotalCents: number;

  @Column({ name: 'expires_at', type: 'timestamptz', nullable: true })
  expiresAt: Date | null;

  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive: boolean;
}

@Entity('orders')
@Index(['userId', 'createdAt'])
export class Order {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index({ unique: true })
  @Column({ name: 'order_number', type: 'varchar', length: 20 })
  orderNumber: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  @ManyToOne(() => User, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @Column({ type: 'varchar', length: 20 })
  status: OrderStatus;

  @Column({ name: 'subtotal_cents', type: 'integer' })
  subtotalCents: number;

  @Column({ name: 'discount_cents', type: 'integer', default: 0 })
  discountCents: number;

  @Column({ name: 'shipping_cents', type: 'integer', default: 0 })
  shippingCents: number;

  @Column({ name: 'total_cents', type: 'integer' })
  totalCents: number;

  @Column({ name: 'coupon_code', type: 'varchar', length: 40, nullable: true })
  couponCode: string | null;

  @Column({ name: 'shipping_address', type: 'jsonb', nullable: true })
  shippingAddress: Record<string, string> | null;

  @Column({ type: 'varchar', length: 40, nullable: true })
  carrier: string | null;

  @Column({
    name: 'tracking_number',
    type: 'varchar',
    length: 60,
    nullable: true,
  })
  trackingNumber: string | null;

  @Column({ name: 'shipped_at', type: 'timestamptz', nullable: true })
  shippedAt: Date | null;

  @Column({ name: 'delivered_at', type: 'timestamptz', nullable: true })
  deliveredAt: Date | null;

  @OneToMany(() => OrderItem, (i) => i.order)
  items: OrderItem[];

  @OneToMany(() => ReturnRequest, (r) => r.order)
  returns: ReturnRequest[];

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}

@Entity('order_items')
export class OrderItem {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'order_id', type: 'uuid' })
  orderId: string;

  @ManyToOne(() => Order, (o) => o.items, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'order_id' })
  order: Order;

  // Kept if the product is later deleted; name and price are frozen at purchase.
  @Column({ name: 'product_id', type: 'uuid', nullable: true })
  productId: string | null;

  @ManyToOne(() => Product, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'product_id' })
  product: Product | null;

  @Column({ name: 'name_snapshot', type: 'varchar', length: 200 })
  nameSnapshot: string;

  @Column({ name: 'unit_price_cents', type: 'integer' })
  unitPriceCents: number;

  @Column({ type: 'integer' })
  quantity: number;
}

@Entity('return_requests')
export class ReturnRequest {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'order_id', type: 'uuid' })
  orderId: string;

  @ManyToOne(() => Order, (o) => o.returns, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'order_id' })
  order: Order;

  @Index()
  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @Column({ type: 'text' })
  reason: string;

  @Column({ type: 'jsonb' })
  items: { orderItemId: string; quantity: number }[];

  @Column({ type: 'varchar', length: 20, default: 'REQUESTED' })
  status: ReturnStatus;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}

@Entity('faq_articles')
export class FaqArticle {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 20 })
  topic: FaqTopic;

  @Column({ type: 'varchar', length: 300 })
  question: string;

  @Column({ type: 'text' })
  answer: string;
}

@Entity('support_tickets')
export class SupportTicket {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ name: 'user_id', type: 'uuid', nullable: true })
  userId: string | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'user_id' })
  user: User | null;

  @Column({
    name: 'conversation_id',
    type: 'varchar',
    length: 64,
    nullable: true,
  })
  conversationId: string | null;

  @Column({
    name: 'contact_email',
    type: 'varchar',
    length: 254,
    nullable: true,
  })
  contactEmail: string | null;

  @Column({ type: 'varchar', length: 200 })
  subject: string;

  @Column({ type: 'text' })
  summary: string;

  @Column({ type: 'varchar', length: 10, default: 'normal' })
  priority: TicketPriority;

  @Column({ type: 'varchar', length: 20, default: 'OPEN' })
  status: TicketStatus;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}

@Entity('agent_action_logs')
export class AgentActionLog {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ name: 'user_id', type: 'uuid', nullable: true })
  userId: string | null;

  @Index()
  @Column({
    name: 'conversation_id',
    type: 'varchar',
    length: 64,
    nullable: true,
  })
  conversationId: string | null;

  @Column({ type: 'varchar', length: 120 })
  action: string;

  @Column({ type: 'jsonb', default: () => "'{}'" })
  payload: Record<string, unknown>;

  // HTTP status of the attempt; null only for rows written before it was recorded.
  @Column({ type: 'integer', nullable: true })
  status: number | null;

  // Error message shown to the shopper when the attempt failed.
  @Column({ type: 'varchar', length: 500, nullable: true })
  error: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}

/** Stored responses for `Idempotency-Key` retries (docs/ARCHITECTURE.md §11.4). */
@Entity('idempotency_keys')
// Unique per (user_id, key) with NULLS NOT DISTINCT, so guest keys are unique too.
@Index('UQ_idempotency_keys_user_key', { synchronize: false })
export class IdempotencyKey {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 100 })
  key: string;

  @Column({ name: 'user_id', type: 'uuid', nullable: true })
  userId: string | null;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User | null;

  @Column({ type: 'varchar', length: 120 })
  route: string;

  @Column({ name: 'request_hash', type: 'char', length: 64 })
  requestHash: string;

  // Null while the first request is still running.
  @Column({ type: 'jsonb', nullable: true })
  response: Record<string, unknown> | null;

  @Column({ name: 'status_code', type: 'integer', nullable: true })
  statusCode: number | null;

  @Index()
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}

export const ENTITIES = [
  User,
  Category,
  Product,
  Cart,
  CartItem,
  Coupon,
  Order,
  OrderItem,
  ReturnRequest,
  FaqArticle,
  SupportTicket,
  AgentActionLog,
  IdempotencyKey,
];
