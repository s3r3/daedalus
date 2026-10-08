import { useDeck } from '@slidemason/renderer';

export function SlideThumbnails() {
  const { currentSlide, slideCount, goTo } = useDeck();

  return (
    <div style={{
      position: 'fixed', bottom: 0, left: 0, right: 0,
      display: 'flex', justifyContent: 'center', padding: '8px 16px',
      backgroundColor: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(8px)',
      zIndex: 40, overflowX: 'auto', gap: '6px',
    }}>
      {Array.from({ length: slideCount }, (_, i) => (
        <button
          key={i}
          onClick={() => goTo(i)}
          aria-label={`Go to slide ${i + 1}`}
          style={{
            minWidth: '36px', height: '24px', borderRadius: '4px',
            backgroundColor: i === currentSlide ? 'rgba(139,92,246,0.6)' : 'rgba(255,255,255,0.1)',
            border: i === currentSlide ? '1px solid rgba(139,92,246,0.8)' : '1px solid transparent',
            color: i === currentSlide ? '#fff' : '#888',
            fontSize: '0.65rem', cursor: 'pointer',
            transition: 'all 0.15s ease',
          }}
        >
          {i + 1}
        </button>
      ))}
    </div>
  );
}
