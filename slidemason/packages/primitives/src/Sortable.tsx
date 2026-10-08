import { useState, useRef } from 'react';

interface SortableItem {
  id: string;
  content: React.ReactNode;
}

interface SortableProps {
  items: SortableItem[];
  style?: React.CSSProperties;
  className?: string;
}

export function Sortable({
  items: initialItems = [],
  style,
  className = '',
}: SortableProps) {
  const [items, setItems] = useState(initialItems);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const dragOverIndex = useRef<number | null>(null);

  function handleDragStart(index: number) {
    setDragIndex(index);
  }

  function handleDragOver(e: React.DragEvent, index: number) {
    e.preventDefault();
    dragOverIndex.current = index;
  }

  function handleDragEnd() {
    if (dragIndex !== null && dragOverIndex.current !== null && dragIndex !== dragOverIndex.current) {
      const updated = [...items];
      const [moved] = updated.splice(dragIndex, 1);
      updated.splice(dragOverIndex.current, 0, moved);
      setItems(updated);
    }
    setDragIndex(null);
    dragOverIndex.current = null;
  }

  return (
    <div className={className} style={{ display: 'flex', flexDirection: 'column', gap: 8, ...style }} data-pptx-type="passthrough">
      {items.map((item, i) => {
        const isDragging = dragIndex === i;
        return (
          <div
            key={item.id}
            draggable
            onDragStart={() => handleDragStart(i)}
            onDragOver={(e) => handleDragOver(e, i)}
            onDragEnd={handleDragEnd}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              padding: '12px 16px',
              background: isDragging ? 'var(--sm-surface)' : 'var(--sm-glass-bg)',
              backdropFilter: 'blur(12px)',
              border: '1px solid',
              borderColor: isDragging ? 'var(--sm-primary)' : 'var(--sm-border)',
              borderRadius: 'var(--sm-radius)',
              cursor: 'grab',
              transition: 'background 0.15s ease, border-color 0.15s ease',
            }}
          >
            <span
              style={{
                fontWeight: 700,
                color: 'var(--sm-muted)',
                fontSize: '0.85rem',
                minWidth: 24,
              }}
            >
              {i + 1}
            </span>
            <div style={{ flex: 1 }}>{item.content}</div>
          </div>
        );
      })}
    </div>
  );
}
