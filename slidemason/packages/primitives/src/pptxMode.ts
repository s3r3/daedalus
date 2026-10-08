export function isPptxMode(): boolean {
  return typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('pptx');
}
