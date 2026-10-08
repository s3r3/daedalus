import { useEffect, useState } from 'react';
import { useDeck } from '@slidemason/renderer';

interface TableOfContentsProps {
  slideLabels?: string[];
}

export function TableOfContents({ slideLabels }: TableOfContentsProps) {
  const { currentSlide, slideCount, goTo } = useDeck();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [open]);

  return (
    <>
      {/* Toggle button - top left */}
      <button
        onClick={() => setOpen(!open)}
        aria-label="Toggle table of contents"
        style={{
          position: 'fixed', top: '24px', left: '24px', zIndex: 50,
          width: '40px', height: '40px', borderRadius: '50%',
          backgroundColor: 'rgba(0,0,0,0.6)', border: '1px solid rgba(255,255,255,0.2)',
          cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: '#fff', fontSize: '1rem', backdropFilter: 'blur(8px)',
        }}
      >
        ☰
      </button>

      {/* Overlay panel */}
      {open && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Table of contents"
          style={{
            position: 'fixed', inset: 0, zIndex: 45,
            backgroundColor: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(4px)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
          onClick={() => setOpen(false)}
        >
          <div
            style={{
              backgroundColor: 'rgba(20,20,30,0.95)', borderRadius: '12px',
              border: '1px solid rgba(255,255,255,0.1)', padding: '24px',
              maxHeight: '70vh', overflowY: 'auto', minWidth: '250px',
            }}
            onClick={e => e.stopPropagation()}
          >
            <h3 style={{ color: '#fff', fontSize: '1rem', fontWeight: 600, margin: '0 0 12px' }}>
              Slides
            </h3>
            <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
              {Array.from({ length: slideCount }, (_, i) => (
                <li key={i}>
                  <button
                    onClick={() => { goTo(i); setOpen(false); }}
                    style={{
                      width: '100%', textAlign: 'left', padding: '8px 12px',
                      borderRadius: '6px', border: 'none', cursor: 'pointer',
                      backgroundColor: i === currentSlide ? 'rgba(139,92,246,0.2)' : 'transparent',
                      color: i === currentSlide ? '#c4b5fd' : '#aaa',
                      fontSize: '0.85rem', marginBottom: '2px',
                      transition: 'background-color 0.15s ease',
                    }}
                  >
                    <span style={{ color: '#666', marginRight: '8px' }}>{i + 1}.</span>
                    {slideLabels?.[i] ?? `Slide ${i + 1}`}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </>
  );
}
