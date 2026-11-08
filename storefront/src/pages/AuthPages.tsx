import { useState, type FormEvent } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router';
import { useAuth } from '../auth';
import { safeNext } from '../components/RequireAuth';
import { ErrorBox, Notice } from '../components/ui';

function useAuthForm() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const next = safeNext(params.get('next'));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const submit = (action: () => Promise<void>) => async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await action();
      navigate(next, { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };
  return { next, busy, error, submit };
}

export function LoginPage() {
  const { user, login, sessionExpired } = useAuth();
  const { next, busy, error, submit } = useAuthForm();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  if (user) return <Navigate to={next} replace />;

  return (
    <div className="auth-card">
      <h1>Log in</h1>
      {sessionExpired && <Notice tone="info">Your session expired. Please log in again.</Notice>}
      <form onSubmit={submit(() => login(email, password))} className="form">
        <label>
          Email
          <input type="email" autoComplete="username" required maxLength={254} value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label>
          Password
          <input type="password" autoComplete="current-password" required maxLength={72} value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {error && <ErrorBox error={error} />}
        <button type="submit" className="btn btn-primary btn-block" disabled={busy}>
          {busy ? 'Logging in…' : 'Log in'}
        </button>
      </form>
      <p className="muted">
        New here? <Link to={`/register?next=${encodeURIComponent(next)}`}>Create an account</Link>
      </p>
      <p className="hint">Demo account: alice@example.com / Password123!</p>
    </div>
  );
}

export function RegisterPage() {
  const { user, register } = useAuth();
  const { next, busy, error, submit } = useAuthForm();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  if (user) return <Navigate to={next} replace />;

  return (
    <div className="auth-card">
      <h1>Create an account</h1>
      <form onSubmit={submit(() => register(name.trim(), email, password))} className="form">
        <label>
          Name
          <input autoComplete="name" required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label>
          Email
          <input type="email" autoComplete="email" required maxLength={254} value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label>
          Password
          <input
            type="password"
            autoComplete="new-password"
            required
            minLength={8}
            maxLength={72}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            aria-describedby="password-help"
          />
          <span id="password-help" className="field-help">
            At least 8 characters.
          </span>
        </label>
        {error && <ErrorBox error={error} />}
        <button type="submit" className="btn btn-primary btn-block" disabled={busy}>
          {busy ? 'Creating account…' : 'Create account'}
        </button>
      </form>
      <p className="muted">
        Already have an account? <Link to={`/login?next=${encodeURIComponent(next)}`}>Log in</Link>
      </p>
    </div>
  );
}
