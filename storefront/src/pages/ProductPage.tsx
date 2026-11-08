import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router';
import { api, ApiError } from '../api';
import { useAuth } from '../auth';
import { useCart } from '../cart';
import { ProductCard } from '../components/ProductCard';
import { ProductImage } from '../components/ProductImage';
import { ErrorBox, Loading, Notice, Rating } from '../components/ui';
import { useAsync } from '../useAsync';

const label = (key: string) => key.charAt(0).toUpperCase() + key.slice(1);

export function ProductPage() {
  const { slug = '' } = useParams();
  const { user } = useAuth();
  const { setCart } = useCart();
  const navigate = useNavigate();
  const location = useLocation();
  const product = useAsync(() => api.product(slug), [slug]);
  const recs = useAsync(() => api.recommendations(slug), [slug]);
  const [quantity, setQuantity] = useState(1);
  const [adding, setAdding] = useState(false);
  const [added, setAdded] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    setQuantity(1);
    setAdded(false);
    setError(undefined);
  }, [slug]);

  if (product.error) {
    return product.error instanceof ApiError && product.error.status === 404 ? (
      <div className="empty">
        <h1>Product not found</h1>
        <Link to="/">Back to the shop</Link>
      </div>
    ) : (
      <ErrorBox error={product.error} onRetry={product.reload} />
    );
  }
  if (!product.data) return <Loading />;
  const p = product.data;
  const maxQty = Math.min(20, p.stock);

  const addToCart = async () => {
    if (!user) {
      navigate(`/login?next=${encodeURIComponent(location.pathname)}`);
      return;
    }
    setAdding(true);
    setError(undefined);
    setAdded(false);
    try {
      setCart(await api.addToCart(p.id, quantity));
      setAdded(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setAdding(false);
    }
  };

  return (
    <>
      <nav className="breadcrumbs" aria-label="Breadcrumb">
        <Link to="/">Shop</Link> <span aria-hidden="true">/</span> {p.category}
      </nav>
      <div className="product-detail">
        <ProductImage name={p.name} category={p.category} large />
        <div className="product-info">
          <p className="eyebrow">{p.brand}</p>
          <h1>{p.name}</h1>
          <div className="product-meta">
            <span className="price price-large">{p.price}</span>
            <Rating value={p.rating} />
          </div>
          <p className="description">{p.description}</p>

          {p.inStock ? (
            <p className={`stock ${p.stock <= 10 ? 'stock-low' : 'stock-in'}`}>
              {p.stock <= 10 ? `Only ${p.stock} left in stock` : 'In stock'}
            </p>
          ) : (
            <p className="stock stock-out">Out of stock</p>
          )}

          {p.inStock && (
            <div className="buy-row">
              <label>
                <span className="visually-hidden">Quantity</span>
                <select value={quantity} onChange={(e) => setQuantity(Number(e.target.value))}>
                  {Array.from({ length: maxQty }, (_, i) => i + 1).map((n) => (
                    <option key={n} value={n}>
                      Qty {n}
                    </option>
                  ))}
                </select>
              </label>
              <button type="button" className="btn btn-primary" onClick={addToCart} disabled={adding}>
                {adding ? 'Adding…' : user ? 'Add to cart' : 'Log in to buy'}
              </button>
            </div>
          )}
          {added && (
            <Notice>
              Added to your cart. <Link to="/cart">View cart</Link>
            </Notice>
          )}
          {error && <ErrorBox error={error} />}

          {Object.keys(p.attributes).length > 0 && (
            <dl className="attributes">
              {Object.entries(p.attributes).map(([k, v]) => (
                <div key={k}>
                  <dt>{label(k)}</dt>
                  <dd>{v}</dd>
                </div>
              ))}
              <div>
                <dt>SKU</dt>
                <dd>{p.sku}</dd>
              </div>
            </dl>
          )}
        </div>
      </div>

      {recs.data && recs.data.items.length > 0 && (
        <section className="recommendations" aria-labelledby="recs-heading">
          <h2 id="recs-heading">You might also like</h2>
          <div className="product-grid">
            {recs.data.items.map((r) => (
              <ProductCard key={r.id} product={r} />
            ))}
          </div>
        </section>
      )}
    </>
  );
}
