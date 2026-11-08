import bcrypt from 'bcryptjs';
import { pathToFileURL } from 'node:url';
import { DataSource, type EntityManager } from 'typeorm';
import { BCRYPT_COST } from '../auth/auth.service.js';
import { priceCart } from '../cart/pricing.js';
import {
  Category,
  Coupon,
  FaqArticle,
  Order,
  OrderItem,
  Product,
  User,
  type OrderStatus,
} from './entities.js';
import { embedAll, formatCounts } from './embed.js';
import { dataSourceOptions } from './options.js';
import {
  CATEGORIES,
  FAQS,
  PLANTED_FAQ,
  PLANTED_PRODUCT,
  PRODUCTS,
} from './seed-data.js';

export const DEMO_PASSWORD = 'Password123!';
// Fixed IDs so tokens issued before a re-seed still point at the same demo shopper.
export const ALICE_ID = '00000000-0000-4000-8000-0000000a11ce';
export const BOB_ID = '00000000-0000-4000-8000-000000000b0b';
const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY_MS);

interface SeedOrder {
  orderNumber: string;
  user: User;
  status: OrderStatus;
  placedDaysAgo: number;
  items: [sku: string, quantity: number][];
  carrier?: string;
  trackingNumber?: string;
  shippedDaysAgo?: number;
  deliveredDaysAgo?: number;
}

/**
 * Wipes every table and loads the demo data (docs/AGENT.md §10). Dev and test only.
 * Fixtures: ORD-1001 delivered 7 days ago (returnable), ORD-1002 shipped, ORD-1003
 * processing, ORD-0950 delivered 65 days ago (window closed); ORD-1004 belongs to Bob.
 * Red-team fixtures: product OUT-005 and the gift-card FAQ carry planted instructions.
 */
export async function seed(db: DataSource) {
  if (process.env.NODE_ENV === 'production')
    throw new Error('Refusing to seed a production database');

  await db.transaction(async (m) => {
    const tables = db.entityMetadatas.map((e) => `"${e.tableName}"`).join(', ');
    await m.query(`TRUNCATE ${tables} RESTART IDENTITY CASCADE`);
    await m.query(`ALTER SEQUENCE order_number_seq RESTART WITH 2001`);

    const categories = await m.save(
      CATEGORIES.map((c) => m.create(Category, c)),
    );
    const categoryId = (slug: string) =>
      categories.find((c) => c.slug === slug)!.id;
    const products = await m.save(
      [...PRODUCTS, PLANTED_PRODUCT].map(({ category, ...p }) =>
        m.create(Product, { ...p, categoryId: categoryId(category) }),
      ),
    );

    const passwordHash = await bcrypt.hash(DEMO_PASSWORD, BCRYPT_COST);
    const [alice, bob] = await m.save([
      m.create(User, {
        id: ALICE_ID,
        email: 'alice@example.com',
        name: 'Alice',
        passwordHash,
      }),
      m.create(User, {
        id: BOB_ID,
        email: 'bob@example.com',
        name: 'Bob',
        passwordHash,
      }),
    ]);

    await m.save([
      m.create(Coupon, { code: 'WELCOME10', percentOff: 10 }),
      m.create(Coupon, {
        code: 'SAVE20',
        amountOffCents: 2000,
        minSubtotalCents: 10000,
      }),
      m.create(Coupon, {
        code: 'OLD2023',
        percentOff: 50,
        expiresAt: new Date('2023-12-31T23:59:59Z'),
      }),
    ]);

    const orders: SeedOrder[] = [
      {
        orderNumber: 'ORD-1001',
        user: alice,
        status: 'DELIVERED',
        placedDaysAgo: 12,
        items: [
          ['SHOE-001', 1],
          ['CLO-001', 2],
        ],
        carrier: 'UPS',
        trackingNumber: '1Z999AA10123456784',
        shippedDaysAgo: 10,
        deliveredDaysAgo: 7,
      },
      {
        orderNumber: 'ORD-1002',
        user: alice,
        status: 'SHIPPED',
        placedDaysAgo: 4,
        items: [['ELEC-001', 1]],
        carrier: 'FedEx',
        trackingNumber: '612999AA10123456',
        shippedDaysAgo: 2,
      },
      {
        orderNumber: 'ORD-1003',
        user: alice,
        status: 'PROCESSING',
        placedDaysAgo: 1,
        items: [
          ['ELEC-002', 1],
          ['OUT-001', 1],
        ],
      },
      {
        orderNumber: 'ORD-0950',
        user: alice,
        status: 'DELIVERED',
        placedDaysAgo: 70,
        items: [['OUT-002', 1]],
        carrier: 'USPS',
        trackingNumber: '9400111899223197428490',
        shippedDaysAgo: 68,
        deliveredDaysAgo: 65,
      },
      {
        orderNumber: 'ORD-1004',
        user: bob,
        status: 'DELIVERED',
        placedDaysAgo: 6,
        items: [['CLO-002', 1]],
        carrier: 'UPS',
        trackingNumber: '1Z999AA10123456999',
        shippedDaysAgo: 5,
        deliveredDaysAgo: 3,
      },
    ];
    for (const o of orders) await saveOrder(m, o, products);

    await m.save([...FAQS, PLANTED_FAQ].map((f) => m.create(FaqArticle, f)));
  });
}

async function saveOrder(m: EntityManager, o: SeedOrder, products: Product[]) {
  const lines = o.items.map(([sku, quantity]) => ({
    product: products.find((p) => p.sku === sku)!,
    quantity,
  }));
  const price = priceCart(
    lines.map((l) => ({
      priceCents: l.product.priceCents,
      quantity: l.quantity,
    })),
    null,
  );
  const order = await m.save(
    m.create(Order, {
      orderNumber: o.orderNumber,
      userId: o.user.id,
      status: o.status,
      subtotalCents: price.subtotalCents,
      discountCents: 0,
      shippingCents: price.shippingCents,
      totalCents: price.totalCents,
      shippingAddress: { name: o.user.name, city: 'Portland', country: 'US' },
      carrier: o.carrier ?? null,
      trackingNumber: o.trackingNumber ?? null,
      shippedAt:
        o.shippedDaysAgo === undefined ? null : daysAgo(o.shippedDaysAgo),
      deliveredAt:
        o.deliveredDaysAgo === undefined ? null : daysAgo(o.deliveredDaysAgo),
      createdAt: daysAgo(o.placedDaysAgo),
    }),
  );
  await m.save(
    lines.map((l) =>
      m.create(OrderItem, {
        orderId: order.id,
        productId: l.product.id,
        nameSnapshot: l.product.name,
        unitPriceCents: l.product.priceCents,
        quantity: l.quantity,
      }),
    ),
  );
}

// `npm run seed` runs this file directly.
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    process.loadEnvFile();
  } catch {
    // No .env file: use the real environment.
  }
  const db = await new DataSource(dataSourceOptions()).initialize();
  try {
    await seed(db);
    console.log('Seeded demo data. Log in as alice@example.com / Password123!');
    // Only here, not in seed(): e2e tests seed before every test and don't need vectors.
    console.log(`Embeddings · ${formatCounts(await embedAll(db))}`);
  } finally {
    await db.destroy();
  }
}
