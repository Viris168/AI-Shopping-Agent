import { formatMoney } from '../common/money.js';
import type { Product } from '../database/entities.js';

const storefront = () =>
  (process.env.STOREFRONT_URL ?? 'http://localhost:8080').replace(/\/$/, '');

// Shapes from docs/AGENT.md §4. `product.category` must be loaded.
export function toProductListItem(p: Product) {
  return {
    id: p.id,
    sku: p.sku,
    name: p.name,
    slug: p.slug,
    brand: p.brand,
    category: p.category.name,
    price: formatMoney(p.priceCents),
    priceCents: p.priceCents,
    inStock: p.stock > 0,
    stock: p.stock,
    rating: p.rating,
    imageUrl: `${storefront()}/images/${p.slug}.jpg`,
    url: `${storefront()}/products/${p.slug}`,
    summary: p.description.slice(0, 160),
  };
}

export function toProductDetail(p: Product) {
  const { summary: _summary, ...rest } = toProductListItem(p);
  return {
    ...rest,
    description: p.description,
    attributes: p.attributes,
    tags: p.tags,
  };
}
