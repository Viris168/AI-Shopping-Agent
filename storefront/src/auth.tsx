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

// Who is signed in, for the first render. Not a secret: the session is an httpOnly cookie, and
// a stale entry is cleared by the first 401.
const USER_KEY = 'storefront.user';
// Where older builds kept the bearer token; removed on load.
const LEGACY_TOKEN_KEY = 'storefront.token';

interface AuthState {
  user: User | null;
  login: (email: string, password: string) => Promise<void>;
  register: (name: string, email: string, password: string) => Promise<void>;
  logout: () => void;
  /** True right after an expired session was cleared, so the login page can explain why. */
  sessionExpired: boolean;
}

const AuthContext = createContext<AuthState | null>(null);

function readUser(): User | null {
  // Signed in under the old token scheme: the cookie doesn't exist yet, so log in again.
  if (storage.get(LEGACY_TOKEN_KEY)) {
    storage.set(LEGACY_TOKEN_KEY, null);
    storage.set(USER_KEY, null);
    return null;
  }
  try {
    const raw = storage.get(USER_KEY);
    return raw ? (JSON.parse(raw) as User) : null;
  } catch {
    return null;
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(readUser);
  const [sessionExpired, setSessionExpired] = useState(false);
  const userRef = useRef(user);
  userRef.current = user;

  const save = useCallback((session: Session | null) => {
    storage.set(USER_KEY, session ? JSON.stringify(session.user) : null);
    userRef.current = session?.user ?? null;
    setUser(session?.user ?? null);
  }, []);

  // Configure synchronously during render so the very first requests know who is signed in.
  configureApi(
    () => userRef.current !== null,
    () => {
      save(null);
      setSessionExpired(true);
    },
  );

  const value = useMemo<AuthState>(
    () => ({
      user,
      sessionExpired,
      login: async (email, password) => {
        save(await api.login(email, password));
        setSessionExpired(false);
      },
      register: async (name, email, password) => {
        save(await api.register(name, email, password));
        setSessionExpired(false);
      },
      logout: () => {
        // Best effort: the UI signs out at once; the server revokes the tokens and clears the cookie.
        void api.logout().catch(() => {});
        save(null);
      },
    }),
    [user, sessionExpired, save],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
