import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type Page } from './api';

/**
 * Cursor-paginated list. Changing `url` resets to page one; "load more" appends the next page.
 * A request counter discards responses that arrive after the filters already changed (no stale flashes).
 */
export function usePaged<T>(url: string | null) {
  const [items, setItems] = useState<T[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const seq = useRef(0);

  const fetchPage = useCallback(async (cursor: string | null, replace: boolean) => {
    if (!url) return;
    const id = ++seq.current;
    setLoading(true); setError(null);
    try {
      const sep = url.includes('?') ? '&' : '?';
      const page = await api<Page<T>>(cursor ? `${url}${sep}cursor=${encodeURIComponent(cursor)}` : url);
      if (id !== seq.current) return;
      setItems((prev) => (replace ? page.items : [...prev, ...page.items]));
      setNext(page.nextCursor);
    } catch (e) {
      if (id === seq.current) setError(e);
    } finally {
      if (id === seq.current) setLoading(false);
    }
  }, [url]);

  useEffect(() => { setItems([]); setNext(null); void fetchPage(null, true); }, [fetchPage]);

  return {
    items, setItems, loading, error, hasMore: next !== null,
    loadMore: () => { if (next) void fetchPage(next, false); },
    reload: () => void fetchPage(null, true),
  };
}
