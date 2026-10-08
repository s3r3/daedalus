import { useState, useEffect, useCallback } from 'react';

interface AssetEntry {
  name: string;
  ext: string;
}

export function useAssets(slug: string | null) {
  const [assets, setAssets] = useState<AssetEntry[]>([]);

  const refresh = useCallback(async () => {
    if (!slug) { setAssets([]); return; }
    try {
      const res = await fetch(`/__api/decks/${encodeURIComponent(slug)}/assets`);
      const data = await res.json();
      const raw: string[] = data.assets ?? [];
      setAssets(raw.map(name => ({
        name,
        ext: name.includes('.') ? name.slice(name.lastIndexOf('.')) : '',
      })));
    } catch {
      setAssets([]);
    }
  }, [slug]);

  const upload = useCallback(async (fileList: FileList) => {
    if (!slug) return;
    const formData = new FormData();
    for (const file of fileList) {
      formData.append('files', file);
    }
    await fetch(`/__api/decks/${encodeURIComponent(slug)}/assets`, { method: 'POST', body: formData });
    await refresh();
  }, [slug, refresh]);

  const remove = useCallback(async (name: string) => {
    if (!slug) return;
    await fetch(`/__api/decks/${encodeURIComponent(slug)}/assets/${encodeURIComponent(name)}`, { method: 'DELETE' });
    await refresh();
  }, [slug, refresh]);

  useEffect(() => { refresh(); }, [refresh]);

  return { assets, upload, remove, refresh };
}
