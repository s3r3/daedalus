import { useState, useEffect, useCallback } from 'react';

export interface DeckEntry {
  slug: string;
  title: string;
  theme: string;
  slideCount: number;
  lastModified: string;
}

export function useDecks() {
  const [decks, setDecks] = useState<DeckEntry[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/__api/decks');
      const data = await res.json();
      setDecks(data.decks ?? []);
    } catch {
      setDecks([]);
    } finally {
      setLoading(false);
    }
  }, []);

  const create = useCallback(async (name: string): Promise<string> => {
    const res = await fetch('/__api/decks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Failed to create deck' }));
      throw new Error(err.error || 'Failed to create deck');
    }
    const data = await res.json();
    await refresh();
    return data.slug;
  }, [refresh]);

  const remove = useCallback(async (slug: string) => {
    await fetch(`/__api/decks/${encodeURIComponent(slug)}`, { method: 'DELETE' });
    await refresh();
  }, [refresh]);

  useEffect(() => { refresh(); }, [refresh]);

  return { decks, loading, create, remove, refresh };
}
