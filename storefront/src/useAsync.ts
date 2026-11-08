import { useCallback, useEffect, useState, type DependencyList } from 'react';

interface AsyncState<T> {
  data: T | undefined;
  error: Error | undefined;
  loading: boolean;
  reload: () => void;
  setData: (data: T) => void;
}

/** Runs `load` whenever `deps` change; ignores results from superseded runs. */
export function useAsync<T>(load: () => Promise<T>, deps: DependencyList): AsyncState<T> {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<Error>();
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);

  // Callers pass the values `load` depends on, like useEffect.
  const run = useCallback(load, deps);

  useEffect(() => {
    let current = true;
    setLoading(true);
    setError(undefined);
    run().then(
      (d) => {
        if (current) {
          setData(d);
          setLoading(false);
        }
      },
      (e: unknown) => {
        if (current) {
          setError(e instanceof Error ? e : new Error(String(e)));
          setLoading(false);
        }
      },
    );
    return () => {
      current = false;
    };
  }, [run, nonce]);

  return { data, error, loading, reload: () => setNonce((n) => n + 1), setData };
}
