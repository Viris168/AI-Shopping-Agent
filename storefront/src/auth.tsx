import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { api, configureApi } from './api';
import { storage } from './storage';
import type { Session, User } from './types';

const TOKEN_KEY = 'storefront.token';
const USER_KEY = 'storefront.user';

interface AuthState {
  user: User | null;
  token: string | null;
  login: (email: string, password: string) => Promise<void>;
  register: (name: string, email: string, password: string) => Promise<void>;
  logout: () => void;
  /** True right after an expired session was cleared, so the login page can explain why. */
  sessionExpired: boolean;
}

const AuthContext = createContext<AuthState | null>(null);

function readUser(): User | null {
  try {
    const raw = storage.get(USER_KEY);
    return raw ? (JSON.parse(raw) as User) : null;
  } catch {
    return null;
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState<string | null>(() => storage.get(TOKEN_KEY));
  const [user, setUser] = useState<User | null>(() => (storage.get(TOKEN_KEY) ? readUser() : null));
  const [sessionExpired, setSessionExpired] = useState(false);
  const tokenRef = useRef(token);
  tokenRef.current = token;

  const save = useCallback((session: Session | null) => {
    storage.set(TOKEN_KEY, session?.accessToken ?? null);
    storage.set(USER_KEY, session ? JSON.stringify(session.user) : null);
    tokenRef.current = session?.accessToken ?? null;
    setToken(session?.accessToken ?? null);
    setUser(session?.user ?? null);
  }, []);

  // Configure synchronously during render so the very first requests already carry the token.
  configureApi(
    () => tokenRef.current,
    () => {
      save(null);
      setSessionExpired(true);
    },
  );

  const value = useMemo<AuthState>(
    () => ({
      user,
      token,
      sessionExpired,
      login: async (email, password) => {
        save(await api.login(email, password));
        setSessionExpired(false);
      },
      register: async (name, email, password) => {
        save(await api.register(name, email, password));
        setSessionExpired(false);
      },
      logout: () => save(null),
    }),
    [user, token, sessionExpired, save],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
