import { useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router';
import { api, type ProductQuery } from '../api';
import { ProductCard } from '../components/ProductCard';
import { ErrorBox, Loading } from '../components/ui';
import { useAsync } from '../useAsync';

const PAGE_SIZE = 12;
const SORTS: { value: NonNullable<ProductQuery['sort']>; label: string }[] = [
  { value: 'relevance', label: 'Best match' },
  { value: 'price_asc', label: 'Price: low to high' },
  { value: 'price_desc', label: 'Price: high to low' },
  { value: 'rating', label: 'Top rated' },
  { value: 'newest', label: 'Newest' },
];

const toCents = (dollars: string | null) => {
  if (!dollars) return undefined;
  const n = Number(dollars);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : undefined;
};

/** All filters live in the URL, so results can be shared and the back button works. */
export function ShopPage() {
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const category = params.get('category') ?? '';
  const sort = (params.get('sort') ?? 'relevance') as NonNullable<ProductQuery['sort']>;
  const inStock = params.get('inStock') === 'true';
  const min = params.get('min');
  const max = params.get('max');
  const page = Math.max(1, Number(params.get('page')) || 1);

  const categories = useAsync(() => api.categories(), []);
  const products = useAsync(
    () =>
      api.products({
        q: q || undefined,
        category: category || undefined,
        sort,
        inStock: inStock || undefined,
        minPriceCents: toCents(min),
        maxPriceCents: toCents(max),
        limit: PAGE_SIZE,
        offset: (page - 1) * PAGE_SIZE,
      }),
    [q, category, sort, inStock, min, max, page],
  );

  const update = (changes: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(changes)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    if (!('page' in changes)) next.delete('page');
    setParams(next);
  };

  const [minInput, setMinInput] = useState(min ?? '');
  const [maxInput, setMaxInput] = useState(max ?? '');
  const applyPrice = (e: FormEvent) => {
    e.preventDefault();
    update({ min: minInput.trim() || null, max: maxInput.trim() || null });
  };

  const total = products.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const hasFilters = q || category || inStock || min || max;
  const heading = q
    ? `Results for “${q}”`
    : (categories.data?.find((c) => c.slug === category)?.name ?? 'All products');

  return (
    <div className="shop">
      <aside className="filters" aria-label="Filters">
        <section>
          <h2 className="filters-title">Category</h2>
          <ul className="category-list">
            <li>
              <button type="button" className={!category ? 'active' : ''} onClick={() => update({ category: null })}>
                All
              </button>
            </li>
            {categories.data?.map((c) => (
              <li key={c.slug}>
                <button
                  type="button"
                  className={category === c.slug ? 'active' : ''}
                  aria-pressed={category === c.slug}
                  onClick={() => update({ category: c.slug })}
                >
                  {c.name}
                </button>
              </li>
            ))}
          </ul>
        </section>
        <section>
          <h2 className="filters-title">Price</h2>
          <form className="price-form" onSubmit={applyPrice}>
            <label>
              <span className="visually-hidden">Minimum price in dollars</span>
              <input type="number" min={0} step="1" inputMode="decimal" placeholder="Min $" value={minInput} onChange={(e) => setMinInput(e.target.value)} />
            </label>
            <span aria-hidden="true">–</span>
            <label>
              <span className="visually-hidden">Maximum price in dollars</span>
              <input type="number" min={0} step="1" inputMode="decimal" placeholder="Max $" value={maxInput} onChange={(e) => setMaxInput(e.target.value)} />
            </label>
            <button type="submit" className="btn btn-small btn-ghost">
              Go
            </button>
          </form>
        </section>
        <section>
          <label className="checkbox">
            <input type="checkbox" checked={inStock} onChange={(e) => update({ inStock: e.target.checked ? 'true' : null })} />
            In stock only
          </label>
        </section>
        {hasFilters && (
          <button
            type="button"
            className="btn btn-small btn-ghost"
            onClick={() => {
              setMinInput('');
              setMaxInput('');
              setParams(new URLSearchParams());
            }}
          >
            Clear all filters
          </button>
        )}
      </aside>

      <section className="results" aria-labelledby="results-heading">
        <div className="results-header">
          <div>
            <h1 id="results-heading">{heading}</h1>
            {products.data && (
              <p className="muted" aria-live="polite">
                {total} {total === 1 ? 'product' : 'products'}
              </p>
            )}
          </div>
          <label className="sort">
            Sort by
            <select value={sort} onChange={(e) => update({ sort: e.target.value === 'relevance' ? null : e.target.value })}>
              {SORTS.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
        </div>

        {products.error && <ErrorBox error={products.error} onRetry={products.reload} />}
        {products.loading && !products.data && <Loading label="Loading products…" />}
        {products.data && products.data.items.length === 0 && (
          <div className="empty">
            <p>No products match your search.</p>
            {hasFilters && <Link to="/">See all products</Link>}
          </div>
        )}
        {products.data && products.data.items.length > 0 && (
          <div className={`product-grid${products.loading ? ' is-stale' : ''}`}>
            {products.data.items.map((p) => (
              <ProductCard key={p.id} product={p} />
            ))}
          </div>
        )}
        {pages > 1 && (
          <nav className="pagination" aria-label="Pages">
            <button type="button" className="btn btn-small btn-ghost" disabled={page <= 1} onClick={() => update({ page: String(page - 1) })}>
              Previous
            </button>
            <span>
              Page {page} of {pages}
            </span>
            <button type="button" className="btn btn-small btn-ghost" disabled={page >= pages} onClick={() => update({ page: String(page + 1) })}>
              Next
            </button>
          </nav>
        )}
      </section>
    </div>
  );
}
