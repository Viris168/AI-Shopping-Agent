import { useEffect, useState, type FormEvent } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate, useSearchParams } from 'react-router';
import { useAuth } from '../auth';
import { useCart } from '../cart';
import { ChatWidget } from './ChatWidget';

export function Layout() {
  const { user, logout } = useAuth();
  const { cart } = useCart();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const urlQuery = params.get('q') ?? '';
  const [query, setQuery] = useState(urlQuery);
  useEffect(() => {
    setQuery(urlQuery);
  }, [urlQuery]);

  const search = (e: FormEvent) => {
    e.preventDefault();
    const q = query.trim();
    navigate(q ? `/?q=${encodeURIComponent(q)}` : '/');
  };

  const { pathname } = useLocation();
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname]);

  const count = cart?.itemCount ?? 0;

  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="site-header">
        <div className="container header-inner">
          <Link to="/" className="brand">
            <span className="brand-mark" aria-hidden="true">N</span>
            <span>Northwind Outfitters</span>
          </Link>
          <form className="header-search" role="search" onSubmit={search}>
            <label className="visually-hidden" htmlFor="site-search">
              Search products
            </label>
            <input
              id="site-search"
              type="search"
              placeholder="Search products"
              value={query}
              maxLength={200}
              onChange={(e) => setQuery(e.target.value)}
            />
          </form>
          <nav className="header-nav" aria-label="Main">
            <NavLink to="/" end>
              Shop
            </NavLink>
            <NavLink to="/help">Help</NavLink>
            {user && <NavLink to="/orders">Orders</NavLink>}
            <NavLink to="/cart" className="cart-link" aria-label={`Cart, ${count} item${count === 1 ? '' : 's'}`}>
              Cart
              {count > 0 && <span className="cart-count">{count}</span>}
            </NavLink>
            {user ? (
              <span className="account">
                <span className="account-name" title={user.email}>
                  Hi, {user.name}
                </span>
                <button
                  type="button"
                  className="btn btn-small btn-ghost"
                  onClick={() => {
                    logout();
                    navigate('/');
                  }}
                >
                  Log out
                </button>
              </span>
            ) : (
              <NavLink to="/login" className="btn btn-small">
                Log in
              </NavLink>
            )}
          </nav>
        </div>
      </header>
      <main id="main" className="container main">
        <Outlet />
      </main>
      <footer className="site-footer">
        <div className="container">
          Demo store for commerce-api. Pay doesn’t charge anything; orders are marked paid right away.
        </div>
      </footer>
      <ChatWidget />
    </>
  );
}
