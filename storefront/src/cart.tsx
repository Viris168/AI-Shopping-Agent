import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { api } from './api';
import { useAuth } from './auth';
import type { Cart } from './types';

interface CartState {
  cart: Cart | null;
  loading: boolean;
  /** Replace the cart with the one returned by a cart mutation. */
  setCart: (cart: Cart | null) => void;
  refresh: () => Promise<void>;
}

const CartContext = createContext<CartState | null>(null);

/** Keeps the shopper's cart (for the header badge and cart page). Empty for guests. */
export function CartProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [cart, setCart] = useState<Cart | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!user) {
      setCart(null);
      return;
    }
    setLoading(true);
    try {
      setCart(await api.cart());
    } catch {
      setCart(null);
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const value = useMemo(() => ({ cart, loading, setCart, refresh }), [cart, loading, refresh]);
  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

export function useCart(): CartState {
  const ctx = useContext(CartContext);
  if (!ctx) throw new Error('useCart must be used inside CartProvider');
  return ctx;
}
