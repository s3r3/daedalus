import { useRef, useState, type DragEvent } from 'react';

interface FileUploadZoneProps {
  files: { name: string; ext: string }[];
  onUpload: (files: FileList) => void;
  onRemove: (name: string) => void;
}

export function FileUploadZone({ files, onUpload, onRemove }: FileUploadZoneProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  const handleDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    if (e.dataTransfer.files.length) onUpload(e.dataTransfer.files);
  };

  const handleDragOver = (e: DragEvent) => { e.preventDefault(); setDragging(true); };
  const handleDragLeave = () => setDragging(false);

  return (
    <div>
      {/* Drop zone */}
      <div
        role="button"
        tabIndex={0}
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onClick={() => inputRef.current?.click()}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); inputRef.current?.click(); } }}
        style={{
          border: `2px dashed ${dragging ? 'rgba(139,92,246,0.6)' : 'rgba(255,255,255,0.15)'}`,
          borderRadius: '8px',
          padding: '20px',
          textAlign: 'center',
          cursor: 'pointer',
          backgroundColor: dragging ? 'rgba(139,92,246,0.1)' : 'transparent',
          transition: 'all 0.2s ease',
          marginBottom: '8px',
        }}
      >
        <p style={{ color: '#888', fontSize: '0.8rem', margin: 0 }}>
          Drop files here or click to browse
        </p>
        <p style={{ color: '#666', fontSize: '0.7rem', margin: '4px 0 0' }}>
          PDF, MD, TXT, CSV, DOCX, images
        </p>
        <input
          ref={inputRef}
          type="file"
          multiple
          style={{ display: 'none' }}
          onChange={(e) => e.target.files && onUpload(e.target.files)}
        />
      </div>

      {/* File list */}
      {files.length > 0 && (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {files.map(f => (
            <li key={f.name} style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '6px 8px', borderRadius: '4px', marginBottom: '2px',
              backgroundColor: 'rgba(255,255,255,0.03)',
            }}>
              <span style={{ color: '#ccc', fontSize: '0.8rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                {f.name}
              </span>
              <button
                onClick={() => onRemove(f.name)}
                aria-label={`Remove ${f.name}`}
                style={{ color: '#888', fontSize: '0.75rem', cursor: 'pointer', border: 'none', background: 'none', padding: '2px 4px' }}
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
