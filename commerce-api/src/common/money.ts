/** Formats integer cents for display, e.g. 4999 → "$49.99". Use only at the edge (DTOs). */
export function formatMoney(cents: number, currency = 'USD'): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(
    cents / 100,
  );
}
