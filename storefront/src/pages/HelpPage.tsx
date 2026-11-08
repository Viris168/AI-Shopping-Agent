import { useState, type FormEvent } from 'react';
import { api } from '../api';
import { useAuth } from '../auth';
import { ErrorBox, Loading, Notice } from '../components/ui';
import type { FaqResult, FaqTopic, TicketCreated } from '../types';

const TOPICS: FaqTopic[] = ['shipping', 'returns', 'payment', 'orders', 'account', 'warranty'];
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function HelpPage() {
  return (
    <div className="help">
      <h1>Help center</h1>
      <FaqSearch />
      <ContactForm />
    </div>
  );
}

function FaqSearch() {
  const [query, setQuery] = useState('');
  const [topic, setTopic] = useState<FaqTopic>();
  const [results, setResults] = useState<FaqResult[]>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const search = async (q: string, t: FaqTopic | undefined) => {
    if (!q.trim()) return;
    setBusy(true);
    setError(undefined);
    try {
      setResults((await api.searchFaq(q.trim(), t)).results);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel" aria-labelledby="faq-heading">
      <h2 id="faq-heading">Search our FAQ</h2>
      <form
        className="inline-field"
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          void search(query, topic);
        }}
      >
        <label htmlFor="faq-q" className="visually-hidden">
          Your question
        </label>
        <input id="faq-q" placeholder="e.g. How long do refunds take?" maxLength={300} value={query} onChange={(e) => setQuery(e.target.value)} />
        <button type="submit" className="btn btn-primary" disabled={busy || !query.trim()}>
          Search
        </button>
      </form>
      <div className="chips" role="group" aria-label="Topic">
        {[undefined, ...TOPICS].map((t) => (
          <button
            key={t ?? 'all'}
            type="button"
            className={`chip${topic === t ? ' active' : ''}`}
            aria-pressed={topic === t}
            onClick={() => {
              setTopic(t);
              void search(query, t);
            }}
          >
            {t ? cap(t) : 'All topics'}
          </button>
        ))}
      </div>
      <div aria-live="polite">
        {busy && <Loading label="Searching…" />}
        {error && <ErrorBox error={error} />}
        {!busy && results && results.length === 0 && (
          <p className="muted">No answers found. Try other words, or contact support below.</p>
        )}
        {!busy && results && results.length > 0 && (
          <div className="faq-results">
            {results.map((r) => (
              <details key={r.question} open={results.length === 1}>
                <summary>
                  <span className="eyebrow">{cap(r.topic)}</span> {r.question}
                </summary>
                <p>{r.answer}</p>
              </details>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function ContactForm() {
  const { user } = useAuth();
  const [subject, setSubject] = useState('');
  const [summary, setSummary] = useState('');
  const [priority, setPriority] = useState<'normal' | 'high'>('normal');
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [ticket, setTicket] = useState<TicketCreated>();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      setTicket(
        await api.createTicket({
          subject: subject.trim(),
          summary: summary.trim(),
          priority,
          contactEmail: user ? undefined : email.trim(),
        }),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel" aria-labelledby="contact-heading">
      <h2 id="contact-heading">Contact support</h2>
      {ticket ? (
        <Notice>
          Thanks! We got your message and will reply {ticket.expectedResponse}.{' '}
          <button
            type="button"
            className="link-button"
            onClick={() => {
              setTicket(undefined);
              setSubject('');
              setSummary('');
            }}
          >
            Send another
          </button>
        </Notice>
      ) : (
        <form className="form" onSubmit={submit}>
          {user ? (
            <p className="muted">We’ll reply to {user.email}.</p>
          ) : (
            <label>
              Your email
              <input type="email" autoComplete="email" required maxLength={254} value={email} onChange={(e) => setEmail(e.target.value)} />
            </label>
          )}
          <label>
            Subject
            <input required maxLength={200} value={subject} onChange={(e) => setSubject(e.target.value)} />
          </label>
          <label>
            How can we help?
            <textarea required maxLength={4000} rows={5} value={summary} onChange={(e) => setSummary(e.target.value)} />
          </label>
          <label className="checkbox">
            <input type="checkbox" checked={priority === 'high'} onChange={(e) => setPriority(e.target.checked ? 'high' : 'normal')} />
            This is urgent
          </label>
          {error && <ErrorBox error={error} />}
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? 'Sending…' : 'Send message'}
          </button>
        </form>
      )}
    </section>
  );
}
