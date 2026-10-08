import { useState, useEffect, useCallback } from 'react';

interface FileEntry {
  name: string;
  ext: string;
}

export function useFiles(slug: string | null) {
  const [files, setFiles] = useState<FileEntry[]>([]);

  const refresh = useCallback(async () => {
    if (!slug) { setFiles([]); return; }
    try {
      const res = await fetch(`/__api/decks/${encodeURIComponent(slug)}/files`);
      const data = await res.json();
      const raw: string[] = data.files ?? [];
      setFiles(raw.map(name => ({
        name,
        ext: name.includes('.') ? name.slice(name.lastIndexOf('.')) : '',
      })));
    } catch {
      setFiles([]);
    }
  }, [slug]);

  const upload = useCallback(async (fileList: FileList) => {
    if (!slug) return;
    const formData = new FormData();
    for (const file of fileList) {
      formData.append('files', file);
    }
    await fetch(`/__api/decks/${encodeURIComponent(slug)}/files`, { method: 'POST', body: formData });
    await refresh();
  }, [slug, refresh]);

  const remove = useCallback(async (name: string) => {
    if (!slug) return;
    await fetch(`/__api/decks/${encodeURIComponent(slug)}/files/${encodeURIComponent(name)}`, { method: 'DELETE' });
    await refresh();
  }, [slug, refresh]);

  useEffect(() => { refresh(); }, [refresh]);

  return { files, upload, remove, refresh };
}
