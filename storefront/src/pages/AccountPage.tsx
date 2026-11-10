import { useState } from 'react';
import { api } from '../api';
import { useAuth } from '../auth';
import { ErrorBox, Loading, Notice } from '../components/ui';
import { formatDate } from '../format';
import type { MemoryFactKind, MemoryView } from '../types';
import { useAsync } from '../useAsync';

const KIND_LABELS: Record<MemoryFactKind, string> = {
  size: 'Size',
  style: 'Style',
  diet: 'Diet',
  brand_like: 'Brand you like',
  brand_dislike: 'Brand you avoid',
  other: 'Other',
};

export function AccountPage() {
  const { user } = useAuth();
  const memory = useAsync(() => api.memory(), []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error>();
  const [done, setDone] = useState<string>();

  // Every change goes through commerce-api; the page shows what it sends back.
  const run = async (work: () => Promise<MemoryView | null>, message: string) => {
    setBusy(true);
    setError(undefined);
    setDone(undefined);
    try {
      const view = await work();
      if (view) memory.setData(view);
      else memory.reload();
      setDone(message);
    } catch (e) {
      setError(e instanceof Error ? e : new Error(String(e)));
    } finally {
      setBusy(false);
    }
  };

  const toggle = (enabled: boolean) => {
    if (!enabled && !window.confirm('Turn memory off? This deletes everything the assistant remembers.'))
      return;
    void run(
      () => api.setMemory(enabled),
      enabled ? 'Memory is on. The assistant will remember what you tell it.' : 'Memory is off and everything was deleted.',
    );
  };

  const forgetAll = () => {
    if (!window.confirm('Delete everything the assistant remembers? This can’t be undone.')) return;
    void run(async () => (await api.forgetAll(), null), 'Everything was deleted.');
  };

  const forget = (id: string) =>
    void run(async () => (await api.forgetFact(id), null), 'Forgotten.');

  return (
    <>
      <h1>Your account</h1>
      {user && <p className="muted">{user.name} · {user.email}</p>}

      <section className="account-section" aria-labelledby="memory-heading">
        <h2 id="memory-heading">Assistant memory</h2>
        <p>
          When this is on, the shopping assistant remembers preferences you tell it (like your size or
          brands you like) and short notes about earlier chats, so you don’t have to repeat yourself.
          It never remembers payment details, addresses or prices. Notes about chats are deleted after
          90 days; preferences stay until you delete them.
        </p>

        {memory.error && <ErrorBox error={memory.error} onRetry={memory.reload} />}
        {!memory.data && !memory.error && <Loading label="Loading what the assistant remembers…" />}
        {memory.data && (
          <>
            <label className="switch">
              <input
                type="checkbox"
                role="switch"
                checked={memory.data.enabled}
                disabled={busy}
                onChange={(e) => toggle(e.target.checked)}
              />
              <span>Let the assistant remember my preferences and earlier chats</span>
            </label>

            {error && <ErrorBox error={error} />}
            {done && <Notice>{done}</Notice>}

            <h3>Preferences</h3>
            {memory.data.facts.length === 0 ? (
              <p className="muted">Nothing saved.</p>
            ) : (
              <ul className="memory-list">
                {memory.data.facts.map((f) => (
                  <li key={f.id}>
                    <span>
                      <span className="muted">{KIND_LABELS[f.kind] ?? f.kind}:</span> {f.value}
                    </span>
                    <button
                      type="button"
                      className="btn btn-small btn-ghost"
                      disabled={busy}
                      onClick={() => forget(f.id)}
                      aria-label={`Forget ${KIND_LABELS[f.kind] ?? f.kind}: ${f.value}`}
                    >
                      Forget
                    </button>
                  </li>
                ))}
              </ul>
            )}

            <h3>Earlier chats</h3>
            {memory.data.episodes.length === 0 ? (
              <p className="muted">Nothing saved.</p>
            ) : (
              <ul className="memory-list">
                {memory.data.episodes.map((e) => (
                  <li key={e.id}>
                    <span>
                      <span className="muted">{formatDate(e.createdAt)}:</span> {e.summary}
                    </span>
                  </li>
                ))}
              </ul>
            )}

            {(memory.data.facts.length > 0 || memory.data.episodes.length > 0) && (
              <button type="button" className="btn btn-ghost" disabled={busy} onClick={forgetAll}>
                Delete everything
              </button>
            )}
          </>
        )}
      </section>
    </>
  );
}
