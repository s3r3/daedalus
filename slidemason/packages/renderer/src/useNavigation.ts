import { useState, useEffect, useCallback, useRef } from 'react';

/** SessionStorage key for persisting slide position across reloads. */
function storageKey(): string {
  const hash = window.location.hash.replace(/^#\/?/, '');
  return hash ? `slidemason-pos-${hash}` : 'slidemason-pos-default';
}

function readInitialSlide(max: number): number {
  try {
    // ?slide=N takes priority (used by PDF/PPTX export via Playwright)
    if (typeof window !== 'undefined') {
      const param = new URLSearchParams(window.location.search).get('slide');
      if (param != null) {
        const n = parseInt(param, 10);
        if (!isNaN(n) && n >= 0) return Math.min(n, max);
      }
    }
    // Fall back to session storage for normal browsing
    const stored = sessionStorage.getItem(storageKey());
    if (stored != null) {
      const n = parseInt(stored, 10);
      if (!isNaN(n) && n >= 0) return Math.min(n, max);
    }
  } catch { /* SSR or private browsing */ }
  return 0;
}

export function useNavigation(slideCount: number) {
  const safeMax = Math.max(0, slideCount - 1);
  const [currentSlide, setCurrentSlide] = useState(() =>
    readInitialSlide(safeMax),
  );
  const prevSlideRef = useRef(currentSlide);

  // Derive direction from change in currentSlide
  const direction: 1 | -1 = currentSlide >= prevSlideRef.current ? 1 : -1;

  // Update ref after each render so next render can compare
  useEffect(() => {
    prevSlideRef.current = currentSlide;
  });

  // When slideCount changes (e.g. async deck load), re-read ?slide=N from URL
  // This handles the case where slides load after initial render
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const param = new URLSearchParams(window.location.search).get('slide');
    if (param != null) {
      const n = parseInt(param, 10);
      if (!isNaN(n) && n >= 0 && n < slideCount) {
        setCurrentSlide(n);
      }
    }
  }, [slideCount]);

  // Persist current slide to sessionStorage
  useEffect(() => {
    try {
      sessionStorage.setItem(storageKey(), String(currentSlide));
    } catch { /* ignore */ }
  }, [currentSlide]);

  const goTo = useCallback((index: number) => {
    setCurrentSlide(Math.max(0, Math.min(index, slideCount - 1)));
  }, [slideCount]);

  const next = useCallback(() => {
    setCurrentSlide((prev) => Math.min(prev + 1, slideCount - 1));
  }, [slideCount]);

  const prev = useCallback(() => {
    setCurrentSlide((cur) => Math.max(cur - 1, 0));
  }, []);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement;
      const tag = target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      // Don't intercept when editing inline text
      if (target?.isContentEditable) return;

      switch (e.key) {
        case 'ArrowDown':
        case 'ArrowRight':
        case ' ':
          e.preventDefault();
          next();
          break;
        case 'ArrowUp':
        case 'ArrowLeft':
          e.preventDefault();
          prev();
          break;
        case 'Home':
          e.preventDefault();
          goTo(0);
          break;
        case 'End':
          e.preventDefault();
          goTo(slideCount - 1);
          break;
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [next, prev, goTo, slideCount]);

  return { currentSlide, direction, goTo, next, prev };
}
