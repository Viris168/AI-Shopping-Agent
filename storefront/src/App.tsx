import { Link, Route, Routes } from 'react-router';
import { Layout } from './components/Layout';
import { RequireAuth } from './components/RequireAuth';
import { LoginPage, RegisterPage } from './pages/AuthPages';
import { CartPage } from './pages/CartPage';
import { HelpPage } from './pages/HelpPage';
import { OrderPage } from './pages/OrderPage';
import { OrdersPage } from './pages/OrdersPage';
import { ProductPage } from './pages/ProductPage';
import { ShopPage } from './pages/ShopPage';

export function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<ShopPage />} />
        <Route path="products/:slug" element={<ProductPage />} />
        <Route path="login" element={<LoginPage />} />
        <Route path="register" element={<RegisterPage />} />
        <Route path="help" element={<HelpPage />} />
        <Route path="cart" element={<RequireAuth><CartPage /></RequireAuth>} />
        <Route path="orders" element={<RequireAuth><OrdersPage /></RequireAuth>} />
        <Route path="orders/:orderNumber" element={<RequireAuth><OrderPage /></RequireAuth>} />
        <Route
          path="*"
          element={
            <div className="empty">
              <h1>Page not found</h1>
              <Link to="/">Back to the shop</Link>
            </div>
          }
        />
      </Route>
    </Routes>
  );
}
