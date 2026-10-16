import { useCallback, useEffect, useRef, useState } from "react";

interface PollingState<T> {
  data: T | null;
  error: Error | null;
  loading: boolean;
  refresh: () => void;
}

/**
 * Calls `fn` immediately and then every `intervalMs`, skipping ticks while the
 * tab is hidden so a backgrounded dashboard stops hitting the API.
 */
export function usePolling<T>(
  fn: () => Promise<T>,
  intervalMs: number,
  deps: unknown[] = [],
): PollingState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);

  // Keep the latest fn in a ref so a caller passing an inline closure does not
  // restart the interval on every render.
  const fnRef = useRef(fn);
  fnRef.current = fn;

  const refresh = useCallback(() => setTick((value) => value + 1), []);

  useEffect(() => {
    let cancelled = false;
    // Skip a tick while the last request is still going, so a slow api doesn't
    // pile up requests or let an old response overwrite a newer one.
    let inFlight = false;

    const run = async () => {
      if (document.hidden || inFlight) {
        return;
      }
      inFlight = true;
      try {
        const result = await fnRef.current();
        if (!cancelled) {
          setData(result);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err : new Error(String(err)));
        }
      } finally {
        inFlight = false;
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    void run();
    const timer = window.setInterval(() => void run(), intervalMs);

    // Catch up immediately when the tab comes back rather than waiting a tick.
    const onVisible = () => {
      if (!document.hidden) {
        void run();
      }
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [intervalMs, tick, ...deps]);

  return { data, error, loading, refresh };
}
