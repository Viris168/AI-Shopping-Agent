// Placeholder art: commerce-api's imageUrl points at a storefront /images path that has no files yet.
const TONES: Record<string, string> = {
  Shoes: 'tone-shoes',
  Clothing: 'tone-clothing',
  Electronics: 'tone-electronics',
  Outdoor: 'tone-outdoor',
};

export function ProductImage({ name, category, large = false }: { name: string; category: string; large?: boolean }) {
  const initials = name
    .split(/\s+/)
    .filter((w) => /^[A-Za-z]/.test(w))
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('');
  return (
    <div className={`product-image ${TONES[category] ?? 'tone-default'}${large ? ' product-image-large' : ''}`} aria-hidden="true">
      <span className="product-image-initials">{initials}</span>
      <span className="product-image-category">{category}</span>
    </div>
  );
}
