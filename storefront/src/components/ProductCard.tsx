import { Link } from 'react-router';
import type { ProductListItem } from '../types';
import { ProductImage } from './ProductImage';
import { Rating } from './ui';

export function ProductCard({ product }: { product: ProductListItem }) {
  return (
    <article className="product-card">
      <Link to={`/products/${product.slug}`} className="product-card-link">
        <ProductImage name={product.name} category={product.category} />
        <div className="product-card-body">
          <p className="eyebrow">{product.brand}</p>
          <h3 className="product-card-title">{product.name}</h3>
          <div className="product-card-meta">
            <span className="price">{product.price}</span>
            <Rating value={product.rating} />
          </div>
          {!product.inStock && <p className="stock stock-out">Out of stock</p>}
          {product.inStock && product.stock <= 10 && <p className="stock stock-low">Only {product.stock} left</p>}
        </div>
      </Link>
    </article>
  );
}
